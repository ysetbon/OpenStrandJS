// areVisuallyEqual: do two documents render identically? Used to (a) skip
// pushing an undo snapshot when a gesture changed nothing visible, and (b) avoid
// dead undo/redo steps. Port of the desktop's dedup with its tolerances.
//
// EXCLUDED from the comparison: shadow_enabled, show_control_points (canvas
// toggles preserved across undo, never undone). INCLUDED: shadow_overrides.

import type { DeletionRect, EditorDocument, Point, RGBA, StrandRecord } from '../model/types';

const approx = (x: number, y: number) => Math.abs(x - y) < 0.1;

const ptEq = (p: Point | null | undefined, q: Point | null | undefined): boolean => {
  if (!p && !q) return true;
  if (!p || !q) return false;
  return approx(p.x, q.x) && approx(p.y, q.y);
};

const rgbaEq = (a: RGBA, b: RGBA) => a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

// circle stroke colors transition null <-> value; treat that as a change.
const rgbaNullEq = (a: RGBA | null, b: RGBA | null): boolean => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return rgbaEq(a, b);
};

// Order-independent signature of the deletion rectangles (corner or x/y/w/h form).
const rectSig = (rects: DeletionRect[] = []): string =>
  rects.map((r) => {
    if (r.top_left) {
      return [r.top_left, r.top_right, r.bottom_left, r.bottom_right]
        .map((c) => (c ? `${Math.round(c[0])},${Math.round(c[1])}` : '_')).join('|');
    }
    return `${Math.round(r.x ?? 0)},${Math.round(r.y ?? 0)},${Math.round(r.width ?? 0)},${Math.round(r.height ?? 0)}`;
  }).sort().join(';');

export function strandVisualEqual(a: StrandRecord, b: StrandRecord): boolean {
  if (a.type !== b.type) return false;
  if (!ptEq(a.start, b.start) || !ptEq(a.end, b.end)) return false;
  if (!ptEq(a.control_points[0], b.control_points[0]) || !ptEq(a.control_points[1], b.control_points[1])) return false;
  if (!ptEq(a.control_point_center, b.control_point_center)) return false;
  if (!!a.control_point_center_locked !== !!b.control_point_center_locked) return false;
  if (!approx(a.width, b.width) || !approx(a.stroke_width, b.stroke_width)) return false;
  if (!rgbaEq(a.color, b.color) || !rgbaEq(a.stroke_color, b.stroke_color)) return false;
  if (!rgbaNullEq(a.circle_stroke_color, b.circle_stroke_color)) return false;
  if (a.has_circles[0] !== b.has_circles[0] || a.has_circles[1] !== b.has_circles[1]) return false;
  if (!!a.is_hidden !== !!b.is_hidden || !!a.shadow_only !== !!b.shadow_only) return false;
  if (!!a.hide_shadow !== !!b.hide_shadow) return false;
  if ((a.attached_to ?? null) !== (b.attached_to ?? null)) return false;
  if ((a.attachment_side ?? null) !== (b.attachment_side ?? null)) return false;
  if (rectSig(a.deletion_rectangles) !== rectSig(b.deletion_rectangles)) return false;
  if (JSON.stringify(a.knot_connections ?? {}) !== JSON.stringify(b.knot_connections ?? {})) return false;
  return true;
}

export function areVisuallyEqual(a: EditorDocument, b: EditorDocument): boolean {
  if (a.order.length !== b.order.length) return false;
  for (let i = 0; i < a.order.length; i++) if (a.order[i] !== b.order[i]) return false; // z-order is visual
  for (const name of a.order) {
    const sa = a.strands[name], sb = b.strands[name];
    if (!sa || !sb || !strandVisualEqual(sa, sb)) return false;
  }
  if (JSON.stringify(a.shadow_overrides ?? {}) !== JSON.stringify(b.shadow_overrides ?? {})) return false;
  return true; // shadow_enabled / show_control_points intentionally excluded
}
