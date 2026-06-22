# OpenStrandJS — fidelity push to ~99% exact

The interactive editor (Phases 1–6) is COMPLETE (`CONTINUATION.md`). This doc is
the spec for the NEXT effort: make the **renderer** match the Qt original ~99%
exact by porting the decorations that the current renderer skips. The Qt app
`../OpenStrandStudio` is the spec; its headless render is the pixel oracle.

Current parity (pixelmatch, AA-ignored, vs Qt): single_strand 99.68%,
three_strand_braid 97.85%, overhand_knot 98.10%, closed_knot 98.80%. The residual
is almost entirely the items below — they exist in Qt's output but the JS renderer
(`web/strand-renderer.js`) doesn't draw them yet.

## Gap inventory (priority order) with exact Qt source refs

1. **Connection caps / semi-circles** (`has_circles`) — the C-shape / elliptical
   ring drawn at a strand end where another strand attaches. THE biggest gap;
   visible at the closed_knot closure.
   - `strand.py`: `_partner_cap_dims` (292), `_make_cap_ellipse` (339),
     `_make_cap_inner` (~370), `_unfolded_start_cap_dims`, `_folded_start_cap_dims`,
     `_attached_child_cap_dims`, `_cap_shadow_path`, `_rotated_ellipse`,
     `_should_scale_cap_depth_by_angle`, `_is_start_unfolded`,
     `_junction_tangent_angle`/`_junction_connection_angle_rad`.
   - Used in `draw` (2155) and `_draw_direct` (2893): cap blocks ~2522–2626 and
     ~3251–3350 — `outer = _make_cap_ellipse(...)`, `inner = _make_cap_inner(...)`;
     the cap = outer − inner, drawn at start (side 0) / end (side 1), gated by
     `has_circles[side]`. Stroke color = `circle_stroke_color` /
     `start_circle_stroke_color` / `end_circle_stroke_color` (alpha 0 = unfolded).
   - Masked: `masked_strand.py::_elliptical_caps_path`. Cap shadows:
     `_cap_shadow_path` + shader_utils (recent desktop commits dfe628080,
     b054ac8a8 — elliptical cap shadow receiver clipping).
   - The JS model already carries `has_circles`, `circle_stroke_color`,
     `start/end_circle_stroke_color` (the last two ride the `extra` bag).

2. **Control-point rendering** (`show_control_points`) — Qt draws the triangle
   (cp1), circle (cp2), and third-cp (center) on the canvas itself.
   - `strand_drawing_canvas.py`: `draw_control_points` (5929),
     `_draw_control_points_supersampled` (5879), called at 2196–2197.
   - NOTE: the fixtures render with `show_control_points` OFF, so this does NOT
     affect the pixel-diff numbers — it's an EDITOR-EXPERIENCE match (make the
     editor's overlay handles look like OSS's). The editor currently draws its own
     overlay handles (`src/overlay/overlayRenderer.ts`); port the OSS style there.

3. **Stroked-outline band** (~1px) — Qt `QPainterPathStroker.createStroke` vs the
   JS sampled ±width/2 offset. Improve sampling density / round-join handling at
   caps in `strokedOutline`/`strokedBodyAtWidth` (`web/strand-renderer.js`).

4. **Bias control** — the renderer hardcodes bias 0.5; port
   `curvature_bias_control.py` so triangle/circle bias affect the curve
   (`strand.py::_build_curve_profile` uses `bias_control.triangle_bias/circle_bias`).
   The JS `buildProfile` already has bias params wired (currently 0.5).

5. **Arrows / side lines / extensions / dashed** — only when a fixture exercises
   them (the corpus doesn't yet — make new fixtures). `strand.py`:
   `get_arrow_path`/`draw_arrow_shaft_with_pattern`/`apply_arrow_texture_brush`/
   `get_arrow_shadow_path`; `update_side_line`; `start/end_extension_visible`.

## How to measure (the harness)

- Fixtures in `fixtures/*.json`. Per-fixture Qt reference + meta in
  `artifacts/<name>/reference.png` + `reference.meta.json`.
- Regenerate a reference (Qt, ~10s): `npm run reference -- fixtures/<f>.json
  artifacts/<name>/reference.png artifacts/<name>/reference.meta.json`
  (uses `../OpenStrandStudio/src/build_env/Scripts/python.exe`).
- **Playwright harness (`js_render.mjs` + `diff.mjs` + `prove.mjs`) HANGS in this
  environment** (chromium.launch never returns; `networkidle` never fires vs Vite).
  Two ways forward: (a) fix/replace the Playwright launch, or (b) measure
  IN-BROWSER: in the editor dev tab, `window.extractStrands(fixtureJson)` +
  `window.renderFixture(strands, referenceMeta)` (the reference meta — NOT the
  editor view — so geometry matches), then pixel-compare `#c` to `reference.png`
  with an in-browser pixelmatch. `renderFixture` is synchronous, so no rAF/tab
  issues. As caps are added, the fixture match% must RISE toward 100.
- `web/viewer.html` (`npm run view`) shows live | Qt-ref | diff side by side.

## Suggested plan / workflow

Each item: port the Qt method into `web/strand-renderer.js` (keep it the single
pixel oracle), then verify the affected fixture's match% improves and the others
don't regress. Caps first (closed_knot/knots), then bias, then the outline band,
then control-point styling in the editor overlay, then new fixtures for arrows.

A good workflow shape: (1) one agent re-measures all fixtures and reports current
match% (establish baseline via the in-browser harness), (2) a coherent author
ports caps + verifies fixture-by-fixture, (3) an adversarial pixel-diff agent
confirms no regressions, (4) repeat per gap. Caps + bias are coupled to the
verified renderer, so keep them single-author; control-point styling and new
fixtures parallelize.

## Repo facts the new session needs

- Editor: `npm install` then `npm run dev` (http://localhost:5173). Renderer:
  `web/strand-renderer.js` (only edits so far: `hidpi="off"`, additive
  `S = ss*zoom`). Editor src under `src/`; dev globals `window.__store/__io/__hit/
  __actions/__exportMeta`.
- Gotchas: NO `confirm()`/`alert()` in UI (blocks automation); MCP screenshots
  scale non-uniformly (target pointer events by transform-computed client coords);
  `renderFixture` is synchronous (call it directly to dodge bg-tab rAF throttling).
- The Python desktop app (`main.py`) must stay UNTOUCHED.
