// Group membership resolution — the OSS-faithful model.
//
// OpenStrand Studio stores a group's `main_strands` as the chosen branches and
// resolves the full membership dynamically (group_layers.py:resolve_group_data):
// a group owns every strand in the branches of its main strands. In this port a
// "branch" is a set_number — an attached child inherits its parent's set_number
// (see attachChild in store/actions.ts) — so a group owns:
//   * every non-masked strand sharing a main strand's set_number, plus
//   * every MaskedStrand whose BOTH components fall in that resolved set.
//
// Resolving on demand (rather than storing a flat member list) keeps groups
// correct when strands are attached/added after the group is created, and matches
// the desktop's whole-branch grouping.

import type { DeletionRect, EditorDocument, GroupRecord, LayerName, Point } from './types';
import { maskComponents } from './layerName';

export interface GroupMembers {
  /** Non-masked strands in the group's branches. */
  regular: LayerName[];
  /** Masks whose both components are in `regular`. */
  masks: LayerName[];
}

// The set_numbers named by a group's existing, non-masked main strands.
export function groupSetNumbers(doc: EditorDocument, name: string): Set<number> {
  const sets = new Set<number>();
  const g = (doc.groups as Record<string, GroupRecord>)[name];
  if (!g) return sets;
  for (const n of g.main_strands || []) {
    const s = doc.strands[n];
    if (s && s.type !== 'MaskedStrand') sets.add(s.set_number);
  }
  return sets;
}

// Resolve a group to its full, current membership (whole branches).
export function resolveGroupMembers(doc: EditorDocument, name: string): GroupMembers {
  const sets = groupSetNumbers(doc, name);
  if (!sets.size) return { regular: [], masks: [] };

  const regular: LayerName[] = [];
  for (const k of Object.keys(doc.strands)) {
    const s = doc.strands[k];
    if (s.type !== 'MaskedStrand' && sets.has(s.set_number)) regular.push(k);
  }
  const regSet = new Set(regular);

  const masks: LayerName[] = [];
  for (const k of Object.keys(doc.strands)) {
    if (doc.strands[k].type !== 'MaskedStrand') continue;
    const comp = maskComponents(k);
    if (comp && regSet.has(comp.first) && regSet.has(comp.second)) masks.push(k);
  }
  return { regular, masks };
}

/* ------------------------------------------------------------------ */
/* Live group drag (move / rotate) — snapshot-once, apply-absolute.     */
/*                                                                      */
/* Mirrors OSS GroupMoveDialog/GroupRotateDialog (group_layers.py): the */
/* membership is resolved and every member's ORIGINAL geometry is        */
/* snapshotted ONCE at drag start; each tick then sets positions         */
/* ABSOLUTELY from that snapshot — move = original + cumulative (dx,dy),  */
/* rotate = original rotated about the group pivot by the ABSOLUTE angle. */
/* So there is no per-tick re-resolution and no incremental float drift, */
/* and the pivot is the OSS "weighted centroid": the mean of every        */
/* start/end/control-point and every mask deletion-rectangle corner.      */
/* ------------------------------------------------------------------ */

export interface GroupDragSnapshot {
  members: GroupMembers;
  /** Rotation pivot: weighted centroid of all member points (OSS parity). */
  pivot: Point;
  /** Original geometry per non-masked member, keyed by layer_name. */
  strands: Record<LayerName, { start: Point; end: Point; cp0: Point; cp1: Point; cpc: Point | null }>;
  /** Original deletion rectangles per mask member, keyed by layer_name. */
  masks: Record<LayerName, DeletionRect[]>;
}

const clonePt = (p: Point): Point => ({ x: p.x, y: p.y });

function cloneRect(r: DeletionRect): DeletionRect {
  const out: DeletionRect = {};
  if (r.top_left) out.top_left = [r.top_left[0], r.top_left[1]];
  if (r.top_right) out.top_right = [r.top_right[0], r.top_right[1]];
  if (r.bottom_left) out.bottom_left = [r.bottom_left[0], r.bottom_left[1]];
  if (r.bottom_right) out.bottom_right = [r.bottom_right[0], r.bottom_right[1]];
  if (r.x != null) out.x = r.x;
  if (r.y != null) out.y = r.y;
  if (r.width != null) out.width = r.width;
  if (r.height != null) out.height = r.height;
  return out;
}

// Capture a group's full transformable geometry once, for a live move/rotate.
export function snapshotGroupDrag(doc: EditorDocument, name: string): GroupDragSnapshot {
  const members = resolveGroupMembers(doc, name);
  const strands: GroupDragSnapshot['strands'] = {};
  const masks: GroupDragSnapshot['masks'] = {};
  let px = 0, py = 0, count = 0;
  const add = (x: number, y: number) => { px += x; py += y; count++; };

  for (const layer of members.regular) {
    const s = doc.strands[layer];
    if (!s) continue;
    strands[layer] = {
      start: clonePt(s.start), end: clonePt(s.end),
      cp0: clonePt(s.control_points[0]), cp1: clonePt(s.control_points[1]),
      cpc: s.control_point_center ? clonePt(s.control_point_center) : null,
    };
    add(s.start.x, s.start.y); add(s.end.x, s.end.y);
    add(s.control_points[0].x, s.control_points[0].y);
    add(s.control_points[1].x, s.control_points[1].y);
  }
  for (const layer of members.masks) {
    const m = doc.strands[layer];
    if (!m) continue;
    const rects = (m.deletion_rectangles || []).map(cloneRect);
    masks[layer] = rects;
    for (const r of rects) {
      for (const c of [r.top_left, r.top_right, r.bottom_left, r.bottom_right]) if (c) add(c[0], c[1]);
    }
  }
  const pivot: Point = count ? { x: px / count, y: py / count } : { x: 0, y: 0 };
  return { members, pivot, strands, masks };
}

// Live MOVE: set every member absolutely from its snapshot + (dx, dy).
export function applyGroupMoveSnapshot(
  draft: EditorDocument,
  snap: GroupDragSnapshot,
  dx: number,
  dy: number,
): void {
  for (const layer of snap.members.regular) {
    const s = draft.strands[layer];
    const o = snap.strands[layer];
    if (!s || !o) continue;
    s.start = { x: o.start.x + dx, y: o.start.y + dy };
    s.end = { x: o.end.x + dx, y: o.end.y + dy };
    s.control_points[0] = { x: o.cp0.x + dx, y: o.cp0.y + dy };
    s.control_points[1] = { x: o.cp1.x + dx, y: o.cp1.y + dy };
    if (o.cpc) s.control_point_center = { x: o.cpc.x + dx, y: o.cpc.y + dy };
  }
  for (const layer of snap.members.masks) {
    const m = draft.strands[layer];
    const orig = snap.masks[layer];
    if (!m || !orig) continue;
    m.deletion_rectangles = orig.map((r) => {
      const out = cloneRect(r);
      for (const c of [out.top_left, out.top_right, out.bottom_left, out.bottom_right]) if (c) { c[0] += dx; c[1] += dy; }
      if (out.x != null) out.x += dx;
      if (out.y != null) out.y += dy;
      return out;
    });
  }
}

// Live ROTATE: rotate every member's snapshot about snap.pivot by angleDeg.
export function applyGroupRotateSnapshot(
  draft: EditorDocument,
  snap: GroupDragSnapshot,
  angleDeg: number,
): void {
  const { x: cx, y: cy } = snap.pivot;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rot = (x: number, y: number): [number, number] => {
    const dx = x - cx, dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
  for (const layer of snap.members.regular) {
    const s = draft.strands[layer];
    const o = snap.strands[layer];
    if (!s || !o) continue;
    const [sx, sy] = rot(o.start.x, o.start.y); s.start = { x: sx, y: sy };
    const [ex, ey] = rot(o.end.x, o.end.y); s.end = { x: ex, y: ey };
    const [a0, b0] = rot(o.cp0.x, o.cp0.y); s.control_points[0] = { x: a0, y: b0 };
    const [a1, b1] = rot(o.cp1.x, o.cp1.y); s.control_points[1] = { x: a1, y: b1 };
    if (o.cpc) { const [ax, ay] = rot(o.cpc.x, o.cpc.y); s.control_point_center = { x: ax, y: ay }; }
  }
  for (const layer of snap.members.masks) {
    const m = draft.strands[layer];
    const orig = snap.masks[layer];
    if (!m || !orig) continue;
    m.deletion_rectangles = orig.map((r) => {
      const out = cloneRect(r);
      for (const c of [out.top_left, out.top_right, out.bottom_left, out.bottom_right]) if (c) { const [x, y] = rot(c[0], c[1]); c[0] = x; c[1] = y; }
      if (out.x != null && out.y != null) { const [x, y] = rot(out.x, out.y); out.x = x; out.y = y; }
      return out;
    });
  }
}
