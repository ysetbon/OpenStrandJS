// Shared hit-testing in WORLD space. Two passes:
//   1. handles (control points then endpoints), topmost strand first — so a
//      handle stays grabbable even when it sits under another strand's body.
//   2. bodies, topmost first — first centerline within (half-width+stroke) wins.
// Masked strands and hidden/locked layers are skipped (not body-selectable in
// Phase 1).

import type { EditorDocument, HandleKind, Point, Settings, StrandRecord } from '../model/types';
import { distToPolyline, sampleCenterline } from './hitGeometry';

export type HitResult =
  | { kind: 'handle'; layerName: string; handle: HandleKind }
  | { kind: 'body'; layerName: string }
  | null;

const ENDPOINT_R = 40;     // world px grab radius for start/end
const CP_R = 26;           // world px grab radius for control points
const CP_SEP = 6;          // a control point is grabbable once this far from both endpoints

const near = (a: Point, b: Point, r: number) => Math.hypot(a.x - b.x, a.y - b.y) <= r;
const sep = (cp: Point, a: Point, b: Point) =>
  Math.hypot(cp.x - a.x, cp.y - a.y) > CP_SEP && Math.hypot(cp.x - b.x, cp.y - b.y) > CP_SEP;

function isInteractable(s: StrandRecord | undefined, doc: EditorDocument): s is StrandRecord {
  return !!s && s.type !== 'MaskedStrand' && !s.is_hidden && !doc.locked_layers.includes(s.layer_name);
}

// Visible, grabbable handles of a strand in priority order.
export function strandHandles(s: StrandRecord): { handle: HandleKind; pos: Point }[] {
  const out: { handle: HandleKind; pos: Point }[] = [];
  if (s.control_point_center && s.control_point_center_locked) {
    out.push({ handle: 'control_point_center', pos: s.control_point_center });
  }
  const [cp1, cp2] = s.control_points;
  if (sep(cp1, s.start, s.end)) out.push({ handle: 'control_point1', pos: cp1 });
  if (sep(cp2, s.start, s.end)) out.push({ handle: 'control_point2', pos: cp2 });
  out.push({ handle: 'start', pos: s.start });
  out.push({ handle: 'end', pos: s.end });
  return out;
}

export function hitTest(world: Point, doc: EditorDocument, settings: Settings): HitResult {
  const rev = [...doc.order].reverse();

  // Pass 1: handles.
  for (const name of rev) {
    const s = doc.strands[name];
    if (!isInteractable(s, doc)) continue;
    for (const h of strandHandles(s)) {
      const r = h.handle === 'start' || h.handle === 'end' ? ENDPOINT_R : CP_R;
      if (near(world, h.pos, r)) return { kind: 'handle', layerName: name, handle: h.handle };
    }
  }

  // Pass 2: bodies.
  for (const name of rev) {
    const s = doc.strands[name];
    if (!isInteractable(s, doc)) continue;
    const poly = sampleCenterline(s, settings.curve_params);
    const reach = s.width / 2 + s.stroke_width + 2;
    if (distToPolyline(world, poly) <= reach) return { kind: 'body', layerName: name };
  }
  return null;
}
