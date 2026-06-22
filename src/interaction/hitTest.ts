// Shared hit-testing in WORLD space. Two passes:
//   1. handles (control points then endpoints), topmost strand first — so a
//      handle stays grabbable even when it sits under another strand's body.
//   2. bodies, topmost first — first centerline within (half-width+stroke) wins.
// Masked strands and hidden/locked layers are skipped (not body-selectable in
// Phase 1).

import type { EditorDocument, HandleKind, Point, Settings, StrandRecord } from '../model/types';
import { distToPolyline, sampleCenterline } from './hitGeometry';
import { maskComponents } from '../model/layerName';

export type HitResult =
  | { kind: 'handle'; layerName: string; handle: HandleKind }
  | { kind: 'body'; layerName: string }
  | null;

const ENDPOINT_R = 60;     // world px grab radius for start/end (OSS 120px area, half 60)
const CP_R = 25;           // world px grab radius for control points (OSS 50px square, half 25)
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
  // cp1 (the triangle) is ALWAYS grabbable — even on a fresh strand where it sits
  // exactly on the start. Its 25px grab area nests inside the 60px endpoint area
  // and is listed first, so a dead-center click grabs cp1 (begins shaping the
  // curve) while an off-center click grabs the endpoint. Grabbing & moving cp1
  // sets triangle_has_moved + control_point2_shown (actions.ts::moveHandle),
  // which then reveals cp2. Mirrors OpenStrand Studio (move_mode.py:2041,2049).
  out.push({ handle: 'control_point1', pos: cp1 });
  // cp2 (the "circle") appears once cp1 has first moved (control_point2_shown),
  // or whenever it already sits away from the endpoints (loaded curves stay editable).
  if (s.control_point2_shown || sep(cp2, s.start, s.end)) out.push({ handle: 'control_point2', pos: cp2 });
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

// Topmost MaskedStrand whose overlap region contains `world`. The overlap is
// approximated as "inside both component bodies" (the renderer's exact region is
// first.stroked ∩ second.stroked, but body containment is enough to grab a mask).
export function maskHitTest(world: Point, doc: EditorDocument, settings: Settings): string | null {
  for (const name of [...doc.order].reverse()) {
    const s = doc.strands[name];
    if (!s || s.type !== 'MaskedStrand' || s.is_hidden) continue;
    const comp = maskComponents(name);
    if (!comp) continue;
    const a = doc.strands[comp.first], b = doc.strands[comp.second];
    if (!a || !b) continue;
    // Match the renderer's mask region: first.stroked(width) ∩
    // second.stroked(width + 2*stroke + 4) -> first uses ±width/2, second is
    // expanded by stroke + 2 on each side.
    const inA = distToPolyline(world, sampleCenterline(a, settings.curve_params)) <= a.width / 2 + 1;
    const inB = distToPolyline(world, sampleCenterline(b, settings.curve_params)) <= b.width / 2 + b.stroke_width + 3;
    if (inA && inB) return name;
  }
  return null;
}

// Dev-only debug handle for hit-testing.
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__hit = { hitTest, maskHitTest };
}
