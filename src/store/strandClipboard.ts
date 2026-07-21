// Selective copy/paste of strand geometry and appearance — port of OSS 1.109
// strand_data_clipboard.py (93c4565b). The clipboard stores VALUE copies only,
// so later edits to the source strand cannot mutate an existing snapshot.
//
// Paste semantics (apply_strand_data): the copied deltas are part of the data —
// pasting never rotates or scales, it only translates the whole copied shape so
// the source anchor (start or end) lands on the target's same anchor. Masked
// strands can be neither copied nor pasted onto; an AttachedStrand's start
// stays pinned to its parent even when Start Point was copied. Attached
// children glued to a moved parent endpoint follow it (start snaps, free end
// stays, control points translate), recursively.
//
// Deferred vs OSS: bias_control positions (the renderer doesn't draw bias
// controls yet, and the field would round-trip via `extra` anyway).

import type { EditorDocument, Point, RGBA, StrandRecord } from '../model/types';

export const COPY_PROPERTIES = [
  'start_point',
  'end_point',
  'control_points',
  'width',
  'strand_color',
  'stroke_color',
] as const;
export type CopyProperty = (typeof COPY_PROPERTIES)[number];

export interface StrandDataSnapshot {
  source_layer_name: string;
  selected_properties: CopyProperty[];
  // Complete source frame — metadata needed to map even a single copied point;
  // does not imply both endpoint toggles were selected.
  source_start: Point;
  source_end: Point;
  start_point?: Point;
  end_point?: Point;
  width?: number;
  stroke_width?: number;
  strand_color?: RGBA;
  stroke_color?: RGBA;
  control_points?: {
    control_point1: Point;
    control_point_center: Point | null;
    control_point2: Point;
    control_point_center_locked: boolean;
    triangle_has_moved: boolean;
    control_point2_shown: boolean;
    control_point2_activated: boolean;
  };
}

const pt = (p: Point): Point => ({ x: p.x, y: p.y });
const col = (c: RGBA): RGBA => ({ ...c });
const close = (a: Point, b: Point, tol = 0.5): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) <= tol;

export function snapshotStrandData(
  s: StrandRecord,
  selectedProperties?: CopyProperty[],
): StrandDataSnapshot | null {
  if (s.type === 'MaskedStrand') return null;
  const selected = new Set(
    (selectedProperties ?? COPY_PROPERTIES).filter((k) => (COPY_PROPERTIES as readonly string[]).includes(k)),
  );
  if (selected.size === 0) return null;

  const snap: StrandDataSnapshot = {
    source_layer_name: s.layer_name,
    selected_properties: COPY_PROPERTIES.filter((k) => selected.has(k)),
    source_start: pt(s.start),
    source_end: pt(s.end),
  };
  if (selected.has('start_point')) snap.start_point = pt(s.start);
  if (selected.has('end_point')) snap.end_point = pt(s.end);
  if (selected.has('width')) {
    snap.width = s.width;
    snap.stroke_width = s.stroke_width;
  }
  if (selected.has('strand_color')) snap.strand_color = col(s.color);
  if (selected.has('stroke_color')) snap.stroke_color = col(s.stroke_color);
  if (selected.has('control_points')) {
    snap.control_points = {
      control_point1: pt(s.control_points[0]),
      control_point_center: s.control_point_center ? pt(s.control_point_center) : null,
      control_point2: pt(s.control_points[1]),
      control_point_center_locked: !!s.control_point_center_locked,
      triangle_has_moved: !!s.triangle_has_moved,
      control_point2_shown: !!s.control_point2_shown,
      control_point2_activated: !!s.control_point2_activated,
    };
  }
  return snap;
}

export function clipboardPropertyCount(snap: StrandDataSnapshot | null): number {
  return snap ? snap.selected_properties.length : 0;
}

// Keep children glued to a parent endpoint moved by a paste: the child's start
// snaps to the parent's new endpoint, its free end STAYS PUT, and its control
// points retain their offsets from the attached start (translate by the same
// delta). Recursive over the attachment tree (strand_data_clipboard.py
// _move_attached_children).
function moveAttachedChildren(
  draft: EditorDocument,
  parent: StrandRecord,
  oldStart: Point,
  oldEnd: Point,
): void {
  for (const name of Object.keys(draft.strands)) {
    const child = draft.strands[name];
    if (child.type !== 'AttachedStrand' || child.attached_to !== parent.layer_name) continue;
    const oldChildStart = pt(child.start);
    const oldChildEnd = pt(child.end);
    let newChildStart: Point;
    if (close(oldChildStart, oldStart)) newChildStart = pt(parent.start);
    else if (close(oldChildStart, oldEnd)) newChildStart = pt(parent.end);
    else continue;
    const dx = newChildStart.x - oldChildStart.x;
    const dy = newChildStart.y - oldChildStart.y;
    child.start = newChildStart;
    child.end = oldChildEnd;
    child.control_points = [
      { x: child.control_points[0].x + dx, y: child.control_points[0].y + dy },
      { x: child.control_points[1].x + dx, y: child.control_points[1].y + dy },
    ];
    if (child.control_point_center) {
      child.control_point_center = {
        x: child.control_point_center.x + dx,
        y: child.control_point_center.y + dy,
      };
    }
    moveAttachedChildren(draft, child, oldChildStart, oldChildEnd);
  }
}

// Apply the snapshot to one strand. Returns true when any data was applied.
export function applyStrandData(
  draft: EditorDocument,
  snap: StrandDataSnapshot,
  layerName: string,
  anchor: 'start' | 'end',
): boolean {
  const s = draft.strands[layerName];
  if (!snap || !s || s.type === 'MaskedStrand') return false;

  const selected = new Set(snap.selected_properties);
  const oldStart = pt(s.start);
  const oldEnd = pt(s.end);
  const sourceAnchor = anchor === 'end' ? snap.source_end : snap.source_start;
  const targetAnchor = anchor === 'end' ? oldEnd : oldStart;
  const mapped = (p: Point): Point => ({
    x: targetAnchor.x + p.x - sourceAnchor.x,
    y: targetAnchor.y + p.y - sourceAnchor.y,
  });

  const isAttached = s.type === 'AttachedStrand';
  let applied = false;
  let geometryChanged = false;
  let endpointChanged = false;

  if (selected.has('start_point') && snap.start_point && !isAttached) {
    s.start = mapped(snap.start_point);
    applied = geometryChanged = endpointChanged = true;
  }
  if (selected.has('end_point') && snap.end_point) {
    s.end = mapped(snap.end_point);
    applied = geometryChanged = endpointChanged = true;
  }

  const controls = selected.has('control_points') ? snap.control_points : undefined;
  if (controls) {
    s.control_points = [mapped(controls.control_point1), mapped(controls.control_point2)];
    s.control_point_center = controls.control_point_center ? mapped(controls.control_point_center) : null;
    s.control_point_center_locked = controls.control_point_center_locked;
    s.triangle_has_moved = controls.triangle_has_moved;
    s.control_point2_shown = controls.control_point2_shown;
    s.control_point2_activated = controls.control_point2_activated;
    applied = geometryChanged = true;
  } else if (endpointChanged) {
    // OSS update_control_points_from_geometry: cp1/cp2 at 1/3 and 2/3 along the
    // new line, center = their midpoint, center lock reset.
    const dx = s.end.x - s.start.x;
    const dy = s.end.y - s.start.y;
    s.control_points = [
      { x: s.start.x + dx / 3, y: s.start.y + dy / 3 },
      { x: s.start.x + (2 * dx) / 3, y: s.start.y + (2 * dy) / 3 },
    ];
    s.control_point_center = {
      x: (s.control_points[0].x + s.control_points[1].x) / 2,
      y: (s.control_points[0].y + s.control_points[1].y) / 2,
    };
    s.control_point_center_locked = false;
  }

  if (selected.has('width') && snap.width != null && snap.stroke_width != null) {
    s.width = snap.width;
    s.stroke_width = snap.stroke_width;
    applied = true;
  }
  if (selected.has('strand_color') && snap.strand_color) {
    s.color = col(snap.strand_color);
    applied = true;
  }
  if (selected.has('stroke_color') && snap.stroke_color) {
    s.stroke_color = col(snap.stroke_color);
    applied = true;
  }

  if (!applied) return false;

  // An attached strand's start remains pinned to its parent even when Start
  // Point was copied (apply_strand_data tail).
  if (isAttached) s.start = oldStart;

  if (geometryChanged || selected.has('width')) {
    moveAttachedChildren(draft, s, oldStart, oldEnd);
  }
  return true;
}

// Dev-only debug handle for deterministic testing.
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__clipboard = {
    snapshotStrandData, applyStrandData, pasteStrandData, clipboardPropertyCount,
  };
}

// Paste onto every eligible target (non-mask, not locked), lowest z first, in
// ONE caller-provided undo step. Returns the layer names actually changed.
export function pasteStrandData(
  draft: EditorDocument,
  snap: StrandDataSnapshot,
  targets: string[],
  anchor: 'start' | 'end',
): string[] {
  const changed: string[] = [];
  const eligible = draft.order.filter(
    (n) =>
      targets.includes(n) &&
      draft.strands[n] &&
      draft.strands[n].type !== 'MaskedStrand' &&
      !draft.locked_layers.includes(n),
  );
  for (const name of eligible) {
    if (applyStrandData(draft, snap, name, anchor)) changed.push(name);
  }
  return changed;
}
