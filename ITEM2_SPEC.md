# ITEM 2 SPEC — Shadow overrides, mask-as-caster, mask-blocking & intermediate subtraction (1:1 with Qt)

Status: planning / definitive spec. Author: lead.

This spec makes `web/strand-renderer.js` `castStrandShadow` honor the per-pair
shadow override dictionary (`shadow_overrides`), the canonical `layer_order`, and
the three currently-missing Qt shadow paths:

1. **mask-as-caster** — a `MaskedStrand` must cast its crossing shadow onto lower
   non-mask strands (the JS main loop currently routes masks only to `drawMasked`
   and never to `castStrandShadow`).
2. **mask-blocking** — a visible mask layered ABOVE the caster subtracts its
   blocker geometry from the caster→receiver shadow (gated OFF by
   `allow_full_shadow`).
3. **intermediate-strand subtraction** — strands strictly between caster and
   receiver in `layer_order` subtract their rendered geometry from the shadow
   (gated OFF by `allow_full_shadow`).
4. **shadow_overrides** — per casting→receiving pair: `visibility` (skip the whole
   pair), `allow_full_shadow` (skip 2 + 3), and `subtracted_layers` (always
   subtracted, UNGATED).

It also plumbs `shadow_overrides` + `layer_order` (+ `num_steps`, `shadow_color`)
from the Qt reference renderer through `js_render.mjs` into `renderFixture`.

---

## 0. Non-negotiable invariants (DO NOT REGRESS)

These MUST stay byte-identical after the change:

- **Single-strand / no-override shadow algorithm.** The existing two-pass cast
  (PASS A solid-core unclipped @ alpha 150; PASS B `combined ∪ circles` stroked
  NUM_STEPS times, clipped to the union of receiver geometries) is unchanged for
  every pair that has no override and no blocker. The new code only *subtracts
  from* `region`/`combined` (it never adds, re-strokes, or reorders), and only
  for pairs that actually have an override or a qualifying mask/intermediate.
  `region` empty ⇒ pair contributes nothing (same as today).
- **Shadow-OFF path.** `if (shadowEnabled) castStrandShadow(...)` stays. When
  `meta.shadow_enabled` is false, `castStrandShadow` is never called and NONE of
  the new code runs. Masks still draw their bodies via `drawMasked`. Zero pixel
  change with shadows off.
- **maskPairs skip stays.** A mask's two own components must keep NOT shadowing
  each other (`maskPairs.has(s.layer_name + '|' + o.layer_name) ⇒ continue`).
  When a mask becomes a CASTER (new path), it must ALSO skip its own two
  components as receivers — see §4.2. Masks casting onto *other* lower strands is
  the only new casting behavior.
- **MaskedStrand receivers stay skipped** in `castStrandShadow`'s receiver loop
  (`o.type === 'MaskedStrand' ⇒ continue`). Qt's `drawMasked` owns the mask's own
  crossing; the regular loop must not also cast onto a mask body. (Qt's
  `build_rendered_geometry` would use the mask path for a mask receiver, but our
  corpus never needs a non-mask strand casting onto a mask receiver, and adding it
  risks double-darkening the mask crossing. Keep the skip; document it.)
- **Existing regression set.** After every JS change, re-run SERIALLY:
  `single_strand` = 100.000, `three_strand_braid` = 99.860, `closed_knot` =
  100.000, `overhand_knot` ≈ 98.809, `box_stitch` ≥ 99.733. Any drop is a bug.

The override/mask/intermediate logic ONLY produces a pixel change for the four new
fixtures (§2). On the current corpus, `shadow_overrides` is empty for every fixture
except `box_stitch` (whose single override sets `allow_full_shadow: true`, so the
new gated paths are skipped and only the UNGATED `subtracted_layers: ['1_2']`
applies — see Fixture 4). So box_stitch's match % must NOT drop; it may rise toward
~100 if applying the `1_2` subtraction closes part of the residual gap.

---

## 1. Source-of-truth (Qt) — the exact algorithm being ported

All references are `OpenStrandStudio/src/shader_utils.py` unless noted. Key facts
the port must reproduce (per-pair, inside the receiver loop `:605`):

- Direction is **casting → receiving**: `get_shadow_override(this_layer=caster,
  other_layer=receiver)` (`:752`, `layer_state_manager.py:677`). The dict is keyed
  `shadow_overrides[CASTER][RECEIVER]`.
- `should_be_above` (`:638`): caster only casts onto receivers with a LOWER
  `layer_order` index. JS already encodes this as `j < i` (array index = z-order),
  which is why `meta.layer_order` must reorder the `strands` array (§6 EDIT 3).
- `part_of_same_visible_mask` (`:644-658`): if caster and receiver are the two
  components of the SAME visible mask, skip the pair. JS = `maskPairs` set.
- **visibility gate** (`:753-754`): if
  `get_shadow_visibility(caster, receiver)` is false → `continue` (no shadow at
  all for this pair). Default (no override key) is true EXCEPT a masked caster onto
  its own first component (`get_default_shadow_visibility`,
  `layer_state_manager.py:697-714`) → false.
- **allow_full_shadow** (`:757`): `shadow_override and
  shadow_override.get('allow_full_shadow', False)`. Gates §mask-blocking (`:781`)
  and §intermediate (`:945`). Does NOT gate `subtracted_layers`.
- **subtracted_layers** (`:758-768`, via `get_subtracted_layers` →
  `_subtract_named_layer_paths`): UNGATED. Subtract `build_rendered_geometry` (or
  mask path) of each named layer from `intersection`. Default for a masked caster's
  second component receiver = `[first_component]`
  (`get_default_subtracted_layers`, `layer_state_manager.py:716-738`).
- **mask-blocking** (`:781-940`, gated by `not allow_full_shadow`): for every
  VISIBLE mask whose `layer_order` index is strictly ABOVE the caster's index
  (`mask_index_sub > self_index`, `:799`) and that is not the receiver itself
  (`:794`), subtract `get_shadow_blocker_path(mask, max_blur_radius)` from the
  current shadow. The blocker (`:1876`, `_get_mask_visual_path` + miter/flat stroke
  widened by `blur_px`) = mask visual path UNION (mask path stroked by `blur_px`
  with MiterJoin/FlatCap). Followed by `_subtract_visible_component_mask_coverage`
  (`:933`, `:119`) which removes shadow under a visible mask drawn above the
  RECEIVER — same blocker geometry, gated on `mask_index > receiving_index`.
- **intermediate-strand subtraction** (`:945-951`, gated by `not
  allow_full_shadow`): subtract `build_rendered_geometry` (or mask path) of every
  layer strictly between caster and receiver indices
  (`_get_intermediate_layer_names`, `:394-403`: `layer_order[min+1 : max]`).
- side-line exclusion (`:954-968`): NO-OP in Qt
  (`get_side_line_exclusion_path` returns an empty path, `:1487-1530`). Do NOT
  port; it changes nothing.
- combine + draw (`:1006-1029`): all surviving per-pair `current_intersection_
  shadow` paths are `addPath`-ed into one `WindingFill` path and filled SOLID at
  alpha 150 (= JS PASS A). The faded blur (PASS B) is the separate downstream
  stroke loop. The JS two-pass structure already matches; we only shrink the
  per-pair `region` before it feeds PASS A and PASS B.

`max_blur_radius = 30.0` everywhere (`:467`), == JS `MAX_BLUR`.

### 1.1 What "mask path" means (caster footprint, receiver geom, blocker, subtractor)

For a `MaskedStrand`, Qt's `get_proper_masked_strand_path` → `get_mask_path()` =
the **intersection of the two component bodies** (deletions applied). JS already
builds exactly this in two places:

- `drawMasked` (`strand-renderer.js:806`) builds `strokeRegion`/`fillRegion` =
  `first@(w+2sw) ∩ second@(w+2sw)` etc.
- `maskComponentPath` (`:712`) strokes one component at a given world width.

So the mask's "mask path" for shadow purposes (caster footprint, blocker base,
subtractor) = `maskComponentPath(first, fw+2fsw) ∩ maskComponentPath(second,
sw+2ssw)` minus deletions. Factor this into a helper `buildMaskPath(ms, byLayer,
P, enableThird, S)` (§4.1) and reuse it for mask-as-caster, mask-blocker, and
mask-as-subtractor so all three agree with `drawMasked`.

---

## 2. Fixture plan (4 fixtures, minimal JSON edits to box_stitch.json)

Base file: `fixtures/box_stitch.json`, history with `current_step == 96`. ALL edits
target the state whose `step == 96` (`state.data`), specifically
`state.data.shadow_overrides['2_3']['1_1']` (raw lines 63976-63986) and, for
Fixture 3, the `is_hidden` flag of the MaskedStrand `1_2_2_3` inside
`state.data.strands`. Leave ALL geometry and every other state untouched. Save each
variant as a NEW file under `fixtures/` so the regression set is unaffected.

Active-state layer order = `['1_1','2_1','1_2','2_2','1_3','2_3','1_2_2_3']`.
Caster `2_3` idx 5, receiver `1_1` idx 0, mask `1_2_2_3` idx 6 (ABOVE caster),
intermediates strictly between idx5 and idx0 = `['2_1','1_2','2_2','1_3']`.

As-is override value: `{"visibility": true, "allow_full_shadow": true,
"subtracted_layers": ["1_2"]}`.

| # | File | Edit | Triggers JS path | Expected effect (Qt-verified) |
|---|------|------|------------------|-------------------------------|
| 1 | `fixtures/box_stitch_maskblock.json` | step-96 `shadow_overrides['2_3']['1_1']['allow_full_shadow'] = false` (keep `visibility:true`, keep `subtracted_layers:['1_2']`) | mask-blocking + intermediate (both un-gate together) + subtracted_layers | 2_3→1_1 shadow shrinks. Δ vs box_stitch as-is = **110px** in bbox x[434..519] y[398..417]. COMBINED effect (see risk). |
| 2 | `fixtures/box_stitch_shadowhidden.json` | step-96 `shadow_overrides['2_3']['1_1']['visibility'] = false` (leave the rest) | visibility gate (pair `continue`) | entire 2_3→1_1 shadow disappears; bodies identical. Δ = **1975px** in bbox x[433..525] y[398..584]. Highest-signal regression for the skip path. |
| 3 | `fixtures/box_stitch_intermediate.json` | step-96 `allow_full_shadow = false` AND set MaskedStrand `1_2_2_3`'s `is_hidden = true` (in `state.data.strands`) | intermediate-subtraction (mask no longer a blocker; only intermediates + subtracted_layers) | isolates intermediate path: 2_3→1_1 shadow loses the `[2_1,1_2,2_2,1_3]` slices. Mask body also stops drawing — verify diff stays inside the shadow bbox. |
| 4 | `fixtures/box_stitch.json` (UNCHANGED) | none | subtracted_layers (UNGATED) + allow_full_shadow skips 2+3 | exercises `subtracted_layers:['1_2']` alone; with the port, box_stitch match must be ≥ current 99.733 (may rise). |

Notes:
- Fixtures 1-3 produce ZERO JS diff until the harness threads `shadow_overrides`
  + `layer_order` AND `castStrandShadow` consumes them. Implement §6 and §4 FIRST,
  then add fixtures, else a "pass" is a false negative.
- Fixture 1's 110px delta is a COMBINED mask-blocking + intermediate effect (the
  single `allow_full_shadow=false` toggle un-gates both). Use Fixture 3 to
  attribute the intermediate-only slice; the mask-blocking-only slice = Fixture 1
  diff minus Fixture 3 diff.
- Fixture 3 risk: a hidden mask also stops drawing its masked body (non-shadow
  pixels change). Confirm the diff bbox stays within the 2_3→1_1 shadow region; if
  the mask body's own crossing pixels move, note it but it does not invalidate the
  intermediate-path verification (the shadow-region delta is what matters).

Run each SERIALLY (never two renders at once):
`node tools/prove.mjs fixtures/box_stitch_maskblock.json box_stitch_maskblock`
(etc.).

---

## 3. Harness change plan (plumbing — do this FIRST)

### EDIT H1 — `tools/reference_render.py` (meta dict, after `:212`)

`shadow_overrides` is already the 8th element of the `load_result` unpack
(`:105-106`) and `apply_loaded_strands` (`:107`) has already populated
`canvas.layer_state_manager.layer_state['order']` and `['shadow_overrides']`. The
meta dict is built and dumped AFTER `image.save(out_png)` (`:186`), so adding
JSON-only fields CANNOT change `reference.png`.

Insert immediately after the existing `"num_strands": len(canvas.strands),` line
(`:212`):

```python
        "num_strands": len(canvas.strands),
        "shadow_overrides": shadow_overrides,
        "layer_order": (
            canvas.layer_state_manager.getOrder()
            if getattr(canvas, "layer_state_manager", None)
            and canvas.layer_state_manager.getOrder()
            else [s.layer_name for s in canvas.strands]
        ),
        "num_steps": 2,
        "shadow_color": (
            {
                "r": canvas.default_shadow_color.red(),
                "g": canvas.default_shadow_color.green(),
                "b": canvas.default_shadow_color.blue(),
                "a": canvas.default_shadow_color.alpha(),
            }
            if getattr(canvas, "default_shadow_color", None) is not None
            else {"r": 0, "g": 0, "b": 0, "a": 150}
        ),
```

- `shadow_overrides` is the existing local (no re-derivation).
- `getOrder()` (`layer_state_manager.py:534`) returns the populated order; fallback
  to `[s.layer_name for s in canvas.strands]` if the manager is absent/empty. Both
  are identical for every fixture (apply_loaded_strands overwrites `['order']` with
  exactly the loaded strands).
- `num_steps`/`shadow_color` are forward-compat metadata; JS keeps its own consts
  unless explicitly switched to meta-driven (NOT in scope; see §6 EDIT 3c).

### EDIT H2 — `tools/js_render.mjs` — NO CHANGE REQUIRED

`js_render.mjs` forwards the WHOLE `meta` object verbatim: it loads the entire
`reference.meta.json` (`:23`) and passes `{ strands, meta }` into
`window.renderFixture(strands, meta)` (`:51-54`). The new meta fields
(`shadow_overrides`, `layer_order`, `num_steps`, `shadow_color`) reach
`renderFixture` automatically. (One optional belt-and-suspenders idea — passing the
state's own `shadow_overrides` from the fixture JSON as a fallback — is NOT needed:
the Qt-emitted `meta.shadow_overrides` is authoritative and identical. Do nothing.)

---

## 4. JS code change plan — `web/strand-renderer.js` (in order)

All edits live in `web/strand-renderer.js`. Implement after §3 so the data is
present. Order matters: helpers first, then `castStrandShadow`, then the main loop.

### EDIT 1 — `renderFixture`: honor `layer_order` + expose `shadow_overrides`

After `byLayer` is built (`:891-892`) and before the `has_circles` loop (`:897`),
reorder `strands` to `meta.layer_order` so the existing `j < i` z-order semantics
match OSS. Guard with `.every(... rank.has ...)` so a partial/missing order falls
back to the incoming array order (current behavior). `strands` is a plain
reassignable param; sort a `.slice()` copy so the caller's array is not mutated.
`byLayer` is keyed by `layer_name` and stays valid.

```js
  if (Array.isArray(meta.layer_order) && meta.layer_order.length) {
    const rank = new Map(meta.layer_order.map((name, idx) => [name, idx]));
    if (strands.every((s) => rank.has(s.layer_name))) {
      strands = strands.slice().sort((a, b) => rank.get(a.layer_name) - rank.get(b.layer_name));
    }
  }
```

Then, near `:902` (before `const shadowEnabled`), stash the override dict module-
scoped so `castStrandShadow` can read it without a new param threading through
unrelated call sites:

```js
  SHADOW_OVERRIDES = meta.shadow_overrides || {};
```

Add a module-level `let SHADOW_OVERRIDES = {};` next to `let SHADOW_ENABLED`
(`:47`). (Module-scoped is consistent with the existing `SHADOW_ENABLED` /
`SHADOW_PAINT` pattern; avoids a signature change to `castStrandShadow`.)

Do NOT touch `SHADOW_COLOR`/`NUM_STEPS` consts (EDIT 3c optional, out of scope):
`meta.shadow_color`/`meta.num_steps` equal the consts for all fixtures, so wiring
them is a no-op and risks masking the hard-coded values `shadowBlurSteps` relies
on (`:477` reads `SHADOW_COLOR.a`).

### EDIT 2 — helper `buildMaskPath` (mask intersection path, shared)

Add near `maskComponentPath` (`:712`). Returns the mask's shadow path = the
component-body intersection minus deletions (= Qt `get_mask_path`). Reused by
mask-as-caster footprint, mask-blocker base, and mask-as-subtractor. Caller removes
the returned path.

```js
function buildMaskPath(ms, byLayer, P, enableThird, S) {
  const parts = (ms.layer_name || '').split('_');
  if (parts.length < 4) return null;
  const first = byLayer[parts[0] + '_' + parts[1]];
  const second = byLayer[parts[2] + '_' + parts[3]];
  if (!first || !second) return null;
  const fw = first.width || 0, fsw = first.stroke_width || 0;
  const sw = second.width || 0, ssw = second.stroke_width || 0;
  const a = maskComponentPath(first, P, enableThird, S, fw + 2 * fsw);
  const b = maskComponentPath(second, P, enableThird, S, sw + 2 * ssw);
  if (!a || !b) { a && a.remove(); b && b.remove(); return null; }
  let region = a.intersect(b);
  a.remove(); b.remove();
  region = subtractDeletions(region, ms, P, S);
  return region && region.area && Math.abs(region.area) > 0.5 ? region : (region && region.remove(), null);
}
```

### EDIT 3 — helper `buildShadowBlockerPath` (mask blocker = base ∪ stroked-by-blur)

Add near `buildMaskPath`. Port of `get_shadow_blocker_path` (`:1876`) +
`_get_mask_visual_path`. Base = mask path; blocker = base ∪ stroke(base, width =
`MAX_BLUR*S`, MiterJoin/FlatCap). Paper's `strokedOutline` uses round/round; for a
blocker (subtracted region) use an explicit stroked outline with miter join + butt
cap to match Qt. Reuse the existing outline-stroking utility but set
`join='miter'`, `cap='butt'`, `width = MAX_BLUR * S` (Qt stroker width is the FULL
width, not half — `setWidth(blur_px)` strokes `blur_px/2` each side, so pass
`MAX_BLUR * S` to a stroker whose `strokeWidth` is the full pen width).

```js
function buildShadowBlockerPath(ms, byLayer, P, enableThird, S) {
  const base = buildMaskPath(ms, byLayer, P, enableThird, S);
  if (!base) return null;
  // Stroke the mask outline by the full blur width (MiterJoin/FlatCap) and union.
  const outline = base.clone();
  outline.fillColor = null;
  outline.strokeWidth = MAX_BLUR * S;     // Qt setWidth(blur_px), full pen width
  outline.strokeJoin = 'miter';
  outline.strokeCap = 'butt';             // FlatCap
  const stroked = cleanOutline(outline.strokeBounds && paperStroke(outline)); // see note
  // Implementation note: build the stroked region via the same mechanism used by
  // strokedOutline()/strokedBodyAtWidth() (which already converts a stroked path
  // into a filled region). Add a width+join+cap-parameterized variant or inline
  // the paper "expand stroke" step. Union base ∪ stroked into the blocker.
  outline.remove();
  if (!stroked) return base;              // degrade to base-only blocker
  const u = base.unite(stroked);
  base.remove(); stroked.remove();
  return u;
}
```

Implementation note (resolve at code time): `strokedOutline(centerline, width)`
(`:121`) already turns a stroked centerline into a filled outline using
round/round. For the blocker we need miter/flat on a CLOSED path (the mask region's
boundary). The cleanest faithful route is to reuse paper's stroke→fill conversion
on a clone of `base` with `strokeWidth = MAX_BLUR*S`, `strokeJoin='miter'`,
`strokeCap='butt'`, then `unite` with `base`. If the existing
`strokedOutline`/`cleanOutline` cannot be parameterized for join/cap, add a small
parameterized variant `strokedRegionOutline(path, widthPx, join, cap)` colocated
with `strokedOutline`. The miter/flat detail is a minor edge effect on a 110px
region; if a faithful miter stroke proves fiddly, a round/round approximation is an
acceptable first cut PROVIDED Fixture 1's diff is verified (note any residual).

### EDIT 4 — `castStrandShadow`: consume overrides, mask-blocking, intermediate, subtracted_layers

`castStrandShadow` (`:501`) signature stays `(s, strands, byLayer, P, enableThird,
S, maskPairs, i)`. It now also needs `layerIndex` (layer_order rank) — but since
`strands` is already reordered to `layer_order` (EDIT 1), the array index `i`/`j`
IS the rank. So no new param; `i` = caster rank, `j` = receiver rank, and
intermediates = `strands[j+1 .. i-1]` by array index. Masks above the caster =
`strands[k]` with `k > i` and `type === 'MaskedStrand'`.

Changes inside `castStrandShadow`, in order:

1. **Caster footprint for a mask caster.** `buildShadowCasterCore` /
   `buildShadowCasterCircles` assume a body strand. When `s.type ===
   'MaskedStrand'`, build the caster footprint from `buildMaskPath(s, byLayer, ...)`
   instead (no circles for masks — Qt `get_proper_masked_strand_path` excludes
   circles). Concretely, at the top of `castStrandShadow`:

   ```js
   let core, circles = null;
   if (s.type === 'MaskedStrand') {
     core = buildMaskPath(s, byLayer, P, enableThird, S);
     if (!core) return;
   } else {
     core = buildShadowCasterCore(s, P, enableThird, S);
     if (!core) return;
     circles = buildShadowCasterCircles(s, strands, P, enableThird, S);
   }
   ```
   `casterFootprint` and `rejectBounds` build the same way (circles null for
   masks). PASS B's `total = combined ∪ circles` already handles `circles == null`.

2. **Per-pair override read** (inside the `for j` loop, after resolving receiver
   `o`, BEFORE building `recv`). Read the override for THIS pair:

   ```js
   const ov = (SHADOW_OVERRIDES[s.layer_name] || {})[o.layer_name] || null;
   // visibility gate (default true; default false only for mask caster onto its
   // own first component — handled by maskPairs/own-component skip below).
   if (ov && ov.visibility === false) continue;
   const allowFull = !!(ov && ov.allow_full_shadow);
   ```
   The default-visibility-false case (masked caster → first component) is naturally
   covered: a mask never casts onto its own components because the own-component
   skip (step 4.2) excludes them. No need to replicate
   `get_default_shadow_visibility` beyond that. (If a future fixture sets an
   explicit `visibility:true` to FORCE a mask onto its first component, that is out
   of corpus scope; document as unsupported.)

3. **Build `region = casterFootprint ∩ recv`** exactly as today. Then, only if
   `region` is a non-empty survivor, apply subtractions to `region` IN THIS ORDER
   (matching Qt `:758` → `:781` → `:945`):

   a. **subtracted_layers (UNGATED).** For each name in
      `ov.subtracted_layers` (or, when no override, the masked-caster default:
      if `s` is a mask and `o` is its second component, `[firstComponent]`),
      subtract that layer's rendered geometry:
      ```js
      const subNames = (ov && ov.subtracted_layers) || defaultSubtracted(s, o, byLayer);
      region = subtractLayers(region, subNames, byLayer, strands, P, enableThird, S);
      ```
   b. **mask-blocking (gated `!allowFull`).** For each `strands[k]` with `k > i`,
      `type === 'MaskedStrand'`, not hidden (`is_hidden !== true`), and `k`'s mask
      is not the receiver itself: subtract `buildShadowBlockerPath(mask, ...)`:
      ```js
      if (!allowFull) {
        for (let k = i + 1; k < strands.length; k++) {
          const m = strands[k];
          if (m.type !== 'MaskedStrand' || m.is_hidden === true) continue;
          if (m.layer_name === o.layer_name) continue;        // self-block guard
          const blk = buildShadowBlockerPath(m, byLayer, P, enableThird, S);
          if (blk) { const r = region.subtract(blk); blk.remove(); region.remove(); region = r; }
          if (!region || Math.abs(region.area || 0) <= 0.5) break;
        }
      }
      ```
      (This also covers `_subtract_visible_component_mask_coverage` for our corpus:
      it uses the SAME blocker geometry; the only difference is the gate is
      `mask_index > receiving_index` instead of `> caster_index`. Since our single
      mask is above BOTH caster and receiver, the caster-index loop already removes
      it. Note this simplification; if a fixture needs a mask between receiver and
      caster only, add the receiver-index variant.)
   c. **intermediate subtraction (gated `!allowFull`).** Subtract every
      `strands[m]` with `j < m < i` (strictly between receiver rank `j` and caster
      rank `i`), using its rendered geometry (mask path if it is a mask):
      ```js
      if (!allowFull && region && Math.abs(region.area || 0) > 0.5) {
        const interNames = [];
        for (let m = j + 1; m < i; m++) interNames.push(strands[m].layer_name);
        region = subtractLayers(region, interNames, byLayer, strands, P, enableThird, S);
      }
      ```

4. After subtractions, the existing survivor test (`region.area > 0.5`) decides
   whether `region` accumulates into `combined` and `recv` into `clip` — UNCHANGED.
   If subtraction emptied `region`, treat it as a non-survivor (remove `region` and
   `recv`, like today's else branch). PASS A and PASS B downstream are byte-
   identical.

### EDIT 5 — helper `subtractLayers` + `defaultSubtracted`

Colocate with `castStrandShadow`. Faithful port of `_subtract_named_layer_paths`
(`:406`, skipping hidden strands) and `get_default_subtracted_layers`.

```js
// Subtract the rendered geometry of each named layer from `region`. Masks use
// their mask path; hidden strands are skipped. Returns the (possibly empty/null)
// region; caller owns it.
function subtractLayers(region, names, byLayer, strands, P, enableThird, S) {
  if (!region || !names || !names.length) return region;
  for (const name of names) {
    const t = byLayer[name];
    if (!t || t.is_hidden === true) continue;
    const geom = t.type === 'MaskedStrand'
      ? buildMaskPath(t, byLayer, P, enableThird, S)
      : buildShadowReceiverGeom(t, strands, P, enableThird, S);
    if (!geom) continue;
    const r = region.subtract(geom);
    geom.remove();
    region.remove();
    region = r;
    if (!region || Math.abs(region.area || 0) <= 0.5) break;
  }
  return region;
}

// Qt get_default_subtracted_layers: a mask caster's SECOND component receiver
// defaults to subtracting the FIRST component.
function defaultSubtracted(s, o, byLayer) {
  if (s.type !== 'MaskedStrand') return [];
  const parts = (s.layer_name || '').split('_');
  if (parts.length < 4) return [];
  const firstName = parts[0] + '_' + parts[1];
  const secondName = parts[2] + '_' + parts[3];
  return o.layer_name === secondName ? [firstName] : [];
}
```

Note: `subtractLayers` uses `buildShadowReceiverGeom` (the receiver footprint =
body @ (w+2sw) ∪ visible circles), which equals Qt `build_rendered_geometry`. This
keeps the subtractor geometry identical to a receiver's geometry, as Qt does.

### EDIT 6 — main loop: route mask casters through `castStrandShadow`

`renderFixture` main loop (`:924-930`) currently does
`if (s.type === 'MaskedStrand') { drawMasked(...); continue; }` BEFORE the
`castStrandShadow` call, so masks never cast. Change to: a mask FIRST casts its
crossing shadow onto lower strands (when shadows on), THEN draws its mask body:

```js
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    if (s.type === 'MaskedStrand') {
      if (shadowEnabled) castStrandShadow(s, strands, byLayer, P, enableThird, S, maskPairs, i);
      drawMasked(s, byLayer, P, enableThird, S);
      continue;
    }
    if (shadowEnabled) castStrandShadow(s, strands, byLayer, P, enableThird, S, maskPairs, i);
    drawStrand(s, strands, P, enableThird, S);
  }
```

The receiver loop inside `castStrandShadow` already (a) skips MaskedStrand
receivers and (b) skips `maskPairs` (the mask's own two components). So a mask
caster only casts onto OTHER lower non-mask strands — exactly the new behavior
required. `drawMasked` still owns the mask's own crossing shadow via
`drawMaskShadow` (unchanged). NO double-count: the mask's own-component crossing is
handled by `drawMasked`/`drawMaskShadow`; casting onto unrelated lower strands is
`castStrandShadow`.

IMPORTANT ordering subtlety: in box_stitch the only mask `1_2_2_3` is at idx 6
(top), so when it casts there are no higher masks to block it and the intermediate
strands below it are subtracted only if a future fixture turns a mask into a
mid-stack caster. For box_stitch's mask caster, verify it does not introduce a new
shadow that regresses the 99.733 baseline — if the mask-as-caster introduces an
unexpected shadow over a lower strand that Qt also draws, good; if Qt does NOT draw
it (because of the masked-caster default visibility=false onto its first
component), the own-component skip + default-subtracted must suppress it. Validate
against the oracle (the oracle already renders the mask-as-caster correctly).

---

## 5. Verification plan (SERIAL — never two renders at once)

After §3 + §4, run in order and record match %:

1. Regression guard (must hold):
   - `node tools/prove.mjs fixtures/single_strand.json single_strand` → 100.000
   - `node tools/prove.mjs fixtures/three_strand_braid.json three_strand_braid` → 99.860
   - `node tools/prove.mjs fixtures/closed_knot.json closed_knot` → 100.000
   - `node tools/prove.mjs fixtures/overhand_knot.json overhand_knot` → ~98.809
   - `node tools/prove.mjs fixtures/box_stitch.json box_stitch` → ≥ 99.733 (Fixture 4; subtracted_layers now applied — may rise)
2. New fixtures (create per §2 first):
   - `node tools/prove.mjs fixtures/box_stitch_shadowhidden.json box_stitch_shadowhidden` → expect the 2_3→1_1 shadow GONE; high match to oracle (the oracle also hides it). Primary high-signal test.
   - `node tools/prove.mjs fixtures/box_stitch_maskblock.json box_stitch_maskblock` → expect the shrunk shadow to match the oracle in bbox x[434..519] y[398..417].
   - `node tools/prove.mjs fixtures/box_stitch_intermediate.json box_stitch_intermediate` → expect intermediate-only subtraction to match the oracle; diff confined to the shadow region.

If a new fixture does NOT match: diff the JS vs reference PNG, confirm the bbox
matches the Qt-verified bbox, and check the subtraction order (subtracted_layers →
mask-block → intermediate) and the mask blocker stroke (miter/flat vs round/round).

---

## 6. Risk register

- **Combined effect (Fixture 1).** `allow_full_shadow=false` un-gates BOTH
  mask-blocking AND intermediate; the 110px delta is combined. Attribute via
  Fixture 3 (intermediate-only). Cannot isolate with one boolean.
- **Hidden-mask side effect (Fixture 3).** `is_hidden=true` also stops the mask
  body drawing; verify the diff stays inside the 2_3→1_1 shadow bbox.
- **Small signal.** The 2_3→1_1 shadow is small (110px mask-block delta) and the
  existing ~0.267% box_stitch gap clusters at central crossings; a port bug could
  hide in stroker residual. Use Fixture 2 (1975px) as the primary regression for
  the skip path.
- **Blocker stroke fidelity.** Qt blocker = base ∪ miter/flat stroke by `blur_px`.
  Paper's helpers default round/round. Use a miter/flat stroke variant; if not
  feasible immediately, a round/round approximation is acceptable as a first cut
  with the residual noted — it only affects the blocker fringe on a small region.
- **Mask-as-caster default visibility.** Qt's `get_default_shadow_visibility`
  returns false for a masked caster onto its FIRST component. The port relies on
  the own-component skip (`maskPairs` / a mask never casts onto its own components)
  to suppress that case rather than re-implementing the default. Confirm box_stitch
  does not gain a spurious mask→first-component shadow.
- **layer_order reorder guard.** `strands.every(rank.has(...))` is REQUIRED: a
  partial order (missing a `layer_name`, e.g. a mask name absent) yields NaN
  compares and garbage order. Falls back to incoming array order (safe). Confirm
  every mask `layer_name` is present in `meta.layer_order` (apply_loaded_strands
  builds order from ALL strands incl. masks).
- **Do NOT regress shadow-OFF / single-strand.** The new subtractions only run for
  pairs with an override or a qualifying mask/intermediate AND only with shadows
  on. Empty-override fixtures take the exact current path. Re-run the regression
  set after every change.
- **Param reassignment.** EDIT 1 reassigns `strands` (a plain param) and sorts a
  `.slice()`; the caller's array is untouched. If a refactor makes `strands`
  `const`, switch to a separate `ordered` local used throughout the loop.
