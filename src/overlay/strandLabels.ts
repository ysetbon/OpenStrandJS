// "Draw Names": the strand name labels the layer panel's Draw Names button
// toggles. A faithful port of OpenStrand Studio's draw_strand_label +
// _calculate_strand_curve_center (strand_drawing_canvas.py). OSS paints these
// inside paintEvent under the canvas's zoom/pan transform, so every size below
// (12pt font, 6px white halo, 2px black outline) is a CANVAS/WORLD length that
// scales with the zoom — reproduced here by drawing under the same transform.

import type { EditorDocument, Point, Settings, StrandRecord, ViewState } from '../model/types';
import { buildMeta, toRenderArray } from '../renderer/toRenderArray';
import { callMaskLabelClip, type MaskLabelClip } from '../renderer/rendererBridge';

// Only the view fields the transform needs, so the PNG export can pass its own
// content-fit zoom/offset in place of the live viewport.
export interface LabelView { zoom: number; panX: number; panY: number; }

// painter.font() is the application default (Qt on Windows: Segoe UI) with
// setPointSize(12): 12pt at Qt's 96 dpi logical resolution is 16px.
const FONT_PX = 12 * (96 / 72);
const FONT = `${FONT_PX}px "Segoe UI", system-ui, -apple-system, sans-serif`;
const HALO_W = 6;      // QPen(Qt.white, 6)  — white outline
const OUTLINE_W = 2;   // QPen(Qt.black, 2)  — black outline over the black fill

// OSS _calculate_strand_curve_center: the point the label is centred on.
export function strandCurveCenter(s: StrandRecord, enableThird: boolean): Point {
  // Three-control-point mode with the centre locked: the centre control point IS
  // the curve's midpoint.
  if (enableThird && s.control_point_center_locked && s.control_point_center) {
    return s.control_point_center;
  }
  const cp1 = s.control_points[0], cp2 = s.control_points[1];
  const cp1AtStart = Math.abs(cp1.x - s.start.x) < 1.0 && Math.abs(cp1.y - s.start.y) < 1.0;
  const cp2AtStart = Math.abs(cp2.x - s.start.x) < 1.0 && Math.abs(cp2.y - s.start.y) < 1.0;
  // Unmoved control points: a straight line, so the linear midpoint.
  if (cp1AtStart && cp2AtStart) {
    return { x: (s.start.x + s.end.x) / 2, y: (s.start.y + s.end.y) / 2 };
  }
  // Two-control-point mode: the virtual centre between cp1 and cp2, the junction
  // of the two cubic segments strand.get_path() builds.
  return { x: (cp1.x + cp2.x) / 2, y: (cp1.y + cp2.y) / 2 };
}

// ---------------------------------------------------------------------------
// Mask label clip cache. The mask region is a paper.js boolean op (a few ms per
// mask), and the overlay repaints on every hover move, so the region is memoised
// on the geometry it depends on: the two component bodies, the deletion rects,
// and the curve settings. Any edit to those changes the key and rebuilds.
// ---------------------------------------------------------------------------
interface ClipEntry { key: string; clip: MaskLabelClip | null; path: Path2D | null; }
const clipCache = new Map<string, ClipEntry>();
const CLIP_CACHE_MAX = 64;

function geomSig(s: StrandRecord | undefined): string {
  if (!s) return '-';
  const pt = (p: Point | null | undefined) => (p ? `${p.x},${p.y}` : '-');
  return [
    s.type, pt(s.start), pt(s.end), pt(s.control_points[0]), pt(s.control_points[1]),
    pt(s.control_point_center), s.control_point_center_locked ? 1 : 0,
    s.width, s.stroke_width, s.circle_stroke_color ? (s.circle_stroke_color.a ?? 255) : '-',
    s.has_circles.join(''), s.attached_to ?? '',
  ].join('|');
}

function maskClipFor(ms: StrandRecord, doc: EditorDocument, settings: Settings): ClipEntry {
  const parts = ms.layer_name.split('_');
  const first = doc.strands[`${parts[0]}_${parts[1]}`];
  const second = doc.strands[`${parts[2]}_${parts[3]}`];
  const key = [
    geomSig(first), geomSig(second), JSON.stringify(ms.deletion_rectangles ?? []),
    JSON.stringify(settings.curve_params), settings.enable_third_control_point ? 1 : 0,
    settings.enable_curvature_bias_control ? 1 : 0, JSON.stringify(ms.extra?.bias ?? null),
    JSON.stringify(first?.extra ?? null), JSON.stringify(second?.extra ?? null),
  ].join('#');
  const hit = clipCache.get(ms.layer_name);
  if (hit && hit.key === key) return hit;
  // World-unit geometry: identity offset, no supersample, no zoom.
  const unitView: ViewState = { zoom: 1, panX: 0, panY: 0, width: 1, height: 1, supersample: 1 };
  const meta = buildMeta(doc, unitView, settings);
  let clip: MaskLabelClip | null = null;
  try {
    clip = callMaskLabelClip(ms.layer_name, toRenderArray(doc), meta);
  } catch (err) {
    console.error('[OpenStrandJS] mask label clip failed:', err);
  }
  const entry: ClipEntry = { key, clip, path: clip ? new Path2D(clip.pathData) : null };
  if (clipCache.size >= CLIP_CACHE_MAX) clipCache.clear();
  clipCache.set(ms.layer_name, entry);
  return entry;
}

// OSS draw_strand_label for one strand, drawn in WORLD units (the ctx must
// already carry the world->screen transform).
function drawLabel(ctx: CanvasRenderingContext2D, s: StrandRecord, doc: EditorDocument, settings: Settings): void {
  let center: Point;
  let clipPath: Path2D | null = null;
  if (s.type === 'MaskedStrand') {
    const entry = maskClipFor(s, doc, settings);
    // No mask region: OSS's get_mask_path() would be empty and boundingRect().center()
    // is (0,0) — nothing worth labelling, so skip the label rather than paint it
    // at the origin.
    if (!entry.clip) return;
    const b = entry.clip.bounds;
    center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    clipPath = entry.path;
  } else {
    center = strandCurveCenter(s, settings.enable_third_control_point);
  }

  const text = s.layer_name || `${s.set_number}_1`;
  ctx.font = FONT;
  const m = ctx.measureText(text);
  const textWidth = m.width;
  // QFontMetrics.height() == ascent + descent.
  const ascent = m.fontBoundingBoxAscent ?? FONT_PX * 0.9;
  const descent = m.fontBoundingBoxDescent ?? FONT_PX * 0.25;
  const textHeight = ascent + descent;
  // addText(x, y): the baseline origin, at rect.center - width/2, center + height/4.
  const x = center.x - textWidth / 2;
  const y = center.y + textHeight / 4;

  ctx.save();
  if (clipPath) ctx.clip(clipPath);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'bevel';  // QPen default join
  // White outline.
  ctx.lineWidth = HALO_W;
  ctx.strokeStyle = 'rgb(255,255,255)';
  ctx.strokeText(text, x, y);
  // Black text: fill, then the 2px black outline on top.
  ctx.fillStyle = 'rgb(0,0,0)';
  ctx.fillText(text, x, y);
  ctx.lineWidth = OUTLINE_W;
  ctx.strokeStyle = 'rgb(0,0,0)';
  ctx.strokeText(text, x, y);
  ctx.restore();
}

// Draw the label of EVERY strand in draw order (OSS paintEvent iterates
// canvas.strands with no visibility filter — hidden strands are labelled too).
export function drawStrandLabels(
  ctx: CanvasRenderingContext2D, doc: EditorDocument, settings: Settings, view: LabelView,
): void {
  ctx.save();
  // screen = world * zoom + pan (viewTransform.worldToScreen), as one transform so
  // font, halo and outline widths scale with the zoom the way Qt's do.
  ctx.transform(view.zoom, 0, 0, view.zoom, view.panX, view.panY);
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s) continue;
    drawLabel(ctx, s, doc, settings);
  }
  ctx.restore();
}
