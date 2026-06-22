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
import {
  DEFAULT_STRAND_COLOR, DEFAULT_STRAND_WIDTH, DEFAULT_STROKE_COLOR, DEFAULT_STROKE_WIDTH,
} from '../model/factory';
import { screenToWorld, worldToScreen } from '../interaction/viewTransform';
import { strandHandles } from '../interaction/hitTest';
import { sampleCenterline } from '../interaction/hitGeometry';

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

const MASK_COLOR = '#d61f9c';
const HOT_COLOR = '#e8651a';

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
  const showCenter = !!center && s.control_point_center_locked;
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
  if (s.control_point_center && s.control_point_center_locked) {
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
  // Endpoint (120px) squares first, then control-point (50px) squares on top, so
  // a cp1 square sitting on a fresh strand's start isn't hidden by the big square.
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!interactable(s, doc)) continue;
    for (const h of strandHandles(s)) if (isEndpoint(h.handle)) draw(name, h);
  }
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!interactable(s, doc)) continue;
    for (const h of strandHandles(s)) if (!isEndpoint(h.handle)) draw(name, h);
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

// New-strand / attach rubber-band preview: a translucent body band that
// resembles the strand being created (parent dims for attach, defaults for new).
function drawPending(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const { view, pending, doc } = st;
  if (!pending) return;
  const a = worldToScreen(pending.start, view);
  const b = worldToScreen(pending.end, view);
  const z = view.zoom;
  let width = DEFAULT_STRAND_WIDTH, sw = DEFAULT_STROKE_WIDTH;
  let body = DEFAULT_STRAND_COLOR, stroke = DEFAULT_STROKE_COLOR;
  if (pending.kind === 'attach' && pending.parent) {
    const par = doc.strands[pending.parent];
    if (par) { width = par.width; sw = par.stroke_width; body = par.color; stroke = par.stroke_color; }
  }
  ctx.save();
  ctx.lineCap = 'round';
  const line = (lw: number, color: string) => {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.stroke();
  };
  line((width + sw * 2) * z, `rgba(${stroke.r},${stroke.g},${stroke.b},0.40)`);
  line(width * z, `rgba(${body.r},${body.g},${body.b},0.55)`);
  ctx.restore();
}

// ---------------------------------------------------------------------------

function drawGrid(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const g = st.settings.grid_size;
  if (!st.settings.show_grid || g <= 0 || g * st.view.zoom < 4) return; // skip when too dense
  const w = st.view.width, h = st.view.height;
  const tl = screenToWorld({ x: 0, y: 0 }, st.view);
  const br = screenToWorld({ x: w, y: h }, st.view);
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  for (let x = Math.floor(tl.x / g) * g; x <= br.x; x += g) {
    const s = worldToScreen({ x, y: 0 }, st.view);
    ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, h); ctx.stroke();
  }
  for (let y = Math.floor(tl.y / g) * g; y <= br.y; y += g) {
    const s = worldToScreen({ x: 0, y }, st.view);
    ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(w, s.y); ctx.stroke();
  }
  ctx.restore();
}

function highlightCenterline(ctx: CanvasRenderingContext2D, st: OverlayState, layer: string, color: string): void {
  const s = st.doc.strands[layer];
  if (!s || s.type === 'MaskedStrand') return;
  const poly = sampleCenterline(s, st.settings.curve_params);
  ctx.beginPath();
  poly.forEach((wp, i) => {
    const p = worldToScreen(wp, st.view);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  ctx.lineWidth = (s.width + s.stroke_width * 2) * st.view.zoom;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.35;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const { doc, selection, mode } = st;

  drawGrid(ctx, st);

  // Mask-pending: highlight already-picked strands.
  for (const layer of st.maskPending) highlightCenterline(ctx, st, layer, MASK_COLOR);

  // Mask-edit eraser rectangle.
  if (st.eraser) {
    const r = st.eraser.rect;
    const a = worldToScreen({ x: r.minX, y: r.minY }, st.view);
    const b = worldToScreen({ x: r.maxX, y: r.maxY }, st.view);
    ctx.save();
    ctx.fillStyle = 'rgba(232,101,26,0.18)';
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2; ctx.strokeStyle = HOT_COLOR;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }

  // The selection highlight is drawn in the renderer (#c), under the body — see
  // strand-renderer.js::drawHighlight — so it is NOT drawn here.

  // Persistent control-point glyph layer (all visible strands).
  if (doc.show_control_points) {
    for (const name of doc.order) {
      const s = doc.strands[name];
      if (!interactable(s, doc)) continue;
      drawConnectors(ctx, st, s);
      drawGlyphs(ctx, st, s);
    }
  }

  // New-strand / attach preview (the strand being drawn), under the overlays.
  if (st.pending) drawPending(ctx, st);

  // Mode-specific endpoint/CP handles, drawn last (on top, translucent).
  if (mode === 'move') drawMoveOverlays(ctx, st);
  else if (mode === 'attach') drawAttachOverlays(ctx, st);
}
