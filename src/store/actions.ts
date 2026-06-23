// Pure document mutators used by interaction modes. They mutate a DRAFT document
// (a structural clone owned by the store), so callers wrap them in
// store.mutateDoc(draft => ...). No object cross-references, so drafts stay
// JSON-serializable for future snapshot history.

import type { EditorDocument, GroupRecord, HandleKind, Point, RGBA, Settings, StrandRecord } from '../model/types';
import { weldedEndpoints } from '../interaction/connections';
import { makeAttachedStrand, makeStrand } from '../model/factory';
import { formatLayerName, maskComponents, nextFreeSet, nextIndexInSet, parseLayerName } from '../model/layerName';
import { resolveGroupMembers } from '../model/group';

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

// Set strand `layerName`'s absolute angle (degrees, atan2(dy,dx) convention,
// 0deg = +x, y-down so positive rotates +x toward +y = clockwise on screen) by
// rotating its END about its START, preserving length. Faithful to OSS
// StrandAngleEditDialog.update_strand_angle's pivot=start, length-preserving
// rotation. Reuses moveHandle's endpoint-move weld propagation so any attached
// children welded at this end (and their coincident control points) follow
// rigidly -- identical to dragging the endpoint. JSON-serializable throughout.
export function setStrandAngle(draft: EditorDocument, layerName: string, angleDeg: number): void {
  const s = draft.strands[layerName];
  if (!s) return;
  const len = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);
  const rad = (angleDeg * Math.PI) / 180;
  const newEnd: Point = {
    x: s.start.x + Math.cos(rad) * len,
    y: s.start.y + Math.sin(rad) * len,
  };
  moveHandle(draft, layerName, 'end', newEnd);
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

// Best-effort mask grid: for each unordered pair of distinct members that don't
// already have a mask (in either over/under direction), create an over/under
// MaskedStrand via createMask (first member = OVER). Returns the names created.
// TODO: faithful OSS grid logic resolves true crossings and over/under ordering
// from geometry; this is the reasonable pairwise version.
export function createMaskGrid(draft: EditorDocument, name: string): string[] {
  const g = (draft.groups as Record<string, GroupRecord>)[name];
  if (!g) return [];
  const members = (g.main_strands || []).filter(
    (n) => draft.strands[n] && draft.strands[n].type !== 'MaskedStrand',
  );
  const created: string[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      // Skip if a mask already exists in either direction.
      if (draft.strands[`${a}_${b}`] || draft.strands[`${b}_${a}`]) continue;
      const made = createMask(draft, a, b);
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
    setColor, setWidth, setShadowOnly,
    toggleLockMode, clearAllLocks, renameLayer,
    createGroupFromSet, createGroup, renameGroup, duplicateGroup,
    deleteGroup, translateGroup, rotateGroup, setGroupShadowOnly, createMaskGrid,
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
