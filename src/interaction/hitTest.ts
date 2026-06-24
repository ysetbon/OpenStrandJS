// Shared hit-testing in WORLD space. Two passes:
//   1. handles (control points then endpoints), topmost strand first — so a
//      handle stays grabbable even when it sits under another strand's body.
//   2. bodies, topmost first — first centerline within (half-width+stroke) wins.
// Masked strands and hidden/locked layers are skipped (not body-selectable in
// Phase 1).

import type { EditorDocument, HandleKind, Point, Settings, StrandRecord } from '../model/types';
import { distToPolyline, sampleCenterline, biasPositions } from './hitGeometry';
import { buildConnTable } from './connections';
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

// Visible, grabbable handles of a strand in priority order. The center (third CP) is
// offered on the same gate as OSS draws/grabs it: enable_third_control_point AND
// triangle_has_moved (NOT control_point_center_locked, which is only SET by grabbing it —
// move_mode.py:2080; strand_drawing_canvas.py:6174). So visible == grabbable.
export function strandHandles(s: StrandRecord, enableThird = false): { handle: HandleKind; pos: Point }[] {
  const out: { handle: HandleKind; pos: Point }[] = [];
  if (enableThird && s.triangle_has_moved && s.control_point_center) {
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
    for (const h of strandHandles(s, settings.enable_third_control_point)) {
      const r = h.handle === 'start' || h.handle === 'end' ? ENDPOINT_R : CP_R;
      if (near(world, h.pos, r)) return { kind: 'handle', layerName: name, handle: h.handle };
    }
  }

  // Pass 2: bodies. Match the drawn curve's bias so a biased body stays clickable.
  const enableBias = settings.enable_third_control_point && settings.enable_curvature_bias_control;
  for (const name of rev) {
    const s = doc.strands[name];
    if (!isInteractable(s, doc)) continue;
    const poly = sampleCenterline(s, settings.curve_params, enableBias);
    const reach = s.width / 2 + s.stroke_width + 2;
    if (distToPolyline(world, poly) <= reach) return { kind: 'body', layerName: name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// MOVE-MODE grab — a faithful port of OpenStrand Studio's press-time hit-test
// (move_mode.mousePressEvent / handle_strand_movement / try_move_control_points /
// try_move_strand). Unlike the generic `hitTest` above it:
//   * uses AXIS-ALIGNED SQUARE areas (QRectF/QPainterPath.contains), NOT circles —
//     endpoints are a 120x120 square (half 60), control points a 50x50 square (half 25);
//   * runs THREE passes whose winner is whoever fires FIRST:
//       1. control points across ALL strands in FORWARD (bottom-first) order — a CP
//          anywhere beats any endpoint anywhere (move_mode.py:1814-1822);
//       2. endpoints in FORWARD order, "connection-aware": at a shared joint it
//          collects every strand whose square contains the click plus its directed
//          neighbour, then PREFERS the first non-AttachedStrand (the parent) so a
//          parent+child weld grabs the PARENT (move_mode.py:1829-1887);
//       3. a REVERSE (topmost-first) fallback for isolated endpoints with no recorded
//          connection (move_mode.py:1889-1900);
//   * NEVER returns a body (move mode has no body hit-test — a body click does not
//     grab and does not select).
// Picking the parent as the BFS root is what makes connectedMovers/gatherMoving
// move the OSS-correct set, so this must match OSS exactly.
const ENDPOINT_HALF = 60;  // OSS get_start_area/get_end_area: 120px square
const CP_HALF = 25;        // OSS get_control_point_rectangle: 50px square

const inSquare = (p: Point, c: Point, half: number) =>
  Math.abs(p.x - c.x) <= half && Math.abs(p.y - c.y) <= half;
const eqPt = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

// A strand is grabbable in move mode if it is a real (non-masked), visible strand.
// Lock gating is applied per-side by canMoveSide (OSS can_move_side).
function moveGrabbable(s: StrandRecord | undefined): s is StrandRecord {
  return !!s && s.type !== 'MaskedStrand' && !s.is_hidden;
}

// OSS can_move_side: only active when lock mode is on. A locked strand is frozen;
// an endpoint that coincides with a LOCKED neighbour's start/end is also frozen
// (a shared joint with a locked layer can't be dragged). Control points pass
// through (the per-strand lock is checked separately in the CP pass).
function canMoveSide(doc: EditorDocument, s: StrandRecord, side: 0 | 1): boolean {
  if (!doc.lock_mode) return true;
  if (doc.locked_layers.includes(s.layer_name)) return false;
  const pt = side === 0 ? s.start : s.end;
  for (const name of doc.locked_layers) {
    const o = doc.strands[name];
    if (o && (eqPt(pt, o.start) || eqPt(pt, o.end))) return false;
  }
  return true;
}

// Grabbable control points of a strand, in OSS try_move_control_points order:
// cp1 (always) -> cp2 (only if control_point2_shown) -> center. OSS gates the center
// on the GLOBAL enable_third_control_point toggle AND triangle_has_moved (move_mode.py:
// 2080); grabbing it is what LOCKS it. So we gate on `enableThird && triangle_has_moved`,
// NOT on control_point_center_locked (which would be chicken-and-egg: locked is only set
// BY grabbing the center). With the feature off (default), the center is never grabbable —
// exactly matching OSS with the toggle off.
function moveCpHandles(s: StrandRecord, enableThird: boolean, enableBias: boolean): { handle: HandleKind; pos: Point }[] {
  const out: { handle: HandleKind; pos: Point }[] = [];
  // OSS try_move_control_points (the authoritative PRESS path, move_mode.py:1978) checks
  // the BIAS controls FIRST — before cp1/cp2/center — so a bias square dragged onto the
  // center (bias->0, where the square overlaps the center handle) re-grabs the BIAS
  // control, not the center. Mirror that press order here (moveGrab returns first match).
  // Gate: bias toggle on AND center LOCKED (should_show_controls). enableBias already
  // implies enableThird (effective gate computed in moveGrab).
  if (enableThird && enableBias && s.control_point_center_locked && s.triangle_has_moved && s.control_point_center) {
    const bp = biasPositions(s);
    if (bp) {
      out.push({ handle: 'bias_triangle', pos: bp.triangle });
      out.push({ handle: 'bias_circle', pos: bp.circle });
    }
  }
  out.push({ handle: 'control_point1', pos: s.control_points[0] });
  if (s.control_point2_shown) out.push({ handle: 'control_point2', pos: s.control_points[1] });
  if (enableThird && s.triangle_has_moved && s.control_point_center) {
    out.push({ handle: 'control_point_center', pos: s.control_point_center });
  }
  return out;
}

export type MoveGrab = { layerName: string; handle: HandleKind } | null;

export function moveGrab(world: Point, doc: EditorDocument, settings: Settings): MoveGrab {
  const enableThird = settings.enable_third_control_point;
  const enableBias = enableThird && settings.enable_curvature_bias_control;
  // Pass 1 — control points, ALL strands, FORWARD. First hit wins over any endpoint.
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!moveGrabbable(s)) continue;
    if (doc.lock_mode && doc.locked_layers.includes(name)) continue;  // locked: no CP grab
    for (const h of moveCpHandles(s, enableThird, enableBias)) {
      if (inSquare(world, h.pos, CP_HALF)) return { layerName: name, handle: h.handle };
    }
  }

  // Pass 2 — connection-aware endpoints, FORWARD. First collect the DIRECT endpoint
  // hits (no connection table needed); only if there is at least one do we build the
  // directed table to pull in joint neighbours — so plain hovering over empty space or
  // a control point never pays for buildConnTable.
  const direct: { name: string; side: 0 | 1 }[] = [];
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!moveGrabbable(s)) continue;
    for (const side of [0, 1] as const) {
      const pt = side === 0 ? s.start : s.end;
      if (inSquare(world, pt, ENDPOINT_HALF) && canMoveSide(doc, s, side)) direct.push({ name, side });
    }
  }
  if (direct.length) {
    const table = buildConnTable(doc);
    const joint: { name: string; side: 0 | 1 }[] = [];
    const addJoint = (name: string, side: 0 | 1) => {
      if (!joint.some((e) => e.name === name)) joint.push({ name, side });
    };
    for (const { name, side } of direct) {
      addJoint(name, side);
      // Pull in the one directed neighbour at this slot. OSS adds the neighbour even
      // when it is HIDDEN (get_connected_strands has no is_hidden filter — only the
      // DIRECT hits above are visibility-gated), so a hidden parent can still become the
      // preferred grab root. MaskedStrands never appear in the table, so existence is enough.
      const nb = table.get(name, side);
      if (nb && doc.strands[nb.name]) addJoint(nb.name, nb.point);
    }
    const pick = joint.find((e) => doc.strands[e.name].type !== 'AttachedStrand') ?? joint[0];
    return { layerName: pick.name, handle: pick.side === 0 ? 'start' : 'end' };
  }

  // Pass 3 — topmost (REVERSE) fallback for isolated endpoints.
  for (const name of [...doc.order].reverse()) {
    const s = doc.strands[name];
    if (!moveGrabbable(s)) continue;
    if (inSquare(world, s.start, ENDPOINT_HALF) && canMoveSide(doc, s, 0)) return { layerName: name, handle: 'start' };
    if (inSquare(world, s.end, ENDPOINT_HALF) && canMoveSide(doc, s, 1)) return { layerName: name, handle: 'end' };
  }
  return null;
}

// Topmost MaskedStrand whose overlap region contains `world`. The overlap is
// approximated as "inside both component bodies" (the renderer's exact region is
// first.stroked ∩ second.stroked, but body containment is enough to grab a mask).
export function maskHitTest(world: Point, doc: EditorDocument, settings: Settings): string | null {
  const enableBias = settings.enable_third_control_point && settings.enable_curvature_bias_control;
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
    const inA = distToPolyline(world, sampleCenterline(a, settings.curve_params, enableBias)) <= a.width / 2 + 1;
    const inB = distToPolyline(world, sampleCenterline(b, settings.curve_params, enableBias)) <= b.width / 2 + b.stroke_width + 3;
    if (inA && inB) return name;
  }
  return null;
}

// All non-masked strands whose body OR endpoint-selection circle contains the
// point, topmost first — the mask-mode picker (OSS mask_mode.find_strands_at_point).
// OSS endpoint paths are circles of radius max(width/2, 15); the body is the
// stroked selection path (approximated by distToPolyline <= width/2+stroke+2).
// Mask mode never selects/hovers MaskedStrands; we also skip hidden/locked (a
// hidden strand has no visible body to click). Used to enforce OSS's "select only
// when EXACTLY ONE strand is at the point, else clear" rule and the hover target.
export function maskStrandsAtPoint(world: Point, doc: EditorDocument, settings: Settings): string[] {
  const out: string[] = [];
  const enableBias = settings.enable_third_control_point && settings.enable_curvature_bias_control;
  for (const name of [...doc.order].reverse()) {
    const s = doc.strands[name];
    if (!isInteractable(s, doc)) continue;
    const endR = Math.max(s.width / 2, 15);
    if (near(world, s.start, endR) || near(world, s.end, endR)) { out.push(name); continue; }
    const poly = sampleCenterline(s, settings.curve_params, enableBias);
    if (distToPolyline(world, poly) <= s.width / 2 + s.stroke_width + 2) out.push(name);
  }
  return out;
}

// Dev-only debug handle for hit-testing.
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__hit = { hitTest, maskHitTest, maskStrandsAtPoint };
}
