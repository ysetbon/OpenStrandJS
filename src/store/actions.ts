// Pure document mutators used by interaction modes. They mutate a DRAFT document
// (a structural clone owned by the store), so callers wrap them in
// store.mutateDoc(draft => ...). No object cross-references, so drafts stay
// JSON-serializable for future snapshot history.

import type { EditorDocument, HandleKind, Point, RGBA, Settings, StrandRecord } from '../model/types';
import { weldedEndpoints } from '../interaction/connections';
import { makeAttachedStrand, makeStrand } from '../model/factory';
import { maskComponents, nextFreeSet, nextIndexInSet } from '../model/layerName';

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

  // The center is the cp midpoint unless it has been pinned (locked).
  const recenter = (t: StrandRecord) => {
    if (!t.control_point_center_locked) {
      t.control_point_center = {
        x: (t.control_points[0].x + t.control_points[1].x) / 2,
        y: (t.control_points[0].y + t.control_points[1].y) / 2,
      };
    }
  };

  if (handle === 'control_point1') {
    s.control_points[0] = pos;
    s.triangle_has_moved = true;
    s.control_point2_shown = true;        // cp1's first move reveals cp2 (passive -> shown)
    recenter(s);
    return;
  }
  if (handle === 'control_point2') {
    s.control_points[1] = pos;
    s.control_point2_activated = true;    // dragging cp2 makes it independent
    recenter(s);
    return;
  }
  if (handle === 'control_point_center') {
    // Dragging the third control point pins it; the renderer then uses the
    // 3-point profile and the center no longer tracks the cp midpoint.
    s.control_point_center = pos;
    s.control_point_center_locked = true;
    return;
  }

  // Endpoint move: faithful port of update_end -- a control point follows its
  // endpoint ONLY when it sits at that endpoint's default (coincident) position;
  // a manually-placed control point stays put so the curve reshapes. Welded
  // peers move with it. Center is recomputed as the cp midpoint unless pinned.
  const cur = handle === 'start' ? s.start : s.end;
  const delta = { x: pos.x - cur.x, y: pos.y - cur.y };
  if (delta.x === 0 && delta.y === 0) return;
  const EPS = 1e-3;

  for (const ep of weldedEndpoints(draft, layerName, handle)) {
    const t = draft.strands[ep.layer];
    if (!t) continue;
    const pt = ep.end === 'start' ? t.start : t.end;
    const old = { x: pt.x, y: pt.y };
    pt.x += delta.x; pt.y += delta.y;
    const cpIdx = ep.end === 'start' ? 0 : 1;
    const cp = t.control_points[cpIdx];
    if (Math.hypot(cp.x - old.x, cp.y - old.y) < EPS) { cp.x += delta.x; cp.y += delta.y; }
    recenter(t);
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

// Add an eraser rectangle (world space) to a mask's deletion_rectangles. The
// renderer subtracts these from the over/under overlap, revealing the under
// strand. Stored in the desktop's corner-array format (absolute coords).
export function addDeletionRect(
  draft: EditorDocument,
  maskLayer: string,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
): void {
  const m = draft.strands[maskLayer];
  if (!m || m.type !== 'MaskedStrand') return;
  if (!m.deletion_rectangles) m.deletion_rectangles = [];
  m.deletion_rectangles.push({
    top_left: [rect.minX, rect.minY],
    top_right: [rect.maxX, rect.minY],
    bottom_left: [rect.minX, rect.maxY],
    bottom_right: [rect.maxX, rect.maxY],
  });
}

// Reset a mask to the full intersection (drop all eraser rectangles).
export function resetMask(draft: EditorDocument, maskLayer: string): void {
  const m = draft.strands[maskLayer];
  if (m && m.type === 'MaskedStrand') m.deletion_rectangles = [];
}

// Delete a strand and everything that depends on it: attached descendants (and
// theirs), and any MaskedStrand whose components include a removed strand. Frees
// the parent endpoint's circle when an attached strand is removed.
export function deleteStrand(draft: EditorDocument, name: string): void {
  const target = draft.strands[name];
  if (!target) return;
  const toRemove = new Set<string>([name]);

  if (target.type !== 'MaskedStrand') {
    const collect = (n: string) => {
      for (const k of Object.keys(draft.strands)) {
        const s = draft.strands[k];
        if (s.type === 'AttachedStrand' && s.attached_to === n && !toRemove.has(k)) {
          toRemove.add(k);
          collect(k);
        }
      }
    };
    collect(name);
    if (target.type === 'AttachedStrand' && target.attached_to != null && target.attachment_side != null) {
      const parent = draft.strands[target.attached_to];
      if (parent) parent.has_circles[target.attachment_side] = false;
    }
  }

  // Masks that reference any removed strand also go.
  for (const k of Object.keys(draft.strands)) {
    if (draft.strands[k].type !== 'MaskedStrand') continue;
    const comp = maskComponents(k);
    if (comp && (toRemove.has(comp.first) || toRemove.has(comp.second))) toRemove.add(k);
  }

  for (const k of toRemove) delete draft.strands[k];
  draft.order = draft.order.filter((n) => !toRemove.has(n));
  draft.locked_layers = draft.locked_layers.filter((n) => !toRemove.has(n));
  if (draft.selected_strand_name && toRemove.has(draft.selected_strand_name)) draft.selected_strand_name = null;
}

export function deleteAllStrands(draft: EditorDocument): void {
  draft.strands = {};
  draft.order = [];
  draft.locked_layers = [];
  draft.selected_strand_name = null;
}

// Move order[from] to position `to` (both are indices into doc.order = z-order).
export function reorderLayer(draft: EditorDocument, from: number, to: number): void {
  const n = draft.order.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
  const [moved] = draft.order.splice(from, 1);
  draft.order.splice(to, 0, moved);
}

export function toggleHidden(draft: EditorDocument, name: string): void {
  const s = draft.strands[name];
  if (s) s.is_hidden = !s.is_hidden;
}

// Set fill or stroke color on a strand, optionally across its whole set (every
// non-masked strand sharing set_number) — the desktop's color-propagation rule.
export function setColor(
  draft: EditorDocument,
  name: string,
  kind: 'fill' | 'stroke',
  color: RGBA,
  wholeSet: boolean,
): void {
  const s = draft.strands[name];
  if (!s) return;
  const apply = (t: StrandRecord) => {
    if (kind === 'fill') t.color = { ...color };
    else t.stroke_color = { ...color };
  };
  if (wholeSet) {
    for (const k of Object.keys(draft.strands)) {
      const t = draft.strands[k];
      if (t.type !== 'MaskedStrand' && t.set_number === s.set_number) apply(t);
    }
  } else {
    apply(s);
  }
}

// Set fill width or stroke width, optionally across the whole set.
export function setWidth(
  draft: EditorDocument,
  name: string,
  kind: 'width' | 'stroke_width',
  value: number,
  wholeSet: boolean,
): void {
  const s = draft.strands[name];
  if (!s) return;
  const apply = (t: StrandRecord) => { t[kind] = value; };
  if (wholeSet) {
    for (const k of Object.keys(draft.strands)) {
      const t = draft.strands[k];
      if (t.type !== 'MaskedStrand' && t.set_number === s.set_number) apply(t);
    }
  } else {
    apply(s);
  }
}

export function setShadowOnly(draft: EditorDocument, name: string, value: boolean): void {
  const s = draft.strands[name];
  if (s) s.shadow_only = value;
}

// Dev-only debug handle for testing actions directly.
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__actions = {
    moveHandle, addNewStrand, attachChild, createMask, addDeletionRect, resetMask,
    deleteStrand, deleteAllStrands, reorderLayer, toggleHidden, toggleLock,
    setColor, setWidth, setShadowOnly,
  };
}

export function toggleLock(draft: EditorDocument, name: string): void {
  const i = draft.locked_layers.indexOf(name);
  if (i >= 0) draft.locked_layers.splice(i, 1);
  else draft.locked_layers.push(name);
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
