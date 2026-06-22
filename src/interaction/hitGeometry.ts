// TS mirror of strand-renderer.js::buildProfile, used only for HIT-TESTING
// (selecting a strand by clicking its body). It produces a sampled centerline
// polyline in world space; the hit-test measures distance to it. The visible
// rendering still comes from the verified renderer — this is just geometry the
// pointer code needs and the renderer doesn't expose.

import type { Point, Settings, StrandRecord } from '../model/types';

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s });
const len = (v: Point): number => Math.hypot(v.x, v.y);
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const norm = (v: Point): Point => { const l = len(v); return l < 0.001 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l }; };

interface Cubic { p0: Point; cp1: Point; cp2: Point; p3: Point; }
type Profile = { mode: 'line' } | { mode: 'multi'; segments: Cubic[] };

type Curve = Settings['curve_params'];

// Faithful port of _build_curve_profile (the non-bias path; bias fixed at 0.5).
function buildProfile(s: StrandRecord, curve: Curve, enableThird: boolean): Profile {
  const start = s.start, end = s.end;
  const cps = s.control_points || [start, end];
  const control_point1 = cps[0] || start;
  const control_point2 = cps[1] || end;
  const { base_fraction, dist_multiplier, exponent } = curve;
  const bias = 0.5;

  const thirdLocked = enableThird && s.control_point_center_locked && s.control_point_center;
  if (thirdLocked && s.control_point_center) {
    const p0 = start, p1 = control_point1, p2 = s.control_point_center, p3 = control_point2, p4 = end;
    const in_norm = norm(sub(p2, p1)), out_norm = norm(sub(p3, p2));
    const ct = { x: (in_norm.x + out_norm.x) * 0.5, y: (in_norm.y + out_norm.y) * 0.5 };
    const dist2 = dist(p2, p1), dist3 = dist(p3, p2);
    let frac1 = Math.min(0.1 + base_fraction * 0.3, 8.33);
    let frac2 = Math.min(0.05 + base_fraction * 0.15, 3.77);
    frac1 = Math.min(frac1 * dist_multiplier, 8.33);
    frac2 = Math.min(frac2 * dist_multiplier, 8.33);
    if (exponent !== 1.0) { frac1 = Math.pow(frac1, 1 / exponent); frac2 = Math.pow(frac2, 1 / exponent); }
    const cp1 = add(p0, mul(sub(p1, p0), frac1 * (0.5 + bias)));
    const cp2 = sub(p2, mul(ct, dist2 * frac2 * (0.5 + bias)));
    const cp3 = add(p2, mul(ct, dist3 * frac2 * (0.5 + bias)));
    const cp4 = add(p4, mul(sub(p3, p4), frac2 * (0.5 + bias)));
    return { mode: 'multi', segments: [{ p0, cp1, cp2, p3: p2 }, { p0: p2, cp1: cp3, cp2: cp4, p3: p4 }] };
  }

  const cp1AtStart = Math.abs(control_point1.x - start.x) < 1.0 && Math.abs(control_point1.y - start.y) < 1.0;
  const cp2AtStart = Math.abs(control_point2.x - start.x) < 1.0 && Math.abs(control_point2.y - start.y) < 1.0;
  if (cp1AtStart && cp2AtStart) return { mode: 'line' };

  const p0 = start, p1 = control_point1;
  const p2 = { x: (control_point1.x + control_point2.x) / 2, y: (control_point1.y + control_point2.y) / 2 };
  const p3 = control_point2, p4 = end;
  const in_norm = norm(sub(p2, p1)), out_norm = norm(sub(p3, p2));
  const ct = { x: (in_norm.x + out_norm.x) * 0.5, y: (in_norm.y + out_norm.y) * 0.5 };
  const dist2 = dist(p2, p1), dist3 = dist(p3, p2);
  let frac1 = Math.min(Math.min(0.1 + base_fraction * 0.2, 2.34) * dist_multiplier, 8.33);
  let frac2 = Math.min(Math.min(0.05 + base_fraction * 0.1, 1.17) * dist_multiplier, 8.33);
  if (exponent !== 1.0) { frac1 = Math.pow(frac1, 1 / exponent); frac2 = Math.pow(frac2, 1 / exponent); }
  const cp1 = add(p0, mul(sub(p1, p0), frac1 * (0.5 + bias)));
  const cp2 = sub(p2, mul(ct, dist2 * frac2 * (0.5 + bias)));
  const cp3 = add(p2, mul(ct, dist3 * frac2 * (0.5 + bias)));
  const cp4 = add(p4, mul(sub(p3, p4), frac2 * (0.5 + bias)));
  return { mode: 'multi', segments: [{ p0, cp1, cp2, p3: p2 }, { p0: p2, cp1: cp3, cp2: cp4, p3: p4 }] };
}

function cubicAt(c: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return {
    x: a * c.p0.x + b * c.cp1.x + d * c.cp2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.cp1.y + d * c.cp2.y + e * c.p3.y,
  };
}

// Sampled centerline (world space). ~per-segment resolution good enough for
// click hit-testing.
export function sampleCenterline(s: StrandRecord, curve: Curve, perSeg = 18): Point[] {
  const enableThird = s.control_point_center != null;
  const prof = buildProfile(s, curve, enableThird);
  if (prof.mode === 'line') return [s.start, s.end];
  const pts: Point[] = [];
  for (const seg of prof.segments) {
    for (let i = 0; i <= perSeg; i++) pts.push(cubicAt(seg, i / perSeg));
  }
  return pts;
}

// Minimum distance from p to the polyline (world space).
export function distToPolyline(p: Point, poly: Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}
