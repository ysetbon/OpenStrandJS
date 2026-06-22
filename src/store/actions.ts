// Pure document mutators used by interaction modes. They mutate a DRAFT document
// (a structural clone owned by the store), so callers wrap them in
// store.mutateDoc(draft => ...). No object cross-references, so drafts stay
// JSON-serializable for future snapshot history.

import type { EditorDocument, HandleKind, Point, RGBA, Settings, StrandRecord } from '../model/types';
import { weldedEndpoints } from '../interaction/connections';
import { makeAttachedStrand, makeStrand } from '../model/factory';
import { nextFreeSet, nextIndexInSet } from '../model/layerName';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// Snap `end` so the segment start->end lies on a 45-degree increment, keeping
// length (the desktop locks the first strand of a set to 45-degree angles).
export function snapAngle45(start: Point, end: Point): Point {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { ...end };
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: start.x + Math.cos(ang) * len, y: start.y + Math.sin(ang) * len };
}

export function snapPoint(p: Point, settings: Settings): Point {
  if (!settings.snap_to_grid_enabled || settings.grid_size <= 0) return p;
  const g = settings.grid_size;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

// Move a handle to a new world position. Endpoints drag their welded peers (and
// each strand's associated control point) rigidly; control points move alone.
export function moveHandle(
  draft: EditorDocument,
  layerName: string,
  handle: HandleKind,
  pos: Point,
): void {
  const s = draft.strands[layerName];
  if (!s) return;

  if (handle === 'control_point1') { s.control_points[0] = pos; s.triangle_has_moved = true; return; }
  if (handle === 'control_point2') { s.control_points[1] = pos; s.control_point2_activated = true; return; }
  if (handle === 'control_point_center') { s.control_point_center = pos; return; }

  // Endpoint move: rigid propagation across the weld group.
  const cur = handle === 'start' ? s.start : s.end;
  const delta = { x: pos.x - cur.x, y: pos.y - cur.y };
  if (delta.x === 0 && delta.y === 0) return;

  for (const ep of weldedEndpoints(draft, layerName, handle)) {
    const t = draft.strands[ep.layer];
    if (!t) continue;
    const pt = ep.end === 'start' ? t.start : t.end;
    pt.x += delta.x; pt.y += delta.y;
    // Carry the associated control point so straight strands stay straight and
    // curves keep their shape relative to the moved end.
    const cpIdx = ep.end === 'start' ? 0 : 1;
    t.control_points[cpIdx] = { x: t.control_points[cpIdx].x + delta.x, y: t.control_points[cpIdx].y + delta.y };
    if (t.control_point_center) {
      t.control_point_center = { x: t.control_point_center.x + delta.x * 0.5, y: t.control_point_center.y + delta.y * 0.5 };
    }
  }
}

// Create a free first strand of a brand-new set. Returns the new layer_name.
export function addNewStrand(draft: EditorDocument, start: Point, end: Point, color?: RGBA): string {
  const set = nextFreeSet(draft);
  const layer_name = `${set}_1`;
  const s = makeStrand({ layer_name, set_number: set, start, end, color, is_first_strand: true });
  draft.strands[layer_name] = s;
  draft.order.push(layer_name);
  return layer_name;
}

// Attach a child strand to a free parent endpoint. Marks the parent endpoint
// occupied (has_circles[side]=true). Returns the new layer_name.
export function attachChild(
  draft: EditorDocument,
  parentName: string,
  side: 0 | 1,
  start: Point,
  end: Point,
): string | null {
  const parent = draft.strands[parentName];
  if (!parent) return null;
  const set = parent.set_number;
  const idx = nextIndexInSet(draft, set);
  const layer_name = `${set}_${idx}`;
  const child = makeAttachedStrand({
    layer_name, set_number: set, start, end,
    color: clone(parent.color), width: parent.width, stroke_width: parent.stroke_width,
    attached_to: parentName, attachment_side: side,
  });
  parent.has_circles[side] = true;
  draft.strands[layer_name] = child;
  draft.order.push(layer_name);
  return layer_name;
}

// Create an over/under MaskedStrand from two existing strands. `first` is OVER,
// `second` is UNDER. layer_name concatenates the components ("a_b_c_d"). The
// renderer resolves components by name, so the mask inherits the first strand's
// paint for serialization only. Returns the new layer_name, or null if invalid.
export function createMask(draft: EditorDocument, first: string, second: string): string | null {
  if (first === second) return null;
  const a = draft.strands[first], b = draft.strands[second];
  if (!a || !b || a.type === 'MaskedStrand' || b.type === 'MaskedStrand') return null;
  const layer_name = `${first}_${second}`;
  if (draft.strands[layer_name]) return null; // duplicate mask
  const mask: StrandRecord = {
    type: 'MaskedStrand',
    layer_name,
    set_number: a.set_number,
    start: clone(a.start),
    end: clone(a.end),
    control_points: [clone(a.start), clone(a.end)],
    control_point_center: null,
    control_point_center_locked: false,
    width: a.width,
    stroke_width: a.stroke_width,
    color: clone(a.color),
    stroke_color: clone(a.stroke_color),
    has_circles: [false, false],
    is_hidden: false,
    shadow_only: false,
    circle_stroke_color: null,
    knot_connections: {},
    deletion_rectangles: [],
    using_absolute_coords: false,
    extra: {
      is_start_side: true,
      manual_circle_visibility: [null, null],
      start_line_visible: true,
      end_line_visible: true,
      start_extension_visible: false,
      end_extension_visible: false,
      start_arrow_visible: false,
      end_arrow_visible: false,
      full_arrow_visible: false,
      closed_connections: [false, false],
    },
  };
  draft.strands[layer_name] = mask;
  draft.order.push(layer_name);
  return layer_name;
}
