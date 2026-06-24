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

// Segment-segment intersection test (orientation method, CLRS). Returns true for
// a proper X crossing AND for the boundary case where an endpoint lies on the
// other segment. The touch case matters because the sampled centerlines place a
// vertex exactly on the other line at symmetric crossings (e.g. a horizontal
// strand crossed by a vertical one): there every straddling sub-segment pair has
// an endpoint with orientation 0, so a strict proper-only test would miss the
// crossing entirely. (The attached-join false positive that touch-tolerance would
// introduce is filtered out in strandsCross by skipping pairs that share an
// endpoint.)
export function segIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o = (a: Point, b: Point, c: Point): number =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSeg = (a: Point, b: Point, c: Point): boolean =>
    Math.min(a.x, b.x) - 1e-9 <= c.x && c.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= c.y && c.y <= Math.max(a.y, b.y) + 1e-9;
  const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(p3, p4, p1)) return true;
  if (d2 === 0 && onSeg(p3, p4, p2)) return true;
  if (d3 === 0 && onSeg(p1, p2, p3)) return true;
  if (d4 === 0 && onSeg(p1, p2, p4)) return true;
  return false;
}

// Do two strands' centerlines actually cross? Samples both centerlines (curve-
// aware) and tests every segment pair. The straight-line fast case keeps a
// non-curved pair to a single segment-pair test. This gates the mask grid:
// OSS only produces a mask where the two ribbons overlap (area intersection);
// a centerline crossing is the faithful, cheap polyline approximation of that.
export function strandsCross(a: StrandRecord, b: StrandRecord, curve: Curve): boolean {
  // Strands joined at a shared endpoint (an attached/welded join) are connected,
  // not woven — skip the pair so the join point isn't masked as a crossing.
  const eq = (p: Point, q: Point): boolean => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  for (const ea of [a.start, a.end]) for (const eb of [b.start, b.end]) if (eq(ea, eb)) return false;
  const pa = sampleCenterline(a, curve);
  const pb = sampleCenterline(b, curve);
  for (let i = 0; i + 1 < pa.length; i++) {
    for (let j = 0; j + 1 < pb.length; j++) {
      if (segIntersect(pa[i], pa[i + 1], pb[j], pb[j + 1])) return true;
    }
  }
  return false;
}

// Do two strands' STROKED BODIES overlap? This is the faithful gate for creating
// a two-click mask: OSS create_masked_layer refuses a mask only when
// get_stroked_path(s1).intersected(get_stroked_path(s2)).isEmpty()
// (strand_drawing_canvas.py:3141-3150). Unlike strandsCross (which gates the group
// auto-grid and deliberately excludes endpoint-sharing/attached pairs), a mask of
// two CONNECTED or overlapping ribbons IS valid here, so we test true body overlap:
// the centerlines cross, OR any sample of one lies within the combined stroked
// half-widths of the other (covers shared endpoints, T-junctions, and near-parallel
// touching ribbons that never cross at the centerline).
export function strandBodiesOverlap(a: StrandRecord, b: StrandRecord, curve: Curve): boolean {
  const pa = sampleCenterline(a, curve);
  const pb = sampleCenterline(b, curve);
  for (let i = 0; i + 1 < pa.length; i++) {
    for (let j = 0; j + 1 < pb.length; j++) {
      if (segIntersect(pa[i], pa[i + 1], pb[j], pb[j + 1])) return true;
    }
  }
  const reach = a.width / 2 + a.stroke_width + b.width / 2 + b.stroke_width;
  for (const p of pa) if (distToPolyline(p, pb) <= reach) return true;
  for (const p of pb) if (distToPolyline(p, pa) <= reach) return true;
  return false;
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
