// The hit-test half of OSS 1.111 end_style.py: what a stylized free end ADDS
// to and REMOVES from the flat-capped selection footprint (strand.py
// get_body_selection_path -> get_footprint_path). The renderer carries the
// same construction in pixel space (web/strand-renderer.js esGeometry); this is
// the WORLD-space polygon form the selection footprint and the click hit-test
// consume, built exactly like OSS's _ahead_polygons / _behind_polygons — one
// simple polygon per run, no boolean operation:
//
//   * `added`   — the cap pieces between the plane just behind the endpoint and
//                 the profile, where the profile is ahead of it (a rounded /
//                 pointed / extended end reaches past the flat cap);
//   * `removed` — everything outward of the profile but behind the cut plane
//                 (a trimmed / angled / notched / concave end gives up part of
//                 the flat-capped body). Nothing ahead of the endpoint plane is
//                 ever removed.
//
// A point is inside the styled footprint iff it is inside the classic body or
// an `added` piece, and inside no `removed` piece.

import type { Point, StrandRecord } from '../model/types';
import type { EndStyle } from '../model/endStyle';

const EDGE_CLEARANCE = 0.1;
const CUT_PLANE = 0.5;

export interface StyledEndPolys {
  added: Point[][];
  removed: Point[][];
  // How far the edge's farthest point reaches beyond the classic end, along
  // the outward tangent (negative when trimmed).
  extentShift: number;
}

function profilePoints(shape: EndStyle['shape'], half: number, depth: number, tiltDeg: number, baseX: number, steps = 24): Point[] {
  let pts: Point[] = [];
  const width = 2 * half;
  if (shape === 'rounded' || shape === 'concave') {
    const r = depth * half, sign = shape === 'rounded' ? 1 : -1;
    for (let i = 0; i <= steps; i++) {
      const y = -half + width * i / steps;
      pts.push({ x: sign * r * Math.sqrt(Math.max(0, 1 - (y / half) * (y / half))), y });
    }
  } else if (shape === 'pointed') {
    pts = [{ x: 0, y: -half }, { x: depth * width, y: 0 }, { x: 0, y: half }];
  } else if (shape === 'notched') {
    pts = [{ x: 0, y: -half }, { x: -depth * width, y: 0 }, { x: 0, y: half }];
  } else {
    pts = [{ x: 0, y: -half }, { x: 0, y: half }];
  }
  const a = tiltDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return fitToBand(pts.map((p) => ({ x: baseX + p.x * c - p.y * s, y: p.x * s + p.y * c })), half);
}

function fitToBand(pts: Point[], half: number): Point[] {
  if (pts.length < 2) return pts;
  half += EDGE_CLEARANCE;
  const hit = (a: Point, b: Point, targetY: number): Point => {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dy) < 1e-9) return b;
    const t = (targetY - a.y) / dy;
    return { x: a.x + dx * t, y: targetY };
  };
  const ascending = pts[0].y < pts[pts.length - 1].y;
  const first = hit(pts[1], pts[0], ascending ? -half : half);
  const last = hit(pts[pts.length - 2], pts[pts.length - 1], ascending ? half : -half);
  return [first, ...pts.slice(1, -1), last];
}

function chordExtended(prof: Point[], ylim: number): [Point, Point] {
  const a = prof[0], b = prof[prof.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dy) < 1e-9) return [{ x: a.x, y: -ylim }, { x: b.x, y: ylim }];
  const sgn = dy > 0 ? 1 : -1;
  const ta = (-sgn * ylim - a.y) / dy, tb = (sgn * ylim - a.y) / dy;
  return [{ x: a.x + dx * ta, y: a.y + dy * ta }, { x: a.x + dx * tb, y: a.y + dy * tb }];
}

function clipPolylineY(pts: Point[], ylim: number): Point[] {
  const out: Point[] = [];
  let prev: Point | null = null;
  for (const p of pts) {
    const inside = Math.abs(p.y) <= ylim;
    if (prev) {
      const prevInside = Math.abs(prev.y) <= ylim;
      if (prevInside !== inside || (!prevInside && !inside && (prev.y > 0) !== (p.y > 0))) {
        const bounds = prev.y < p.y ? [-ylim, ylim] : [ylim, -ylim];
        for (const bound of bounds) {
          const lo = Math.min(prev.y, p.y), hi = Math.max(prev.y, p.y);
          if (lo < bound && bound < hi) {
            const t = (bound - prev.y) / (p.y - prev.y);
            out.push({ x: prev.x + (p.x - prev.x) * t, y: bound });
          }
        }
      }
    }
    if (inside) out.push(p);
    prev = p;
  }
  return out;
}

function runsByX(pts: Point[], x0: number, ahead: boolean): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const cross = (a: Point, b: Point): Point => { const t = (x0 - a.x) / (b.x - a.x); return { x: x0, y: a.y + (b.y - a.y) * t }; };
  let prev: Point | null = null;
  for (const p of pts) {
    const keep = ahead ? p.x > x0 : p.x < x0;
    if (prev) {
      const prevKeep = ahead ? prev.x > x0 : prev.x < x0;
      if (prevKeep !== keep) {
        const c = cross(prev, p);
        if (keep) run = [c];
        else { run.push(c); runs.push(run); run = []; }
      }
    }
    if (keep) run.push(p);
    prev = p;
  }
  if (run.length >= 2) runs.push(run);
  return runs.filter((r) => r.length >= 2);
}

const runsToPolygons = (runs: Point[][], x0: number): Point[][] =>
  runs.map((run) => [{ x: x0, y: run[0].y }, ...run, { x: x0, y: run[run.length - 1].y }]);

function aheadPolygons(prof: Point[], half: number, yLim: number, x0: number): Point[][] {
  const [first, last] = chordExtended(prof, yLim + 1);
  void half;
  return runsToPolygons(runsByX(clipPolylineY([first, ...prof, last], yLim), x0, true), x0);
}

function behindPolygons(prof: Point[], yLim: number, x0: number): Point[][] {
  const [first, last] = chordExtended(prof, yLim);
  return runsToPolygons(runsByX([first, ...prof, last], x0, false), x0);
}

function clearOfEndpointPlane(pts: Point[]): Point[] {
  const xs = pts.map((p) => p.x);
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(b.y - a.y) > 1e-9) {
      const slope = (b.x - a.x) / (b.y - a.y);
      for (const y of [-2 * Math.abs(a.y) - 1, 2 * Math.abs(b.y) + 1]) xs.push(a.x + slope * (y - a.y));
    }
  }
  if (xs.every((x) => Math.abs(x) >= EDGE_CLEARANCE)) return pts;
  const shift = -EDGE_CLEARANCE - Math.max(...xs.filter((x) => Math.abs(x) < EDGE_CLEARANCE));
  return pts.map((p) => ({ x: p.x + shift, y: p.y }));
}

// The world-space polygons of one styled end. `angle` is the OUTWARD tangent at
// the endpoint (a start's tangent flipped), `lineVisible` the end's side-line flag.
export function styledEndPolys(s: StrandRecord, side: 0 | 1, style: EndStyle, lineVisible: boolean, angle: number): StyledEndPolys {
  const point = side === 0 ? s.start : s.end;
  const total = s.width + 2 * s.stroke_width;
  const half = total / 2;
  const lineWidth = style.line_width == null ? s.stroke_width : style.line_width;
  const bandWidth = lineVisible ? lineWidth : 0;
  const baseX = bandWidth + style.offset;
  const profile = clearOfEndpointPlane(profilePoints(style.shape, half, style.depth, style.tilt, baseX));
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const map = (pts: Point[]): Point[] => pts.map((p) => ({ x: point.x + p.x * cos - p.y * sin, y: point.y + p.x * sin + p.y * cos }));
  let maxX = -Infinity;
  for (const p of profile) if (p.x > maxX) maxX = p.x;
  return {
    added: aheadPolygons(profile, half, half, -1).map(map),
    removed: behindPolygons(profile, 1.5 * half, CUT_PLANE).map(map),
    extentShift: maxX - bandWidth,
  };
}
