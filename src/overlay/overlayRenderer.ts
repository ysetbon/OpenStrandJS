// Draws the interaction overlay (control-point glyphs, endpoint/CP handles,
// selection ring, new-strand / attach preview, mask-pending highlight) onto
// #overlay using the SAME viewTransform world->screen math as hit-testing, so
// handles sit exactly on the rendered geometry. The overlay canvas is 1:1 with
// #c's backing store (synced by renderScheduler).
//
// The visuals are a faithful port of OpenStrand Studio's Qt overlay
// (OVERLAY_UI_SPEC.md). All glyph/handle constants are specified in CANVAS/WORLD
// units in OSS and drawn under the zoom transform, so each is multiplied by
// view.zoom to reach screen px. The renderer (#c) draws with control points OFF,
// so this layer is an editor-experience match verified visually, not a pixel
// diff.

import type {
  EditorDocument, HandleKind, ModeName, Point, RGBA, Selection, Settings, StrandRecord, ViewState,
} from '../model/types';
import type { PendingStrand } from '../store/editorStore';
import type { AngleSession } from '../store/actions';
import {
  DEFAULT_STRAND_COLOR, DEFAULT_STRAND_WIDTH, DEFAULT_STROKE_COLOR, DEFAULT_STROKE_WIDTH,
} from '../model/factory';
import { worldToScreen } from '../interaction/viewTransform';
import { strandHandles } from '../interaction/hitTest';
import { sampleCenterline, maskCentroid } from '../interaction/hitGeometry';
import { maskComponents } from '../model/layerName';

export interface OverlayState {
  doc: EditorDocument;
  view: ViewState;
  selection: Selection;
  settings: Settings;
  hover: { layerName: string | null; handle: HandleKind | null };
  pending: PendingStrand | null;
  maskPending: string[];
  eraser: { layerName: string; rect: { minX: number; minY: number; maxX: number; maxY: number } } | null;
  mode: ModeName;
  dragging: boolean;
  // OSS should_draw_names: label every strand with its layer_name on the canvas.
  drawNames: boolean;
  // OSS AngleAdjustMode: the strand under live angle edit (dialog open) + the
  // geometry snapshot taken at activation (for the faded-original line + arc span).
  angleEditTarget: string | null;
  angleEditInitial: AngleSession | null;
}

// --- OSS glyph/handle constants (canvas/world units; * zoom -> screen px) ---
const CP_R = 11 * 1.333;                       // control_point_radius = 14.663
const GLYPH_STROKE_W = 5;                       // outer black outline pen
const GLYPH_FILL_W = 1;                         // inner green border pen
const TRI_VERTEX_R = CP_R * 1.06;              // 15.54 (triangle vertex radius)
const TRI_Y_OFFSET = 1.06;                     // cp1 vertical centering nudge
const TRI_FILL_SCALE = (CP_R - 1.06) / (CP_R * 1.06); // 0.8752 green-triangle shrink
const SQUARE_HALF = CP_R * 0.7;                // center square half-size = 10.264
const ENDPOINT_HALF = 60;                      // move-mode endpoint square (120px)
const CP_HALF = 25;                            // move-mode control-point square (50px)
const ATTACH_R = 60;                           // attach-mode endpoint circle (120px dia)
const HANDLE_BORDER_W = 2;                     // black 2px solid border on squares/circles
const TRI_ANGLES = [270, 30, 150].map((d) => (d * Math.PI) / 180); // apex up (+y down)

const GREEN = 'rgb(0,128,0)';                  // QColor('green')
const BLACK = 'rgb(0,0,0)';

// Per-state overlay fills (alpha bytes from OSS converted to 0..1).
const FILL_ENDPOINT_IDLE = 'rgba(255,0,0,0.149)';   // red alpha 38
const FILL_CP_IDLE = 'rgba(0,100,0,0.149)';         // dark green alpha 38
const FILL_HOT = 'rgba(255,230,160,0.275)';         // pale yellow alpha 70
const FILL_ATTACH_START = 'rgba(255,0,0,0.235)';    // red alpha 60
const FILL_ATTACH_END = 'rgba(0,0,255,0.235)';      // blue alpha 60
const FILL_ATTACH_HOT = 'rgba(255,230,160,0.549)';  // pale yellow alpha 140

const css = (c: RGBA): string => `rgba(${c.r},${c.g},${c.b},${(c.a ?? 255) / 255})`;
const CP_SEP = 6;                              // matches hitTest.sep threshold
const sepFromEnds = (cp: Point, a: Point, b: Point): boolean =>
  Math.hypot(cp.x - a.x, cp.y - a.y) > CP_SEP && Math.hypot(cp.x - b.x, cp.y - b.y) > CP_SEP;

function interactable(s: StrandRecord | undefined, doc: EditorDocument): s is StrandRecord {
  return !!s && s.type !== 'MaskedStrand' && !s.is_hidden && !doc.locked_layers.includes(s.layer_name);
}

// cp2 (the circle glyph + connector lines) appears once the curve has been
// shaped — i.e. cp1/cp2 have moved off the start, mirroring OSS's
// `triangle_has_moved && show_small_cps` gate.
function curveShaped(s: StrandRecord): boolean {
  return !!s.control_point2_shown || sepFromEnds(s.control_points[1], s.start, s.end);
}

// ---------------------------------------------------------------------------
// Control-point glyphs (the persistent green triangle / circle / square layer)
// ---------------------------------------------------------------------------

function drawTriangleGlyph(ctx: CanvasRenderingContext2D, center: Point, z: number, coreCss: string): void {
  const r = TRI_VERTEX_R * z;
  const cy = center.y + TRI_Y_OFFSET * z;          // OSS centers cp1 at y + 1.06
  const verts = TRI_ANGLES.map((a) => ({ x: center.x + r * Math.cos(a), y: cy + r * Math.sin(a) }));
  const poly = (pts: Point[]) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  };
  const c = { x: center.x, y: cy };
  // Layer 1: black outline.
  poly(verts);
  ctx.lineJoin = 'miter'; ctx.lineWidth = GLYPH_STROKE_W * z; ctx.strokeStyle = BLACK; ctx.stroke();
  // Layer 2: green fill, vertices pulled toward center by TRI_FILL_SCALE.
  const green = verts.map((v) => ({ x: c.x + (v.x - c.x) * TRI_FILL_SCALE, y: c.y + (v.y - c.y) * TRI_FILL_SCALE }));
  poly(green);
  ctx.fillStyle = GREEN; ctx.fill();
  ctx.lineWidth = GLYPH_FILL_W * z; ctx.strokeStyle = GREEN; ctx.stroke();
  // Layer 3: strand-color core, the green triangle scaled 0.5 about center.
  const core = green.map((v) => ({ x: c.x + (v.x - c.x) * 0.5, y: c.y + (v.y - c.y) * 0.5 }));
  poly(core);
  ctx.fillStyle = coreCss; ctx.fill();
}

function drawCircleGlyph(ctx: CanvasRenderingContext2D, c: Point, z: number, coreCss: string): void {
  const arc = (rad: number) => { ctx.beginPath(); ctx.arc(c.x, c.y, rad, 0, Math.PI * 2); };
  arc(CP_R * z); ctx.lineWidth = GLYPH_STROKE_W * z; ctx.strokeStyle = BLACK; ctx.stroke();
  arc((CP_R - 1) * z); ctx.fillStyle = GREEN; ctx.fill();
  ctx.lineWidth = GLYPH_FILL_W * z; ctx.strokeStyle = GREEN; ctx.stroke();
  arc((CP_R - 1) * 0.5 * z); ctx.fillStyle = coreCss; ctx.fill();
}

function drawSquareGlyph(ctx: CanvasRenderingContext2D, c: Point, z: number, coreCss: string): void {
  const box = (half: number) => { ctx.beginPath(); ctx.rect(c.x - half, c.y - half, half * 2, half * 2); };
  box(SQUARE_HALF * z); ctx.lineJoin = 'miter'; ctx.lineWidth = GLYPH_STROKE_W * z; ctx.strokeStyle = BLACK; ctx.stroke();
  box((SQUARE_HALF - 1) * z); ctx.fillStyle = GREEN; ctx.fill();
  ctx.lineWidth = GLYPH_FILL_W * z; ctx.strokeStyle = GREEN; ctx.stroke();
  box((SQUARE_HALF - 1) * 0.5 * z); ctx.fillStyle = coreCss; ctx.fill();
}

function drawConnectors(ctx: CanvasRenderingContext2D, st: OverlayState, s: StrandRecord): void {
  if (!curveShaped(s)) return;
  const z = st.view.zoom;
  const [cp1, cp2] = s.control_points;
  const center = s.control_point_center;
  // Center is shown on the OSS gate (enable_third_control_point && triangle_has_moved),
  // matching the grab gate so visible == grabbable — not on control_point_center_locked.
  const showCenter = !!center && st.settings.enable_third_control_point && !!s.triangle_has_moved;
  const cp2NearStart = Math.abs(cp2.x - s.start.x) < 0.1 && Math.abs(cp2.y - s.start.y) < 0.1;
  const seg = (a: Point, b: Point) => {
    const pa = worldToScreen(a, st.view); const pb = worldToScreen(b, st.view);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  };
  ctx.save();
  ctx.setLineDash([4 * z, 3 * z]);
  ctx.lineWidth = GLYPH_FILL_W * z;
  ctx.strokeStyle = GREEN;
  seg(s.start, cp1);
  seg(cp2NearStart ? s.start : s.end, cp2);
  if (showCenter && center) { seg(center, cp1); seg(center, cp2); }
  ctx.restore();
}

function drawGlyphs(ctx: CanvasRenderingContext2D, st: OverlayState, s: StrandRecord): void {
  const z = st.view.zoom;
  const coreCss = css(s.color);
  const [cp1, cp2] = s.control_points;
  // Triangle (cp1) is always shown when control points are enabled.
  drawTriangleGlyph(ctx, worldToScreen(cp1, st.view), z, coreCss);
  if (curveShaped(s)) drawCircleGlyph(ctx, worldToScreen(cp2, st.view), z, coreCss);
  if (s.control_point_center && st.settings.enable_third_control_point && s.triangle_has_moved) {
    drawSquareGlyph(ctx, worldToScreen(s.control_point_center, st.view), z, coreCss);
  }
}

// ---------------------------------------------------------------------------
// Move-mode overlay squares (drawn on top of the glyphs).
// ---------------------------------------------------------------------------

function overlaySquare(ctx: CanvasRenderingContext2D, c: Point, halfWorld: number, z: number, fill: string): void {
  const half = halfWorld * z;
  ctx.beginPath(); ctx.rect(c.x - half, c.y - half, half * 2, half * 2);
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineJoin = 'miter'; ctx.lineWidth = HANDLE_BORDER_W * z; ctx.strokeStyle = BLACK; ctx.stroke();
}

function drawMoveOverlays(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const { doc, view, selection, hover, dragging } = st;
  const isEndpoint = (h: HandleKind) => h === 'start' || h === 'end';
  const draw = (name: string, h: { handle: HandleKind; pos: Point }) => {
    const p = worldToScreen(h.pos, view);
    const isEnd = isEndpoint(h.handle);
    const moving = dragging && selection.layerName === name && selection.handle === h.handle;
    const hovered = !dragging && hover.layerName === name && hover.handle === h.handle;
    const fill = moving || hovered ? FILL_HOT : isEnd ? FILL_ENDPOINT_IDLE : FILL_CP_IDLE;
    overlaySquare(ctx, p, isEnd ? ENDPOINT_HALF : CP_HALF, view.zoom, fill);
  };
  // During a move drag OSS suppresses every OTHER strand's handle squares (the
  // per-strand `continue` in strand_drawing_canvas.py), showing only the affected
  // strand's squares (its grabbed handle pale-yellow, its other handles idle). At
  // rest/hover we still show every strand's squares.
  const affected = dragging ? selection.layerName : null;
  // Endpoint (120px) squares first, then control-point (50px) squares on top, so
  // a cp1 square sitting on a fresh strand's start isn't hidden by the big square.
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!interactable(s, doc)) continue;
    if (affected && name !== affected) continue;
    for (const h of strandHandles(s, st.settings.enable_third_control_point)) if (isEndpoint(h.handle)) draw(name, h);
  }
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!interactable(s, doc)) continue;
    if (affected && name !== affected) continue;
    for (const h of strandHandles(s, st.settings.enable_third_control_point)) if (!isEndpoint(h.handle)) draw(name, h);
  }
}

// ---------------------------------------------------------------------------
// Attach-mode overlay circles at free endpoints (drawn on top of the glyphs).
// ---------------------------------------------------------------------------

function overlayCircle(ctx: CanvasRenderingContext2D, c: Point, rWorld: number, z: number, fill: string): void {
  const r = rWorld * z;
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = HANDLE_BORDER_W * z; ctx.strokeStyle = BLACK; ctx.stroke();
}

function drawAttachOverlays(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const { doc, view, hover, pending } = st;
  // During an active drag the original draws ONLY the real growing strand (its
  // optimized_paint_event: background + active_strand.draw + control points) — NO
  // attach-target circles. Those translucent circles are idle hover hints shown
  // BEFORE the press, so suppress them while dragging and let drawPending be the
  // sole preview.
  if (st.dragging) return;
  const ends: [keyof Pick<StrandRecord, 'start' | 'end'>, 0 | 1, HandleKind][] = [
    ['start', 0, 'start'], ['end', 1, 'end'],
  ];
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!interactable(s, doc)) continue;
    for (const [key, side, handle] of ends) {
      if (s.has_circles[side]) continue;                  // occupied -> not attachable
      const p = worldToScreen(s[key], view);
      const hovered = hover.layerName === name && hover.handle === handle;
      const affected = !!pending && pending.kind === 'attach' && pending.parent === name && pending.side === side;
      const fill = hovered || affected ? FILL_ATTACH_HOT : side === 0 ? FILL_ATTACH_START : FILL_ATTACH_END;
      overlayCircle(ctx, p, ATTACH_R, view.zoom, fill);
    }
  }
}

// New-strand / attach preview: draws the REAL two-layer strand body (outer
// stroke band + inner body band, both solid) growing under the cursor, mirroring
// the renderer's drawStrand. Parent dims/colors for attach, DEFAULT_* for new.
// For attach we also draw the renderer's start half-circle cap at the parent
// endpoint (outer stroke half + inner body fill, radius from the parent width),
// matching attached_strand.py::draw's start circle so it looks identical on commit.
function drawPending(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const { view, pending, doc } = st;
  if (!pending) return;
  const z = view.zoom;
  let width = DEFAULT_STRAND_WIDTH, sw = DEFAULT_STROKE_WIDTH;
  let body = DEFAULT_STRAND_COLOR, stroke = DEFAULT_STROKE_COLOR;
  if (pending.kind === 'attach' && pending.parent) {
    const par = doc.strands[pending.parent];
    if (par) { width = par.width; sw = par.stroke_width; body = par.color; stroke = par.stroke_color; }
  }
  const bodyCss = `rgba(${body.r},${body.g},${body.b},1)`;
  const strokeCss = `rgba(${stroke.r},${stroke.g},${stroke.b},1)`;
  const a = worldToScreen(pending.start, view);
  const b = worldToScreen(pending.end, view);
  ctx.save();
  // FLAT (butt) caps: the real body runs exactly start->end with no bulge past the
  // endpoints (round caps made the preview balloon past both ends). The rounded
  // join at the attachment point comes ONLY from the start cap below, like the
  // renderer.
  ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  const angle = Math.atan2(b.y - a.y, b.x - a.x);   // start->end tangent (into body)
  const line = (lw: number, color: string) => {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.stroke();
  };
  // Mirror the renderer's two fill layers (strand-renderer.js drawStrand): the
  // black stroke layer entirely UNDER the body fill layer. Attach also gets the
  // start cap (collectCaps: capOuterStart = black half-circle R=(w+2sw)/2 pointing
  // AWAY from the body; capInner = body-color FULL circle R=w/2) so the join is
  // identical to the committed strand.
  const startCap = pending.kind === 'attach';
  // Layer 1 — stroke (black): outer band, then the outer cap half-circle.
  line((width + sw * 2) * z, strokeCss);
  if (startCap) {
    ctx.beginPath();
    ctx.arc(a.x, a.y, (width + sw * 2) * 0.5 * z, angle + Math.PI / 2, angle + (3 * Math.PI) / 2);
    ctx.closePath();
    ctx.fillStyle = strokeCss; ctx.fill();
  }
  // Layer 2 — fill (body): inner band, then the inner full circle, on top of black.
  line(width * z, bodyCss);
  if (startCap) {
    ctx.beginPath();
    ctx.arc(a.x, a.y, width * 0.5 * z, 0, Math.PI * 2);
    ctx.fillStyle = bodyCss; ctx.fill();
  }
  // Side lines (collectSideLines), drawn LAST (on top): a flat stroke-color bar
  // across each circle-less visible end — the black flat-end edge. Length (w+2sw),
  // thickness sw, shifted sw/2 along the tangent. The free cursor end always gets
  // one; a 'new' strand's free start does too. The attach start has the cap, not a
  // side line (mirrors `*_line_visible && !has_circles[side]`).
  const sideBar = (center: Point, alongSign: number) => {
    const perp = angle + Math.PI / 2;
    const halfLen = (width + sw * 2) * 0.5 * z;
    const sh = sw * 0.5 * z * alongSign;
    const cx = center.x + sh * Math.cos(angle), cy = center.y + sh * Math.sin(angle);
    ctx.beginPath();
    ctx.moveTo(cx - halfLen * Math.cos(perp), cy - halfLen * Math.sin(perp));
    ctx.lineTo(cx + halfLen * Math.cos(perp), cy + halfLen * Math.sin(perp));
    ctx.lineWidth = sw * z; ctx.strokeStyle = strokeCss; ctx.stroke();
  };
  if (!startCap) sideBar(a, -1);   // 'new': free start end
  sideBar(b, 1);                   // free cursor end (both 'new' and 'attach')
  ctx.restore();
}

// Mask-mode body highlight (OSS MaskMode.draw, mask_mode.py:237-312): OSS strokes
// get_path() into a body-band polygon (width + 2*stroke_width, FLAT caps + MITER
// joins) and draws it ONCE with brush=`fill` + pen=`outline` — i.e. the band is
// FILLED with the (semi-transparent) colour and its PERIMETER is stroked with a 2px
// border. We must do the same: fill an offset-outline polygon (so the translucent
// yellow/red composites over the STRAND showing through #c, NOT over an opaque
// band) and stroke only its edge. Drawing a solid band under the fill would make
// the translucent colour composite over black and come out far too dark.
// Used for the HOVER hint (yellow@170 fill + solid black 2px border) and the
// PICKED/selection highlight (red@128 fill + black@128 border).
const MASK_HL_BORDER = 2;                            // OSS pen width 2 (world px ×zoom)
function maskBodyHighlight(
  ctx: CanvasRenderingContext2D, st: OverlayState, layer: string,
  fill: string, outline: string,
): void {
  const s = st.doc.strands[layer];
  if (!s || s.type === 'MaskedStrand') return;
  const world = sampleCenterline(s, st.settings.curve_params);
  if (world.length < 2) return;
  const pts = world.map((wp) => worldToScreen(wp, st.view));
  const half = (s.width + s.stroke_width * 2) * st.view.zoom / 2;   // body half-width
  // Offset the centerline by ±half along the local normal to get the two long
  // edges; closing left-forward + right-back yields the band polygon with FLAT
  // (squared) caps at both ends (matching Qt FlatCap).
  const left: Point[] = [], right: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const nx = -dy, ny = dx;                                  // unit normal
    left.push({ x: pts[i].x + nx * half, y: pts[i].y + ny * half });
    right.push({ x: pts[i].x - nx * half, y: pts[i].y - ny * half });
  }
  ctx.save();
  ctx.beginPath();
  left.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineJoin = 'miter';
  ctx.lineWidth = MASK_HL_BORDER * st.view.zoom; ctx.strokeStyle = outline; ctx.stroke();
  ctx.restore();
}

// OSS highlight colors (mask_mode.py): hover = yellow QColor(255,230,160,170) fill
// + solid black border; picked = highlight_color (red) @128 fill + black @128 border.
const MASK_HOVER_FILL = 'rgba(255,230,160,0.667)';
const MASK_HOVER_OUTLINE = 'rgba(0,0,0,1)';
const MASK_PICK_FILL = 'rgba(255,0,0,0.5)';
const MASK_PICK_OUTLINE = 'rgba(0,0,0,0.5)';

// ---------------------------------------------------------------------------
// Strand name labels (OSS should_draw_names / draw_strand_label).
// ---------------------------------------------------------------------------

// OSS _calculate_strand_curve_center: the point ON the curve where the label sits.
//   * locked 3rd control point  -> the center control point IS the curve midpoint;
//   * straight (cp1 & cp2 on start) -> the linear midpoint;
//   * otherwise the "virtual center" = midpoint of cp1 and cp2.
function strandLabelCenter(s: StrandRecord): Point {
  if (s.control_point_center_locked && s.control_point_center) return s.control_point_center;
  const [cp1, cp2] = s.control_points;
  const onStart = (p: Point) => Math.abs(p.x - s.start.x) < 1 && Math.abs(p.y - s.start.y) < 1;
  if (onStart(cp1) && onStart(cp2)) return { x: (s.start.x + s.end.x) / 2, y: (s.start.y + s.end.y) / 2 };
  return { x: (cp1.x + cp2.x) / 2, y: (cp1.y + cp2.y) / 2 };
}

// OSS draw_strand_label: layer_name centered on the curve center, font size 12,
// drawn as a white outline (pen width 6) under solid black fill text. Scales with
// zoom (the OSS font lives under the canvas zoom transform).
function drawStrandNames(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const z = st.view.zoom;
  ctx.save();
  ctx.font = `${12 * z}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const name of st.doc.order) {
    const s = st.doc.strands[name];
    if (!s || s.is_hidden) continue;
    let center: Point | null;
    if (s.type === 'MaskedStrand') {
      const comp = maskComponents(name);
      const a = comp && st.doc.strands[comp.first];
      const b = comp && st.doc.strands[comp.second];
      center = a && b ? maskCentroid(a, b, st.settings.curve_params, s.deletion_rectangles) : null;
    } else {
      center = strandLabelCenter(s);
    }
    if (!center) continue;
    const p = worldToScreen(center, st.view);
    ctx.strokeStyle = 'rgb(255,255,255)';
    ctx.lineWidth = 6 * z;
    ctx.strokeText(name, p.x, p.y);
    ctx.fillStyle = 'rgb(0,0,0)';
    ctx.fillText(name, p.x, p.y);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Angle-adjust overlay (OSS AngleAdjustMode.draw): a faded line at the strand's
// ORIGINAL orientation, an arc at the pivot (start) spanning the rotation, and the
// adjusted strand drawn as a green line.
// ---------------------------------------------------------------------------

function drawAngleOverlay(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const sess = st.angleEditInitial;
  const s = st.angleEditTarget ? st.doc.strands[st.angleEditTarget] : undefined;
  if (!sess || !s) return;
  const z = st.view.zoom;
  const startS = worldToScreen(s.start, st.view);
  const endS = worldToScreen(s.end, st.view);
  const init0 = (sess.angle0 * Math.PI) / 180;
  const initEnd = worldToScreen(
    { x: sess.start.x + Math.cos(init0) * sess.length0, y: sess.start.y + Math.sin(init0) * sess.length0 },
    st.view,
  );
  ctx.save();
  // Faded original orientation (OSS draws the original strand at 0.5 opacity; we
  // approximate with a translucent gray line — the overlay can't cheaply re-draw
  // the full body that lives in #c).
  ctx.strokeStyle = 'rgba(120,120,120,0.5)';
  ctx.lineWidth = 2 * z;
  ctx.beginPath(); ctx.moveTo(startS.x, startS.y); ctx.lineTo(initEnd.x, initEnd.y); ctx.stroke();
  // Angle arc at the pivot, radius min(50, width*2), highlight color, spanning the
  // swept rotation (initial -> current, minor direction).
  const r = Math.min(50, s.width * 2) * z;
  const cur = Math.atan2(s.end.y - s.start.y, s.end.x - s.start.x);
  let span = cur - init0;
  while (span > Math.PI) span -= 2 * Math.PI;
  while (span < -Math.PI) span += 2 * Math.PI;
  ctx.strokeStyle = css(st.settings.highlight_color);
  ctx.lineWidth = 2 * z;
  ctx.beginPath(); ctx.arc(startS.x, startS.y, r, init0, init0 + span, span < 0); ctx.stroke();
  // Adjusted strand: green line start -> current end.
  ctx.strokeStyle = 'rgb(0,255,0)';
  ctx.lineWidth = 2 * z;
  ctx.beginPath(); ctx.moveTo(startS.x, startS.y); ctx.lineTo(endS.x, endS.y); ctx.stroke();
  ctx.restore();
}

export function drawOverlay(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const { doc, selection, mode } = st;

  // NOTE: the reference grid is NOT drawn here. The overlay canvas (#overlay) sits
  // ABOVE the strand canvas (#c), so a grid drawn here painted OVER the layers. The
  // grid is now rendered inside strand-renderer.js (renderFixture/renderDragFrame),
  // after the white bg and before the strands, so it composites UNDER the bodies.

  // Yellow body HOVER highlight on the strand under the cursor. OSS draws this in
  // BOTH select mode (select_mode.py:101-136) and mask mode (mask_mode.py:237-270)
  // with the identical QColor(255,230,160,170) fill + black 2px border. In mask mode
  // it is suppressed for an already-picked strand, and each picked strand instead
  // gets the red@128 selection highlight (mask_mode.py:272-312).
  if (mode === 'select' && st.hover.layerName) {
    maskBodyHighlight(ctx, st, st.hover.layerName, MASK_HOVER_FILL, MASK_HOVER_OUTLINE);
  } else if (mode === 'mask') {
    const hov = st.hover.layerName;
    if (hov && !st.maskPending.includes(hov)) {
      maskBodyHighlight(ctx, st, hov, MASK_HOVER_FILL, MASK_HOVER_OUTLINE);
    }
    for (const layer of st.maskPending) maskBodyHighlight(ctx, st, layer, MASK_PICK_FILL, MASK_PICK_OUTLINE);
  }

  // Mask-EDIT eraser rectangle (OSS mask_edit_mode paint, strand_drawing_canvas.py
  // 2769-2772): semi-transparent WHITE fill + a white 1px DASHED outline.
  if (st.eraser) {
    const r = st.eraser.rect;
    const a = worldToScreen({ x: r.minX, y: r.minY }, st.view);
    const b = worldToScreen({ x: r.maxX, y: r.maxY }, st.view);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }

  // The selection highlight is drawn in the renderer (#c), under the body — see
  // strand-renderer.js::drawHighlight — so it is NOT drawn here.

  // Persistent control-point glyph layer (all visible strands). During a move
  // drag OSS draws control-point glyphs ONLY for the affected strand
  // (draw_control_points should_skip = not is_affected), so suppress every other
  // strand's green triangle/circle/square + dashed connectors for the gesture.
  //
  // OSS View mode: when view_hide_control_points is on and we're in View mode,
  // draw_control_points early-returns (strand_drawing_canvas.py:5941-5942) —
  // independent of the global show_control_points toggle, exactly like OSS.
  if (doc.show_control_points && !(mode === 'view' && st.settings.view_hide_control_points)) {
    const affected = st.dragging && mode === 'move' && selection.handle ? selection.layerName : null;
    for (const name of doc.order) {
      const s = doc.strands[name];
      if (!interactable(s, doc)) continue;
      if (affected && name !== affected) continue;
      drawConnectors(ctx, st, s);
      drawGlyphs(ctx, st, s);
    }
  }

  // New-strand / attach preview (the strand being drawn), under the overlays.
  if (st.pending) drawPending(ctx, st);

  // Mode-specific endpoint/CP handles, drawn last (on top, translucent).
  if (mode === 'move') drawMoveOverlays(ctx, st);
  else if (mode === 'attach') drawAttachOverlays(ctx, st);
  else if (mode === 'angle' && st.angleEditTarget) drawAngleOverlay(ctx, st);

  // Strand name labels on top of everything (OSS draws them after control points).
  if (st.drawNames) drawStrandNames(ctx, st);
}
