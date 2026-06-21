# OpenStrandJS — status & next steps

Fidelity-first JS/Canvas port of OpenStrand Studio. The Qt app
(`../OpenStrandStudio`) is the spec; its headless render is the pixel oracle.

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
