// Pure document mutators used by interaction modes. They mutate a DRAFT document
// (a structural clone owned by the store), so callers wrap them in
// store.mutateDoc(draft => ...). No object cross-references, so drafts stay
// JSON-serializable for future snapshot history.

import type { EditorDocument, GroupRecord, HandleKind, KnotConnection, Point, RGBA, Settings, ShadowOverride, StrandRecord } from '../model/types';
import { gestureConnTable, connectedMovers } from '../interaction/connections';
import { makeAttachedStrand, makeStrand } from '../model/factory';
import { formatLayerName, maskComponents, nextFreeSet, nextIndexInSet, parseLayerName } from '../model/layerName';
import { resolveGroupMembers } from '../model/group';
import { strandsCross, strandBodiesOverlap, maskCentroid } from '../interaction/hitGeometry';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// Attach/create-mode grid snapping. Gated on snap_to_grid_attach_enabled (OSS
// EnableSnapToGridAttach) — distinct from move-mode snap (snapMove, gated on
// snap_to_grid_enabled). Both default true.
export function snapPoint(p: Point, settings: Settings): Point {
  if (!settings.snap_to_grid_attach_enabled || settings.grid_size <= 0) return p;
  const g = settings.grid_size;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

// Move-mode grid snapping — a faithful port of OSS move_mode.mouseMoveEvent's
// zoom/Ctrl-gated decision (move_mode.py:4036-4079). Four effective branches:
//   * zoom < 0.35 and not Ctrl              -> no snap (too zoomed out)
//   * (zoom >= 0.8 or Ctrl) and userSnap    -> full snap (round to grid)
//   * 0.5 <= zoom < 0.8 and userSnap        -> gentle snap, only within (grid/8)*zoom
//   * otherwise                              -> no snap
// Ctrl forces full snap ONLY when snap is already enabled (it pushes the decision into
// the full-snap branch at any zoom). When snap is DISABLED, Ctrl is a no-op: OSS's
// `elif force_grid_snap` branch calls canvas.snap_to_grid, which early-returns the point
// unchanged while snap_to_grid_enabled is False (strand_drawing_canvas.py:5177) — so
// there is NO real "Ctrl override when off". `userSnap` excludes bias controls (none yet).
export function snapMove(p: Point, settings: Settings, zoom: number, ctrl: boolean, isBias = false): Point {
  const g = settings.grid_size;
  const userSnap = settings.snap_to_grid_enabled && g > 0 && !isBias;
  if (zoom < 0.35 && !ctrl) return p;
  if ((zoom >= 0.8 || ctrl) && userSnap) return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
  if (zoom >= 0.5 && userSnap) {
    const gx = Math.round(p.x / g) * g, gy = Math.round(p.y / g) * g;
    const thr = (g / 8) * zoom;
    return Math.abs(p.x - gx) < thr && Math.abs(p.y - gy) < thr ? { x: gx, y: gy } : p;
  }
  return p;
}

// Move a handle to a new world position. Endpoints drag their welded peers (and
// each strand's associated control point) rigidly; control points move alone.
export function moveHandle(
  draft: EditorDocument,
  layerName: string,
  handle: HandleKind,
  pos: Point,
  curve?: Settings['curve_params'],
): void {
  const s = draft.strands[layerName];
  if (!s) return;

  // The center is the cp midpoint unless it has been pinned (locked). A LOCKED center
  // that drifts back within 0.5px of the cp midpoint AUTO-UNLOCKS, exactly like OSS
  // update_shape (strand.py:767-780) — then it resumes tracking the midpoint.
  const recenter = (t: StrandRecord) => {
    const mid = {
      x: (t.control_points[0].x + t.control_points[1].x) / 2,
      y: (t.control_points[0].y + t.control_points[1].y) / 2,
    };
    if (t.control_point_center_locked && t.control_point_center
        && Math.hypot(t.control_point_center.x - mid.x, t.control_point_center.y - mid.y) < 0.5) {
      t.control_point_center_locked = false;
    }
    if (!t.control_point_center_locked) t.control_point_center = mid;
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
    // OSS move_mode.py:2821-2831: cp2 dragged back within 1px of the endpoint
    // DEACTIVATES (returns to passive, where it tracks the endpoint); moving it away
    // ACTIVATES it (independent). This FLAG — not cp2's position — gates end-follow below.
    const atEnd = Math.abs(pos.x - s.end.x) < 1.0 && Math.abs(pos.y - s.end.y) < 1.0;
    s.control_point2_activated = !atEnd;
    recenter(s);
    return;
  }
  if (handle === 'control_point_center') {
    // Dragging the third control point pins it; the renderer then uses the
    // 3-point profile and the center no longer tracks the cp midpoint. recenter()
    // then applies OSS update_shape's 0.5px auto-unlock: if the user drags the center
    // back onto the cp midpoint it un-pins and resumes tracking (strand.py:767-780).
    s.control_point_center = pos;
    s.control_point_center_locked = true;
    recenter(s);
    return;
  }

  // Endpoint move (faithful to OSS move_mode.py:2925-2972). The grabbed endpoint and
  // every CONNECTED peer endpoint snap to the SAME absolute position -- where "peer"
  // is decided by the DIRECTED, first-claim-wins connection table + move-test
  // (connections.ts), not a symmetric weld component. Control points follow per the OSS
  // setters: moving a START carries cp1 AND cp2 if EITHER coincided with the old start
  // (strand.py:436-444); moving an END carries cp2 ONLY while it is passive
  // (control_point2_activated == false — there is no cp1-on-end rule). Center
  // re-derives unless pinned.
  const cur = handle === 'start' ? s.start : s.end;
  if (pos.x === cur.x && pos.y === cur.y) return;
  const COINCIDE = 1e-6;
  const at = (p: Point, q: { x: number; y: number }) =>
    Math.abs(p.x - q.x) < COINCIDE && Math.abs(p.y - q.y) < COINCIDE;

  const moveEnd = (t: StrandRecord, end: 'start' | 'end') => {
    if (end === 'start') {
      const old = { x: t.start.x, y: t.start.y };
      const cp1WasAtStart = at(t.control_points[0], old);
      const cp2WasAtStart = at(t.control_points[1], old);
      t.start = { x: pos.x, y: pos.y };
      if (cp1WasAtStart) t.control_points[0] = { x: pos.x, y: pos.y };
      if (cp2WasAtStart) t.control_points[1] = { x: pos.x, y: pos.y };
    } else {
      t.end = { x: pos.x, y: pos.y };
      if (!t.control_point2_activated) t.control_points[1] = { x: pos.x, y: pos.y };
    }
    recenter(t);
  };

  // Grabbed endpoint moves directly; peers follow only when their slot points back at
  // it. Reuse the per-gesture cached connection table (topology is invariant across an
  // endpoint drag); falls back to a fresh build when no gesture is active.
  const moved = new Set<string>([layerName]);
  moveEnd(s, handle);
  const side: 0 | 1 = handle === 'end' ? 1 : 0;
  const table = gestureConnTable(draft);
  for (const m of connectedMovers(table, draft, layerName, side)) {
    const t = draft.strands[m.name];
    if (t) { moveEnd(t, m.end); moved.add(m.name); }
  }

  // Any MaskedStrand built on a moved strand has its erase windows ride along by the
  // shift of the intersection CENTROID — OSS move_mode.py:2978-3031.
  trackMaskDeletionRects(draft, moved, curve);
}

// When a constituent strand of a MaskedStrand moves, the mask's intersection region
// shifts; OSS keeps the erased windows pinned to the region by translating each
// deletion rectangle by the CENTROID delta (move_mode.py:2978-3031). We replicate
// exactly: snapshot the stored center, recompute the 50x50-grid centroid from the new
// component geometry, and shift the rects by (new - old). Masks with no erasures are
// skipped (nothing to translate). The first move of a freshly-loaded mask just seeds
// the center (old == null) without translating — matching OSS's None-initial behaviour.
function trackMaskDeletionRects(
  draft: EditorDocument,
  moved: Set<string>,
  curve: Settings['curve_params'] = DEFAULT_CURVE,
): void {
  for (const name of draft.order) {
    const m = draft.strands[name];
    if (!m || m.type !== 'MaskedStrand') continue;
    if (!m.deletion_rectangles || m.deletion_rectangles.length === 0) continue;
    const comp = maskComponents(name);
    if (!comp || (!moved.has(comp.first) && !moved.has(comp.second))) continue;
    const first = draft.strands[comp.first], second = draft.strands[comp.second];
    if (!first || !second) continue;

    const oldCenter = m.edited_center_point ?? m.base_center_point ?? null;
    // ONE centroid per frame on the hot path: the "edited" centroid (region minus
    // deletion rects). seedMaskCenters grounds base/edited at grab, so the null-fallbacks
    // here are cold paths (fully-erased region, or a mask reached outside MoveMode's seed
    // e.g. via setStrandAngle) — only then do we touch base.
    const editedCenter = maskCentroid(first, second, curve, m.deletion_rectangles);
    const newCenter = editedCenter ?? m.base_center_point ?? null;
    if (oldCenter && newCenter) {
      const dx = newCenter.x - oldCenter.x, dy = newCenter.y - oldCenter.y;
      if (dx !== 0 || dy !== 0) {
        for (const r of m.deletion_rectangles) {
          if (r.top_left) { r.top_left[0] += dx; r.top_left[1] += dy; }
          if (r.top_right) { r.top_right[0] += dx; r.top_right[1] += dy; }
          if (r.bottom_left) { r.bottom_left[0] += dx; r.bottom_left[1] += dy; }
          if (r.bottom_right) { r.bottom_right[0] += dx; r.bottom_right[1] += dy; }
          if (r.x != null) r.x += dx;
          if (r.y != null) r.y += dy;
        }
      }
    }
    if (newCenter) m.edited_center_point = newCenter;
    if (!m.base_center_point) m.base_center_point = maskCentroid(first, second, curve);
  }
}

// Seed (overwrite) the stored centroid of every mask whose constituent is about to move,
// using the CURRENT geometry, so the FIRST drag frame already has a valid `oldCenter` and
// translates the deletion rectangles from frame 1 (OSS keeps base/edited_center_point live
// at all times via calculate_center_point; we seed at grab to match without persisting).
// Re-grounding on each grab also absorbs any geometry change since the last drag (undo,
// group move, angle edit). Called once at pointer-down for the gesture's moving set.
export function seedMaskCenters(
  draft: EditorDocument,
  moving: Set<string>,
  curve: Settings['curve_params'] = DEFAULT_CURVE,
): void {
  for (const name of draft.order) {
    const m = draft.strands[name];
    if (!m || m.type !== 'MaskedStrand') continue;
    if (!m.deletion_rectangles || m.deletion_rectangles.length === 0) continue;
    const comp = maskComponents(name);
    if (!comp || (!moving.has(comp.first) && !moving.has(comp.second))) continue;
    const first = draft.strands[comp.first], second = draft.strands[comp.second];
    if (!first || !second) continue;
    m.base_center_point = maskCentroid(first, second, curve);
    m.edited_center_point = maskCentroid(first, second, curve, m.deletion_rectangles) ?? m.base_center_point;
  }
}

// Reset triangle_has_moved on release when the curve has returned to straight, so the
// center / cp2-hover gating re-hides (OSS mouseReleaseEvent:1620-1637). OSS resets ONLY
// triangle_has_moved here; control_point2_shown is an INDEPENDENT, sticky flag (it gates
// cp2 GRAB, set once on the first cp1 move and never reset — move_mode.py:2061,2804), so
// we must NOT clear it. Straight == cp2 within 1px of start AND, if the center is locked,
// the center within 1px of start.
export function resetStraightCurveFlags(draft: EditorDocument, layerName: string): void {
  const s = draft.strands[layerName];
  if (!s) return;
  const d = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);
  const cp2Straight = d(s.control_points[1], s.start) <= 1.0;
  const centerStraight = !s.control_point_center_locked || !s.control_point_center
    || d(s.control_point_center, s.start) <= 1.0;
  if (cp2Straight && centerStraight) {
    s.triangle_has_moved = false;
  }
}

// Press-time auto-adjust when grabbing cp1 on a collapsed triangle (cp1 AND cp2 both
// within 1px of start): snap cp2 onto the end and mark it passive, so the first cp1
// drag shapes a clean curve. Faithful to OSS start_movement's auto_adjust_control_points
// (move_mode.py:2469-2524). When the third-CP feature is enabled, OSS also pins the center
// to the cp1/cp2 midpoint (== start/end midpoint here, since cp1==start, cp2==end).
export function autoAdjustCp1OnGrab(draft: EditorDocument, layerName: string, enableThird = false): void {
  const s = draft.strands[layerName];
  if (!s) return;
  const atStart = (p: Point) => Math.abs(p.x - s.start.x) < 1.0 && Math.abs(p.y - s.start.y) < 1.0;
  if (atStart(s.control_points[0]) && atStart(s.control_points[1])) {
    s.control_points[1] = { x: s.end.x, y: s.end.y };
    s.control_point2_activated = false;
    if (enableThird) {
      s.control_point_center = {
        x: (s.control_points[0].x + s.control_points[1].x) / 2,
        y: (s.control_points[0].y + s.control_points[1].y) / 2,
      };
      s.control_point_center_locked = true;
    }
  }
}

// Set strand `layerName`'s absolute angle (degrees, atan2(dy,dx) convention,
// 0deg = +x, y-down so positive rotates +x toward +y = clockwise on screen) by
// rotating its END about its START, preserving length. Faithful to OSS
// StrandAngleEditDialog.update_strand_angle's pivot=start, length-preserving
// rotation. Reuses moveHandle's endpoint-move weld propagation so any attached
// children welded at this end (and their coincident control points) follow
// rigidly -- identical to dragging the endpoint. JSON-serializable throughout.
export function setStrandAngle(
  draft: EditorDocument,
  layerName: string,
  angleDeg: number,
  curve?: Settings['curve_params'],
): void {
  const s = draft.strands[layerName];
  if (!s) return;
  const len = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);
  const rad = (angleDeg * Math.PI) / 180;
  const newEnd: Point = {
    x: s.start.x + Math.cos(rad) * len,
    y: s.start.y + Math.sin(rad) * len,
  };
  moveHandle(draft, layerName, 'end', newEnd, curve);   // curve -> faithful mask-rect tracking
}

// Create a free first strand of a brand-new set. Returns the new layer_name.
// `defaults` threads the user's default strand colour/stroke/width settings (OSS
// uses these for new strands); omitted fields fall back to the factory constants.
export function addNewStrand(
  draft: EditorDocument,
  start: Point,
  end: Point,
  defaults?: { color?: RGBA; stroke_color?: RGBA; width?: number; stroke_width?: number },
): string {
  const set = nextFreeSet(draft);
  const layer_name = `${set}_1`;
  const s = makeStrand({ layer_name, set_number: set, start, end, is_first_strand: true, ...defaults });
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

// Set width_in_grid_units (extra-only — no typed field), optionally across the
// whole set. Mirrors setWidth's set_number loop. OSS change_width writes this to
// every non-masked strand sharing the set; change_layer_width writes it to one.
export function setWidthGridUnits(
  draft: EditorDocument,
  name: string,
  units: number,
  wholeSet: boolean,
): void {
  const s = draft.strands[name];
  if (!s) return;
  const apply = (t: StrandRecord) => { t.extra.width_in_grid_units = units; };
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

// OSS 1.109 per-layer "Hide Shadow" (layer_panel.py toggle_layer_hide_shadow):
// the strand casts no shadow onto other strands; it still receives.
export function setHideShadow(draft: EditorDocument, name: string, value: boolean): void {
  const s = draft.strands[name];
  if (s) s.hide_shadow = value;
}

// OSS is_strand_deletable: deletable iff it has knot connections OR not all of
// its endpoint circles are present. A strand with both circles and no knot
// connections is a closed-on-both-ends interior strand and may not be deleted.
export function isStrandDeletable(s: StrandRecord): boolean {
  if (s.knot_connections && Object.keys(s.knot_connections).length > 0) return true;
  return !(s.has_circles[0] && s.has_circles[1]);
}

// OSS Transparent / Restore-Default Stroke item: sets circle_stroke_color (the
// stroke around the endpoint circle). Passing null clears it.
export function setCircleStrokeColor(draft: EditorDocument, name: string, color: RGBA | null): void {
  const s = draft.strands[name];
  if (s) s.circle_stroke_color = color ? { ...color } : null;
}

// OSS toggle_strand_circle_visibility: flips has_circles[index] and records the
// manual override in extra.manual_circle_visibility so the renderer's has_circles
// recompute respects the user's explicit choice.
export function toggleCircleVisible(draft: EditorDocument, name: string, index: 0 | 1): void {
  const s = draft.strands[name];
  if (!s) return;
  s.has_circles[index] = !s.has_circles[index];
  const mcv = Array.isArray(s.extra.manual_circle_visibility)
    ? [...(s.extra.manual_circle_visibility as unknown[])]
    : [null, null];
  mcv[index] = s.has_circles[index];
  s.extra.manual_circle_visibility = mcv;
}

// OSS toggle_strand_line_visibility: flips the start/end side-line flag. Lines
// are visible by default, so the first toggle turns the flag off; the renderer
// reads start_line_visible / end_line_visible from extra.
export function toggleLineVisible(draft: EditorDocument, name: string, end: 'start' | 'end'): void {
  const s = draft.strands[name];
  if (!s) return;
  const key = `${end}_line_visible`;
  const cur = s.extra[key];
  s.extra[key] = cur === false ? true : false;
}

// OSS close_the_knot: connect this strand's free end to the nearest sibling in
// the same set that also has exactly one free end. Moves the free point (plus any
// control point — including control_point_center — coincident with it) to the
// target's free point, caps both ends with circles, marks closed_connections +
// manual_circle_visibility on BOTH strands, and records the knot connection on
// both (keyed by END TYPE) with the target mirroring the initiator. Gating
// (exactly-one-free-end) is computed by the caller (NumberedLayerButton).
// TODO(oss-fidelity): per-end circle-stroke transparency on the target's
// connecting edge (OSS start/end_circle_stroke_color) needs per-end stroke model
// fields the JS renderer lacks; the target keeps an opaque-black circle stroke.
export function closeKnot(draft: EditorDocument, name: string, freeEnd: 'start' | 'end'): void {
  const s = draft.strands[name];
  if (!s) return;
  const freeIdx = freeEnd === 'start' ? 0 : 1;

  // Find the nearest sibling sharing set_number (different layer) with exactly
  // one free end (one of has_circles is false).
  const myPoint = freeEnd === 'start' ? s.start : s.end;
  let best: { layer: string; end: 'start' | 'end'; idx: 0 | 1; pt: Point } | null = null;
  let bestDist = Infinity;
  for (const k of Object.keys(draft.strands)) {
    if (k === name) continue;
    const t = draft.strands[k];
    if (t.type === 'MaskedStrand') continue;
    if (t.set_number !== s.set_number) continue;
    const freeEnds: ('start' | 'end')[] = [];
    if (!t.has_circles[0]) freeEnds.push('start');
    if (!t.has_circles[1]) freeEnds.push('end');
    if (freeEnds.length !== 1) continue;
    const te = freeEnds[0];
    const tIdx: 0 | 1 = te === 'start' ? 0 : 1;
    const tp = te === 'start' ? t.start : t.end;
    const d = Math.hypot(tp.x - myPoint.x, tp.y - myPoint.y);
    if (d < bestDist) { bestDist = d; best = { layer: k, end: te, idx: tIdx, pt: { x: tp.x, y: tp.y } }; }
  }
  if (!best) return;

  const target = draft.strands[best.layer];
  const oldFree = { x: myPoint.x, y: myPoint.y };
  const newPt = best.pt;
  const coincident = (p: Point | null | undefined) =>
    !!p && Math.abs(p.x - oldFree.x) + Math.abs(p.y - oldFree.y) < 1;
  // Move this strand's free point to the target's free point; carry control_point1,
  // control_point2 AND control_point_center if they sat on the old free position
  // (OSS close_the_knot, numbered_layer_button.py:2556-2575).
  const moved = freeEnd === 'start' ? s.start : s.end;
  moved.x = newPt.x; moved.y = newPt.y;
  for (const cp of s.control_points) {
    if (coincident(cp)) { cp.x = newPt.x; cp.y = newPt.y; }
  }
  if (coincident(s.control_point_center)) s.control_point_center = { x: newPt.x, y: newPt.y };

  // Cap both connection ends with circles.
  s.has_circles[freeIdx] = true;
  target.has_circles[best.idx] = true;

  // Default the circle stroke color to opaque black when unset (OSS:2589-2600).
  const black: RGBA = { r: 0, g: 0, b: 0, a: 255 };
  if (!s.circle_stroke_color) s.circle_stroke_color = { ...black };
  if (!target.circle_stroke_color) target.circle_stroke_color = { ...black };

  // Mark closed_connections + manual_circle_visibility on BOTH strands so the
  // renderer draws full closing circles (OSS:2610-2651).
  const markClosed = (rec: StrandRecord, idx: 0 | 1) => {
    const cc = Array.isArray(rec.extra.closed_connections)
      ? [...(rec.extra.closed_connections as unknown[])]
      : [false, false];
    cc[idx] = true;
    rec.extra.closed_connections = cc;
    const mcv = Array.isArray(rec.extra.manual_circle_visibility)
      ? [...(rec.extra.manual_circle_visibility as unknown[])]
      : [null, null];
    mcv[idx] = true;
    rec.extra.manual_circle_visibility = mcv;
  };
  markClosed(s, freeIdx);
  markClosed(target, best.idx);

  // Record the knot connection on BOTH strands, keyed by END TYPE (OSS:2674-2683):
  // the initiator is the closing strand; the target mirrors it (is_closing_strand
  // false). connected_strand is stored by name for save/load round-trip.
  const selfConn: KnotConnection = { connected_strand_name: best.layer, connected_end: best.end, is_closing_strand: true };
  const mirrorConn: KnotConnection = { connected_strand_name: name, connected_end: freeEnd, is_closing_strand: false };
  s.knot_connections[freeEnd] = selfConn;
  target.knot_connections[best.end] = mirrorConn;
}

// ---- groups (Phase 6f) ----
// A group is stored as { main_strands: layer_names } under doc.groups[name]
// (GroupRecord, imported from types). createGroupFromSet's membership is "every
// non-masked strand sharing a set_number" (the branch-prefix "<set>_*" family);
// createGroup takes arbitrary membership.

export function createGroupFromSet(draft: EditorDocument, setNumber: number): string | null {
  const members = Object.keys(draft.strands).filter(
    (k) => draft.strands[k].type !== 'MaskedStrand' && draft.strands[k].set_number === setNumber,
  );
  if (!members.length) return null;
  const name = `set ${setNumber}`;
  (draft.groups as Record<string, GroupRecord>)[name] = { main_strands: members };
  return name;
}

export function deleteGroup(draft: EditorDocument, name: string): void {
  delete (draft.groups as Record<string, unknown>)[name];
}

// Translate every member strand (and the deletion rectangles of masks wholly
// inside the group) by (dx, dy) — moving the group as a rigid unit. Membership is
// resolved to whole branches (see resolveGroupMembers), so attached children move
// with their parent.
export function translateGroup(draft: EditorDocument, name: string, dx: number, dy: number): void {
  const { regular, masks } = resolveGroupMembers(draft, name);
  if (!regular.length) return;
  const move = (p: Point | null | undefined) => { if (p) { p.x += dx; p.y += dy; } };
  for (const layer of regular) {
    const s = draft.strands[layer];
    if (!s) continue;
    move(s.start); move(s.end);
    move(s.control_points[0]); move(s.control_points[1]); move(s.control_point_center);
  }
  for (const k of masks) {
    const m = draft.strands[k];
    for (const r of m.deletion_rectangles || []) {
      for (const c of [r.top_left, r.top_right, r.bottom_left, r.bottom_right]) if (c) { c[0] += dx; c[1] += dy; }
      if (r.x != null) { r.x += dx; }
      if (r.y != null) { r.y += dy; }
    }
  }
}

// Create a group from an ARBITRARY set of members (not a whole set). Keeps only
// existing, non-masked layer_names. No-op (returns null) on empty membership or
// a name collision.
export function createGroup(draft: EditorDocument, name: string, mainStrands: string[]): string | null {
  const members = mainStrands.filter(
    (n) => draft.strands[n] && draft.strands[n].type !== 'MaskedStrand',
  );
  if (!members.length) return null;
  if ((draft.groups as Record<string, unknown>)[name]) return null;
  (draft.groups as Record<string, GroupRecord>)[name] = { main_strands: members };
  return name;
}

// Rename a group key (preserving membership). No-op on missing source or
// destination collision.
export function renameGroup(draft: EditorDocument, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const groups = draft.groups as Record<string, GroupRecord>;
  if (!groups[oldName] || groups[newName]) return;
  groups[newName] = groups[oldName];
  delete groups[oldName];
}

// Duplicate a group by CLONING its strands into a brand-new, fully independent
// group (OSS group_layers.py:duplicate_group). The copy must NOT share strands
// with the original, so we deep-clone every member record under freshly allocated
// set numbers — moving the copy then moves only the copy.
//
// Membership is resolved to whole branches (resolveGroupMembers): `regular` already
// includes attached children (they share their parent's set_number), and `masks`
// are the masks wholly inside. We allocate ONE new set per original set, remap each
// regular "s_i" -> "<newSet>_<i>" (index preserved, since the whole branch moves to
// a fresh set there are no collisions), and rebuild each mask name from its cloned
// components. Everything else in each record copies verbatim. Returns the new group
// name, or null if the group has no regular members.
export function duplicateGroup(draft: EditorDocument, name: string): string | null {
  const { regular, masks } = resolveGroupMembers(draft, name);
  if (!regular.length) return null;

  // 1) Allocate a NEW unique set number per distinct old set. Track `used`
  // locally (seeded with every set in the doc) so each fresh pick is reserved
  // before the next, avoiding the live-doc reuse trap.
  const used = new Set<number>();
  for (const k of Object.keys(draft.strands)) {
    const p = parseLayerName(k);
    if (p) used.add(p.set);
  }
  // Map the group's distinct old sets — SORTED ascending — to the next free set
  // numbers (lowest-free counting from 1; masks excluded since parseLayerName
  // returns null for them). This matches OSS group_layers.py:2578-2590, which zips
  // sorted(unique_set_numbers) with get_next_consecutive_set_numbers.
  const oldSets = Array.from(new Set(regular.map((l) => draft.strands[l].set_number))).sort((a, b) => a - b);
  const setMap = new Map<number, number>();
  for (const oldSet of oldSets) {
    let next = 1;
    while (used.has(next)) next++;
    used.add(next);
    setMap.set(oldSet, next);
  }

  // 2) Layer remap for regular "s_i" -> "<newSet>_<i>" (same index, new set).
  const nameMap = new Map<string, string>();
  for (const layer of regular) {
    const p = parseLayerName(layer);
    if (!p) continue;
    const newSet = setMap.get(p.set);
    if (newSet == null) continue;
    nameMap.set(layer, formatLayerName(newSet, p.index));
  }

  // 3) Clone each regular strand verbatim, overwriting only the remapped fields.
  for (const layer of regular) {
    const newName = nameMap.get(layer);
    const p = parseLayerName(layer);
    if (!newName || !p) continue;
    const c = clone(draft.strands[layer]);
    c.layer_name = newName;
    c.set_number = setMap.get(p.set) as number;
    // Remap to the cloned parent; if the parent is outside the duplicated set
    // (only possible for malformed cross-set data), drop the link rather than
    // cross-linking the clone back to the original.
    if (c.attached_to != null) c.attached_to = nameMap.get(c.attached_to) ?? null;
    // Remap any knot connections that point at a cloned sibling; leave the rest.
    for (const key of Object.keys(c.knot_connections || {})) {
      const conn = c.knot_connections[key];
      const target = nameMap.get(conn.connected_strand_name);
      if (target) conn.connected_strand_name = target;
    }
    draft.strands[newName] = c;
    draft.order.push(newName);
  }

  // 4) Clone each mask: rebuild its name from the cloned OVER/UNDER components and
  // set its set_number from the new set of the OVER component. deep-copy verbatim
  // (preserves deletion_rectangles / using_absolute_coords).
  for (const mask of masks) {
    const comp = maskComponents(mask);
    if (!comp) continue;
    const first = nameMap.get(comp.first);
    const second = nameMap.get(comp.second);
    if (!first || !second) continue;
    const newName = `${first}_${second}`;
    const c = clone(draft.strands[mask]);
    c.layer_name = newName;
    const overSet = parseLayerName(comp.first);
    if (overSet) c.set_number = setMap.get(overSet.set) as number;
    draft.strands[newName] = c;
    draft.order.push(newName);
  }

  // 5) Fresh unique group name ("<name> copy", then " copy 2"…).
  const groups = draft.groups as Record<string, GroupRecord>;
  let newGroupName = `${name} copy`;
  let n = 2;
  while (groups[newGroupName]) newGroupName = `${name} copy ${n++}`;

  // 6) main_strands of the new group = each original main_strand remapped, keeping
  // only those that actually exist as cloned strands.
  const orig = groups[name];
  const newMains = (orig?.main_strands || [])
    .map((m) => nameMap.get(m))
    .filter((m): m is string => !!m && !!draft.strands[m]);
  groups[newGroupName] = { main_strands: newMains };
  return newGroupName;
}

// Rotate every member strand (start/end/control_points/control_point_center) and
// the deletion-rectangle corners of masks wholly inside the group, by angleDeg
// about the group centroid. Membership is resolved to whole branches; the centroid
// is the mean of the resolved members' start+end points.
export function rotateGroup(draft: EditorDocument, name: string, angleDeg: number): void {
  const { regular, masks } = resolveGroupMembers(draft, name);
  if (!regular.length) return;

  // Centroid from member endpoints.
  let sx = 0, sy = 0, n = 0;
  for (const layer of regular) {
    const s = draft.strands[layer];
    if (!s) continue;
    sx += s.start.x + s.end.x; sy += s.start.y + s.end.y; n += 2;
  }
  if (n === 0) return;
  const cx = sx / n, cy = sy / n;

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rotXY = (x: number, y: number): [number, number] => {
    const dx = x - cx, dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
  const rotP = (p: Point | null | undefined) => {
    if (!p) return;
    const [x, y] = rotXY(p.x, p.y); p.x = x; p.y = y;
  };

  for (const layer of regular) {
    const s = draft.strands[layer];
    if (!s) continue;
    rotP(s.start); rotP(s.end);
    rotP(s.control_points[0]); rotP(s.control_points[1]); rotP(s.control_point_center);
  }
  for (const k of masks) {
    const m = draft.strands[k];
    for (const r of m.deletion_rectangles || []) {
      for (const c of [r.top_left, r.top_right, r.bottom_left, r.bottom_right]) {
        if (c) { const [x, y] = rotXY(c[0], c[1]); c[0] = x; c[1] = y; }
      }
      // {x,y,width,height} rects: rotate the top-left corner (best-effort; corner
      // arrays are the faithful form and are handled above).
      if (r.x != null && r.y != null) { const [x, y] = rotXY(r.x, r.y); r.x = x; r.y = y; }
    }
  }
}

// Group shadow toggle: set shadow_only on every resolved member strand (whole
// branches, matching the OSS shadow editor which lists all group strands).
export function setGroupShadowOnly(draft: EditorDocument, name: string, value: boolean): void {
  const { regular } = resolveGroupMembers(draft, name);
  for (const layer of regular) {
    const s = draft.strands[layer];
    if (s) s.shadow_only = value;
  }
}

// ---- per-pair shadow overrides (OSS layer_state_manager.shadow_overrides) ----
// Nested dict casting_layer -> receiving_layer -> {visibility, allow_full_shadow,
// subtracted_layers}. Mirrors the OSS getter/setter/default logic. Defaults:
// visibility = true, allow_full_shadow = false, subtracted_layers = []. The
// renderer today only consumes `visibility`; the other two are stored for
// forward-compat (see strand-renderer.js / RenderMeta.shadow_overrides).

export function getShadowOverride(
  draft: EditorDocument,
  casting: string,
  receiving: string,
): ShadowOverride | undefined {
  return draft.shadow_overrides[casting]?.[receiving];
}

// Whole-inner-dict replace (OSS set_shadow_override). Empty dicts are pruned so an
// all-default override doesn't bloat the doc / undo comparison.
export function setShadowOverride(
  draft: EditorDocument,
  casting: string,
  receiving: string,
  override: ShadowOverride,
): void {
  const isEmpty =
    (override.visibility === undefined || override.visibility === true) &&
    (override.allow_full_shadow === undefined || override.allow_full_shadow === false) &&
    (override.subtracted_layers === undefined || override.subtracted_layers.length === 0);
  if (isEmpty) {
    removeShadowOverride(draft, casting, receiving);
    return;
  }
  const byRecv = draft.shadow_overrides[casting] ?? (draft.shadow_overrides[casting] = {});
  byRecv[receiving] = { ...override };
}

export function removeShadowOverride(draft: EditorDocument, casting: string, receiving: string): void {
  const byRecv = draft.shadow_overrides[casting];
  if (!byRecv) return;
  delete byRecv[receiving];
  if (Object.keys(byRecv).length === 0) delete draft.shadow_overrides[casting];
}

// Effective visibility: override.visibility if present, else default true.
export function getShadowVisibility(draft: EditorDocument, casting: string, receiving: string): boolean {
  const ov = getShadowOverride(draft, casting, receiving);
  return ov?.visibility ?? true;
}

export function setShadowVisibility(
  draft: EditorDocument,
  casting: string,
  receiving: string,
  visible: boolean,
): void {
  const cur = getShadowOverride(draft, casting, receiving) ?? {};
  setShadowOverride(draft, casting, receiving, { ...cur, visibility: visible });
}

export function setAllowFullShadow(
  draft: EditorDocument,
  casting: string,
  receiving: string,
  allow: boolean,
): void {
  const cur = getShadowOverride(draft, casting, receiving) ?? {};
  setShadowOverride(draft, casting, receiving, {
    visibility: cur.visibility ?? true,
    ...cur,
    allow_full_shadow: allow,
  });
}

export function getSubtractedLayers(draft: EditorDocument, casting: string, receiving: string): string[] {
  return getShadowOverride(draft, casting, receiving)?.subtracted_layers ?? [];
}

export function setSubtractedLayers(
  draft: EditorDocument,
  casting: string,
  receiving: string,
  layers: string[],
): void {
  const cur = getShadowOverride(draft, casting, receiving) ?? {};
  setShadowOverride(draft, casting, receiving, {
    visibility: cur.visibility ?? true,
    allow_full_shadow: cur.allow_full_shadow ?? false,
    ...cur,
    subtracted_layers: layers,
  });
}

type CurveParams = Settings['curve_params'];

// Renderer/hit-test default; the live UI threads settings.curve_params instead.
const DEFAULT_CURVE: CurveParams = { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 };

export interface MaskGridOptions {
  /** Restrict to this member list (default: whole-branch resolved members). */
  members?: string[];
  /** Curve params for the crossing test (default: renderer default). */
  curve?: CurveParams;
}

// Geometry-aware mask grid (OSS create_mask_grid parity, group_layers.py:3511 ->
// strand_drawing_canvas.create_masked_layer). For every UNORDERED pair of the
// group's regular members, create a single MaskedStrand ONLY where the two
// strands actually cross (centerline segment intersection — the cheap faithful
// proxy for OSS's stroked-body area-intersection emptiness gate). Over/under is
// taken from z-order: the strand LATER in draft.order is topmost, so it becomes
// the OVER (first) component of the mask. Pairs that already have a mask in
// EITHER direction are skipped. Returns the layer_names created.
//
// Signature stays back-compatible: `createMaskGrid(draft, name)` still works and
// defaults to whole-branch members + the renderer default curve; pass options to
// supply the dialog's picked members and live curve_params.
export function createMaskGrid(
  draft: EditorDocument,
  name: string,
  options?: MaskGridOptions,
): string[] {
  const g = (draft.groups as Record<string, GroupRecord>)[name];
  if (!g) return [];
  const curve = options?.curve ?? DEFAULT_CURVE;

  // Default to the full whole-branch membership (matches OSS _get_group_strands,
  // which resolves the group then drops MaskedStrands). The dialog passes an
  // explicit picked subset.
  const source = options?.members ?? resolveGroupMembers(draft, name).regular;
  const members = source.filter(
    (n) => draft.strands[n] && draft.strands[n].type !== 'MaskedStrand',
  );

  const created: string[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      // Skip if a mask already exists in either direction.
      if (draft.strands[`${a}_${b}`] || draft.strands[`${b}_${a}`]) continue;
      const sa = draft.strands[a], sb = draft.strands[b];
      if (!sa || !sb) continue;
      // Geometry gate: only mask real crossings.
      if (!strandsCross(sa, sb, curve)) continue;
      // Over/under from z-order: later in order == topmost == OVER (first).
      const ia = draft.order.indexOf(a), ib = draft.order.indexOf(b);
      const over = ia > ib ? a : b;
      const under = ia > ib ? b : a;
      const made = createMask(draft, over, under);
      if (made) created.push(made);
    }
  }
  return created;
}

// Dev-only debug handle for testing actions directly.
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__actions = {
    moveHandle, setStrandAngle, addNewStrand, attachChild, createMask, addDeletionRect, resetMask,
    deleteStrand, deleteAllStrands, reorderLayer, toggleHidden, toggleLock,
    setColor, setWidth, setWidthGridUnits, setShadowOnly, isStrandDeletable,
    setCircleStrokeColor, toggleCircleVisible, toggleLineVisible, closeKnot,
    toggleLockMode, clearAllLocks, renameLayer,
    createGroupFromSet, createGroup, renameGroup, duplicateGroup,
    deleteGroup, translateGroup, rotateGroup, setGroupShadowOnly, createMaskGrid,
    getShadowOverride, setShadowOverride, removeShadowOverride,
    getShadowVisibility, setShadowVisibility, setAllowFullShadow,
    getSubtractedLayers, setSubtractedLayers,
  };
}

export function toggleLock(draft: EditorDocument, name: string): void {
  const i = draft.locked_layers.indexOf(name);
  if (i >= 0) draft.locked_layers.splice(i, 1);
  else draft.locked_layers.push(name);
}

// ---- Phase 4: layer panel (lock-mode, clear locks, rename) ----

// Flip the document-wide lock mode (when on, the panel locks/unlocks per-layer).
export function toggleLockMode(draft: EditorDocument): void {
  draft.lock_mode = !draft.lock_mode;
}

// Clear every per-layer lock (exit-lock-mode "clear all" affordance).
export function clearAllLocks(draft: EditorDocument): void {
  draft.locked_layers = [];
}

// Rename a layer EVERYWHERE so save/load round-trips: order[], the strands key,
// the record's own layer_name, locked_layers, selected_strand_name, any
// AttachedStrand.attached_to pointing at it, and every MaskedStrand whose name
// concatenates it as a component (the mask layer_name is first+second, so we
// rebuild the mask key when a component is renamed). No-op if the target is
// missing or the new name collides.
export function renameLayer(draft: EditorDocument, oldName: string, newName: string): void {
  if (oldName === newName) return;
  if (!draft.strands[oldName]) return;
  if (draft.strands[newName]) return; // collision — refuse

  // 1) Move the record under the new key and update its own layer_name.
  const rec = draft.strands[oldName];
  rec.layer_name = newName;
  draft.strands[newName] = rec;
  delete draft.strands[oldName];

  // 2) z-order.
  draft.order = draft.order.map((n) => (n === oldName ? newName : n));

  // 3) locks.
  draft.locked_layers = draft.locked_layers.map((n) => (n === oldName ? newName : n));

  // 4) selection.
  if (draft.selected_strand_name === oldName) draft.selected_strand_name = newName;

  // 5) attached_to references.
  for (const k of Object.keys(draft.strands)) {
    const s = draft.strands[k];
    if (s.type === 'AttachedStrand' && s.attached_to === oldName) s.attached_to = newName;
  }

  // 6) masks whose name references the renamed component — rebuild the key.
  for (const k of Object.keys(draft.strands)) {
    const m = draft.strands[k];
    if (m.type !== 'MaskedStrand') continue;
    const comp = maskComponents(k);
    if (!comp) continue;
    if (comp.first !== oldName && comp.second !== oldName) continue;
    const first = comp.first === oldName ? newName : comp.first;
    const second = comp.second === oldName ? newName : comp.second;
    const maskNew = `${first}_${second}`;
    if (maskNew === k || draft.strands[maskNew]) continue; // unchanged or collision
    m.layer_name = maskNew;
    draft.strands[maskNew] = m;
    delete draft.strands[k];
    draft.order = draft.order.map((n) => (n === k ? maskNew : n));
    draft.locked_layers = draft.locked_layers.map((n) => (n === k ? maskNew : n));
    if (draft.selected_strand_name === k) draft.selected_strand_name = maskNew;
  }

  // 7) group membership references.
  for (const gk of Object.keys(draft.groups)) {
    const g = draft.groups[gk] as GroupRecord | undefined;
    if (!g || !Array.isArray(g.main_strands)) continue;
    g.main_strands = g.main_strands.map((n) => (n === oldName ? newName : n));
  }
}

// Create an over/under MaskedStrand from two existing strands. `first` is OVER,
// `second` is UNDER. layer_name concatenates the components ("a_b_c_d"). The
// renderer resolves components by name, so the mask inherits the first strand's
// paint for serialization only. Returns the new layer_name, or null if invalid.
export function createMask(
  draft: EditorDocument,
  first: string,
  second: string,
  curve?: Parameters<typeof strandsCross>[2],
): string | null {
  if (first === second) return null;
  const a = draft.strands[first], b = draft.strands[second];
  if (!a || !b || a.type === 'MaskedStrand' || b.type === 'MaskedStrand') return null;
  const layer_name = `${first}_${second}`;
  if (draft.strands[layer_name]) return null; // duplicate mask
  // OSS create_masked_layer refuses a mask only when the two STROKED BODIES don't
  // overlap (intersection_path.isEmpty() -> return). strandBodiesOverlap is the
  // faithful proxy: it allows endpoint-sharing/attached pairs and thick overlaps
  // OSS would mask (strandsCross — used by the group grid — wrongly excludes those).
  // Gated only when a curve is supplied (the two-click + grid create paths pass it).
  if (curve && !strandBodiesOverlap(a, b, curve)) return null;
  // set_number = the two components' set numbers concatenated as digits
  // (OSS masked_strand.py:42 int(f'{first.set_number}{second.set_number}')).
  const concat = Number(`${a.set_number}${b.set_number}`);
  const set_number = Number.isFinite(concat) ? concat : a.set_number;
  const mask: StrandRecord = {
    type: 'MaskedStrand',
    layer_name,
    set_number,
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
    hide_shadow: false,
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
