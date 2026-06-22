# Next session — start here

**Read this file, then `OVERLAY_UI_SPEC.md`, then begin the task below.** This is the
auto-start handoff: when you open a fresh session in this repo, do the task in
"The task" verbatim.

## The task — port the editor overlay to match OpenStrand Studio

Port the OpenStrandJS editor overlay (control points + endpoints + selection/move/attach
handles) to match OpenStrand Studio exactly. The full source-extracted spec is committed at
`OVERLAY_UI_SPEC.md` (read it first — it has exact glyph shapes, radii, colors, z-order,
gating, plus a constants table and 18 open questions). The Qt app `../OpenStrandStudio/src`
is the spec; key files: `strand_drawing_canvas.py` (`draw_control_points` ~5929,
`_draw_control_points_supersampled` ~5879), `strand.py` (`_draw_unified_highlight`,
`draw_selection_path` ~568), `move_mode.py`, `attach_mode.py`.

Implement in the editor overlay renderer `src/overlay/overlayRenderer.ts` (134 lines; it
currently draws its own handles). Match: cp1 = upward triangle (vertex radius ≈
control_point_radius·1.06), cp2 = circle (radius = control_point_radius ≈ 14.66px), center =
square — each as black-outlined / green-fill / strand-color-core; the dashed green connector
lines; the move-mode 120px endpoint squares & 50px control-point squares with per-state
colors; the attach-mode 120px endpoint circles + preview. Note the canvas units vs the
editor's zoom/DPI — convert the spec's px constants into the overlay's coordinate space.

The renderer pixel oracle (`web/strand-renderer.js`) draws with `show_control_points` OFF,
so these handles are an editor-experience match, not a pixel-diff number — verify visually.
The headless harness works: `node tools/js_render.mjs fixtures/<f>.json artifacts/<f>` then
`node tools/diff.mjs artifacts/<f>` (run serially). Live editor: `npm run dev`
(http://localhost:5173). Side-by-side fixture viewer: `npm run view` (auto-opens; serves at
`/` → `/web/viewer.html`). Do NOT touch the Python `main.py`. Resolve the 18 open questions
in `OVERLAY_UI_SPEC.md` against the source as you go.

## Current status (what's already done)

The **renderer** (`web/strand-renderer.js`) is a faithful port of strand + attached-strand
drawing and is pixel-exact on the strand cases:
- single_strand **100%**, fresh_strand (studio-created 1_1) **100%**, 1_1+1_2 attached at 90°
  (`attached_90`) **100%**, closed_knot **100%**, three_strand_braid 99.86%,
  overhand_knot 98.56% (residual = soft-shadow shader only).
- Implemented: two-layer body (stroke@w+2sw / fill@w), end caps, side lines, `has_circles`
  recompute (the OSS load-time rule), faithful two-region MaskedStrand, box-average downscale.

The **editor** uses the same renderer via `src/renderer/rendererBridge.ts` → `renderFixture`.
The editor→renderer adapter is `src/renderer/toRenderArray.ts`; the model lives in the store
(`src/store/`, factory `src/model/factory.ts`). Dev globals on the running editor:
`window.__store` (zustand; `.getState()`), `window.__actions` (raw `(draft, …)` fns applied via
`store.mutateDoc(d => __actions.fn(d, …))`), `window.__io` (`loadProject`/`serializeProject`).
Example to build a scene headlessly:
`__store.getState().mutateDoc(d => __actions.addNewStrand(d, {x:600,y:600}, {x:1200,y:600}))`.

## Gotchas

- **`toRenderArray` only forwards a subset of fields.** Side-line/cap flags
  (`start_line_visible`, `end_line_visible`, `closed_connections`, `manual_circle_visibility`,
  circle stroke colors) live in the model's `extra` bag and are now forwarded — but AUDIT for
  any other field the renderer reads that isn't surfaced (this caused the editor to skip
  flat-end side lines until fixed).
- **Stale vite instances**: `npm run dev` falls back to 5174/5175 if 5173 is held by an old
  session — kill stragglers so you (and the user) aren't viewing pre-fix code. Hard-reload the
  tab after edits.
- **Harness**: run js_render/diff strictly serially (two concurrent Chromium launches hang).
  `mxn_lh_1x1` is a broken fixture (incompatible `attached_to` format) — ignore it.
- **MCP screenshot zoom coordinates scale non-uniformly** — prefer pixel sampling
  (`canvas#c.getContext('2d').getImageData`) or Node crops over the `zoom` action.
- Do NOT touch the Python `main.py`. `artifacts/` is gitignored (regenerate references with
  `npm run reference -- fixtures/<f>.json artifacts/<f>/reference.png artifacts/<f>/reference.meta.json`).

## Optional renderer follow-ups (separate from the overlay task)

- overhand_knot's 1.4% residual = soft-shadow shader (`shader_utils.py`), not strand geometry.
- braid's 0.14% = curved-edge rasterizer AA — re-verify it's truly AA, not another real bug
  (single_strand looked like "AA floor" but was actually a missing side line).
