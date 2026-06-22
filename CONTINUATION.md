# OpenStrandJS — status & next steps

Fidelity-first JS/Canvas port of OpenStrand Studio. The Qt app
(`../OpenStrandStudio`) is the spec; its headless render is the pixel oracle.

## Interactive editor — Phases 1–6 **COMPLETE** (TS + React + Vite + Zustand)

Architecture and roadmap in `EDITOR_PLAN.md`. The editor reuses the verified
`web/strand-renderer.js` UNCHANGED (one harness-safe fix: `hidpi="off"` on the
offscreen canvas so paper.js doesn't double-apply devicePixelRatio at DPR != 1).

**Run it:**
```
npm install      # first time (adds react, vite, zustand)
npm run dev      # Vite dev server, opens http://localhost:5173
```
Toolbar: mode buttons (select / move / attach / mask), shadows toggle, sample
fixtures, Load…, Save. Pan = middle/right-drag or space+drag or wheel.

**What works (all verified in a real browser + deterministic pointer-event tests):**
- Load a real OpenStrandStudio `.json` (bare or `OpenStrandStudioHistory` wrapper)
  and render it pixel-faithfully; live shadow toggle.
- Select (click body/handle); Move endpoints (attached strands follow rigidly via
  the weld graph) and control points (curve reshapes live).
- Draw a new strand (45-degree locked first-of-set) and attach a child from a free
  endpoint (lowest-free layer_name, parent endpoint marked occupied).
- Two-click over/under mask -> `MaskedStrand` "a_b_c_d" appended on top.
- **Save** -> authentic JSON. Round-trip is field-identical + idempotent for all
  fixtures, and the real Qt loader renders an editor-saved file PIXEL-IDENTICAL to
  the original (overhand_knot: 0 diff pixels). Editor saves re-open in `main.py`.

**Editor source layout** (`src/`): `model/` (types, factory, layerName),
`store/` (editorStore, actions), `renderer/` (rendererBridge, toRenderArray,
renderScheduler), `interaction/` (viewTransform, InteractionHost, hitTest,
hitGeometry, connections), `modes/` (Select/Move/Attach/Mask), `overlay/`, `io/`
(saveLoad, fileDialog), `ui/` (App/CanvasStage/Toolbar).

**Editor gotchas:** the render uses `requestAnimationFrame` (throttled in a
backgrounded tab — headless probes must foreground or check store state, which
mutates synchronously). MCP screenshots are scaled NON-uniformly vs the real
client, so target pointer events by transform-computed client coords, not by
eyeballing screenshots. Dev-only `window.__store` / `__io` debug handles exist.

**Phase 2 DONE** (commits 15d471b, 552a10a): faithful control-point move
(`update_end` rule: a cp follows its endpoint only when coincident; center =
cp midpoint unless pinned), cp2 passive→active state machine
(triangle_has_moved / control_point2_shown / control_point2_activated), grab
cursor on handle hover, and the mask-edit eraser (drag inside a mask's overlap
to add a deletion rectangle; "Reset mask" clears them).

**Phase 3 DONE** (133f721): layer panel — reversed list, click-to-select (two-way
sync), DnD z-order reorder, per-row hide/lock/delete (delete cascades attached
descendants + masks), Add / Deselect / Delete All.

**Phase 4 DONE** (990031c): StrandProperties panel — fill/stroke RGBA picker
(ColorField = native color input + alpha slider), width/stroke sliders, "apply to
whole set" propagation (by set_number), shadow_only; masked rows get Reset mask.
(Arrow/line/extension/circle toggles deferred — renderer doesn't draw them yet.)

**Phase 5 DONE** (2ccbe0b): undo/redo — snapshot history (past/future/gestureBase),
`areVisuallyEqual` dedup (no-op gestures create no step), one gesture = one step,
Z/X + Ctrl variants + Toolbar buttons; `shadow_enabled`/`show_control_points`
excluded from dedup and carried across undo, `shadow_overrides` undoable.

**Phase 6 DONE**: 6a full zoom/pan (85e96ca — the one additive renderer edit
`S = ss*zoom`, wheel zoom-about-cursor; fixtures pixel-identical at zoom 1), 6b
PNG export (8dc87f6 — content-fit render → toDataURL → download), 6c rotate/angle
(c5869fa — Angle/Length editor, end rotates around start length-preserved via
moveHandle), 6d settings/i18n/grid/persistence (4dfd169 — settings dialog, theme,
6-language i18n + Hebrew RTL, grid, localStorage), 6e multi-tab (42ba575), 6f
groups (302dd52 — create-from-set + translate as a unit).

**THE EDITOR IS COMPLETE.** Every slice was verified deterministically in a real
browser and committed. Explicitly deferred (low-value / out of corpus scope):
- Renderer decorations not exercised by the fixtures: **end caps** (circle/
  elliptical `_make_cap_*` / `has_circles`), **arrows**, **side lines**,
  **extensions**, **bias control**. These are the known ~1–3% fidelity residual.
- Editor: per-layer arrow/line/extension toggles (no renderer effect yet), group
  rotate + drag-the-group-on-canvas (nudge buttons cover translation), angle
  dialog as a separate modal (inline in StrandProperties instead).

---

## Current fidelity (pixelmatch, AA-ignored, vs Qt @ 2x supersample)

| fixture | match | notes |
|---|---|---|
| `single_strand` | **99.68%** | one curved strand; residual is the ~1px stroked-outline band |
| `three_strand_braid` | **97.85%** | 18 strands + 3 masks; clean over-under, correct curves; shadows off |
| `overhand_knot` | **98.10%** | masking + crossing shadows; residual is the outline band |
| `closed_knot` | **98.80%** | 4 strands, no masks; residual is junction/closure caps + outline band |

Shadows are ported (`draw_strand_shadow` + `draw_mask_strand_shadow`), gated on
`meta.shadow_enabled` (per-fixture). The remaining gaps are now (1) the ~1px
stroked-outline band on every strand and (2) junction caps where strand segments
join (`has_circles`), visible at the closed_knot closure point.

## How the harness works

```
# reference (Qt, slow ~10s, only needed when a fixture/meta changes):
../OpenStrandStudio/src/build_env/Scripts/python.exe tools/reference_render.py <fixture.json> artifacts/<name>/reference.png artifacts/<name>/reference.meta.json
# JS render + diff (fast; the reference is fixed, so loop on just these):
node tools/js_render.mjs <fixture.json> artifacts/<name>
node tools/diff.mjs artifacts/<name>      # prints JSON {match_pct, mismatch_pixels, ...}, writes diff.png
```

Notes / gotchas (also in memory `openstrandjs-port.md`):
- Use `src/build_env`'s Python (the repo `.venv` is broken — built on another machine).
- `js_render` calls `process.exit(0)` (Playwright otherwise hangs after screenshot).
- Background-command stdout often doesn't flush to the task file — redirect to a file and read it, or run foreground.
- Renderer lives entirely in `web/render.html`. `reference_render.py` exports
  `meta.curve_params` and `meta.supersample`; the JS reads them.

## Prioritized next steps

1. **Shadows** (biggest remaining visual gap; the soft gray under-strand shading
   at crossings). Port `shader_utils.py::draw_strand_shadow` and
   `draw_mask_strand_shadow` (multi-step blurred offset of the stroked path,
   clipped to the under-strand). This is most of the knot/braid residual.
2. **Stroked-outline accuracy** (the ~1px band on every strand). The sampled
   ±width/2 offset diverges slightly from Qt's `QPainterPathStroker`. Options:
   higher sampling, round-join handling at the caps, or a proper offset.
3. **Concave-fold spike** on tight S-curves (cosmetic; masking already robust via
   `resolveCrossings`). Consider union-of-trapezoids if it matters.
4. **More fixtures**: `closed_knot.json`, `box_stitch.json`,
   `Interwoven_double_closed_knot.json` (in `../OpenStrandStudio/src/samples`) to
   stress masking generality and find new cases.
5. **End circles / attachment caps**: `has_circles` C-shapes + elliptical caps
   (`strand.py` ~2078-2150, `masked_strand.py::_elliptical_caps_path`) — only
   drawn under attachment/closed-connection conditions.
6. Eventually: the editing UI (React) around the proven renderer.

## What is intentionally NOT done yet

Arrows, extensions, dashed lines, hidden-state, selection highlights, grid,
zoom/pan — none are exercised by these static fixtures. Add when a fixture needs them.
