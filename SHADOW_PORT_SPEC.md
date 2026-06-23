# SHADOW PORT SPEC — make OpenStrandJS shadow rendering pixel-identical to OpenStrand Studio `shader_utils.py`

Status: definitive port spec. Single source of truth for replacing the current
inflate-and-fill shadow in `web/strand-renderer.js` with a faithful port of
`draw_strand_shadow` / `draw_mask_strand_shadow`.

Target file: `C:/Users/YonatanSetbon/projects/OpenStrandJS/web/strand-renderer.js`
Reference: `C:/Users/YonatanSetbon/projects/OpenStrandStudio/src/shader_utils.py`
Harness fixture exercising shadows: `fixtures/overhand_knot.json` (the ONLY shadow-ON fixture).

---

## 0. THE ONE NUMBER THAT WAS WRONG IN EVERY HYPOTHESIS — `num_steps`

The extraction findings disagree about `num_steps` (3 vs 2). **This is now resolved by the
ground-truth settings the reference renderer actually reads.**

- `reference_render.py` instantiates a real `MainWindow().canvas` (a `StrandDrawingCanvas`) and
  never sets `num_steps` / `max_blur_radius` explicitly. The canvas loads them from
  `QStandardPaths.AppDataLocation` → on this machine `C:/Users/YonatanSetbon/AppData/Roaming/OpenStrandStudio/user_settings.txt`.
- That file contains **`NumSteps: 2`** and **`MaxBlurRadius: 30.0`** (and `ShadowColor: 0,0,0,150`).
- The function-signature default `num_steps=3` and the canvas code-default `num_steps=2` are both
  irrelevant: the loaded setting wins, and it is **2**.

**THEREFORE THE PORT MUST USE `NUM_STEPS = 2` AND `MAX_BLUR = 30.0`.** Do not implement the 3-step
100/66/33 @ 10/20/30 progression — that would not match the reference PNGs. The exact per-step
table is in §2.

> If the reference machine's `user_settings.txt` ever changes, re-derive §2 from the formulas. The
> formulas (not the table) are the real contract. The implementation should compute the table from
> `NUM_STEPS` + `MAX_BLUR` + base alpha, NOT hard-code 15/30 & 150/75, so it stays correct if the
> settings change. (We default the constants to 2 / 30 to match the current reference.)

---

## 1. THE ALGORITHM (per casting strand `S_c`, drawn BEFORE `S_c`'s own body)

Shadows are painted UNDER the casting strand's body. The existing renderer already does this
(it casts before `drawStrand(i)`), so keep that structure. For each casting strand `S_c` at list
index `i`, against every receiver `S_r` at index `j < i` (caster strictly above receiver):

There are TWO passes, in this order:

### PASS A — SOLID CORE (unclipped, full alpha)
1. `core = build_shadow_geometry(S_c)` = the caster **body** stroked at width `(w + 2·sw)` (NO blur
   inflation). RoundJoin / FlatCap. (§4.A)
2. For each receiver `S_r`: `region = (core ∪ casterCircles@+2) ∩ receiverGeom(S_r)` where
   `receiverGeom` = `build_rendered_geometry(S_r)` (body + visible end-circles; half-circles for
   AttachedStrand). (§4.B, §4.C) — apply the survivor gating/subtractions in §3. If empty, skip.
3. Accumulate every surviving `region` into one `combined` CompoundPath (UNION / `WindingFill`).
4. Fill `combined` SOLID at the FULL shadow color `rgba(0,0,0,150)` (alpha 150/255 ≈ 0.588),
   `SourceOver`, **no stroke, NOT clipped**. This is the dark inner shadow.

### PASS B — FADED BLUR (clipped, tapering)
1. `total = combined ∪ build_shadow_circle_geometry(S_c, MAX_BLUR)` (caster body-core intersections
   PLUS the caster's full end-circle geometry; see §4.C — note the circle is identical regardless
   of the `+2`/`+0` extension arg).
2. `clip = ⋃ receiverGeom(S_r)` over every receiver that received shadow this strand, minus any
   `clip_blocker` (in the corpus there is no blocker → `clip` = union of receiver geometries). (§3.E)
3. Set clip = `clip`. Then run `NUM_STEPS` (=2) STROKE passes over the **boundary** of `total`:
   for step `i = 0 .. NUM_STEPS-1` stroke `total` with `strokeWidth = current_width`,
   `strokeColor = rgba(0,0,0, current_alpha)`, `strokeCap='butt'` (FlatCap), `strokeJoin='round'`
   (RoundJoin), `fillColor = null`, `SourceOver`. Widths/alphas per §2.

**Both passes use the SAME `combined` geometry.** Pass A fills it; Pass B strokes its outline so the
stroke straddles the boundary and feathers `MAX_BLUR` outward, clipped to the receiver bodies so the
blur never leaks past the strands it lands on.

> WHY boundary-stroke-then-clip instead of expand-and-fill: paper.js has no morphological dilate.
> Qt's `painter.strokePath(total, pen)` strokes the OUTLINE of `total` at `current_width`, centered
> on the boundary, so it extends `current_width/2` outward and inward; the clip keeps only the part
> over the receivers. This is the faithful route and is what produces the soft fade. The current JS
> `expBody = body+30` then fill is a DIFFERENT (and wrong) operation — replace it entirely.

### Draw order recap (unchanged from today)
For strand `i` in list order: if MaskedStrand → `drawMasked` (which now also does the faithful mask
shadow, §5) and continue; else cast shadow onto all `j < i` (Passes A+B), then `drawStrand(i)`.
Hidden strands are already filtered upstream; no `is_hidden` / arrow handling is needed in the
renderer for the corpus.

---

## 2. EXACT PER-STEP WIDTHS & ALPHAS

Formulas (verbatim from `shader_utils.py:1407-1411`, identical in `draw_mask_strand_shadow`):

```
progress       = (NUM_STEPS - i) / NUM_STEPS
current_alpha  = base_alpha * progress * (1.0 / NUM_STEPS) * 2.0      // base_alpha = 150
alpha_byte     = max(0, min(255, Math.trunc(current_alpha)))          // TRUNCATE toward zero (NOT round)
current_width  = MAX_BLUR * ((i + 1) / NUM_STEPS)                     // world px, must be ×S when drawn
```

With `NUM_STEPS = 2`, `base_alpha = 150`, `MAX_BLUR = 30.0` (THE REFERENCE VALUES):

| step i | progress | current_alpha | alpha_byte | paper alpha (÷255) | current_width (world) | strokeWidth (×S) |
|:------:|:--------:|:-------------:|:----------:|:------------------:|:---------------------:|:----------------:|
| 0      | 1.0      | 150·1.0·0.5·2 = 150.0 | **150** | 0.5882 | 30·(1/2) = **15.0** | 15.0·S |
| 1      | 0.5      | 150·0.5·0.5·2 = 75.0  | **75**  | 0.2941 | 30·(2/2) = **30.0** | 30.0·S |

(For the record, IF NUM_STEPS were 3 the table would be 100/66/33 @ 10/20/30 — but it is 2. Use the
2-step table above. Compute it from the formulas so it auto-tracks the constants.)

### SCALING — every length is multiplied by S before drawing
`S = ss * zoom` (`ss = meta.supersample||2`, `zoom = meta.zoom||1`); `P(pt)=pt.x*S+ox*ss`.
All world widths/radii passed to paper MUST be `×S`:
- Caster core stroke width `(w + 2·sw)` → drawn via `strokedOutline(centerline, (w+2·sw)*S)`.
- Faded stroke widths `15.0` and `30.0` → `strokeWidth = 15.0*S` and `30.0*S`.
- Caster circle radius `(w+2·sw)/2 + 2` → `((w+2·sw)/2 + 2) * S`. The `+2` IS scaled (it is world px).
- Receiver circle radius `(w+2·sw)/2` → `((w+2·sw)/2) * S`.
Alphas are 0–255 → divide by 255 for `paper.Color` (do NOT scale alpha by S).

> The `MAX_BLUR+2` (=32) vs `MAX_BLUR` (=30) argument distinction in the Qt source is MOOT:
> `build_shadow_circle_geometry` ignores its extension arg for the radius — the radius is always
> `(w+2·sw)/2 + 2`. So the caster circle geometry is identical in Pass A's intersection test and in
> Pass B's `total`. Implement ONE caster-circle builder with radius `((w+2·sw)/2 + 2)*S`.

---

## 3. GATING & SUBTRACTIONS (per caster→receiver pair)

Apply in this exact order. In the current corpus (`overhand_knot`) most subtractions are no-ops, but
implement them so future fixtures stay faithful. Items marked NO-OP/ABSENT may be omitted with a code
comment, but the gating in A–C and the clip in E are mandatory.

- **A. Caster gate** (before the receiver loop): caster must be non-Masked and have a valid body.
  No `is_hidden`/arrow handling (hidden strands filtered upstream; arrows never cast in the corpus).
- **B. Receiver gate** (per `S_r`): skip if `S_r` is the caster; skip MaskedStrand receivers; skip if
  no body; only cast when `index(S_c) > index(S_r)` (caster strictly above — `j < i`); skip the pair
  if both are the two components of the SAME MaskedStrand (the existing `maskPairs` set — keep it);
  bbox quick-reject (keep the existing inflated-bounds check, but inflate by the BLUR so the reject is
  conservative: a pair whose `(core)` bounds inflated by `MAX_BLUR*S` don't touch the receiver bounds
  can't produce visible blur).
- **C. Intersection** must be non-empty (`Math.abs(region.area) > 0.5`) or skip the pair.
- **D. Per-pair subtractions** from each `region` (all NO-OP/ABSENT in the corpus):
  1. user-configured subtracted layers — ABSENT (no `layer_state_manager`; `shadow_overrides = {}`).
  2. overlying VISIBLE-mask blockers (`get_shadow_blocker_path`, masks with index > caster) —
     not present in `overhand_knot` (the two masks ARE the casters/receivers, handled by `maskPairs`).
  3. `_subtract_visible_component_mask_coverage` — ABSENT.
  4. intermediate strands strictly between caster & receiver — ABSENT for the 5-strand corpus.
  5. side-line exclusion — **NO-OP in Qt** (`get_side_line_exclusion_path` always returns empty).
     Do NOT implement; leave a comment.
- **E. Clip path (Pass B only)**: `clip = ⋃ receiverGeom(S_r)` over receivers that received shadow,
  minus `clip_blocker` (ABSENT → no subtraction). Pass A is UNCLIPPED.

Default external semantics (no `layer_state_manager` in the JS corpus): `allow_full_shadow = false`,
`get_shadow_visibility = true`. So: subtractions D.1–D.4 run when present but are empty here, and
every above-pair casts.

---

## 4. GEOMETRY SOURCES (exact widths / radii)

### 4.A Caster core — `build_shadow_geometry(S_c, 0, include_circles=False)`
- Body = centerline stroked at **`width + 2·stroke_width`** (extension arg 0 → NO blur), RoundJoin +
  FlatCap. JS: `strokedBodyAtWidth(S_c, P, enableThird, (w + 2*sw) * S)`.
- NO circles in this call (circles are added separately, §4.C).

### 4.B Receiver — `build_rendered_geometry(S_r)`  ← THE KEY UPGRADE
- Body = centerline stroked at **`width + 2·stroke_width`**, RoundJoin + FlatCap.
  JS: `strokedBodyAtWidth(S_r, …, (w + 2*sw) * S)`.
- **UNION each VISIBLE end-circle.** Circle radius = **`(width + 2·sw)/2`** (NOT +2; that +2 is only
  for the CASTER circle). Use the render-time `has_circles` (already recomputed by `computeHasCircles`)
  and the circle-stroke alpha gate: **transparent circles (stroke alpha == 0) are EXCLUDED.**
- **AttachedStrand draws HALF-circles, not full circles**, at its attachment caps:
  - full circle radius `(w+2·sw)/2` at the endpoint, MINUS a tangent-rotated mask rect.
  - mask rect: `rect_width = rect_height = radius*4`; local rect `addRect(0, -rect_height/2, rect_width, rect_height)`;
    transform = translate(endpoint) then rotate(`degrees(angle)`) for the START cap, rotate(`degrees(angle - π)`)
    for the END cap. `half = fullCircle.subtract(maskRect)`.
  - This is EXACTLY the geometry already in `capOuterStart(center, angle, td)` / `capOuterEnd(center, angle, td)`
    with `td = (w+2·sw)*S` (they build `circle(td/2) − localRect`). **Reuse those two helpers.**
  - Start angle = `calculate_start_tangent()` ≈ `tangentAngle(centerline, 0)`; end angle ≈
    `atan2(cubic_tangent(1.0))` ≈ `tangentAngle(centerline, len)`. Use the existing `tangentAngle`.
- Plain `Strand` receivers: union a FULL circle radius `(w+2·sw)/2` at each visible end-circle
  endpoint (use `new paper.Path.Circle(P(endpoint), ((w+2*sw)/2)*S)`).
- MaskedStrand receivers use `get_proper_masked_strand_path` (mask intersection, no circles) — but
  MaskedStrand receivers are SKIPPED by gate B, so this path is not needed for regular casting.

**Corpus check (overhand_knot, §minimum the implementer must reproduce):** receivers `1_1` (Strand,
has_circles [true,true]) and `1_2`/`1_3` (AttachedStrand, has_circles [true,false], so START half-circle
only). All circle strokes are visible (alpha > 0). **So receiver end-circles ARE exercised — the body-only
receiver geometry (current JS) is insufficient and is DIVERGENCE #3.** The implementer must union the
half-circle (AttachedStrand start) / full-circle (plain Strand ends) into the receiver geometry, else the
shadow falls short at the rounded junctions and the diff will not close.

### 4.C Caster circles — `build_shadow_circle_geometry(S_c, …)`
- Circles ONLY (no body). For each VISIBLE end-circle of the caster (same `has_circles` + alpha-gate as
  4.B), radius = **`(w + 2·sw)/2 + 2`** (the `+2` is fixed, NOT from blur; arg ignored).
- AttachedStrand uses the same HALF-circle construction as 4.B (reuse `capOuterStart`/`capOuterEnd`
  with `td = ((w+2·sw) + 4)*S` so radius = `(w+2·sw)/2 + 2`, then `×S`). Plain Strand → full circle.
- Used in BOTH Pass A's intersection test (`core ∪ casterCircles`) and Pass B's `total`
  (`combined ∪ casterCircles`). One builder, called identically both places.

### Stroker fidelity caveat (DIVERGENCE #5 — accept as residual)
`strokedOutline` is a `±half-width` offset polygon, not a true `QPainterPathStroker` RoundJoin/FlatCap
stroke; at sharp corners and ends it differs slightly from Qt. This already affects the body render and
is an accepted baseline residual — do NOT try to fix it in this task. The shadow uses the same stroker as
the body, so it stays consistent with the body it sits under.

---

## 5. MASKEDSTRAND CROSSING SHADOW — `draw_mask_strand_shadow` (port-for-completeness)

Replace the current `drawMasked` shadow block (`web/strand-renderer.js:558-569`, the
`firstExp ∩ secondBody` solid fill). NOTE: no mask fixture in the corpus has shadows ON
(`overhand_knot`'s masks ARE shadow-on but the mask self-crossing shadow is unmeasured at pixel level
because the over-strand body fully covers it except a fringe). Implement faithfully; mark
"port-for-completeness — unmeasured by corpus" in a comment.

Faithful algorithm (`shader_utils.py:179-373`), with `first` = top component, `second` = bottom:
1. `first_path` = `get_stroked_path_for_strand(first)` = `first` body stroked at `(fw + 2·fsw)`.
   `second_path` = `second` body stroked at `(sw + 2·ssw)`. (NO blur inflation — the current JS inflates
   `first` by `MAX_BLUR`, which is wrong; remove that.)
2. `intersection = first_path ∩ second_path`, minus the mask deletion rectangles (`subtractDeletions`).
3. Clip to `second_path` (`setClipPath` → paper clipping Group, §6).
4. `shading_path = second_path ∩ first_path` (same region; clipped).
5. **3-step faded loop = SAME formulas as §2** but with `NUM_STEPS`/`MAX_BLUR` from the canvas. Qt's
   `draw_mask_strand_shadow` signature default is `max_blur_radius = 29.99`, BUT the call site passes
   `canvas.max_blur_radius` = **30.0** (the loaded setting), so use **MAX_BLUR = 30, NUM_STEPS = 2** —
   identical table to §2 (widths 15/30, alphas 150/75). Stroke `shading_path` (butt/round), clipped.
6. **Inner-core fill** (the darker core): `inner = stroke(first_center_path, width = fw + 2·fsw)` (RoundJoin
   + FlatCap) `∩ second_path`, filled SOLID with `core_color = shadow base color at FULL alpha 150`,
   `SourceOver`. `first_center_path` = `first.get_path()` (raw centerline). In JS:
   `strokedBodyAtWidth(first, …, (fw + 2*fsw)*S)` intersected with `second_path`.
   (NOTE: unlike `draw_strand_shadow`, the mask path has NO separate unclipped solid-core pass; the inner
   core IS its core, drawn clipped after the faded loop.)

Draw order inside `drawMasked` is unchanged: shadow first (under), then the two mask color regions
(stroke region under fill region) which redraw the top strand over everything but the fringe.

---

## 6. PAPER.JS MAPPINGS

| Qt construct | paper.js construct |
|---|---|
| `QPainterPathStroker(width).createStroke(centerline)` RoundJoin/FlatCap | `strokedBodyAtWidth(s, P, enableThird, width*S)` (existing offset-polygon stroker; accepted residual §4) |
| `path.addPath(other)` then `setFillRule(WindingFill)` (UNION of regions) | accumulate into one `paper.CompoundPath`, or fold with `acc = acc.unite(region)`; `fillRule = 'nonzero'`. For the SOLID CORE the union of disjoint intersections can be a CompoundPath of the regions. |
| `painter.setBrush(QBrush(color)); setPen(NoPen); drawPath(p)` (SOLID FILL) | `p.fillColor = new paper.Color(0,0,0, 150/255); p.strokeColor = null;` |
| `painter.strokePath(region, pen)` with `pen.setWidthF(w); FlatCap; RoundJoin; color α` | a `paper.Path`/`CompoundPath` clone of `region` with `fillColor=null`, `strokeColor=new paper.Color(0,0,0, αbyte/255)`, `strokeWidth=w*S`, `strokeCap='butt'`, `strokeJoin='round'`. Stroking the boundary = Qt `strokePath`. |
| `painter.setCompositionMode(SourceOver)` | paper default blend is `'normal'` = SourceOver. Leave `blendMode` default. |
| `painter.save(); painter.setClipPath(clip); …; painter.restore()` | a clipping `paper.Group([clipRegion, ...strokeItems])` with `group.clipped = true` (paper uses the FIRST child as the clip mask; set `clipRegion.clipMask = true` is implied by `clipped`). Everything after the first child is clipped to it. Remove/rebuild the group per casting strand. |
| `QColor(0,0,0,150)` | `new paper.Color(0, 0, 0, 150/255)` (≈ rgba 0,0,0,0.5882). Constant; NOT read from fixture/meta. |

Concrete clip pattern for Pass B:
```js
// clipRegion = unite of all receiver geometries that received shadow (a paper Path/CompoundPath)
const strokeItems = [];
for (let stp = 0; stp < NUM_STEPS; stp++) {
  const progress = (NUM_STEPS - stp) / NUM_STEPS;
  const aByte = Math.max(0, Math.min(255, Math.trunc(150 * progress * (1 / NUM_STEPS) * 2.0)));
  const wWorld = MAX_BLUR * ((stp + 1) / NUM_STEPS);
  const stroke = total.clone();                 // `total` = combined ∪ casterCircles
  stroke.fillColor = null;
  stroke.strokeColor = new paper.Color(0, 0, 0, aByte / 255);
  stroke.strokeWidth = wWorld * S;
  stroke.strokeCap = 'butt';
  stroke.strokeJoin = 'round';
  strokeItems.push(stroke);
}
const clipGroup = new paper.Group([clipRegion, ...strokeItems]);
clipGroup.clipped = true;                        // first child clips the rest
```
Pass A (solid core) is just `combined.fillColor = new paper.Color(0,0,0,150/255); combined.strokeColor = null;`
added to the scene BEFORE `clipGroup` (so it sits under) and BEFORE `drawStrand(i)`.

> Z-ORDER: insert Pass A solid core, then Pass B clipGroup, then the body, in that order, for each
> casting strand. Because each strand casts then draws its own body, the body covers the inner part of
> its own shadow; only the fringe over LOWER strands remains — matching Qt. Do not batch all shadows
> first; keep the per-strand cast→draw interleave already in the loop.

---

## 7. HARD CONSTRAINT — SHADOW-OFF PATH STAYS BYTE-IDENTICAL

Only the `if (shadowEnabled)` branch may change. The shadow-OFF render path (every fixture except
`overhand_knot`) MUST stay byte-identical.

- `single_strand`, `three_strand_braid`, `closed_knot` (and all other non-overhand fixtures) have
  `shadow_enabled` false or absent → `SHADOW_ENABLED = false` → none of the new code runs. Verify these
  three do not move from baseline `match_pct` after the change.
- Do NOT touch `drawStrand`, `bodyLayers`, `collectCaps`, `collectSideLines`, `strokedOutline`,
  `computeHasCircles`, the downscale loop, or `P`/`S` setup.
- For `drawMasked`: the mask COLOR regions (`fStroke/sStroke/fFill/sExt`, lines 571-591) MUST be
  unchanged; only the `if (SHADOW_ENABLED) { … }` shadow block (558-569) is replaced. With shadows off
  the mask draw is identical.

---

## 8. CONCRETE CHANGE-LIST against `web/strand-renderer.js`

1. **Constants (lines 37-40).** Keep `SHADOW_COLOR = {r:0,g:0,b:0,a:150}`. Keep `MAX_BLUR = 30`. ADD
   `const NUM_STEPS = 2;` (the loaded reference setting). Keep `SHADOW_ENABLED`, `SHADOW_PAINT`.
   Update the comment block to describe the two-pass core+blur algorithm (it currently describes the
   old expand-and-intersect).

2. **ADD `buildShadowReceiverGeom(s, strands, P, enableThird, S)`** (new helper, near `bodyLayers`).
   Returns `build_rendered_geometry`: `strokedBodyAtWidth(s, …, (w+2sw)*S)` UNIONED with each visible
   end-circle. Reuse `capOuterStart`/`capOuterEnd` (with `td=(w+2sw)*S`) for AttachedStrand half-circles
   and `paper.Path.Circle(P(end), ((w+2sw)/2)*S)` for plain-Strand full circles. Gate each circle on
   render-time `has_circles[k]` AND `circleStrokeAlpha(...) > 0`. Use the same endpoint/child/closed
   logic as `collectCaps` so the circles match the body's drawn caps.

3. **ADD `buildShadowCasterCore(s, P, enableThird, S)`** → `strokedBodyAtWidth(s, …, (w+2sw)*S)` (NO blur).

4. **ADD `buildShadowCasterCircles(s, strands, P, enableThird, S)`** → union of caster end-circles at
   radius `((w+2sw)/2 + 2)*S` (half-circles for AttachedStrand via `capOuterStart/End` with
   `td=((w+2sw)+4)*S`; full circle for plain Strand). Same `has_circles`+alpha gate. May return null.

5. **ADD `castStrandShadow(s, strands, byLayer, P, enableThird, S, maskPairs, i)`** implementing §1:
   - build `core` (#3) and `casterCircles` (#4);
   - loop receivers `j < i` with §3 gating + bbox reject (inflate by `MAX_BLUR*S`);
   - per receiver: `region = (core ∪ casterCircles) ∩ buildShadowReceiverGeom(o)`; if `|area|>0.5`,
     add to `combined` (union) and add receiverGeom to `clip` (union);
   - if `combined` non-empty: Pass A solid fill at full alpha; Pass B `total = combined ∪ casterCircles`,
     `NUM_STEPS` stroke passes (§2 formulas) wrapped in a `clipGroup` clipped to `clip` (§6).
   - clean up all temporary helper paths.

6. **REPLACE the inline shadow loop (lines 660-710).** Delete the `fullBody`/`expBody` precompute
   (662-674), the per-strand `j<i` intersect-and-fill block (684-703), and the helper cleanup
   (708-710). Inside the main draw loop, before `drawStrand(s, …)`, call
   `if (shadowEnabled && s.type !== 'MaskedStrand') castStrandShadow(s, strands, byLayer, P, enableThird, S, maskPairs, i);`.
   Keep `maskPairs` (650-658), `SHADOW_ENABLED`/`SHADOW_PAINT` setup (644-646), and the draw loop
   skeleton (680-682, 705). `shadowCol` (675) can be dropped (build the color inside `castStrandShadow`).

7. **REPLACE the `drawMasked` shadow block (lines 558-569)** with a `drawMaskShadow(ms, first, second, P, enableThird, S)`
   call implementing §5 (component intersection, clip to `second`, 2-step faded loop, inner-core fill).
   Remove the `firstExp = …+MAX_BLUR` inflation. Leave the mask COLOR regions (571-591) untouched.

8. **Do NOT add any model/adapter field.** `meta.shadow_enabled` is already forwarded
   (`src/renderer/toRenderArray.ts:72`). No per-strand shadow field is consumed. The shadow color is the
   hard-coded constant. No changes outside `web/strand-renderer.js` are required for the harness path.

---

## 9. VERIFICATION (measure loop, run SERIALLY per fixture)

1. `python tools/reference_render.py fixtures/<f>.json artifacts/<f>/reference.png artifacts/<f>/reference.meta.json`
2. `node tools/js_render.mjs fixtures/<f>.json artifacts/<f>`
3. `node tools/diff.mjs artifacts/<f>`  → JSON `match_pct`; pixelmatch threshold 0.1.

- PRIMARY: `overhand_knot` must IMPROVE from the ~98.562% baseline (the soft fade + receiver
  half-circles are the gap). The remaining residual is the stroker-fidelity caveat (§4) and the box
  downscale, not the shadow algorithm.
- REGRESSION (must NOT move from baseline): `single_strand`, `three_strand_braid`, `closed_knot`
  (all shadow-OFF → new code dormant).
- `node tools/workflows/shadow-fidelity-port.mjs` drives steps 2+3 for the overhand iteration.

---

## 10. RESIDUALS / OUT OF SCOPE

- Stroker is an offset polygon, not Qt `QPainterPathStroker` (RoundJoin/FlatCap) — accepted residual,
  shared with the body; do not change here.
- Elliptical match-connected caps (`_make_cap_ellipse`/`_partner_cap_dims`) are NOT exercised
  (corpus has `elliptical_end_caps` off → plain circles). Use circles only.
- Overlying-mask blockers, intermediate-strand subtraction, component-mask coverage, shadow_overrides,
  `allow_full_shadow`, arrow shadows, `is_hidden` casting — all ABSENT/NO-OP in the corpus; implement
  the hooks as documented no-ops or omit with a comment. The side-line exclusion is a CONFIRMED Qt
  no-op — never implement it.
- MaskedStrand crossing shadow is port-for-completeness — no mask fixture exercises it at pixel level.
- The 2-step (not 3-step) progression is driven by the reference machine's `user_settings.txt`
  (`NumSteps: 2`, `MaxBlurRadius: 30.0`). Compute the table from the formulas so it tracks the constants.
