# Next session — start here

**Read this file, then begin the task below.** This is the auto-start handoff: when you
open a fresh session in this repo, do the task in "The task" verbatim.

## The task — renderer follow-ups (the overlay port is DONE)

The editor overlay port is complete and verified (see "Overlay overlay port — DONE"
below). Pick up the **optional renderer follow-ups** at the bottom of this file:
chase the overhand_knot 1.4% soft-shadow residual and re-confirm the braid 0.14% is
true AA. Use the headless harness: `node tools/js_render.mjs fixtures/<f>.json
artifacts/<f>` then `node tools/diff.mjs artifacts/<f>` (run serially). Live editor:
`npm run dev` (http://localhost:5173). Side-by-side fixture viewer: `npm run view`. Do
NOT touch the Python `main.py`.

## Overlay port — DONE (2026-06-22)

`src/overlay/overlayRenderer.ts` was rewritten to match OpenStrand Studio (spec:
`OVERLAY_UI_SPEC.md`). Implemented and pixel-verified live (sampling the `#overlay`
canvas via `getContext('2d').getImageData`):
- **CP glyphs** drawn for all visible strands when `doc.show_control_points`: cp1 =
  upward triangle (vertex radius `control_point_radius·1.06`, y-offset +1.06), cp2 =
  circle (R = `control_point_radius` = 14.663px), center = square — each three-layer:
  black 5px outline → green `rgb(0,128,0)` fill (R−1) → strand-color core (0.5 scale).
  Triangle always; circle when curve shaped (`control_point2_shown || cp2 off-ends`);
  square only when `control_point_center_locked` (matches `strandHandles` grabbability).
- **Green dashed connectors** (`[4,3]`, 1px, green) when shaped: start→cp1, end/start→cp2,
  and center→cp1/cp2 when the center is locked.
- **Move mode**: per `strandHandles`, 120px endpoint squares (idle red `255,0,0,38`,
  hover/moving yellow `255,230,160,70`) + 50px CP squares (idle green `0,100,0,38`,
  hover/moving yellow), black 2px borders.
- **Attach mode**: 120px circles at free endpoints — start red `255,0,0,60`, end blue
  `0,0,255,60`, hover/affected yellow `255,230,160,140`; + translucent body preview.
  Added idle-hover detection to `src/modes/AttachMode.ts` so circles light up.
- **Selection ring**: red band hugging the selected body via a wide red stroke with the
  interior punched out (`destination-out`), revealing the strand on `#c` (so the body
  isn't tinted). Shown in select/move modes.
- All spec px constants are in canvas/world units; the overlay multiplies each by
  `view.zoom` (pinned to 1.0). At zoom 1 / pan 0 the `#overlay` backing store is 1:1 with
  world coords — handy for pixel-sampling verification.
- `CanvasStage.tsx` now passes `mode` + `dragging` into the overlay state. Typecheck
  (`npm run build` = `tsc`) is clean; no console errors.

Follow-up fixes (same session):
- **cp1 is now always grabbable** (`hitTest.ts::strandHandles`): the triangle handle
  is returned even when it sits on the start, so you can begin shaping a fresh strand.
  Its 25px grab area nests inside the 60px endpoint area (radii bumped 26/40 → 25/60 to
  match OSS 50/120), so a dead-center click grabs cp1 and an off-center click grabs the
  endpoint. `moveHandle` already flips `triangle_has_moved` + `control_point2_shown` on
  the first cp1 move (revealing cp2). Mirrors `move_mode.py:2041,2049`.
- **Selection highlight moved into the renderer** (`web/strand-renderer.js::drawHighlight`)
  and drawn UNDER the body — a faithful port of `strand.py::_draw_unified_highlight` /
  `attached_strand.py:542`. OSS paints the highlight first (strand.py:2483) then the body
  fill+stroke on top (:2485+), so the black stroke stays visible and the red is only an
  outer halo + protruding flat-end side-line bars + C-shape rings. The earlier overlay
  approach painted OVER the stroke (covering it); that whole overlay highlight (and its
  destination-out hack) was removed. Gated on per-strand `is_selected`.
  - Wiring: `toRenderArray(doc, selectedLayer)` sets `is_selected`; `renderScheduler`
    passes `selection.layerName`; Select/Move modes call `requestRender` (not just
    `requestOverlay`) on selection so #c redraws; the drag fast-path (`_dragPaint`) routes
    the moving strand through `drawStrand` so the highlight tracks live during a drag.
  - **Pixel-diffable now**: `reference_render.py` honors a per-strand `"is_selected": true`
    in a fixture (sets `strand.is_selected` so OSS draws its highlight). Three fixtures —
    `hl_single`, `hl_attach_parent`, `hl_attach_child` — all diff **100.00%** vs OSS
    (`node tools/js_render.mjs fixtures/<f>.json artifacts/<f>` then `node tools/diff.mjs`).
    Added to the `npm run view` dropdown under "HIGHLIGHT —".

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
