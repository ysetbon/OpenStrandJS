# OpenStrand Studio — endpoint & control-point UI spec

Source: `../OpenStrandStudio/src`. Extracted to port the OpenStrandJS editor overlay so its handles/markers match the Qt app exactly. Each section cites file:line.

## Constants quick-reference

| name | value | source |
|---|---|---|
| control_point_radius (master glyph size) | 11 * 1.333 = 14.663 px | src/strand_drawing_canvas.py:5962 |
| stroke_color (outer outline color) | QColor('black') | src/strand_drawing_canvas.py:5964 |
| stroke_pen (outer outline) | QPen(black, width 5) | src/strand_drawing_canvas.py:6284 |
| control_point_pen (green fill border) | QPen(green, width 1) | src/strand_drawing_canvas.py:6285 |
| control line/connector pen | QPen(green, width 1, Qt.DashLine) | src/strand_drawing_canvas.py:5877 |
| glyph green fill color | QColor('green') | src/strand_drawing_canvas.py:6286 |
| glyph inner core color | strand.color (strand's own color) | src/strand_drawing_canvas.py:6301 |
| cp2 circle outer radius | control_point_radius = 14.663 px | src/strand_drawing_canvas.py:6293 |
| cp2 circle green-fill radius | control_point_radius - 1 = 13.663 px | src/strand_drawing_canvas.py:6297 |
| cp2 circle inner-core radius | (control_point_radius - 1) * 0.5 = 6.83 px | src/strand_drawing_canvas.py:6299 |
| cp1 triangle vertex radius | control_point_radius * 1.06 = 15.54 px | src/strand_drawing_canvas.py:6314 |
| cp1 triangle vertex angles | 270 deg, 30 deg, 150 deg (apex up) | src/strand_drawing_canvas.py:6312,6317,6322 |
| cp1 triangle center y offset (normal branch) | control_point1.y() + 1.06 | src/strand_drawing_canvas.py:6309 |
| cp1 triangle center y offset (affected branch) | control_point1.y() + 1.06 * 1.333 = +1.41 | src/strand_drawing_canvas.py:6125 |
| cp1 triangle green-fill scale_factor | (control_point_radius - 1.06)/(control_point_radius*1.06) = 0.8752 | src/strand_drawing_canvas.py:6339 |
| cp1 triangle inner-core scale | 0.5 of green fill, about center | src/strand_drawing_canvas.py:6353 |
| center square size (outer) | control_point_radius * 2 * 0.7 = 20.528 px | src/strand_drawing_canvas.py:6363 |
| center square top-left offset (outer) | control_point_radius * 0.7 = 10.264 px | src/strand_drawing_canvas.py:6365 |
| center square green-fill size | square_size - 2 = 18.528 px | src/strand_drawing_canvas.py:6375 |
| center square green-fill top-left offset | (control_point_radius*0.7) - 1 = 9.264 px | src/strand_drawing_canvas.py:6377 |
| center square inner-core size | inner_size * 0.5 = 9.264 px | src/strand_drawing_canvas.py:6384 |
| show_control_points default | True | src/strand_drawing_canvas.py:163 |
| show_cp_selected_only default | False | src/strand_drawing_canvas.py:165 |
| view_hide_control_points default | False | src/strand_drawing_canvas.py:168 |
| use_supersampling default | True | src/strand_drawing_canvas.py:68 |
| supersampling_factor default | 2 (4x pixels) | src/strand_drawing_canvas.py:69 |
| supersample buffer format | QImage.Format_ARGB32_Premultiplied, filled transparent | src/strand_drawing_canvas.py:5882-5883 |
| enable_third_control_point default | False (canvas property) | src/strand_drawing_canvas.py:6404-6405 |
| triangle_has_moved default | False (per strand) | src/strand.py:71 |
| control_point_center_locked default | False (per strand) | src/strand.py:68 |
| control_point2_activated default | False (per strand; not used in drawing path) | src/strand.py:81 |
| cp init position (cp1, cp2, center all at start) | QPointF(start.x, start.y) | src/strand.py:53-66 |
| control points z-order (call site) | drawn after all strands + current strand, before labels | src/strand_drawing_canvas.py:2196-2197 |
| highlight_color (Strand default) | QColor(255, 0, 0, 255) — opaque red | strand.py:25 |
| highlight_color (canvas default, operative) | QColor(255, 0, 0, 255) | strand_drawing_canvas.py:175 |
| highlight_color (canvas, re-set) | QColor(255, 0, 0, 255) | strand_drawing_canvas.py:1289 |
| highlight_color (separate canvas attr, transparent) | QColor(255, 0, 0, 0) | strand_drawing_canvas.py:111 |
| Highlight outline pen/band width (outline_stroker, regular) | 10 (MiterJoin, FlatCap) | strand.py:2013-2015 |
| Highlight outline band width (outline_stroker, attached) | 10 (RoundJoin, FlatCap) | attached_strand.py:577-579 |
| Body stroke width (highlight base) | self.width + self.stroke_width * 2 | strand.py:2004 / attached_strand.py:546 |
| Highlight brush/pen draw | setPen(Qt.NoPen); setBrush(self.highlight_color) | strand.py:2151-2152 |
| C-shape ring outer radius offset | circle_radius + 5 (circle_radius = (width+stroke_width*2)/2) | strand.py:2089-2091 |
| C-shape mask rect size | rect_w = rect_h = total_diameter * 2 | strand.py:2094-2095 |
| Side line highlight thickness | highlight_pen_thickness = 10; stroker width = stroke_width + 10 | strand.py:2025, 2056 |
| Side line half-width | (width+stroke_width*2)/2 + 10/2 | strand.py:2026-2027 |
| Attached start-circle highlight trim (start/end) | t_start_point=5.5, t_end_point=3.5; num_samples=100 | attached_strand.py:552-559 |
| Regular highlight trim (start/end) | 5.0 / 5.0; num_samples=50 | strand.py:1988-1995 |
| Endpoint selection square size (MoveMode) | 120 x 120 (half = 60) | strand_drawing_canvas.py:2228, 2374 |
| Control-point square size (MoveMode) | 50 x 50 | strand_drawing_canvas.py:2230, 2376 |
| Selected/hovered square color (yellow, low alpha) | QColor(255, 230, 160, 70) | strand_drawing_canvas.py:2695, 2437 |
| Hover/affected color (yellow, higher alpha) | QColor(255, 230, 160, 140) | strand_drawing_canvas.py:2902, 2912 |
| Non-selected endpoint square color (red) | QColor(highlight_color) with alpha 38 | strand_drawing_canvas.py:2435-2436 |
| Square / circle marker pen | QPen(Qt.black, 2, Qt.SolidLine) | strand_drawing_canvas.py:2438, 2697 |
| AttachMode endpoint circle size | 120 diameter (radius 60) | strand_drawing_canvas.py:2915, 2928, 2942 |
| AttachMode default (idle) circle color | QColor(highlight_color) with alpha 60 | strand_drawing_canvas.py:2938-2939 |
| AttachMode circle pen | create_smooth_pen(Qt.black, 2) | strand_drawing_canvas.py:2914 |
| draw_selection_path pen | QPen(QColor('blue'), 1, Qt.DashLine), no brush | strand.py:573 |
| Endpoint hit-test circle radius | max(self.width/2, 15) | strand.py:587, 602 |
| is_selected default | self._is_selected = False | strand.py:36 |
| selected_attached_strand init | None | strand_drawing_canvas.py:160/190 |
| selected_strand init | None | strand_drawing_canvas.py:180 |
| endpoint overlay square size | 120 px (half 60) | strand_drawing_canvas.py:2374-2375 |
| endpoint hit-test area size (get_start_area/get_end_area) | 120 px (outer_size) | move_mode.py:2166,2192 |
| control-point overlay square size | 50 px (square_control_size, half 25) | strand_drawing_canvas.py:2376-2377 |
| control-point hit-test rect size (get_control_point_rectangle) | 50 px | move_mode.py:2139,2153 |
| yellow selected square size (endpoint) | 120 px (yellow_square_size / base_yellow_square_size) | move_mode.py:995-997; strand_drawing_canvas.py:2228 |
| yellow selected square size (control point) | 50 px (square_control_size) | move_mode.py:998-1000 |
| yellow selected square size (bias) | 50 px (bias_square_size) | move_mode.py:1002-1003 |
| yellow square fill color | QColor(255,230,160,70) | move_mode.py:989; strand_drawing_canvas.py:2695 |
| hover square fill color | QColor(255,230,160,70) | strand_drawing_canvas.py:2437 |
| endpoint idle fill color | QColor(highlight_color) with alpha 38 = RGBA(255,0,0,38) | strand_drawing_canvas.py:2435-2436 |
| control-point idle fill color | QColor(0,100,0,38) | strand_drawing_canvas.py:2532 |
| overlay/selected square border pen | QPen(Qt.black, 2, Qt.SolidLine) | move_mode.py:991; strand_drawing_canvas.py:2438,2534,2697 |
| highlight_color (default) | QColor(255,0,0,255) | strand_drawing_canvas.py:175,1289 |
| control_point_radius (glyphs) | 11 * 1.333 = 14.663 px | strand_drawing_canvas.py:5962 |
| glyph stroke pen | QPen(QColor('black'), 5) | strand_drawing_canvas.py:6075,6284 |
| glyph fill pen / brush | QPen(QColor('green'),1) / QBrush(QColor('green')) | strand_drawing_canvas.py:6076-6077,6285-6286 |
| glyph inner core color | strand.color | strand_drawing_canvas.py:6116,6171,6207,6301,6355,6392 |
| triangle (cp1) radius factor | control_point_radius * 1.06 = 15.54 px, center y offset +1.06 | strand_drawing_canvas.py:6309,6314-6325 |
| circle (cp2) outer radius | control_point_radius; fill radius control_point_radius-1; core (cp_r-1)*0.5 | strand_drawing_canvas.py:6293,6297,6299 |
| center square (cp3) size | control_point_radius*2*0.7 = 20.53 px; fill size-2; core inner*0.5 | strand_drawing_canvas.py:6363,6375,6384 |
| control connector line pen | QPen(QColor('green'), 1, Qt.DashLine) | strand_drawing_canvas.py:5877 |
| C-shape highlight pen thickness (fixed) | 10 | move_mode.py:3759 |
| C-shape outer_radius | (strand.width + strand.stroke_width*2)/2 + 10/2 | move_mode.py:3760-3761 |
| C-shape inner_radius | strand.width/2 + 6 | move_mode.py:3762 |
| C-shape stroke band color | self.canvas.highlight_color (RGBA 255,0,0,255), alpha 0 if circle stroke transparent | move_mode.py:3834-3842 |
| bias control visual square size | control_size = 16 (outer outline 18) | curvature_bias_control.py:23,141 |
| bias control icon size | icon_size = 9 | curvature_bias_control.py:24 |
| bias control selection/clickable size | selection_size = 50 | curvature_bias_control.py:25 |
| bias square outer outline pen | QPen(QColor('black'), 2) | curvature_bias_control.py:149 |
| bias square fill pen/brush | QPen(QColor('green'),1.5) / green brush | curvature_bias_control.py:153-154 |
| show_move_highlights default | True | strand_drawing_canvas.py:486 |
| show_hover_highlights default | True | strand_drawing_canvas.py:495 |
| show_control_points default | True | strand_drawing_canvas.py:163 |
| enable_third_control_point default | True | strand_drawing_canvas.py:217 |
| snap_to_grid_enabled default | True | strand_drawing_canvas.py:1336 |
| very-zoomed-out no-snap threshold | zoom_factor < 0.35 (unless Ctrl) | move_mode.py:4051 |
| gentle-snap threshold | (grid_size/8)*zoom_factor when zoom>=0.5 | move_mode.py:4064 |
| is_moving_control_point sides | ['control_point1','control_point2','control_point_center','bias_control','bias_triangle','bias_circle'] | move_mode.py:2449 |
| is_moving_strand_point sides | [0, 1] | move_mode.py:2451 |
| Attachable endpoint circle diameter (circle_size) | 120 | strand_drawing_canvas.py:2915,2928,2942,2962,2975,2988 |
| Attachable endpoint circle radius | 60 (circle_size/2) | strand_drawing_canvas.py:2916,2943,2963,2989 |
| Attachable circle pen (outline) | Qt.black, width 2, RoundCap, RoundJoin | strand_drawing_canvas.py:2914,2927,2941; render_utils.py:84-88 |
| Default START attachable circle fill | QColor(highlight_color) alpha 60 = rgba(255,0,0,60) with default highlight_color | strand_drawing_canvas.py:2938-2939 |
| Canvas default highlight_color | QColor(255,0,0,255) | strand_drawing_canvas.py:175,1289 |
| Default END attachable circle fill | QColor(0,0,255,60) (blue alpha 60) | strand_drawing_canvas.py:2985 |
| Hover circle fill (hover_color) | QColor(255,230,160,140) (pale yellow alpha 140) | strand_drawing_canvas.py:2902,2925,2972 |
| Affected/selected circle fill | QColor(255,230,160,140) (pale yellow alpha 140) | strand_drawing_canvas.py:2912,2959 |
| Hover hit-test circle_size | 120 | attach_mode.py:738 |
| Hover hit-test radius | 60 (circle_size/2) | attach_mode.py:739 |
| Attachment hit-test base_area_size | 120 | attach_mode.py:1033 |
| Attachment hit-test circle_radius | 60 (area_size/2, min 1.0) | attach_mode.py:1036 |
| Junction (start) circle outer radius on attached strand | (width + stroke_width*2)/2 = (46+8)/2 = 27 px with defaults | attached_strand.py:1201-1202 |
| Junction circle shape | half-circle (ellipse subtracted by tangent-aligned rect) | attached_strand.py:1207-1221 |
| AttachedStrand initial has_circles | [True, False] (circle at start/junction only) | attached_strand.py:37 |
| Parent has_circles set on attach | has_circles[side] = True | attach_mode.py:1151 |
| Default strand_width | 46 | strand_drawing_canvas.py:171,1285 |
| Default stroke_width | 4 | strand_drawing_canvas.py:174,1288 |
| Default grid_size | 28 | strand_drawing_canvas.py:183,1297 |
| snap_to_grid_attach_enabled default | True | strand_drawing_canvas.py:1337 |
| show_hover_highlights default | True | strand_drawing_canvas.py:495 |
| move_speed (grid steps per timer tick) | 1 | attach_mode.py:44 |
| move timer interval / frame_limit_ms | 16 ms (~60fps) | attach_mode.py:46,669,711 |
| AttachedStrand initial length / min_length | length=0, min_length=40 | attached_strand.py:35-36 |
| default_stroke_color | QColor(0,0,0,255) | strand_drawing_canvas.py:232,1354 |

## Control-point glyphs (triangle / circle / center)

### Control-Point Glyph Rendering (OpenStrand Studio)

All control-point glyphs are drawn by the canvas, not by the strand classes. `strand.py`/`attached_strand.py` only *store* the control points (`control_point1`, `control_point2`, `control_point_center`) and their flags; their `drawPolygon`/`drawEllipse` calls are for arrow heads and dashed-line/highlight rendering, never for CP glyphs. The single source of truth is `StrandDrawingCanvas._draw_control_points_impl` in `strand_drawing_canvas.py` (`src/strand_drawing_canvas.py:5953`).

There are **two near-identical glyph-drawing blocks**: a "draw-all-for-affected-strand" branch used during a MoveMode control-point drag with *Draw Only Affected Strand* ON (`:6041`–`:6216`), and the **Normal Drawing branch** (`:6218`–`:6398`). The glyph geometry/colors are identical between them; the only difference is the triangle's vertical centering offset (see cp1 below). Numbers below cite the Normal branch unless noted.

#### Shared setup
- `painter.setRenderHint(QPainter.Antialiasing)` is enabled for the whole CP pass (`:5961`).
- `control_point_radius = 11 * 1.333 = 14.663` px — the master size for all glyphs (`:5962`). Comment: "Scaled by 1.333 to enlarge control point shapes."
- `stroke_color = QColor('black')` (`:5964`).
- Outer stroke pen: `stroke_pen = QPen(stroke_color, 5)` — black, width **5** (`:6284`, affected branch `:6075`).
- Fill border pen: `control_point_pen = QPen(QColor('green'), 1)` — green, width **1** (`:6285`, affected `:6076`).
- Connector lines between CPs use `_create_control_line_pen()` = `QPen(QColor('green'), 1, Qt.DashLine)` — green, width 1, dashed (`:5876`–`:5877`, set at `:6266`).
- The "inner" core of every glyph is filled with `strand.color` (the strand's own color), drawn with `Qt.NoPen` (`:6300`–`:6302`, `:6354`–`:6356`, `:6391`–`:6393`).

Each glyph is rendered as **three stacked layers**, painted in this order (so later layers sit on top):
1. Outer black stroke outline (5 px pen, `Qt.NoBrush`).
2. Green fill at radius − 1 (1 px green pen + green brush).
3. Inner core at 0.5 scale, filled with `strand.color` (no pen).

#### (1) FIRST control point — cp1 — TRIANGLE
- Shape: equilateral **triangle** (`QPolygonF`), pointing **up** (`:6307`–`:6356`).
- Center: `center_x = strand.control_point1.x()`; `center_y = strand.control_point1.y() + 1.06` in the Normal branch (`:6308`–`:6309`). In the affected-strand branch the y offset is `+ 1.06 * 1.333 = +1.41` (`:6125`) — slightly larger nudge for visual centering.
- Vertex radius (distance from center to each vertex): `control_point_radius * 1.06 = 14.663 * 1.06 = 15.54` px (`:6314`–`:6325`).
- Vertices at angles **270°, 30°, 150°** (math angles; +y is downward in Qt screen space, so 270° is the top apex) (`:6312`, `:6317`, `:6322`).
- Layer 1 — outer stroke: `stroke_pen` (black, width 5), `Qt.NoBrush`, `drawPolygon(triangle)` (`:6329`–`:6331`).
- Layer 2 — green fill: a shrunk triangle. `scale_factor = (control_point_radius - 1.06) / (control_point_radius * 1.06) = (14.663 - 1.06)/(14.663*1.06) = 13.603/15.543 ≈ 0.8752`; each vertex pulled toward center by that factor (`:6338`–`:6347`). Pen `control_point_pen` (green, width 1), brush green.
- Layer 3 — inner core: `inner_triangle` = the green `filled_triangle` scaled by **0.5** about center, `Qt.NoPen`, brush = `strand.color` (`:6349`–`:6356`).
- **Always drawn when CPs are enabled**: `show_triangle_cp = True` (`:6256`, comment "Always show triangle when control points are enabled"). The triangle is the only glyph shown before the strand's curve handles have been touched.

#### (2) SECOND control point — cp2 — CIRCLE
- Shape: **circle** (`drawEllipse` with equal x/y radii) centered on `strand.control_point2` (`:6289`–`:6302`).
- Layer 1 — outer stroke: `stroke_pen` (black, width 5), `Qt.NoBrush`, radius = `control_point_radius` = **14.663** px (`:6291`–`:6293`).
- Layer 2 — green fill: `control_point_pen` (green, width 1) + green brush, radius = `control_point_radius - 1` = **13.663** px (`:6295`–`:6297`).
- Layer 3 — inner core: `inner_radius = (control_point_radius - 1) * 0.5` = **6.83** px, `Qt.NoPen`, brush = `strand.color` (`:6298`–`:6302`).
- Gating: `show_circle_cp = triangle_has_moved and show_small_cps` (`:6255`/`:6262`). The circle (and the green dashed connector lines) appear **only after the triangle has been moved at least once** (`strand.triangle_has_moved`, default `False`, `strand.py:71`). `show_small_cps` is True when third-CP mode is on, or — when third-CP is off — when Shift is held OR cp1/cp2 are not both still at the strand start (`:6249`–`:6252`, `:6235`–`:6238`). Note: `control_point2_activated` (`strand.py:81`) gates *interaction/sync* but is **not** consulted in the drawing path; the circle's visibility is governed by `triangle_has_moved` + `show_small_cps` only.

#### (3) CENTER / third control point — control_point_center — SQUARE
- Shape: **axis-aligned square** (`drawRect` / `QRectF`) centered on `strand.control_point_center` (`:6358`–`:6393`).
- `square_size = control_point_radius * 2 * 0.7 = 14.663 * 2 * 0.7 = 20.528` px (`:6363`). The rect's top-left is offset by `control_point_radius * 0.7 = 10.264` px from the center on both axes (`:6364`–`:6369`).
- Layer 1 — outer stroke: `stroke_pen` (black, width 5), `Qt.NoBrush`, the `square_size` rect (`:6361`–`:6370`).
- Layer 2 — green fill: `control_point_pen` (green, width 1) + green brush, `inner_size = square_size - 2 = 18.528` px, top-left offset `(control_point_radius*0.7) - 1 = 9.264` px (`:6373`–`:6382`).
- Layer 3 — inner core: `inner_square_size = inner_size * 0.5 = 9.264` px, centered, `Qt.NoPen`, brush = `strand.color` (`:6383`–`:6393`).
- Gating (must satisfy ALL): `triangle_has_moved` AND `self.enable_third_control_point` (canvas property, default `False`, `:6404`–`:6405`) AND the strand has a non-None `control_point_center` (`:6359`). Note `control_point_center_locked` (default `False`, `strand.py:68`) does **not** gate the square's drawing; it only affects whether the center auto-recenters to the cp1/cp2 midpoint vs. stays where the user dragged it (`strand.py:777`–`:780`, and `enable_third_control_point` setter at `:6407`–`:6447`). `control_point_center_locked` does, however, influence the small-CP visibility decision indirectly via `show_small_cps` in the *affected-strand* branch's earlier `center_is_locked` reads (`:6053`, `:6082`).

#### Connector lines (between glyphs)
Drawn with the green dashed pen, only when `triangle_has_moved and show_small_cps` (`:6269`–`:6281`): `start→control_point1`; then `start→control_point2` if cp2 is within 0.1 px of start else `end→control_point2`. If third-CP enabled and triangle moved: also `control_point_center→control_point1` and `control_point_center→control_point2` (`:6279`–`:6281`).

#### Curvature-bias controls
After the glyphs, if `strand.bias_control` exists and `canvas.enable_curvature_bias_control` is set, `strand.bias_control.draw_bias_controls(painter, strand)` is called (`:6395`–`:6398`). Separate subsystem, not a CP glyph.

#### (4) WHEN each is drawn (top-level gating)
- `draw_control_points` returns immediately if `self.show_control_points` is False (`:5937`–`:5938`; default `True`, `:163`). The call site at `:2196`–`:2197` *also* re-checks `show_control_points` before calling.
- In `ViewMode`, returns early if `view_hide_control_points` is True (`:5941`–`:5942`; default `False`, `:168`).
- Per-strand skips in the loop (`:5995`–`:6038`):
  - `MaskedStrand`, or strands lacking `control_point1`/`control_point2`, or with either CP `None` → skipped (`:5997`–`:6000`).
  - **Hidden strands** (`strand.is_hidden`) → skipped, no CPs shown (`:6003`–`:6004`).
  - **Selected-only filter**: if `show_cp_selected_only` (default `False`, `:165`) is on, or (`move_selected_only` on AND in MoveMode), a strand is skipped unless `is_strand_in_selected_family(strand)` returns True — which restricts to the exactly-selected strand (`:6006`–`:6009`, helper `:5898`–`:5927`).
  - **During an active CP/strand-point drag**: if moving a control point or strand point, all strands except the affected one are skipped, unless *Draw Only Affected* is on and the strand is in `truly_moving_strands` (`:6011`–`:6037`).
- Per-glyph gating recap: triangle = always (when the strand reaches drawing); circle = `triangle_has_moved and show_small_cps`; square = `triangle_has_moved and enable_third_control_point and control_point_center is not None`.

#### (5) Supersampling for control points
- `draw_control_points` (`:5944`–`:5951`): if `self.use_supersampling` (default `True`, `:68`) and the painter device's `devicePixelRatioF()` is **less than** `self.supersampling_factor` (default `2`, `:69`), it routes to `_draw_control_points_supersampled`; otherwise it calls `_draw_control_points_impl` directly (the device is already hi-DPI/supersampled). This guard avoids double-supersampling.
- `_draw_control_points_supersampled` (`:5879`–`:5896`):
  1. Allocate an off-screen `QImage` of `widget_size * supersampling_factor` (2× each axis = 4× pixels), `Format_ARGB32_Premultiplied`, filled transparent (`:5880`–`:5883`).
  2. Create `buffer_painter`; if the device supports it, set `setDevicePixelRatio(supersampling_factor)` so logical coordinates still map 1:1 while backing pixels are doubled (`:5885`–`:5887`).
  3. `RenderUtils.setup_painter(buffer_painter, enable_high_quality=True)` then **copy the caller's transform** via `buffer_painter.setTransform(painter.transform())` so pan/zoom match (`:5888`–`:5889`).
  4. Render glyphs into the buffer with `_draw_control_points_impl(buffer_painter)` (`:5890`).
  5. Blit back: on the real painter, `save()`, `resetTransform()`, `drawImage(self.rect(), buffer, buffer.rect())` (scales the 2× buffer down into the widget rect, giving anti-aliased/crisp edges), then `restore()` (`:5893`–`:5896`).
- Net mapping: glyph constants (radius 14.663, pen widths 5/1, etc.) are specified in **logical** coordinates; they are rasterized at 2× resolution and downsampled to final device pixels. With supersampling off, the same `_draw_control_points_impl` draws directly to the widget painter at native resolution.

#### (6) Z-order
Control points are drawn **after the entire strand body pass** and after the temporary/current strand, at `:2196`–`:2197` (`if self.show_control_points: self.draw_control_points(painter)`), so all CP glyphs render **on top of** every strand. They are drawn *before* strand name labels (`:2200`), before `current_mode.draw` (`:2206`), and before the MoveMode selection-square overlay (`:2212`+). Within a single glyph, layer z-order is black stroke (bottom) → green fill → strand-color inner core (top).

## Endpoints & selection highlight

### Strand START/END points & SELECTION highlight in OpenStrand Studio

This documents exactly how a strand's endpoints and the selection highlight are painted. There are two distinct rendering systems:

1. The **unified selection highlight** (the red "C-shape"/ring/outline that hugs the strand body and end caps) — painted *by the strand itself* inside `Strand._draw_unified_highlight` / `AttachedStrand._draw_unified_highlight`, gated on `is_selected`.
2. The **endpoint markers** (squares in MoveMode, attach circles in AttachMode) — painted *by the canvas* (`StrandDrawingCanvas`) as overlays, gated on the current mode + hover/affected state.

---

#### 1. The selection highlight outline (the "C-shape" / ring / body outline)

The highlight is built as one combined filled `QPainterPath` (`combined_highlight`, `WindingFill`) and painted with **no pen, brush = `self.highlight_color`** at the very end:

- `painter.setPen(Qt.NoPen); painter.setBrush(self.highlight_color); painter.drawPath(combined_highlight)` — `strand.py:2151-2153` (regular) and `attached_strand.py:681-683`.

**Color (`highlight_color`) and its defaults:**
- Per-strand default: `self.highlight_color = QColor(255, 0, 0, 255)` (opaque **red**) — `strand.py:25`.
- Canvas default propagated to strands: `self.highlight_color = QColor(255, 0, 0, 255)` — `strand_drawing_canvas.py:175` and `:1289`. (Note a *separate* earlier canvas attr at `strand_drawing_canvas.py:111` is `QColor(255, 0, 0, 0)` — fully transparent red — but the operative one used for selection is the `…,255` one.)
- The canvas pushes its color to all strands via `set_highlight_color` — `strand_drawing_canvas.py:5310-5320`.

**Body outline geometry (the outline that follows the strand body):**
The body highlight is a "stroke of a stroke":
- Regular strand: takes the existing `stroke_path` (the full body outline of width `self.width + self.stroke_width*2`) and strokes *that* outline with an `outline_stroker` of **width 10**, `MiterJoin`, `FlatCap` → `body_highlight` — `strand.py:2012-2016`. So the red ring is a **10px-wide band wrapping the outside of the body silhouette**.
- Attached strand: builds its own body stroke first (`stroke_stroker` width `self.width + self.stroke_width*2`, `MiterJoin`, `FlatCap`, `attached_strand.py:545-549`), then strokes it with `outline_stroker` width **10**, but `RoundJoin`, `FlatCap` — `attached_strand.py:576-580`.

**Endpoint shortening when a circle is transparent:** if a start/end circle stroke is transparent (`alpha()==0`) and `total_length > 10`, the body path is re-sampled between trimmed endpoints so the highlight does not poke past an open end:
- Regular: trim `t_start_point/t_end_point = 5.0` at the transparent end; resampled with `num_samples = 50`; body re-stroked with `body_stroker` width `self.width + self.stroke_width*2`, `RoundJoin`, `FlatCap` — `strand.py:1988-2007`.
- Attached: trim values are `5.5` (start) / `3.5` (end); `num_samples = 100` — `attached_strand.py:552-571`.

**Side lines (the straight cap segments at an open, circle-less end):**
Only drawn for **regular strands** (guarded by `if not hasattr(self, 'parent')`) — `strand.py:2024`. For each end where `*_line_visible` is true, the corresponding `has_circles[*]` is false, and the circle stroke alpha != 0:
- `highlight_pen_thickness = 10`; `black_half_width = (self.width + self.stroke_width*2)/2`; `highlight_half_width = black_half_width + 10/2` — `strand.py:2025-2027`.
- A perpendicular line of half-length `highlight_half_width` is placed at the end (shifted by `stroke_width/2` along the tangent) and stroked with `line_stroker` width `self.stroke_width + 10`, `FlatCap` — `strand.py:2052-2058` (start), `2069-2075` (end).
- Attached strand draws **only an End side line** (its start is always a circle), `highlight_pen_thickness = 10`, same `+10` math, stroker width `self.stroke_width + 10` — `attached_strand.py:587-616`.

**The C-shape rings (highlight around an endpoint circle):**
At each end where `has_circles[*]` and the circle stroke alpha > 0, a C-shaped (gapped) ring is added:
- `total_diameter = self.width + self.stroke_width*2`; `circle_radius = total_diameter/2`; **`highlight_radius = circle_radius + 5`** — `strand.py:2089-2091` (start), `2126-2128` (end); `attached_strand.py:621-623`, `656-658`.
- The ring = `highlight_circle (r = circle_radius+5)` minus a rotated rectangular `mask` minus the `outer_circle (r = circle_radius)`. This yields a 5px-wide arc that wraps the *outside* of the circle, with a flat gap (the "C" opening) on the side where the body joins, produced by subtracting the tangent-aligned `mask_rect` (`rect_w = rect_h = total_diameter*2`) — `strand.py:2093-2112` (start), `2130-2148` (end).
- When the partner has a non-default cap (`_partner_cap_dims`), the ring uses a rotated ellipse (`_rotated_ellipse`, `strand.py:404`) with `rx` from the partner cap and `ry = circle_radius (+5)` instead of a plain circle — `strand.py:2102-2110`, `2138-2146`.

**Important gating difference between Strand and AttachedStrand C-shapes:**
- Regular `Strand`: the start/end C-shape is only added if the circle is *actually used as a junction* — i.e. there is an `AttachedStrand` child whose `start` coincides, OR `closed_connections[*]` is set — `strand.py:2078-2083` (start), `2115-2120` (end).
- `AttachedStrand`: the **start** C-shape has no such requirement — it is drawn whenever `has_circles[0] and start_circle_stroke_color.alpha() > 0` (`attached_strand.py:619`), because an attached strand's start is always a real attachment circle. Its **end** C-shape uses the same child/closed-connection requirement as a regular strand (`attached_strand.py:647-652`).

---

#### 2. Endpoint markers when a strand is selected / hovered

These are NOT part of `_draw_unified_highlight`. They are drawn by the canvas as **squares (rectangles)** while in MoveMode, in `draw_overlay` / the MoveMode block of `paintEvent` (`strand_drawing_canvas.py:2212+`). All squares use **pen = black, 2px, solid** (`QPen(Qt.black, 2, Qt.SolidLine)`, e.g. `:2438`, `:2697`).

- **Endpoint square size:** `120 x 120` canvas units (`square_size = 120` / `yellow_square_size = 120`, half = 60) — `strand_drawing_canvas.py:2228`, `2374`, `2378`.
- **Control-point square size:** `50 x 50` (`square_control_size = 50`) — `:2230`, `:2376`.
- **Selected (actively moving) endpoint** → filled **yellow** square: `square_color = QColor(255, 230, 160, 70)` — `:2695`, drawn at the affected start/end — `:2705-2720`.
- **Hovered endpoint** → filled yellow square `hover_color = QColor(255, 230, 160, 70)` — `:2437`, drawn at the hovered start/end — `:2443-2445`, `:2458-2460`. (A second, more opaque hover yellow `QColor(255, 230, 160, 140)` is used for attach-mode circles, `:2902`, and for affected MoveMode markers elsewhere.)
- **Other (non-selected, non-hovered) endpoints of strands** → filled translucent **red** square: `red_color = QColor(self.highlight_color)` with `red_color.setAlpha(38)` ("85% transparency") — `:2435-2436`, drawn at start/end — `:2451-2452`, `:2466-2467`.
- Squares are suppressed when overlapping the active yellow square, when already drawn at that position, or for the exact selected point — `:2401-2417`.
- The whole MoveMode square overlay is gated by `show_move_highlights` (`:2693`) and hover squares by `show_hover_highlights` (`:2899`).

So: endpoints are marked with **120px black-bordered squares**, color-coded yellow (selected/hovered) vs. translucent-red (other). Endpoints are **never** marked as squares in non-Move modes; the persistent selection indicator in other modes is the red C-shape/ring outline from section 1.

---

#### 3. Attached-strand start-circle highlight (AttachMode circles)

In **AttachMode**, the canvas draws filled **circles** at every free endpoint to indicate where you can attach (`draw_overlay`, `strand_drawing_canvas.py:2876-2950`):
- **Circle size = 120** diameter (`circle_size = 120`, radius 60) — `:2915`, `:2928`, `:2942`.
- Drawn for an end only if `not strand.has_circles[*]` (i.e. the end is still free) — `:2906`, `:2953`.
- Pen = **black, 2px** (`RenderUtils.create_smooth_pen(Qt.black, 2)`) — `:2914`, `:2927`, `:2941`.
- **Affected/pressed** circle → `QColor(255, 230, 160, 140)` (opaque-ish yellow) — `:2912`.
- **Hovered** circle → `hover_color = QColor(255, 230, 160, 140)` — `:2902`, `:2925`.
- **Default (idle free endpoint)** circle → `QColor(self.highlight_color)` with `setAlpha(60)` (translucent red) — `:2938-2939`, `:2959`.
- All gated by `isinstance(self.current_mode, AttachMode)` and `show_move_highlights` — `:2877`; hover specifically by `show_hover_highlights` — `:2899`.

The persistent ring around an attached strand's *start circle* when that attached strand is selected is the C-shape from section 1 (`attached_strand.py:618-644`, 5px-wide red arc at `circle_radius + 5`).

---

#### 4. Gating: who paints the highlight and when

**Strand-level (the unified highlight in `_draw_unified_highlight`)** is gated identically in every call site:
`if self.is_selected and not isinstance(self, MaskedStrand) and not self._suppress_highlight_in_view():`
- Regular strand: `strand.py:2482-2483` and `:3211-3212`.
- Attached strand: `attached_strand.py:1027-1028` (`not isinstance(self.parent, MaskedStrand)`) and `:2826-2827`.
- Masked strand has its own variant gated `if self.is_selected and not self._suppress_highlight_in_view():` — `masked_strand.py:764`.

**`is_selected`** is a property over `self._is_selected` (default `False`) — `strand.py:36`, getter `:469-471`, setter `:473-483`. The setter **refuses to set False** for strands currently in `truly_moving_strands`.

**`_suppress_highlight_in_view`** — `strand.py:1970-1980`: returns True only when `canvas.view_hide_highlight` is enabled AND the current mode class name is `'ViewMode'`. It does *not* clear selection; it only skips painting the highlight (for clean presentation/export). Default behavior (not in ViewMode, or setting off) → returns `False` → highlight is painted.

**Canvas-level dispatch (`draw_highlighted_strand`, `strand_drawing_canvas.py:3389`)** decides *which* strands get `draw_highlighted_strand` called on them in `paintEvent`:
- `is_selected_for_highlight = (strand == self.selected_strand or strand == self.selected_attached_strand or getattr(strand, 'is_selected', False))` — `strand_drawing_canvas.py:2000`, `:2143`, `:2158`; parent variant at `:1972`.
- Painted when `(is_selected_for_highlight or should_force_highlight) and not should_suppress_highlight and not suppress_view_highlight` and not in `MaskMode` — `:2032-2035`, `:2145-2147`, `:1995-1996`.
- `selected_strand` (`:180`) and `selected_attached_strand` (`:160`/`:190`) are the two distinct canvas pointers; either one (or the strand's own `is_selected` flag) triggers the highlight, so both a top-level selected strand and a selected attached child are highlighted.
- Note `draw_highlighted_strand` itself first draws the strand normally (`strand.draw(..., skip_painter_setup=True)`, `:3421`) — and the strand's own `draw` is what invokes `_draw_unified_highlight`. The old canvas-level C-shape code is disabled via `_skip_canvas_c_shapes = True` (`:3426`, `:3451`) to avoid double-drawing; C-shapes now live solely inside the unified highlight.

**`draw_selection_path` (`strand.py:568-578`)** is a separate, simpler debug/selection-area visual (NOT the red highlight): blue, 1px, **dashed** pen (`QPen(QColor('blue'), 1, Qt.DashLine)`), no brush, drawing `get_selection_path()`. The click/hit selection paths for endpoints (`get_start_selection_path` / `get_end_selection_path`, `strand.py:581-606`) are circles of radius `max(self.width/2, 15)` — used for hit-testing, not normally rendered.


## Move mode UI

## MOVE Mode: Endpoint and Control-Point Handles / Markers

This documents exactly what OpenStrand Studio draws in MOVE mode for strand endpoints and control points. The visuals come from two cooperating files:

- `move_mode.py` (the `MoveMode` class) — owns the move-mode *state* (which side is moving, hover state), draws the **yellow "selected point" square** during a drag (`draw_selection_square`), and installs an optimized paint handler. It does NOT itself draw the per-point red/green hit squares, the control-point glyphs, or the grid — it delegates those to the canvas.
- `strand_drawing_canvas.py` (`StrandDrawingCanvas`) — `paintEvent` draws the per-point overlay squares (red endpoints, green control points, yellow selected, hover), and `draw_control_points` / `_draw_control_points_impl` draw the actual control-point glyphs (triangle / circle / square). The C-shape selection ring is `MoveMode.draw_c_shape_for_strand` (the canvas-level one is disabled).

IMPORTANT distinction: there are two layers of visuals per point:
1. A flat, semi-transparent **selection/hit overlay square** drawn behind/around every movable point (red for endpoints, green for control points), turning **yellow** for the actively-moving point and a **light-yellow** for the hovered point. These exist only in MOVE mode (`isinstance(self.current_mode, MoveMode)`), `strand_drawing_canvas.py:2212`.
2. The persistent **control-point glyphs** (green triangle / circle / square) drawn by `draw_control_points`, which show whenever `show_control_points` is true regardless of mode.

### 1. Endpoint markers (start = side 0, end = side 1)

Endpoints have NO persistent glyph — only the overlay hit square. In MOVE mode each non-masked, non-hidden strand gets a square drawn around `strand.start` and `strand.end`.

- Shape: axis-aligned square (filled `QRectF`, `drawRect`). `strand_drawing_canvas.py:2386-2398`.
- Size: `square_size = 120` px (canvas coords); `half_size = 60`. Centered on the point. `strand_drawing_canvas.py:2374-2375`.
- Border: `QPen(Qt.black, 2, Qt.SolidLine)` — black, 2 px, solid. `strand_drawing_canvas.py:2438`.
- Fill (idle / not selected, not hovered): `red_color = QColor(self.highlight_color)` with `red_color.setAlpha(38)` ("85% transparency"). `highlight_color` defaults to opaque red `QColor(255,0,0,255)` (`strand_drawing_canvas.py:175`, re-asserted at `:1289`), so the idle endpoint square fills as **red at alpha 38 (~15% opacity), i.e. RGBA(255,0,0,38)**. `strand_drawing_canvas.py:2435-2436, 2451, 2466`.
- Fill (hovered endpoint): `hover_color = QColor(255, 230, 160, 70)` — light/pale yellow, alpha 70. `strand_drawing_canvas.py:2437, 2444, 2459`.
- Fill (the point currently being dragged): YELLOW — see section 3. The dragged point's own red/green square is suppressed (`skip_start`/`skip_end`, `strand_drawing_canvas.py:2382-2383`) and replaced by the yellow square.

Gating / suppression for the endpoint squares:
- Only drawn in MoveMode. `strand_drawing_canvas.py:2212`.
- Suppressed entirely if `show_move_highlights` is False. `strand_drawing_canvas.py:2318` (and in `MoveMode.draw_selection_square`, `move_mode.py:985`). Default `show_move_highlights = True` (`strand_drawing_canvas.py:486`).
- Suppressed entirely during an active drag when `draw_only_affected_strand` is True (`is_moving and draw_only_affected_strand`). `strand_drawing_canvas.py:2314-2316`.
- During an active endpoint/control-point drag, squares are drawn ONLY for the affected strand; all other strands are skipped. `strand_drawing_canvas.py:2361` (endpoints), `:2480` (control points).
- Skipped if it overlaps the yellow rect, or duplicates an already-drawn position. `strand_drawing_canvas.py:2401-2417`.
- Hidden strands and masked strands are skipped. `strand_drawing_canvas.py:2328-2331`.
- Family filter (`move_selected_only` / `show_cp_selected_only`): non-family strands skipped. `strand_drawing_canvas.py:2334-2336`.
- The matching mouse hit-test area for endpoints is also a 120x120 square (`get_start_area` / `get_end_area`, `outer_size = 120`). `move_mode.py:2166, 2192`.

### 2. Control-point markers

Two visuals per control point: (a) the overlay hit square (green), and (b) the persistent glyph (green triangle / circle / square). All glyphs are GREEN with a black stroke and a strand-colored inner core.

Shared glyph constants (`_draw_control_points_impl`, `strand_drawing_canvas.py:5953`):
- `control_point_radius = 11 * 1.333 ≈ 14.663` px. `strand_drawing_canvas.py:5962`.
- `stroke_color = QColor('black')`; outer stroke pen `stroke_pen = QPen(black, 5)` (5 px). `strand_drawing_canvas.py:5964, 6075/6284`.
- Fill pen `control_point_pen = QPen(QColor('green'), 1)`; fill brush `QBrush(QColor('green'))`. `strand_drawing_canvas.py:6076-6077 / 6285-6286`.
- Connector lines between point and control points: `_create_control_line_pen` = `QPen(QColor('green'), 1, Qt.DashLine)` — green, 1 px, dashed. `strand_drawing_canvas.py:5877`. Drawn only after `triangle_has_moved`. `strand_drawing_canvas.py:6269-6281`.
- Antialiasing on. `strand_drawing_canvas.py:5961`.

**control_point1 — triangle** (`strand.control_point1`):
- Always drawn when control points are enabled (`show_triangle_cp = True`). `strand_drawing_canvas.py:6256, 6305`.
- Equilateral triangle, vertices at angles 270deg/30deg/150deg, radius `control_point_radius * 1.06 ≈ 15.54`, centered at `(control_point1.x, control_point1.y + 1.06)`. `strand_drawing_canvas.py:6307-6326`.
- Layered draw: (1) black 5px stroke outline (`Qt.NoBrush`); (2) green-filled inner triangle scaled by `(r-1.06)/(r*1.06)`; (3) innermost triangle (filled triangle scaled by 0.5) filled with `strand.color`. `strand_drawing_canvas.py:6328-6356`.

**control_point2 — circle** (`strand.control_point2`):
- Drawn only when `show_circle_cp = triangle_has_moved and show_small_cps`. `strand_drawing_canvas.py:6255, 6289`.
- Layered: (1) black 5px stroke circle of radius `control_point_radius`; (2) green circle of radius `control_point_radius - 1`; (3) inner circle radius `(control_point_radius-1)*0.5` filled with `strand.color`. `strand_drawing_canvas.py:6291-6302`.

**control_point_center — square** (`strand.control_point_center`):
- Drawn only when `triangle_has_moved and enable_third_control_point and control_point_center is not None`. `enable_third_control_point` default True (`strand_drawing_canvas.py:217`). `strand_drawing_canvas.py:6359`.
- `square_size = control_point_radius * 2 * 0.7 ≈ 20.53`, centered on the point. Layered: (1) black 5px stroke square; (2) green fill square `square_size - 2`; (3) inner square `inner_size*0.5` filled `strand.color`. `strand_drawing_canvas.py:6363-6393`.

**Control-point overlay hit squares** (the flat green selection squares, drawn in `paintEvent`):
- Shape: square `drawRect`. Size `square_control_size = 50` px; `half_control_size = 25`. `strand_drawing_canvas.py:2376-2377, 2498-2518`.
- Border: `QPen(Qt.black, 2, Qt.SolidLine)`. `strand_drawing_canvas.py:2534`.
- Fill (idle): `green_color = QColor(0, 100, 0, 38)` — dark green at alpha 38 ("85% transparency"). `strand_drawing_canvas.py:2532`.
- Fill (hovered): `hover_color = QColor(255, 230, 160, 70)`. `strand_drawing_canvas.py:2533, 2550/2562/2575`.
- cp1 square always eligible; cp2 square only if `strand.control_point2_shown`; cp3 square only if `triangle_has_moved and enable_third_control_point`. `strand_drawing_canvas.py:2607-2648`.
- Hit-test rectangle (mouse): `get_control_point_rectangle` uses `size = 50` square. `move_mode.py:2139, 2153`.

**Bias controls** (when `enable_curvature_bias_control` is on AND `triangle_has_moved`): `curvature_bias_control.py`:
- Visual square `control_size = 16`, with black 2px outer outline at `control_size + 2 = 18`, green fill (`QPen(green,1.5)` + green brush). `curvature_bias_control.py:23, 132-155`.
- Inner icon `icon_size = 9`: a triangle (for the triangle bias control) or a circle (`drawEllipse`, radius `icon_size/2`), drawn in the strand's color. `curvature_bias_control.py:24, 158-173`.
- Clickable/overlay area `selection_size = 50` (matches the green CP square). `curvature_bias_control.py:25, 244-250`. In `paintEvent` the bias overlay square is 50px, green `QColor(0,100,0,38)` baseline / hover `(255,230,160,70)`. `strand_drawing_canvas.py:2650-2680`.

### 3. Selected / moving / hovered visual states

There are three distinct states for the point under interaction:

**Idle (movable but not interacted):**
- Endpoint: red square `RGBA(255,0,0,38)`, black 2px border, 120px.
- Control point: green square `RGBA(0,100,0,38)`, black 2px border, 50px, plus its green glyph.

**Hovered (mouse over the point, not dragging):**
- Hover state computed by `MoveMode._update_hover_state` (`move_mode.py:2225`), checking control points first then start/end, setting `self.hovered_strand` / `self.hovered_side`. Triggered from `mouseMoveEvent` only when `not self.is_moving` (`move_mode.py:4017-4018`).
- The hovered point's overlay square is filled with `hover_color = QColor(255, 230, 160, 70)` (pale yellow, alpha 70), same black 2px border, same size (120 endpoint / 50 control). `strand_drawing_canvas.py:2444, 2459, 2550, 2562, 2575`.
- Hover overlays are gated by `show_hover_highlights` (default True, `strand_drawing_canvas.py:495`); if False, `hovered_strand`/`hovered_side` are forced to None for drawing. `strand_drawing_canvas.py:2309-2311`.
- To prevent double-draw, the red/green idle square at a hovered position is skipped (`skip_for_hover` / `skip_green`). `strand_drawing_canvas.py:2449, 2555` etc.

**Moving / selected (the point being dragged):** the YELLOW square.
- Drawn by `MoveMode.draw_selection_square` (during optimized-paint drag, `move_mode.py:979`) AND by the canvas paintEvent yellow block (`strand_drawing_canvas.py:2692-2740`). Both use identical constants.
- Fill: `square_color = QColor(255, 230, 160, 70)` — yellow, alpha 70. `move_mode.py:989`, `strand_drawing_canvas.py:2695`.
- Border: `QPen(Qt.black, 2, Qt.SolidLine)` — black, 2px, solid. `move_mode.py:991`, `strand_drawing_canvas.py:2697`.
- Size by `moving_side`:
  - `0` (start) / `1` (end): `yellow_square_size = 120`, half = 60. `move_mode.py:995-997`, `strand_drawing_canvas.py:2228-2229`.
  - `'control_point1'` / `'control_point2'` / `'control_point_center'`: `square_control_size = 50`, half = 25. `move_mode.py:998-1000`.
  - `'bias_triangle'` / `'bias_circle'`: `bias_square_size = 50`, half = 25. `move_mode.py:1002-1003, 1049-1068`.
- Drawn only when `is_moving and selected_rectangle and affected_strand` (and `show_move_highlights`). `move_mode.py:981-985`. The dragged point's own red/green square is suppressed via `skip_*`. `strand_drawing_canvas.py:2382-2383, 2473-2475`.
- Note: `draw_selection_square` does NOT scale visual sizes with zoom — the comment says it should but `yellow_square_size = base_yellow_square_size` with no zoom division. `move_mode.py:995-996`.

**Selected-strand body highlight (the red C-shape ring):** When a strand is selected/moving, its connection-circle ends get a C-shaped highlight ring drawn by `MoveMode.draw_c_shape_for_strand` (`move_mode.py:3705`), invoked from the optimized paint handler via `draw_highlighted_strand` or directly. `move_mode.py:874-880`.
- Ring geometry per circle-end: `outer_radius = (strand.width + strand.stroke_width*2)/2 + highlight_pen_thickness/2` with fixed `highlight_pen_thickness = 10`; `inner_radius = strand.width/2 + 6`. `move_mode.py:3759-3762`.
- It is a ring (outer circle minus inner circle) cut into a "C" by subtracting a rotated mask rectangle aligned to the strand tangent. `move_mode.py:3764-3801`.
- Stroke band painted with `self.canvas.highlight_color` (red `RGBA(255,0,0,255)`), `Qt.NoPen`; if the end-circle stroke is transparent (`alpha()==0`), the highlight is also alpha 0. `move_mode.py:3827-3844`. The inner color band is computed but its draw is commented out (`#painter.drawPath(color_c_shape)`). `move_mode.py:3850`.
- C-shape gating: only for ends where `has_circle` is True AND (`strand.is_selected` OR strand in `truly_moving_strands`); skipped for hidden strands. `move_mode.py:3713-3728`. (NOTE: the canvas-level duplicate C-shape draw is disabled via `_skip_canvas_c_shapes = True`, `strand_drawing_canvas.py:3426`.)

### 4. Snap / grid indicators

- There is NO special on-canvas snap indicator (no snap crosshair, no highlighted grid cell). The only "indicator" is that the dragged point's coordinates are snapped, so the yellow square and strand visibly jump to grid intersections.
- The background grid itself is drawn by `StrandDrawingCanvas.draw_grid` (`strand_drawing_canvas.py:3227`) and is part of the cached background during a move (re-rendered in the optimized handler when `show_grid`). `move_mode.py:726-733`.
- Snap math is in `mouseMoveEvent` (`move_mode.py:4036-4079`): zoom- and modifier-dependent. `Ctrl` forces grid snap (`force_grid_snap`, `move_mode.py:4039`). Snapping requires `snap_to_grid_enabled` (default True, `strand_drawing_canvas.py:1336`), except bias controls never snap (`move_mode.py:4046-4048`). At `zoom_factor < 0.35` no snap unless Ctrl; `>=0.8` or Ctrl uses full `snap_to_grid`; `>=0.5` uses gentle snap only when within `(grid_size/8)*zoom` of an intersection. `move_mode.py:4051-4079`.

### 5. Gating conditions summary

- Move-mode overlays exist only when `isinstance(self.current_mode, MoveMode)`. `strand_drawing_canvas.py:2212`.
- `show_move_highlights` (default True) gates ALL endpoint/control overlay squares and the yellow square. `strand_drawing_canvas.py:2318, 2693`; `move_mode.py:985`.
- `show_hover_highlights` (default True) gates the pale-yellow hover square. `strand_drawing_canvas.py:2309`.
- `show_control_points` (default True) gates the green CP glyphs entirely. `strand_drawing_canvas.py:5937`.
- `draw_only_affected_strand` (the "drag only affected strand" toggle): when ON and `is_moving`, suppresses overlay squares for all strands and restricts CP-glyph drawing to moving strands. `strand_drawing_canvas.py:2314-2316`, `:5981, 6015`; `move_mode.py:846-848, 948-956`.
- During an active drag (`is_moving_control_point` or `is_moving_strand_point`), overlays and CP glyphs are restricted to the affected strand. `strand_drawing_canvas.py:2361, 2480, 6013-6037`.
- Hidden (`is_hidden`), deleted, and `MaskedStrand` strands never show endpoint/CP overlays or glyphs. `strand_drawing_canvas.py:2328-2331, 5997-6004`; `move_mode.py:2245`.
- Lock mode: locked layer indices are not hoverable/movable. `move_mode.py:2249-2252`.
- Glyph visibility staging: triangle (cp1) always shown; circle (cp2) only after `triangle_has_moved` and `show_small_cps`; center square (cp3) and bias controls only after `triangle_has_moved` (and their feature toggles). `strand_drawing_canvas.py:6249-6263, 6359, 6396`.


## Attach mode UI

### ATTACH mode — what OpenStrand Studio draws

Important architectural note: `attach_mode.py` (`AttachMode`) **draws nothing itself**. It only computes state (hover, which strand/side is "affected", the live `current_strand` geometry) and triggers repaints. All actual painting happens in `strand_drawing_canvas.py` (the attach-mode endpoint circles in `_draw_overlays`, and the live preview via `current_strand.draw`) and in `attached_strand.py` (the junction circle once a strand is attached). The `attach_mode.py` file contains zero `painter`/`drawEllipse`/`QPen` calls — every match is from setting up the *optimized paint handler* (a cached background blit), not drawing the attach UI. See the optimized handler at `attach_mode.py:251-461`, which just draws grid + non-active strands to a cache pixmap and then `active_strand.draw(painter)` on top (`attach_mode.py:420`).

#### 1) Attachable-endpoint highlight circles (the "you can attach here" circle)

Drawn in `StrandDrawingCanvas._draw_overlays` (`strand_drawing_canvas.py:2859-3001`), gated on `isinstance(self.current_mode, AttachMode)` and `show_move_highlights` (`strand_drawing_canvas.py:2877`). Called once per paint, last in the paint flow (`strand_drawing_canvas.py:2815`), so these circles render **on top of all strands** but the painter for them is re-set with the zoom/pan transform (`strand_drawing_canvas.py:2864-2869`).

For every strand (skipping `MaskedStrand` and `is_hidden` strands — `:2885-2890`), a circle is drawn at each endpoint **only if that side has no circle yet** (`if not strand.has_circles[0]` start `:2906`; `if not strand.has_circles[1]` end `:2953`).

- Shape: full circle via `painter.drawEllipse(QRectF(...))`.
- Size: `circle_size = 120`, `radius = circle_size / 2 = 60` (hard-coded at every branch, e.g. `:2915-2916`, `:2942-2943`, `:2962-2963`, `:2988-2989`). The rect is `QRectF(point.x - 60, point.y - 60, 120, 120)`, i.e. **diameter 120, radius 60 px in canvas units**, centered on the endpoint. This is independent of strand width.
- Pen (outline): `RenderUtils.create_smooth_pen(Qt.black, 2)` — solid **black**, **width 2**, round cap, round join (`render_utils.py:84-88`). Same pen for all states.
- Brush (fill) depends on state:
  - Default **start** circle: `QColor(self.highlight_color)` with `.setAlpha(60)` (`strand_drawing_canvas.py:2938-2939`). Canvas `highlight_color` default is `QColor(255,0,0,255)` (`strand_drawing_canvas.py:175,1289`), so default start fill = **red at alpha 60** → `rgba(255,0,0,60)`.
  - Default **end** circle: fixed `QColor(0, 0, 255, 60)` → **blue at alpha 60** (`strand_drawing_canvas.py:2985`).
  - Hovered circle (mouse over that endpoint): `hover_color = QColor(255, 230, 160, 140)` → **pale yellow, alpha 140** (`strand_drawing_canvas.py:2902`, applied `:2925`/`:2972`).
  - "Affected" circle (the side currently being attached / pressed): `QColor(255, 230, 160, 140)` → same pale yellow alpha 140 (`strand_drawing_canvas.py:2912`/`:2959`).

Fill brush is built with `RenderUtils.create_smooth_brush(...)` = `QBrush(color, Qt.SolidPattern)` (`render_utils.py:101`).

Selection/affected gating: if any strand's side is "affected" (`affected_strand`/`affected_point` set in `AttachMode.start_attachment`, `attach_mode.py:1128-1129`), only that strand is drawn (`strand_drawing_canvas.py:2893-2894`) and only its affected side (the other side is skipped, `:2908-2909`/`:2955-2956`).

#### 2) Hover detection (drives the yellow highlight)

Computed in `AttachMode._update_hover_state` (`attach_mode.py:722-768`), called on mouse-move when not actively dragging (`attach_mode.py:687-689`):
- Uses a hit radius of `circle_size = 120`, `radius = 60` (`attach_mode.py:738-739`) — matches the drawn circle.
- Tests Euclidean distance from cursor to `strand.start` (only if `not has_circles[0]`, `:749-754`) and to `strand.end` (only if `not has_circles[1]`, `:757-762`); first hit wins. Skips `MaskedStrand` and `is_hidden` (`:743-746`).
- Sets `hovered_strand`/`hovered_point` (0=start, 1=end) and calls `self.canvas.update()` only when the hover changes (`:765-766`).
- The canvas reads `hovered_point` for AttachMode (`strand_drawing_canvas.py:2900-2901`); the whole hover read is gated on `show_hover_highlights` (default `True`, `strand_drawing_canvas.py:495,2899`).

#### 3) Live preview of the strand being attached (during drag)

There is **no special preview styling**. The strand being created is a real `AttachedStrand` stored as `canvas.current_strand` and drawn with the **normal** strand draw path: `self.current_strand.draw(painter, skip_painter_setup=True)` (`strand_drawing_canvas.py:2164-2175`), drawn after all committed strands but before `_draw_overlays`. So the in-progress strand looks identical to a finished attached strand (same color/stroke/width/circle), just updated live as the mouse moves.

- The preview strand is created at `attach_mode.py:1131-1143`: `AttachedStrand(parent_strand, attach_point, side)` with `color = parent.color`, `stroke_color = parent.stroke_color`, `set_number = parent.set_number`, `highlight_color = QColor(canvas.highlight_color)`. Width/stroke are inherited from the parent (`AttachedStrand.__init__` `attached_strand.py:26-28`). Canvas defaults: `strand_width = 46`, `stroke_width = 4` (`strand_drawing_canvas.py:171-174,1285-1288`).
- It starts with `length = 0` (`attached_strand.py:35`) so initially it is just the start junction circle; as you drag, `end` is updated each move (`attach_mode.py:705-708`) and `update_shape()` redraws the curve.
- During the optimized partial-update path (zoom=1, no pan), the preview is composited over a cached pixmap of everything else, then drawn on top (`attach_mode.py:417-420`). On any zoom!=1 or pan!=0, attach mode falls back to a full `canvas.update()` (`attach_mode.py:83-96`).

#### 4) Snap behavior and snap indicators

- **No snap indicator is drawn at all** — there is no ghost dot, crosshair, or grid-highlight for snapping. Snapping only quantizes the endpoint position; the visual feedback is simply the preview strand jumping to snapped positions.
- Snap-to-grid for attach: `canvas.snap_to_grid_for_attach(point)` (`strand_drawing_canvas.py:5183-5187`) returns the nearest grid intersection if `snap_to_grid_attach_enabled` (default **True**, `strand_drawing_canvas.py:1337`), else the raw point. Grid spacing = `grid_size` (default **28**, `strand_drawing_canvas.py:183,1297`).
- During drag, the end is snapped via `_get_snapped_attachment_position` (`attach_mode.py:931-979`), which additionally prevents the snapped end from collapsing onto the start (pushes one grid unit out in the dominant axis / diagonal fallback). Move is gradual one grid step per timer tick (`gradual_move`, `attach_mode.py:770-810`; step = `grid_size * move_speed`, `move_speed=1`, `attach_mode.py:44`). For the very first free-floating strand (non-attaching), angle snaps to nearest 45° (`update_first_strand`, `attach_mode.py:824-855`).
- There is **no snap-to-endpoint** mechanism; attachment is triggered by the cursor being inside the 120 px attachment circle of an existing endpoint on mouse *press* (see gating below), not by drag-time endpoint snapping.

#### 5) The moment of attachment — what changes visually

On mouse press inside an attachable endpoint's circle (`handle_strand_attachment` → `try_attach_to_strand` → `start_attachment`):
- The attachment hit-test uses a circular `QPainterPath` of radius **60** (`base_area_size = 120`, `circle_radius = 120/2`, `attach_mode.py:1030-1045`); press position must be `path.contains(pos)` (`attach_mode.py:1057-1058`).
- `parent_strand.has_circles[side] = True` (`attach_mode.py:1151`). This **immediately removes the attachable highlight circle** from that endpoint (the overlay only draws when `not has_circles[...]`), and a new `AttachedStrand` is appended to `parent.attached_strands` (`attach_mode.py:1150`).
- The new `AttachedStrand` has `has_circles = [True, False]` (`attached_strand.py:37`): a **circle at its own start** (the junction with the parent) is now drawn by the strand itself, and its end has no circle yet (so its end will show a fresh blue attachable circle once released, since it has no circle there).
- The junction circle drawn by `AttachedStrand.draw` (`attached_strand.py:1200-1234`) is a **half-circle** (an ellipse masked by a rotated rectangle aligned to the start tangent), not the 120 px overlay circle:
  - Radius `= (self.width + self.stroke_width*2) / 2` → with defaults `(46 + 8)/2 = 27` px outer (`attached_strand.py:1201-1202`).
  - Outer ring uses `start_circle_stroke_color` (inherited from parent stroke, default black) and inner fill uses the strand color (parent color). It is only drawn while `start_circle_stroke_color.alpha() > 0` (`attached_strand.py:1200`).
- `parent_strand.update_attachable()` is called (`attach_mode.py:1158`) to recompute attachability; the parent's `knot_freed_ends` for that side is cleared (`attach_mode.py:1154-1156`).
- `affected_strand`/`affected_point` are set (`attach_mode.py:1128-1129`), so during the subsequent drag the overlay highlights only this strand/side in pale yellow `rgba(255,230,160,140)`.
- A full `canvas.update()` is forced (`attach_mode.py:1175`).

On **mouse release** (`mouseReleaseEvent`, `attach_mode.py:463-557`): the final snapped end is committed (`:474-476`), the optimized paint handler and all caches are torn down (`:481-497`), control-point visibility restored (`:500-501`), `affected_strand` cleared (`:540`), `current_strand` cleared (`:544`), and `strand_created` / `strand_attached` signals emit. Visually the strand becomes a permanent attached strand; its previously hovered/affected (yellow) highlight reverts to the default blue/red attachable circle at any still-free end.

#### Gating summary
- Overlay attach circles only render when `current_mode` is `AttachMode` AND `show_move_highlights` is truthy (`strand_drawing_canvas.py:2877`).
- Per-endpoint: only when `not has_circles[side]` and the strand is not `MaskedStrand`/`is_hidden`.
- Hover highlight: only when `show_hover_highlights` (default True).
- Attachment to a side requires `has_free_side` (`attach_mode.py:1002-1028`): regular `Strand` is attachable if either end lacks a circle; an `AttachedStrand`'s start (index 0) is **never** attachable (it is permanently bound to its parent), so only its end (index 1) is offered.

## Open questions for the implementer

- The exact resolved RGB of QColor('green') is Qt's named color (0,128,0) and QColor('black') is (0,0,0); the source uses the string names rather than explicit RGBA, so confirm against Qt's named-color table if exact bytes matter.
- control_point2_activated is initialized and used for interaction/sync logic but is NOT read in _draw_control_points_impl; if the spec intends it to gate the circle glyph, that is not what the current code does (circle gating is triangle_has_moved AND show_small_cps).
- The two drawing branches (affected-strand at :6041 and normal at :6218) differ only in the triangle y-offset (1.06 vs 1.06*1.333); confirm whether this asymmetry is intentional or a latent inconsistency to replicate exactly when porting.
- RenderUtils.setup_painter(enable_high_quality=True) sets additional render hints (e.g., SmoothPixmapTransform/TextAntialiasing) not inspected here; review RenderUtils for the full hint set applied to the supersample buffer if pixel-exact matching is required.
- The canvas has two different highlight_color initializations: QColor(255,0,0,0) at strand_drawing_canvas.py:111 (fully transparent) and QColor(255,0,0,255) at :175 and :1289. The later assignment in __init__ should win, so the operative selection color is opaque red (255,0,0,255), but the implementer should confirm execution order / that :111 is not a different attribute on a different code path.
- RenderUtils.create_smooth_brush / create_smooth_pen are used for AttachMode circles instead of plain QBrush/QPen; the exact antialiasing/cosmetic-pen behavior of these helpers (e.g. whether the 2px pen is cosmetic/zoom-invariant) was not inspected and may matter for a pixel-faithful port.
- All endpoint marker sizes (120, 50) and circle sizes (120) are in canvas/scene coordinates and are drawn under the zoom transform applied in draw_overlay (strand_drawing_canvas.py:2864-2869); whether they should scale with zoom or remain screen-constant in a port was not determined here.
- The C-shape gap orientation depends on calculate_cubic_tangent / calculate_start_tangent and _partner_cap_dims/_rotated_ellipse (strand.py:292, 404); the precise tangent and partner-cap math was not fully traced and should be reviewed for exact arc placement when porting non-circular caps.
- The yellow selection square in MoveMode.draw_selection_square comments say sizes should scale with zoom for visual consistency, but the code sets yellow_square_size = base_yellow_square_size (120) with NO zoom division (move_mode.py:995-996). All overlay/handle sizes (120/50) appear to be in canvas coordinates and are scaled only by the global painter zoom transform, not pre-divided. Confirm whether handles should appear constant-pixel-size on screen across zoom levels or whether they intentionally scale with the canvas.
- The inner colored band of the C-shape highlight (color_c_shape) is computed but its draw call is commented out (move_mode.py:3850), so only the red stroke band of the C ring is rendered. Confirm this is intentional for the port (i.e. do not render the strand-colored inner band).
- highlight_color is set to QColor(255,0,0,0) (fully transparent) at strand_drawing_canvas.py:111 and then overwritten to QColor(255,0,0,255) at :175 and :1289, and can be changed by set_highlight_color (:5310). The documented red endpoint fill assumes the opaque default; if a user customizes highlight_color the endpoint idle-square color and C-shape stroke color change accordingly. Confirm the default opaque red is the value to port.
- Whether MaskedStrand endpoints get any move-mode handles: control-point checks are skipped for MaskedStrand, and the per-point overlay loop also skips MaskedStrand for control squares, but masked strands DO have start/end. The code path at :2328 only draws for non-MaskedStrand strands, so masked strands appear to get no endpoint squares — confirm intended.
- The relationship between control_point2_shown vs triangle_has_moved gating (cp2 overlay square requires control_point2_shown at :2624 while the cp2 glyph requires triangle_has_moved + show_small_cps at :6289). Confirm these two flags are kept in sync in practice or document both gates separately in the port.
- The default START attachable-circle fill uses the canvas `highlight_color` (QColor(self.highlight_color) then setAlpha(60)). Canvas default is QColor(255,0,0,255) (red), but `highlight_color` is user-configurable via set_highlight_color (strand_drawing_canvas.py:5312) and overwritten from settings, so in practice the start circle's hue may differ from red. The END circle is hard-coded blue rgba(0,0,255,60) regardless.
- `show_move_highlights` gates whether attach-mode endpoint circles draw at all (strand_drawing_canvas.py:2877), but its default/initialization value was not located in the read range; confirm whether it defaults to True (the `not hasattr(...)` fallback implies missing attr = draw).
- The junction half-circle is only painted while `start_circle_stroke_color.alpha() > 0` (attached_strand.py:1200). The initial value of `start_circle_stroke_color` on a freshly created AttachedStrand (and whether it copies parent stroke alpha) was not verified in the read excerpt.
- Whether `RenderUtils.setup_painter` applies antialiasing that visibly softens the 2px black ring was assumed (high-quality hints) but the exact render hints set in setup_painter (render_utils.py:17) were not fully read.
- The exact draw order between the live `current_strand` preview (strand_drawing_canvas.py:2175) and `_draw_overlays` (strand_drawing_canvas.py:2815) confirms overlays draw last, but it was not verified whether the affected-side yellow overlay circle visually sits on top of the preview strand's own junction circle during drag (both are at the same point).

