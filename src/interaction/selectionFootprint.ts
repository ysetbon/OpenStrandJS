// The SELECTION FOOTPRINT of a regular / attached strand — a faithful port of
// OpenStrand Studio's strand.get_selection_paths() (strand.py:1697-1729,
// attached_strand.py:177-219, selection_utils.py), the one geometry OSS uses for
// BOTH the yellow hover / red pick highlight (select_mode.draw, mask_mode.draw)
// and the click hit-test (find_strands_at_point). It is the exact rendered
// silhouette of the strand:
//
//   * the BODY: centreline stroked to the full visible thickness
//     (width + 2*stroke_width), FLAT caps, MITER joins — nothing past the ends;
//   * per END, whatever draw() paints there (get_end_decoration_path):
//       - the cap CIRCLE, radius (w+2sw)/2, when a circle is actually drawn
//         (_end_circle_visible: has_circles + opaque circle stroke + a junction —
//         a child attached there or a closed connection; an AttachedStrand's own
//         start needs no junction);
//       - else the SIDE-LINE bar (update_side_line): stroke_width thick, spanning
//         the full visible width, sitting just outside the flat end — when that
//         end's *_line_visible flag is on and no circle occupies it (attached
//         starts never get one);
//       - else, AttachedStrand only, the INNER fill circle (radius w/2) that
//         draw() adds at an unfolded start (transparent circle stroke) and at an
//         end whose circle flag is on with nothing attached.
//
// OSS appends the components with WindingFill rather than a Boolean union
// (Qt's union can drop the body when a side-line touches it exactly). We do the
// same: `fill` is a list of positively-wound polygons whose NONZERO fill is the
// union; a point is inside the footprint iff it is inside any of them. `outline`
// holds the silhouette sources for the highlight's 2px border (OSS
// selection_outline_path: stroke the components, subtract the footprint).
//
// Circle gating reads the RENDER-TIME has_circles (computeHasCircles in
// strand-renderer.js — topology + manual overrides), so the footprint always
// matches the caps the renderer actually painted: what you see is what you hover.
// Elliptical end-caps are not modelled (the renderer does not draw them either).

import type { EditorDocument, Point, RGBA, Settings, StrandRecord } from '../model/types';
import { endTangentAngles, geometryParams, sampleCenterline } from './hitGeometry';

export interface Footprint {
  fill: Point[][];      // union under the nonzero rule (all positively wound)
  outline: Point[][];   // silhouette sources for the border ring
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

const PT_EPS = 0.5;                       // strand-renderer.js approxPt
const CIRCLE_SEGMENTS = 64;
const FOOTPRINT_PER_SEG = 72;             // centreline samples per cubic segment (sub-pixel vs Qt's flattening)

const approxPt = (a: Point, b: Point): boolean =>
  Math.abs(a.x - b.x) < PT_EPS && Math.abs(a.y - b.y) < PT_EPS;

// Does some OTHER AttachedStrand start at `pt`? (strand-renderer.js
// hasAttachedChildAt — the geometric form of Qt's attached_strands check.)
export function attachedChildAt(pt: Point, doc: EditorDocument, self: StrandRecord): boolean {
  for (const name of doc.order) {
    const c = doc.strands[name];
    if (!c || c === self || c.type !== 'AttachedStrand') continue;
    if (approxPt(c.start, pt)) return true;
  }
  return false;
}

// Render-time has_circles (strand-renderer.js computeHasCircles): the stored
// value is replaced by the topology — a child attached at the end — with the
// layer menu's manual_circle_visibility override winning. An AttachedStrand
// keeps its start circle unless overridden.
export function effectiveHasCircles(s: StrandRecord, doc: EditorDocument): [boolean, boolean] {
  const raw = s.extra?.manual_circle_visibility;
  const mcv: [boolean | null, boolean | null] = Array.isArray(raw)
    ? [raw[0] == null ? null : !!raw[0], raw[1] == null ? null : !!raw[1]]
    : [null, null];
  const endAtt = attachedChildAt(s.end, doc, s);
  if (s.type === 'AttachedStrand') return [mcv[0] ?? true, mcv[1] ?? endAtt];
  return [mcv[0] ?? attachedChildAt(s.start, doc, s), mcv[1] ?? endAtt];
}

// Effective per-end circle stroke alpha: start/end_circle_stroke_color, falling
// back to the legacy circle_stroke_color, then opaque (strand.py:507-557).
function circleAlpha(s: StrandRecord, side: 0 | 1): number {
  const key = side === 0 ? 'start_circle_stroke_color' : 'end_circle_stroke_color';
  const c = (s.extra?.[key] as RGBA | null | undefined) ?? s.circle_stroke_color;
  return c && c.a != null ? c.a : 255;
}

function lineVisible(s: StrandRecord, side: 0 | 1): boolean {
  const v = s.extra?.[side === 0 ? 'start_line_visible' : 'end_line_visible'];
  return v !== false;                     // OSS default True
}

function closedAt(s: StrandRecord, side: 0 | 1): boolean {
  const cc = s.extra?.closed_connections;
  return Array.isArray(cc) && !!cc[side];
}

// ---- polygon helpers ---------------------------------------------------------

function signedArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// Every union member is wound the same way so overlapping pieces add up under
// the nonzero rule instead of cancelling to a hole (windingFillLayer's rule).
function positive(poly: Point[]): Point[] {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

function circlePoly(c: Point, r: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const t = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  return out;
}

// A rectangle in the local frame of `angle` (x along the tangent, y across),
// spanning [x0, x1] x [-halfAcross, halfAcross], translated to `c` — Qt's
// addRect(...) mapped through translate(c).rotate(angle).
function localRect(c: Point, angle: number, x0: number, x1: number, halfAcross: number): Point[] {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const m = (x: number, y: number): Point => ({ x: c.x + x * ca - y * sa, y: c.y + x * sa + y * ca });
  return [m(x0, -halfAcross), m(x1, -halfAcross), m(x1, halfAcross), m(x0, halfAcross)];
}

// Even-odd point-in-polygon; every member polygon here is simple, so this is
// exact per piece and any() over the pieces is the nonzero union.
function pointInPoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---- the body band --------------------------------------------------------------
//
// Qt's QPainterPathStroker output for a FlatCap / MiterJoin stroke. The fill is
// built as per-segment quads plus a miter wedge at every interior vertex — each
// a simple polygon — so a tightly curved centreline whose offset folds back on
// itself still fills completely (a single self-intersecting band polygon would
// cancel to holes under nonzero). The outline is the single mitred band
// boundary the ring is stroked from.
function bandPieces(poly: Point[], half: number): { fill: Point[][]; outline: Point[] } {
  const pts: Point[] = [];
  for (const p of poly) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) pts.push(p);
  }
  if (pts.length < 2 || half <= 0) return { fill: [], outline: [] };
  const n = pts.length;
  const normals: Point[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
    const L = Math.hypot(dx, dy);
    normals.push({ x: -dy / L, y: dx / L });
  }
  const fill: Point[][] = [];
  const left: Point[] = [], right: Point[] = [];
  for (let i = 0; i < n; i++) {
    if (i + 1 < n) {
      const nn = normals[i], a = pts[i], b = pts[i + 1];
      fill.push(positive([
        { x: a.x + nn.x * half, y: a.y + nn.y * half }, { x: b.x + nn.x * half, y: b.y + nn.y * half },
        { x: b.x - nn.x * half, y: b.y - nn.y * half }, { x: a.x - nn.x * half, y: a.y - nn.y * half },
      ]));
    }
    // Mitred offset at this vertex (flat at the two ends).
    const nPrev = normals[Math.max(0, i - 1)], nNext = normals[Math.min(normals.length - 1, i)];
    let mx = nPrev.x + nNext.x, my = nPrev.y + nNext.y;
    const mL = Math.hypot(mx, my);
    let scale = 1;
    if (mL < 1e-9) { mx = nNext.x; my = nNext.y; } else {
      mx /= mL; my /= mL;
      const cosHalf = mx * nNext.x + my * nNext.y;
      // Qt bevels a miter that would exceed its limit; a folded-back joint
      // (cosHalf -> 0) is clamped the same way rather than shot to infinity.
      scale = cosHalf > 0.25 ? 1 / cosHalf : 4;
    }
    const p = pts[i];
    const L = { x: p.x + mx * half * scale, y: p.y + my * half * scale };
    const R = { x: p.x - mx * half * scale, y: p.y - my * half * scale };
    left.push(L); right.push(R);
    if (i > 0 && i + 1 < n) {
      // The join wedges on both sides: [vertex, prev-normal offset, miter tip, next-normal offset].
      fill.push(positive([p, { x: p.x + nPrev.x * half, y: p.y + nPrev.y * half }, L, { x: p.x + nNext.x * half, y: p.y + nNext.y * half }]));
      fill.push(positive([p, { x: p.x - nPrev.x * half, y: p.y - nPrev.y * half }, R, { x: p.x - nNext.x * half, y: p.y - nNext.y * half }]));
    }
  }
  return { fill, outline: left.concat(right.reverse()) };
}

// ---- end decorations (get_end_decoration_path) ----------------------------------

function endDecoration(
  s: StrandRecord, side: 0 | 1, doc: EditorDocument, hc: [boolean, boolean], angle: number,
): Point[] | null {
  const pt = side === 0 ? s.start : s.end;
  const w = s.width, sw = s.stroke_width;
  const R = (w + 2 * sw) / 2;
  const alpha = circleAlpha(s, side);
  const attached = s.type === 'AttachedStrand';

  // AttachedStrand, unfolded start: transparent outline, inner fill circle kept
  // (attached_strand.py:192-201; draw() :1291).
  if (attached && side === 0 && hc[0] && alpha === 0) return circlePoly(pt, w / 2);

  // _end_circle_visible: the flag, an opaque circle stroke, and a junction — an
  // attached start is its own junction (attached_strand.py:177-183).
  const junction = attached && side === 0 ? true : (attachedChildAt(pt, doc, s) || closedAt(s, side));
  if (hc[side] && alpha > 0 && junction) return circlePoly(pt, R);

  // _end_side_line_visible: the side-line bar (never at an attached start).
  const sideLine = attached && side === 0 ? false : (lineVisible(s, side) && !hc[side]);
  if (sideLine) {
    // update_side_line: the bar's centre sits stroke_width/2 outside the flat
    // end along the tangent (start: opposite the tangent), spans the full
    // visible width across, and is stroked stroke_width thick, FlatCap.
    return side === 0 ? localRect(pt, angle, -sw, 0, R) : localRect(pt, angle, 0, sw, R);
  }

  // AttachedStrand end with the circle flag on but nothing attached: draw()
  // still adds the inner end-cap fill (attached_strand.py:209-217).
  if (attached && side === 1 && hc[1]) return circlePoly(pt, w / 2);
  return null;
}

// ---- public API ------------------------------------------------------------------

export function strandFootprint(s: StrandRecord, doc: EditorDocument, settings: Settings): Footprint {
  const curve = geometryParams(settings);
  const centre = sampleCenterline(s, curve, FOOTPRINT_PER_SEG);
  const half = (s.width + 2 * s.stroke_width) / 2;
  const band = bandPieces(centre, half);
  const fill = band.fill.slice();
  const outline: Point[][] = band.outline.length ? [band.outline] : [];
  const hc = effectiveHasCircles(s, doc);
  const [aStart, aEnd] = endTangentAngles(s, curve);
  for (const side of [0, 1] as const) {
    const deco = endDecoration(s, side, doc, hc, side === 0 ? aStart : aEnd);
    if (deco) { const p = positive(deco); fill.push(p); outline.push(p); }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of fill) for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { fill, outline, bbox: { minX, minY, maxX, maxY } };
}

// A click is a pixel, not a point (selection_utils._HIT_TOLERANCE = 0.5, nine
// sub-pixel samples). `tol` is in world units, like OSS's canvas coordinates.
export const HIT_SAMPLE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5],
];

export function footprintContains(fp: Footprint, p: Point): boolean {
  const b = fp.bbox;
  if (p.x < b.minX - 0.5 || p.x > b.maxX + 0.5 || p.y < b.minY - 0.5 || p.y > b.maxY + 0.5) return false;
  for (const [dx, dy] of HIT_SAMPLE_OFFSETS) {
    const q = { x: p.x + dx, y: p.y + dy };
    for (const poly of fp.fill) if (pointInPoly(q, poly)) return true;
  }
  return false;
}
