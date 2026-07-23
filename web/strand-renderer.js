// Shared OpenStrandJS renderer. Loaded by both the headless harness
// (render.html, driven by Playwright) and the interactive viewer (viewer.html).
// Requires paper.js to be loaded first (global `paper`).

// ---- small vector helpers (plain {x,y}, world space) ----
const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const vmul = (a, s) => ({ x: a.x * s, y: a.y * s });
const vlen = (v) => Math.hypot(v.x, v.y);
const vdist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const vnorm = (v) => { const l = vlen(v); return l < 0.001 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l }; };

function toColor(c) {
  if (!c) return new paper.Color(0, 0, 0, 1);
  const a = (c.a == null ? 255 : c.a) / 255;
  return new paper.Color(c.r / 255, c.g / 255, c.b / 255, a);
}

// Grid line positions in TARGET-canvas pixel coords (LIVE EDITOR ONLY — the
// offline oracle never sets meta.show_grid, so this returns null there and the
// fidelity fixtures stay byte-identical). `scale` maps world->target px (= zoom
// for the visible 1x canvas, = ss*zoom for the supersampled offscreen) and ox/oy
// are the matching pan offsets in that same target space. Mirrors the screen-space
// math the overlay used previously, so lines land on the same world multiples of
// grid_size that snap-to-grid quantizes to. Returns { xs, ys } or null.
function computeGridLines(meta, scale, ox, oy, targetW, targetH) {
  const g = meta.grid_size;
  if (!meta.show_grid || !g || g <= 0) return null;
  if (g * (meta.zoom || 1) < 4) return null; // skip when too dense (matches the old overlay gate)
  const xs = [], ys = [];
  const worldLeft = (0 - ox) / scale, worldRight = (targetW - ox) / scale;
  const worldTop = (0 - oy) / scale, worldBottom = (targetH - oy) / scale;
  for (let x = Math.floor(worldLeft / g) * g; x <= worldRight; x += g) xs.push(x * scale + ox);
  for (let y = Math.floor(worldTop / g) * g; y <= worldBottom; y += g) ys.push(y * scale + oy);
  return { xs, ys };
}

// Curve-shape parameters. These are canvas-level settings (NOT stored per
// strand in the JSON); the reference renderer exports the canvas's values
// into meta.curve_params. Defaults match the braid fixtures.
let CURVE = { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 };

// Centerline sampling step (px) used to build stroked outlines. renderFixture (the
// pixel oracle) always uses 1 (~1px, full accuracy). The interactive drag path sets
// it coarser via DRAG_SAMPLE_STEP so a long curvy strand isn't sampled thousands of
// times per frame; the body is a hair less smooth mid-drag and snaps back to full
// accuracy on pointer-up. Only _dragPaint raises it, and renderFixture resets it to
// 1 on entry, so the harness output is unaffected.
let SAMPLE_STEP = 1;
const DRAG_SAMPLE_STEP = 3;

// Shadow parameters — faithful port of shader_utils.py::draw_strand_shadow. The
// canvas loads NumSteps=2 / MaxBlurRadius=30.0 / ShadowColor=0,0,0,150 from
// user_settings.txt, so the function-signature default of 3 is moot; the LOADED
// value 2 wins. A strand casts onto every lower-ordered strand in two passes:
//   PASS A — SOLID CORE (unclipped, full alpha 150): the union of all surviving
//     (caster body+circles) ∩ (receiver rendered geometry) regions, filled solid.
//   PASS B — FADED BLUR (clipped to the union of receiver bodies): NUM_STEPS=2
//     boundary-stroke passes over (core ∪ caster-circles) with the per-step
//     width/alpha table computed from the formulas below (15px@150, 30px@75),
//     FlatCap / RoundJoin. The blur is what produces the soft fringe beyond the
//     caster body; the caster's own body (drawn after) covers the inner shadow.
const SHADOW_COLOR = { r: 0, g: 0, b: 0, a: 150 };
const MAX_BLUR = 30;
const NUM_STEPS = 2; // loaded reference setting (user_settings.txt NumSteps:2)
let SHADOW_ENABLED = false; // set per-fixture from meta.shadow_enabled
let SHADOW_PAINT = null;    // paper.Color for shadows (solid-core paint)
let SHADOW_OVERRIDES = {};  // meta.shadow_overrides, keyed [caster][receiver] (consumed in the Port phase)

// Faithful port of strand.py::_build_curve_profile. Returns {mode, segments}
// in world coordinates; each segment is a cubic {p0, cp1, cp2, p3}.
function buildProfile(s, enableThird) {
  const start = s.start, end = s.end;
  const cps = s.control_points || [];
  const control_point1 = cps[0] || start;
  const control_point2 = cps[1] || end;
  const base_fraction = CURVE.base_fraction;
  const dist_multiplier = CURVE.dist_multiplier;
  const exponent = CURVE.exponent;
  const bias_triangle = 0.5, bias_circle = 0.5; // no bias control in fixtures

  const thirdLocked = enableThird && s.control_point_center_locked && s.control_point_center;

  if (thirdLocked) {
    const p0 = start, p1 = control_point1, p2 = s.control_point_center, p3 = control_point2, p4 = end;
    const in_norm = vnorm(vsub(p2, p1)), out_norm = vnorm(vsub(p3, p2));
    const center_tangent = { x: (in_norm.x + out_norm.x) * 0.5, y: (in_norm.y + out_norm.y) * 0.5 };
    const dist2 = vdist(p2, p1), dist3 = vdist(p3, p2);
    let frac1 = Math.min(0.1 + base_fraction * 0.3, 8.33);
    let frac2 = Math.min(0.05 + base_fraction * 0.15, 3.77);
    frac1 = Math.min(frac1 * dist_multiplier, 8.33);
    frac2 = Math.min(frac2 * dist_multiplier, 8.33);
    if (exponent !== 1.0) { frac1 = Math.pow(frac1, 1 / exponent); frac2 = Math.pow(frac2, 1 / exponent); }
    const cp1 = vadd(p0, vmul(vsub(p1, p0), frac1 * (0.5 + bias_triangle)));
    const cp2 = vsub(p2, vmul(center_tangent, dist2 * frac2 * (0.5 + bias_triangle)));
    const cp3 = vadd(p2, vmul(center_tangent, dist3 * frac2 * (0.5 + bias_circle)));
    const cp4 = vadd(p4, vmul(vsub(p3, p4), frac2 * (0.5 + bias_circle)));
    return { mode: 'multi', segments: [{ p0, cp1, cp2, p3: p2 }, { p0: p2, cp1: cp3, cp2: cp4, p3: p4 }] };
  }

  const cp1_at_start = Math.abs(control_point1.x - start.x) < 1.0 && Math.abs(control_point1.y - start.y) < 1.0;
  const cp2_at_start = Math.abs(control_point2.x - start.x) < 1.0 && Math.abs(control_point2.y - start.y) < 1.0;
  if (cp1_at_start && cp2_at_start) return { mode: 'line', segments: [] };

  const p0 = start, p1 = control_point1;
  const p2 = { x: (control_point1.x + control_point2.x) / 2, y: (control_point1.y + control_point2.y) / 2 };
  const p3 = control_point2, p4 = end;
  const in_norm = vnorm(vsub(p2, p1)), out_norm = vnorm(vsub(p3, p2));
  const center_tangent = { x: (in_norm.x + out_norm.x) * 0.5, y: (in_norm.y + out_norm.y) * 0.5 };
  const dist2 = vdist(p2, p1), dist3 = vdist(p3, p2);
  let frac1 = Math.min(Math.min(0.1 + base_fraction * 0.2, 2.34) * dist_multiplier, 8.33);
  let frac2 = Math.min(Math.min(0.05 + base_fraction * 0.1, 1.17) * dist_multiplier, 8.33);
  if (exponent !== 1.0) { frac1 = Math.pow(frac1, 1 / exponent); frac2 = Math.pow(frac2, 1 / exponent); }
  const cp1 = vadd(p0, vmul(vsub(p1, p0), frac1 * (0.5 + bias_triangle)));
  const cp2 = vsub(p2, vmul(center_tangent, dist2 * frac2 * (0.5 + bias_triangle)));
  const cp3 = vadd(p2, vmul(center_tangent, dist3 * frac2 * (0.5 + bias_circle)));
  const cp4 = vadd(p4, vmul(vsub(p3, p4), frac2 * (0.5 + bias_circle)));
  return { mode: 'multi', segments: [{ p0, cp1, cp2, p3: p2 }, { p0: p2, cp1: cp3, cp2: cp4, p3: p4 }] };
}

// Build the centerline as a paper.Path in pixel space.
function buildCenterline(s, P, enableThird) {
  const prof = buildProfile(s, enableThird);
  const path = new paper.Path();
  if (prof.mode === 'line') {
    path.moveTo(P(s.start));
    path.lineTo(P(s.end));
    return path;
  }
  path.moveTo(P(prof.segments[0].p0));
  for (const sg of prof.segments) {
    path.cubicCurveTo(P(sg.cp1), P(sg.cp2), P(sg.p3));
  }
  return path;
}

// Equivalent of QPainterPathStroker.createStroke(width): the closed outline
// produced by stroking the centerline at the given width with flat caps.
// Implemented by sampling the centerline and offsetting by +/- width/2 along
// the normal, then joining left + reversed-right into a closed path.
function strokedOutline(centerline, width) {
  const len = centerline.length;
  if (len === 0 || width <= 0) return null;
  const half = width / 2;
  const N = Math.max(8, Math.ceil(len / SAMPLE_STEP)); // ~1px sampling (coarser while dragging)
  const left = [], right = [];
  for (let i = 0; i <= N; i++) {
    const off = Math.min(len * i / N, len - 1e-4);
    const pt = centerline.getPointAt(off);
    const nrm = centerline.getNormalAt(off);
    if (!pt || !nrm) continue;
    left.push(pt.add(nrm.multiply(half)));
    right.push(pt.subtract(nrm.multiply(half)));
  }
  right.reverse();
  return new paper.Path({ segments: left.concat(right), closed: true });
}

// Stroked body outline at an arbitrary width (pixel space), with
// self-intersections (from offsetting a tightly curved centerline) resolved
// into a clean boundary. Returns a paper path or null. The masking primitive.
function strokedBodyAtWidth(s, P, enableThird, widthPx) {
  const centerline = buildCenterline(s, P, enableThird);
  let outline = strokedOutline(centerline, widthPx);
  centerline.remove();
  if (!outline) return null;
  const cleaned = outline.resolveCrossings();
  if (cleaned !== outline) { outline.remove(); outline = cleaned; }
  return outline;
}

// Resolve self-intersections of a stroked outline into a clean boundary.
function cleanOutline(outline) {
  if (!outline) return null;
  const cleaned = outline.resolveCrossings();
  if (cleaned !== outline) outline.remove();
  return cleaned;
}

// ---- end-cap & side-line geometry (PIXEL space) -------------------------------
// Faithful port of the cap drawing in strand.py::draw and attached_strand.py::draw.
// Qt draws the body as TWO filled layers (stroke path at width+2*stroke in stroke
// color, fill path at width in color on top) and ADDS end caps to each layer:
//   outer = half of a circle/ellipse  -> stroke (combined_stroke_path)
//   inner = full circle/ellipse       -> fill   (combined_fill_path)
//   side rectangle                    -> fill   (combined_fill_path)
// With elliptical_end_caps off (the whole current corpus) _partner_cap_dims is
// (None, None), so every cap is a plain CIRCLE: outer R=(w+2sw)/2, inner R=w/2.

const PT_EPS = 0.5; // world-space coincidence tolerance (Qt compares points exactly)
function approxPt(a, b) {
  return !!a && !!b && Math.abs(a.x - b.x) < PT_EPS && Math.abs(a.y - b.y) < PT_EPS;
}
// circle_stroke colors default to a visible (alpha 255) stroke when absent.
function circleStrokeAlpha(c) { return c && c.a != null ? c.a : 255; }
// Effective per-end stroke: OSS start/end_circle_stroke_color are properties
// that fall back to the legacy circle_stroke_color, then opaque black
// (strand.py:507-521 / 543-557). Saved files may carry only the legacy field
// (e.g. an unfolded start stored as circle_stroke_color alpha 0), so every
// alpha gate must resolve through the same fallback chain.
function effStartStroke(s) { return s.start_circle_stroke_color != null ? s.start_circle_stroke_color : s.circle_stroke_color; }
function effEndStroke(s) { return s.end_circle_stroke_color != null ? s.end_circle_stroke_color : s.circle_stroke_color; }

// True when some OTHER AttachedStrand starts at world point `pt` (i.e. a child
// attaches there). Mirrors Qt's `any(child.start == self.<end> for child in
// self.attached_strands)`, reconstructed geometrically from the flat strand list.
function hasAttachedChildAt(pt, strands, self) {
  for (const c of strands) {
    if (c === self || c.type !== 'AttachedStrand') continue;
    if (approxPt(c.start, pt)) return true;
  }
  return false;
}

// Recompute has_circles the way OpenStrand Studio does on load
// (save_load_manager.py "Fourth pass", ~940-994): the stored value is replaced
// by whether a child actually attaches at each end, with manual_circle_visibility
// overrides. An AttachedStrand always keeps its start circle (the attachment
// point). This is the RENDER-TIME truth -- e.g. a lone strand whose JSON says
// has_circles=[false,true] becomes [false,false], so BOTH ends get a flat side
// line instead of a phantom end circle.
function computeHasCircles(s, strands) {
  const mcv = Array.isArray(s.manual_circle_visibility) ? s.manual_circle_visibility : [null, null];
  if (s.type === 'AttachedStrand') {
    // 1.109 (save_load_manager.py "Fourth pass" fix): an explicit layer-menu
    // choice for the START circle survives reload too — only default to true
    // (the attachment point) when there is no manual override.
    const endAtt = hasAttachedChildAt(s.end, strands, s);
    return [mcv[0] != null ? mcv[0] : true, mcv[1] != null ? mcv[1] : endAtt];
  }
  const startAtt = hasAttachedChildAt(s.start, strands, s);
  const endAtt = hasAttachedChildAt(s.end, strands, s);
  return [mcv[0] != null ? mcv[0] : startAtt, mcv[1] != null ? mcv[1] : endAtt];
}

// Pixel-space tangent ANGLE (radians) at a path offset. Direction follows
// increasing arc length: at off=0 it points INTO the body, at off=len it points
// OUT of the end — matching Qt's calculate_cubic_tangent(0.0001 / 0.9999).
function tangentAngle(centerline, off) {
  const len = centerline.length;
  let o = Math.max(0, Math.min(off, len));
  let t = centerline.getTangentAt(o);
  if (!t && len > 0) t = centerline.getTangentAt(Math.max(0, Math.min(o, len - 1e-3)));
  if (!t) {
    const d = vsub(centerline.lastSegment.point, centerline.firstSegment.point);
    return Math.atan2(d.y, d.x);
  }
  return Math.atan2(t.y, t.x);
}

// A rect defined in a local frame (top-left x,y; size w,h), rotated about the
// local origin by `angle` rad, then translated to `center`. Mirrors Qt
// QTransform().translate(center).rotate(deg).map(rect) (point rotated, then moved).
function localRect(center, x, y, w, h, angle) {
  const r = new paper.Path.Rectangle(new paper.Point(x, y), new paper.Size(w, h));
  r.rotate((angle * 180) / Math.PI, new paper.Point(0, 0));
  r.translate(center);
  return r;
}

// Outer cap half at a START end: keeps the half pointing away from the body.
// `angle` is the tangent at the start (points into the body); `td` = total diameter.
function capOuterStart(center, angle, td) {
  const circle = new paper.Path.Circle(center, td / 2);
  const mask = localRect(center, 0, -td, 2 * td, 2 * td, angle);
  const half = circle.subtract(mask);
  circle.remove();
  mask.remove();
  return half;
}
// Outer cap half at an END end: keeps the half pointing out of the end.
function capOuterEnd(center, angle, td) {
  const circle = new paper.Path.Circle(center, td / 2);
  const mask = localRect(center, -2 * td, -td, 2 * td, 2 * td, angle);
  const half = circle.subtract(mask);
  circle.remove();
  mask.remove();
  return half;
}
function capInner(center, wpx) {
  return new paper.Path.Circle(center, wpx / 2);
}
// Side cover rect: Qt addRect(-sw, -w/2, sw, w) rotated to the tangent.
function capSideRect(center, angle, swpx, wpx) {
  return localRect(center, -swpx, -wpx / 2, swpx, wpx, angle);
}
// Attached-strand end fill quad (attached_strand.py end_side_line_path):
// across = w/2 each way, along the tangent = sw/2 each way.
function capEndQuad(center, angle, swpx, wpx) {
  const perp = angle + Math.PI / 2;
  const dx = (wpx / 2) * Math.cos(perp), dy = (wpx / 2) * Math.sin(perp);
  const dtx = (swpx / 2) * Math.cos(angle), dty = (swpx / 2) * Math.sin(angle);
  return new paper.Path({
    segments: [
      new paper.Point(center.x - dx - dtx, center.y - dy - dty),
      new paper.Point(center.x + dx - dtx, center.y + dy - dty),
      new paper.Point(center.x + dx + dtx, center.y + dy + dty),
      new paper.Point(center.x - dx + dtx, center.y - dy + dty),
    ],
    closed: true,
  });
}

// Collect end-cap pieces (pixel-space paper paths) for one strand, split into the
// stroke-color layer and the fill-color layer.
function collectCaps(s, strands, centerline, P, S) {
  const stroke = [], fill = [];
  const w = s.width || 0, sw = s.stroke_width || 0;
  const td = (w + 2 * sw) * S, wpx = w * S, swpx = sw * S;
  const hc = s.has_circles || [false, false];
  const cc = s.closed_connections || [false, false];
  const startA = circleStrokeAlpha(effStartStroke(s));
  const endA = circleStrokeAlpha(effEndStroke(s));
  const len = centerline.length;
  const cStart = P(s.start), cEnd = P(s.end);
  const aStart = tangentAngle(centerline, 0);
  const aEnd = tangentAngle(centerline, len);
  const childStart = hasAttachedChildAt(s.start, strands, s);
  const childEnd = hasAttachedChildAt(s.end, strands, s);

  if (s.type === 'AttachedStrand') {
    // start (its own attachment point)
    if (hc[0] && startA > 0) {
      stroke.push(capOuterStart(cStart, aStart, td));
      fill.push(capInner(cStart, wpx));
      fill.push(capSideRect(cStart, aStart, swpx, wpx));
    } else if (startA === 0 && s.is_setting_staring_circle !== false && hc[0]) {
      // Unfolded start edge: transparent outline, inner fill circle kept
      // (attached_strand.py:1291+). OSS gates this on is_setting_staring_circle,
      // but that flag is never serialized — the start_circle_stroke_color setter
      // derives it as (alpha == 0) on load (strand.py:534-541) — so with
      // startA === 0 it is always true for loaded OSS files; only an explicit
      // false (editor-supplied) suppresses it.
      fill.push(capInner(cStart, wpx));
    }
    // end — half-circle only when a child attaches there (no alpha gate, per Qt)
    if (hc[1] && childEnd) {
      stroke.push(capOuterEnd(cEnd, aEnd, td));
      fill.push(capInner(cEnd, wpx));
      if (endA > 0) fill.push(capSideRect(cEnd, aEnd, swpx, wpx));
    }
    // end fill is added whenever has_circles[1] (rounds the end)
    if (hc[1]) {
      fill.push(capInner(cEnd, wpx));
      fill.push(capEndQuad(cEnd, aEnd, swpx, wpx));
    }
    // closed-knot end cap
    if (hc[1] && cc[1]) {
      if (endA > 0) stroke.push(capOuterEnd(cEnd, aEnd, td));
      fill.push(capInner(cEnd, wpx));
      if (endA > 0) fill.push(capSideRect(cEnd, aEnd, swpx, wpx));
    }
  } else {
    // plain Strand: cap an end only where a child attaches or the end is closed
    if ((hc[0] && startA > 0 && childStart) || (cc[0] && startA > 0)) {
      stroke.push(capOuterStart(cStart, aStart, td));
      fill.push(capInner(cStart, wpx));
      fill.push(capSideRect(cStart, aStart, swpx, wpx));
    }
    if ((hc[1] && endA > 0 && childEnd) || (cc[1] && endA > 0)) {
      stroke.push(capOuterEnd(cEnd, aEnd, td));
      fill.push(capInner(cEnd, wpx));
      fill.push(capSideRect(cEnd, aEnd, swpx, wpx));
    }
  }
  return { stroke, fill };
}

// Side LINES (strand.py ~2657): a flat stroke-colored bar across an end, drawn
// only when that end has no circle. Returns ready-to-paint paper paths.
function collectSideLines(s, centerline, P, S) {
  const out = [];
  const hc = s.has_circles || [false, false];
  const w = s.width || 0, sw = s.stroke_width || 0;
  const half = ((w + 2 * sw) / 2) * S, shift = (sw / 2) * S, swpx = sw * S;
  const len = centerline.length;
  const bar = (c, a) => {
    const perp = a + Math.PI / 2;
    const dx = half * Math.cos(perp), dy = half * Math.sin(perp);
    const line = new paper.Path.Line(
      new paper.Point(c.x - dx, c.y - dy),
      new paper.Point(c.x + dx, c.y + dy),
    );
    line.strokeColor = toColor(s.stroke_color);
    line.strokeWidth = swpx;
    line.strokeCap = 'butt';
    return line;
  };
  if (s.start_line_visible && !hc[0]) {
    const a = tangentAngle(centerline, 0), c = P(s.start);
    // start shift is opposite the tangent (angle + pi)
    out.push(bar({ x: c.x + shift * Math.cos(a + Math.PI), y: c.y + shift * Math.sin(a + Math.PI) }, a));
  }
  if (s.end_line_visible && !hc[1]) {
    const a = tangentAngle(centerline, len), c = P(s.end);
    // end shift is along the tangent
    out.push(bar({ x: c.x + shift * Math.cos(a), y: c.y + shift * Math.sin(a) }, a));
  }
  return out;
}

// Build the two filled body layers for a strand at scale S (no caps): the outer
// (stroke-color) layer at width+2*stroke and the inner (fill-color) layer at
// width. Returns {stroke, fill} paper paths (uncolored) or null.
function bodyLayers(s, P, enableThird, S, centerline) {
  const cl = centerline || buildCenterline(s, P, enableThird);
  const w = s.width || 0, sw = s.stroke_width || 0;
  const stroke = cleanOutline(strokedOutline(cl, (w + 2 * sw) * S));
  const fill = cleanOutline(strokedOutline(cl, w * S));
  if (!centerline) cl.remove();
  if (!stroke || !fill) {
    stroke && stroke.remove();
    fill && fill.remove();
    return null;
  }
  return { stroke, fill };
}

// ---- shadow geometry (PIXEL space) -----------------------------------------
// Faithful port of shader_utils.py's three geometry builders. All world widths
// and radii are multiplied by S (= ss*zoom) before being handed to Paper. The
// circle gating mirrors build_rendered_geometry / build_shadow_circle_geometry:
// a circle contributes only where computeHasCircles is true AND the matching
// circle-stroke alpha > 0 (a transparent cap is excluded). AttachedStrand caps
// are HALF-circles (same capOuterStart/capOuterEnd construction the body uses);
// plain Strand caps are full circles. The angle is the centerline tangent at
// the relevant end (tangentAngle(cl,0) / (cl,len)).

// build_rendered_geometry(strand): the strand's visible footprint = body stroked
// at (w+2sw) UNION every visible end-circle (radius (w+2sw)/2, NOT +2). This is
// the RECEIVER geometry the caster shadow is intersected with, and also the clip
// region for Pass B. Returns a paper path (caller removes it) or null.
function buildShadowReceiverGeom(s, strands, P, enableThird, S) {
  const w = s.width || 0, sw = s.stroke_width || 0;
  const td = (w + 2 * sw) * S;          // full diameter (px) for the body + cap circles
  const cl = buildCenterline(s, P, enableThird);
  let path = cleanOutline(strokedOutline(cl, td));
  if (!path) { cl.remove(); return null; }
  const hc = s.has_circles || [false, false];
  const startA = circleStrokeAlpha(effStartStroke(s));
  const endA = circleStrokeAlpha(effEndStroke(s));
  const len = cl.length;
  const isAttached = s.type === 'AttachedStrand';
  const addCircle = (centre, angle, which) => {
    let circle;
    if (isAttached) {
      circle = which === 0 ? capOuterStart(centre, angle, td) : capOuterEnd(centre, angle, td);
    } else {
      circle = new paper.Path.Circle(centre, td / 2);
    }
    const u = path.unite(circle);
    path.remove();
    circle.remove();
    path = u;
  };
  if (hc[0] && startA > 0) addCircle(P(s.start), tangentAngle(cl, 0), 0);
  if (hc[1] && endA > 0) addCircle(P(s.end), tangentAngle(cl, len), 1);
  cl.remove();
  return path;
}

// build_shadow_geometry(strand, 0, include_circles=False): the caster CORE =
// body stroked at (w+2sw) with NO blur inflation, no circles. Returns a paper
// path (caller removes it) or null.
function buildShadowCasterCore(s, P, enableThird, S) {
  const w = s.width || 0, sw = s.stroke_width || 0;
  return strokedBodyAtWidth(s, P, enableThird, (w + 2 * sw) * S);
}

// Cut the caster CORE at every UNFOLDED end. Faithful port of the transparent-
// circle subtraction in draw_strand_shadow (shader_utils.py:528-556): for each end
// idx that is has_circles[idx] AND has a transparent circle stroke (alpha 0), Qt
// subtracts a FULL circle of radius adj_radius = (w+2sw)/1.5 centred at start
// (idx 0) / end (idx 1) from the square-capped body core, so the unfolded end (an
// unfolded plain strand OR an unfolded AttachedStrand start) casts a rounded, cut-
// back footprint instead of a square end-cap halo. Returns the (possibly new,
// possibly empty) core; the caller removes it. Radius uses the *S convention.
function subtractTransparentEndCaps(core, s, P, S) {
  const hc = s.has_circles || [false, false];
  if (!hc[0] && !hc[1]) return core;
  const w = s.width || 0, sw = s.stroke_width || 0;
  const r = ((w + 2 * sw) / 1.5) * S;
  const startA = circleStrokeAlpha(effStartStroke(s));
  const endA = circleStrokeAlpha(effEndStroke(s));
  let out = core;
  const cut = (centre) => {
    if (!out) return;
    const c = new paper.Path.Circle(centre, r);
    const d = out.subtract(c);
    c.remove();
    out.remove();
    out = d;
  };
  if (hc[0] && startA === 0) cut(P(s.start));
  if (hc[1] && endA === 0) cut(P(s.end));
  return out;
}

// build_shadow_circle_geometry(strand): caster end-circles only, radius
// ((w+2sw)/2 + 2)*S (the +2 IS scaled). The MAX_BLUR vs MAX_BLUR+2 arg distinction
// is moot — the builder always uses (w+2sw)/2+2 for the radius. Qt
// build_shadow_circle_geometry builds each visible end circle via
// _cap_shadow_path(idx, radius, depth_margin=2) (shader_utils.py:1806); with
// _partner_cap_dims == (None,None) — always true while elliptical_end_caps is off
// (the whole corpus) — that returns a FULL circle (strand.py:392-397), for BOTH
// plain and attached strands. So the caster shadow circle is a full circle, not a
// half circle, on the attached starting side too. (The RECEIVER geometry in
// buildShadowReceiverGeom keeps half-circles to match build_rendered_geometry —
// that is a different path and stays as-is.) May return null when no visible
// circle exists.
function buildShadowCasterCircles(s, strands, P, enableThird, S) {
  const w = s.width || 0, sw = s.stroke_width || 0;
  const radius = ((w + 2 * sw) / 2 + 2) * S;
  const hc = s.has_circles || [false, false];
  const startA = circleStrokeAlpha(effStartStroke(s));
  const endA = circleStrokeAlpha(effEndStroke(s));
  let path = null;
  const addCircle = (centre) => {
    const circle = new paper.Path.Circle(centre, radius);
    if (!path) { path = circle; return; }
    const u = path.unite(circle);
    path.remove();
    circle.remove();
    path = u;
  };
  if (hc[0] && startA > 0) addCircle(P(s.start));
  if (hc[1] && endA > 0) addCircle(P(s.end));
  return path;
}

// Build the per-step width/alpha table from the shader_utils formulas so it
// tracks NUM_STEPS / MAX_BLUR rather than being hard-coded. Each entry:
//   progress = (NUM_STEPS - i) / NUM_STEPS
//   alphaByte = trunc(150 * progress * (1/NUM_STEPS) * 2)   [TRUNCATE, clamp 0..255]
//   width = MAX_BLUR * ((i+1)/NUM_STEPS)   (world px, scaled by S at draw time)
// For NUM_STEPS=2: [{w:15, a:150}, {w:30, a:75}].
function shadowBlurSteps() {
  const base = SHADOW_COLOR.a;
  const steps = [];
  for (let i = 0; i < NUM_STEPS; i++) {
    const progress = (NUM_STEPS - i) / NUM_STEPS;
    const alpha = Math.max(0, Math.min(255, Math.trunc(base * progress * (1 / NUM_STEPS) * 2)));
    const width = MAX_BLUR * ((i + 1) / NUM_STEPS);
    steps.push({ width, alpha });
  }
  return steps;
}

// Cast strand `s` (at list index `i`) onto every already-drawn lower strand
// (j < i). Faithful port of draw_strand_shadow:
//   • caster CORE  = build_shadow_geometry(s, 0, include_circles=False)
//   • caster CIRCLES = build_shadow_circle_geometry(s)  (radius (w+2sw)/2+2)
//   For each receiver o (gated by §3): region = (core ∪ circles) ∩ rendered(o).
//     Accumulate non-empty survivors into `combined` (UNION) and the receiver
//     geometry into `clip` (UNION).
//   PASS A: fill `combined` SOLID at alpha 150, SourceOver, UNCLIPPED.
//   PASS B: total = combined ∪ circles; in a Group clipped to `clip`, run
//     NUM_STEPS boundary-stroke passes over `total` (FlatCap / RoundJoin) with
//     the computed width/alpha table.
// Both passes reuse the same `combined`. Drawn BEFORE the caster's own body so
// the body covers the inner shadow and only the fringe over lower strands shows.
// Per-pair survivor region for caster `s` (rank i) onto receiver `o` (rank j):
// receiver rendered geometry, caster∩receiver, then the renderer's subtractions
// IN ORDER (Qt: subtracted_layers -> mask-blocking -> intermediate). Shared by
// castStrandShadow and the auto_shadow probe so the two can never diverge.
// Returns {region, recv, clipBlocker} — any may be null; the CALLER removes all
// three paths. `rejectBounds` (optional) short-circuits far-away receivers.
function buildPairShadowRegion(s, i, o, j, strands, byLayer, P, enableThird, S, casterFootprint, ov, allowFull, rejectBounds) {
  // A mask receiver uses its crossing FILL region (get_proper_masked_strand_path
  // = get_mask_path); a regular/attached receiver uses its rendered body+circles.
  const recv = o.type === 'MaskedStrand'
    ? buildMaskPath(o, byLayer, P, enableThird, S)
    : buildShadowReceiverGeom(o, strands, P, enableThird, S);
  if (!recv) return { region: null, recv: null, clipBlocker: null };
  if (rejectBounds && !rejectBounds.intersects(recv.bounds)) {
    recv.remove();
    return { region: null, recv: null, clipBlocker: null };
  }
  let region = casterFootprint.intersect(recv);
  let clipBlocker = null; // this pair's subtracted-layer union (Qt clip_blocker_path)
  if (region && region.area && Math.abs(region.area) > 0.5) {
    // (a) subtracted_layers (UNGATED). Default = masked-caster second-component
    //     branch when no override key is present.
    const subNames = (ov && ov.subtracted_layers) || defaultSubtracted(s, o, byLayer);
    const subAcc = { path: null };
    region = subtractLayers(region, subNames, byLayer, strands, P, enableThird, S, subAcc);
    clipBlocker = subAcc.path; // fed into the Pass B clip (shader_utils.py:985-987)

    // (b) mask-blocking (gated !allowFull): subtract every VISIBLE mask whose
    //     layer rank is strictly ABOVE the caster (k > i) and that is not the
    //     receiver itself. Same blocker geometry covers the visible-component
    //     mask-coverage case for our corpus (single mask above both indices).
    if (!allowFull && region && Math.abs(region.area || 0) > 0.5) {
      for (let k = i + 1; k < strands.length; k++) {
        const m = strands[k];
        if (m.type !== 'MaskedStrand' || m.is_hidden === true) continue;
        if (m.layer_name === o.layer_name) continue; // self-block guard
        const blk = buildShadowBlockerPath(m, byLayer, P, enableThird, S);
        if (blk) {
          const r = region.subtract(blk);
          blk.remove();
          region.remove();
          region = r;
        }
        if (!region || Math.abs(region.area || 0) <= 0.5) break;
      }
    }

    // (c) intermediate subtraction (gated !allowFull): subtract every layer
    //     strictly between receiver rank j and caster rank i.
    if (!allowFull && region && Math.abs(region.area || 0) > 0.5) {
      const interNames = [];
      for (let m = j + 1; m < i; m++) interNames.push(strands[m].layer_name);
      region = subtractLayers(region, interNames, byLayer, strands, P, enableThird, S);
    }
  }
  return { region, recv, clipBlocker };
}

function castStrandShadow(s, strands, byLayer, P, enableThird, S, maskPairs, i) {
  // Caster footprint. A MaskedStrand caster uses its mask-crossing region as the
  // core and casts NO circles (Qt get_proper_masked_strand_path excludes circles);
  // a body strand uses the stroked body core + visible end circles.
  let core, circles = null;
  if (s.type === 'MaskedStrand') {
    core = buildMaskPath(s, byLayer, P, enableThird, S);
    if (!core) return;
  } else {
    core = buildShadowCasterCore(s, P, enableThird, S);
    if (!core) return;
    // Unfolded (transparent-circle) ends cast NO square end-cap halo: Qt
    // draw_strand_shadow subtracts a full circle of radius (w+2sw)/1.5 from the
    // caster CORE at every end that is has_circles[idx] AND transparent (circle
    // stroke alpha 0) BEFORE the receiver intersection (shader_utils.py:528-556).
    // Cut here — inside the render path only, NOT in buildShadowCasterCore — so
    // the auto_shadow probe (computeShadowPairAreas) keeps OSS's un-cut raw
    // footprint (auto_shadow.py) and the two never desync.
    core = subtractTransparentEndCaps(core, s, P, S);
    if (!core) return;
    circles = buildShadowCasterCircles(s, strands, P, enableThird, S);
  }

  // The caster's combined casting footprint (core ∪ circles), used both for the
  // intersection with each receiver and as the boundary stroked in Pass B.
  let casterFootprint = core.clone();
  if (circles) {
    const u = casterFootprint.unite(circles);
    casterFootprint.remove();
    casterFootprint = u;
  }

  // Inflated-bbox quick reject bound: the caster core's bounds grown by MAX_BLUR*S
  // (mirrors shader_utils.py:688-702). A receiver whose bounds don't overlap this
  // can't receive any blur fringe, so the pair is skipped before the boolean ops.
  const rejectBounds = core.bounds.expand(2 * MAX_BLUR * S);

  let combined = null;          // PASS A/B survivor union (caster ∩ receivers)
  let clip = null;              // PASS B clip = ⋃ receiver rendered geometry
  for (let j = 0; j < i; j++) {
    const o = strands[j];
    // A mask CAN receive a shadow from a higher strand (Qt draw_strand_shadow uses
    // other_stroke_path = get_proper_masked_strand_path when the receiver has
    // get_mask_path, shader_utils.py:718-722). A hidden mask draws nothing so it
    // receives nothing; and a mask never receives a shadow from one of its own
    // components (it owns that crossing region).
    if (o.type === 'MaskedStrand') {
      if (o.is_hidden === true) continue;
      const comp = (o.layer_name || '').split('_');
      if (comp.length >= 4 &&
          (s.layer_name === comp[0] + '_' + comp[1] || s.layer_name === comp[2] + '_' + comp[3])) continue;
    }
    if (maskPairs.has(s.layer_name + '|' + o.layer_name)) continue; // same-mask component pair

    // Per-pair shadow override (keyed [caster][receiver]). allow_full_shadow gates
    // mask-blocking + intermediate.
    const ov = (SHADOW_OVERRIDES[s.layer_name] || {})[o.layer_name] || null;
    // Effective visibility: an explicit `visibility` key wins; otherwise the Qt
    // default (get_default_shadow_visibility) — false ONLY for a masked caster onto
    // its FIRST component (so a mask never casts a regular shadow on its source).
    if (ov && ov.visibility != null) {
      if (ov.visibility === false) continue;
    } else if (defaultShadowVisibilityFalse(s, o)) {
      continue;
    }
    const allowFull = !!(ov && ov.allow_full_shadow);

    const { region, recv, clipBlocker } = buildPairShadowRegion(
      s, i, o, j, strands, byLayer, P, enableThird, S, casterFootprint, ov, allowFull, rejectBounds);
    if (!recv) continue;

    if (region && region.area && Math.abs(region.area) > 0.5) {
      // survivor — accumulate into combined (union)
      if (!combined) { combined = region; }
      else { const u = combined.unite(region); combined.remove(); region.remove(); combined = u; }
      // accumulate receiver geometry into the Pass B clip (union)
      if (!clip) { clip = recv; }
      else { const u = clip.unite(recv); clip.remove(); recv.remove(); clip = u; }
      // Qt subtracts this pair's subtracted-layer geometry from the accumulated
      // clip so the faded Pass B stroke can't bleed into it (shader_utils.py:985-987).
      if (clipBlocker) { const c = clip.subtract(clipBlocker); clip.remove(); clip = c; }
    } else {
      region && region.remove();
      recv.remove();
    }
    if (clipBlocker) clipBlocker.remove();
  }

  if (combined) {
    // PASS A — solid core, unclipped, full alpha (SourceOver = paper default).
    const solid = combined.clone();
    solid.fillColor = SHADOW_PAINT;
    solid.strokeColor = null;

    // PASS B — faded blur, clipped to the union of receiver geometries.
    let total = combined.clone();
    if (circles) {
      const u = total.unite(circles);
      total.remove();
      total = u;
    }
    const strokeItems = [];
    for (const st of shadowBlurSteps()) {
      const item = total.clone();
      item.fillColor = null;
      item.strokeColor = new paper.Color(SHADOW_COLOR.r / 255, SHADOW_COLOR.g / 255, SHADOW_COLOR.b / 255, st.alpha / 255);
      item.strokeWidth = st.width * S;
      item.strokeCap = 'butt';   // Qt FlatCap
      item.strokeJoin = 'round'; // Qt RoundJoin
      strokeItems.push(item);
    }
    total.remove();
    // A clipped Group: first child is the clip mask, the rest are clipped to it.
    new paper.Group({ children: [clip, ...strokeItems], clipped: true });
    combined.remove();
  } else if (clip) {
    clip.remove();
  }

  casterFootprint.remove();
  core.remove();
  circles && circles.remove();
}

// Selection highlight — faithful port of strand.py::_draw_unified_highlight /
// attached_strand.py::_draw_unified_highlight. Drawn UNDER the body (drawStrand
// paints the body fill+stroke over it, exactly as OSS draws the highlight at
// strand.py:2483 then the body at :2485+), so only the outer ~5px halo, the
// protruding flat-end side-line bars, and the C-shape rings remain visible while
// the black stroke stays on top. Gated on s.is_selected (absent in oracle
// fixtures, so it never affects a pixel-diff that doesn't opt in).
function drawHighlight(s, strands, P, enableThird, S) {
  if (!s.is_selected || s.type === 'MaskedStrand') return;
  const w = s.width || 0, sw = s.stroke_width || 0;
  const td = (w + 2 * sw) * S;       // total diameter (px)
  const cr = td / 2;                 // circle radius (px)
  const hcA = s.highlight_color;
  const red = toColor(hcA && hcA.a != null ? hcA : { r: 255, g: 0, b: 0, a: 255 });
  const hc = s.has_circles || [false, false];
  const cc = s.closed_connections || [false, false];
  const startA = circleStrokeAlpha(effStartStroke(s));
  const endA = circleStrokeAlpha(effEndStroke(s));
  const isAttached = s.type === 'AttachedStrand';
  const childStart = hasAttachedChildAt(s.start, strands, s);
  const childEnd = hasAttachedChildAt(s.end, strands, s);

  const cl = buildCenterline(s, P, enableThird);
  const len = cl.length;
  const items = [];

  // (1) body band: centerline stroked at total+10 (solid; the body covers its
  // inner half, leaving the 5px outer halo). An unfolded (transparent-stroke)
  // edge pulls the band in along the curve — OSS resamples 100 points between
  // t_start/t_end (attached_strand.py:564-583: 5.5 start / 3.5 end;
  // strand.py:2090-2095: 5.0 both) whenever either edge is unfolded and the
  // path is longer than 10.
  let band = cl.clone();
  if ((startA === 0 || endA === 0) && len > 10 * S) {
    const tS = startA === 0 ? (isAttached ? 5.5 : 5.0) * S : 0;
    const tE = endA === 0 ? (isAttached ? 3.5 : 5.0) * S : 0;
    const pts = [];
    for (let i = 0; i <= 100; i++) {
      const off = tS + (len - tE - tS) * (i / 100);
      pts.push(cl.getPointAt(Math.max(0, Math.min(len, off))));
    }
    band.remove();
    band = new paper.Path({ segments: pts });
  }
  band.strokeColor = red;
  band.strokeWidth = td + 10 * S;
  band.strokeCap = 'butt';
  band.strokeJoin = 'round';
  band.fillColor = null;
  items.push(band);

  // Which ends carry a circle (-> C-shape ring) vs a flat side line. Mirrors the
  // cap/side-line gating in collectCaps / collectSideLines so the highlight always
  // matches the junction the body actually draws.
  const startCircle = isAttached
    ? (hc[0] && startA > 0)
    : ((hc[0] && startA > 0 && childStart) || (cc[0] && startA > 0));
  const endCircle = isAttached
    ? (hc[1] && endA > 0 && (childEnd || cc[1]))
    : ((hc[1] && endA > 0 && childEnd) || (cc[1] && endA > 0));

  // (2) C-shape rings: highlight_circle(cr+5) - mask(half-plane toward body) -
  // outer_circle(cr). Same boolean construction as Qt.
  const cShape = (center, angle) => {
    const outer = new paper.Path.Circle(center, cr + 5 * S);
    const inner = new paper.Path.Circle(center, cr);
    const ring = outer.subtract(inner); outer.remove(); inner.remove();
    const mask = localRect(center, 0, -td, 2 * td, 2 * td, angle); // +x_local = toward body
    const c = ring.subtract(mask); ring.remove(); mask.remove();
    c.fillColor = red; c.strokeColor = null;
    items.push(c);
  };
  if (startCircle) cShape(P(s.start), tangentAngle(cl, 0));            // tangent into body
  if (endCircle) cShape(P(s.end), tangentAngle(cl, len) + Math.PI);   // angle_end - pi

  // (3) side lines: a flat red bar across each circle-less, visible end.
  const hhw = cr + 5 * S;            // highlight half width
  const barW = (sw + 10) * S;
  const bar = (center, a, shiftSign) => {
    const cx = center.x + (sw * S / 2) * Math.cos(a) * shiftSign;
    const cy = center.y + (sw * S / 2) * Math.sin(a) * shiftSign;
    const perp = a + Math.PI / 2;
    const dx = hhw * Math.cos(perp), dy = hhw * Math.sin(perp);
    const line = new paper.Path.Line(new paper.Point(cx - dx, cy - dy), new paper.Point(cx + dx, cy + dy));
    line.strokeColor = red; line.strokeWidth = barW; line.strokeCap = 'butt';
    items.push(line);
  };
  if (s.start_line_visible !== false && !hc[0] && startA > 0) bar(P(s.start), tangentAngle(cl, 0), -1);  // shift opposite tangent
  if (s.end_line_visible !== false && !hc[1] && endA > 0) bar(P(s.end), tangentAngle(cl, len), 1);       // shift along tangent

  cl.remove();
  if (items.length) new paper.Group(items);
}

// ---- Arrows (OSS 1.109 §7: strand.py start/end arrows + full strand arrow) --
// Canvas-level arrow dimensions (Qt settings dialog; the oracle renders with
// these defaults). The editor may override via meta.arrow_params.
const ARROW_DEFAULTS = {
  head_length: 20, head_width: 10, gap_length: 10,
  line_length: 20, line_width: 10, head_stroke_width: 4,
};
let ARROW_PARAMS = ARROW_DEFAULTS;

// Draw a strand's arrows AFTER its body (start/end arrows, then the full
// arrow on top) — faithful to strand.py:2818-3000:
//   * start/end arrow: gap -> shaft segment -> head, along the tangent at the
//     end, pointing AWAY from the body. Shaft pen = stroke_color at
//     arrow_line_width (FlatCap); head = triangle (tip extends head_length
//     past the shaft) filled with the STRAND color, bordered with
//     stroke_color at head_stroke_width (MiterJoin/FlatCap).
//   * full arrow: the whole strand path stroked at arrow_line_width
//     (FlatCap/RoundJoin) in arrow_color (fallback stroke_color), plus a head
//     whose BASE sits ON the end point and whose tip extends outward; head
//     fill = arrow_color (fallback strand color), border = stroke_color.
//     arrow_transparency (0-100 %) REPLACES the alpha (Qt setAlphaF) on the
//     full arrow's shaft + head fill only — never on borders or on start/end
//     arrows.
// Deferred (defaults 'solid'/'none' draw identically): shaft patterns
// (stripes/tiles/dots), head textures, arrow_casts_shadow, and the
// hidden-strand full arrow (the editor drops hidden strands pre-render).
function drawArrows(s, P, enableThird, S) {
  const hasAny = s.start_arrow_visible === true || s.end_arrow_visible === true ||
    s.full_arrow_visible === true;
  if (!hasAny) return;
  const ap = ARROW_PARAMS;
  const headL = ap.head_length * S, headW = ap.head_width * S;
  const gapL = ap.gap_length * S, lineL = ap.line_length * S, lineW = ap.line_width * S;
  const borderW = ap.head_stroke_width * S;
  const cl = buildCenterline(s, P, enableThird);
  const len = cl.length;
  if (len <= 0) { cl.remove(); return; }

  const drawHead = (base, dir, fillColor) => {
    const perp = { x: -dir.y, y: dir.x };
    const tip = new paper.Point(base.x + dir.x * headL, base.y + dir.y * headL);
    const left = new paper.Point(base.x + perp.x * headW / 2, base.y + perp.y * headW / 2);
    const right = new paper.Point(base.x - perp.x * headW / 2, base.y - perp.y * headW / 2);
    const poly = new paper.Path([tip, left, right]);
    poly.closed = true;
    poly.fillColor = fillColor;
    poly.strokeColor = null;
    const border = poly.clone();
    border.fillColor = null;
    border.strokeColor = toColor(s.stroke_color);
    border.strokeWidth = borderW;
    border.strokeJoin = 'miter';
    border.strokeCap = 'butt';
  };

  // tangentAngle points INTO the body at off=0 and OUT of it at off=len, so
  // the start arrow flips the direction (OSS arrow_dir = -unit at the start).
  const endArrow = (worldPt, angle, flip) => {
    const dir = { x: Math.cos(angle) * flip, y: Math.sin(angle) * flip };
    const p0 = P(worldPt);
    const s0 = new paper.Point(p0.x + dir.x * gapL, p0.y + dir.y * gapL);
    const s1 = new paper.Point(s0.x + dir.x * lineL, s0.y + dir.y * lineL);
    const shaft = new paper.Path.Line(s0, s1);
    shaft.strokeColor = toColor(s.stroke_color);
    shaft.strokeWidth = lineW;
    shaft.strokeCap = 'butt';
    drawHead(s1, dir, toColor(s.color));
  };

  if (s.start_arrow_visible === true) endArrow(s.start, tangentAngle(cl, 0), -1);
  if (s.end_arrow_visible === true) endArrow(s.end, tangentAngle(cl, len), 1);

  if (s.full_arrow_visible === true) {
    const alpha = Math.max(0, Math.min(100, s.arrow_transparency != null ? s.arrow_transparency : 100)) / 100;
    const shaftColor = toColor(s.arrow_color ? s.arrow_color : s.stroke_color);
    shaftColor.alpha = alpha;
    const shaft = cl.clone();
    shaft.fillColor = null;
    shaft.strokeColor = shaftColor;
    shaft.strokeWidth = lineW;
    shaft.strokeCap = 'butt';
    shaft.strokeJoin = 'round';
    if (s.arrow_head_visible !== false) {
      const a = tangentAngle(cl, len);
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const fill = toColor(s.arrow_color ? s.arrow_color : s.color);
      fill.alpha = alpha;
      drawHead(P(s.end), dir, fill);
    }
  }
  cl.remove();
}

function drawStrand(s, strands, P, enableThird, S) {
  drawHighlight(s, strands, P, enableThird, S);   // under the body
  const centerline = buildCenterline(s, P, enableThird);
  const layers = bodyLayers(s, P, enableThird, S, centerline);
  if (!layers) { centerline.remove(); return; }
  let strokePath = layers.stroke, fillPath = layers.fill;

  const caps = collectCaps(s, strands, centerline, P, S);
  const sideLines = collectSideLines(s, centerline, P, S);
  centerline.remove();

  for (const shp of caps.stroke) {
    const u = strokePath.unite(shp);
    strokePath.remove();
    shp.remove();
    strokePath = u;
  }
  for (const shp of caps.fill) {
    const u = fillPath.unite(shp);
    fillPath.remove();
    shp.remove();
    fillPath = u;
  }

  strokePath.fillColor = toColor(s.stroke_color);
  strokePath.strokeColor = null;
  fillPath.fillColor = toColor(s.color);
  fillPath.strokeColor = null;

  // Paint stroke layer, then fill layer, then side bars (top), in order.
  new paper.Group([strokePath, fillPath, ...sideLines]);

  // Arrows go over this strand's body (start/end arrows, then the full arrow
  // on top) but under any later strand, exactly like OSS's in-draw ordering.
  drawArrows(s, P, enableThird, S);
}

// A deletion rectangle (over-under gap) in pixel space. Corner-based
// ([x,y] arrays) or axis-aligned {x,y,width,height}; world coords via P.
function deletionPath(rect, P, ss) {
  if (rect.top_left && rect.bottom_right) {
    const tl = rect.top_left, br = rect.bottom_right;
    const tr = rect.top_right || br, bl = rect.bottom_left || tl;
    const A = (a) => P({ x: a[0], y: a[1] });
    const path = new paper.Path([A(tl), A(tr), A(br), A(bl)]);
    path.closed = true;
    return path;
  }
  if (rect.x != null && rect.width != null) {
    return new paper.Path.Rectangle(P({ x: rect.x, y: rect.y }), new paper.Size(rect.width * ss, rect.height * ss));
  }
  return null;
}

// A mask-component region for `s` at world width `widthW`: the centerline
// stroked at that width, unioned with the strand's visible attached start circle
// (radius widthW/2). Mirrors masked_strand.py get_*_path_for_strand for the
// circular case (elliptical caps are not exercised by the corpus).
function maskComponentPath(s, P, enableThird, S, widthW) {
  const cl = buildCenterline(s, P, enableThird);
  let path = cleanOutline(strokedOutline(cl, widthW * S));
  cl.remove();
  if (!path) return null;
  if (
    s.type === 'AttachedStrand' &&
    (s.has_circles || [])[0] &&
    circleStrokeAlpha(effStartStroke(s)) > 0
  ) {
    const circle = new paper.Path.Circle(P(s.start), (widthW * S) / 2);
    const u = path.unite(circle);
    path.remove();
    circle.remove();
    path = u;
  }
  return path;
}

function subtractDeletions(region, ms, P, S) {
  if (!region) return region;
  for (const rect of ms.deletion_rectangles || []) {
    const rp = deletionPath(rect, P, S);
    if (rp) {
      const r2 = region.subtract(rp);
      rp.remove();
      region.remove();
      region = r2;
    }
  }
  return region;
}

// ---- shadow-override support helpers (Item-2 port) --------------------------

// Intersection of a mask's two component bodies (stroked at the given widths)
// minus deletion rects, EXCLUDING end circles. Shared core for Qt's two mask
// geometries (these match drawMasked's fillRegion / strokeRegion exactly):
//   'fill'   = get_mask_path()        = first@fw        ∩ second@(sw+2ssw+4)
//   'stroke' = get_mask_path_stroke() = first@(fw+2fsw) ∩ second@(sw+2ssw)
function maskRegion(ms, byLayer, P, enableThird, S, mode) {
  const parts = (ms.layer_name || '').split('_');
  if (parts.length < 4) return null;
  const first = byLayer[parts[0] + '_' + parts[1]];
  const second = byLayer[parts[2] + '_' + parts[3]];
  if (!first || !second) return null;
  const fw = first.width || 0, fsw = first.stroke_width || 0;
  const sw = second.width || 0, ssw = second.stroke_width || 0;
  const wA = mode === 'fill' ? fw : fw + 2 * fsw;
  const wB = mode === 'fill' ? sw + 2 * ssw + 4 : sw + 2 * ssw;
  const a = maskComponentPath(first, P, enableThird, S, wA);
  const b = maskComponentPath(second, P, enableThird, S, wB);
  if (!a || !b) { a && a.remove(); b && b.remove(); return null; }
  let region = a.intersect(b);
  a.remove();
  b.remove();
  region = subtractDeletions(region, ms, P, S);
  if (region && region.area && Math.abs(region.area) > 0.5) return region;
  region && region.remove();
  return null;
}

// Qt get_proper_masked_strand_path -> get_mask_path() (the FILL region). Used as
// the mask-as-caster footprint and the mask-as-subtractor so both agree with
// drawMasked's fillRegion. Returns a paper path (caller removes) or null.
function buildMaskPath(ms, byLayer, P, enableThird, S) {
  return maskRegion(ms, byLayer, P, enableThird, S, 'fill');
}

// Qt get_mask_path_stroke() (the STROKE region) — the wider crossing footprint.
function buildMaskStrokePath(ms, byLayer, P, enableThird, S) {
  return maskRegion(ms, byLayer, P, enableThird, S, 'stroke');
}

// Qt _get_mask_visual_path = get_mask_path() UNION get_mask_path_stroke(). This
// is the blocker BASE (the full visible mask footprint), not the fill region alone.
function buildMaskVisualPath(ms, byLayer, P, enableThird, S) {
  const fill = buildMaskPath(ms, byLayer, P, enableThird, S);
  const stroke = buildMaskStrokePath(ms, byLayer, P, enableThird, S);
  if (!fill) return stroke;
  if (!stroke) return fill;
  const u = fill.unite(stroke);
  fill.remove();
  stroke.remove();
  return u;
}

// Stroke a CLOSED region's boundary by the full pen width `widthPx` with the given
// join/cap, converted to a filled outline. Qt's QPainterPathStroker.setWidth(w)
// strokes w/2 each side; pass the FULL width here (so for the blocker, MAX_BLUR*S).
// Reuses the strokedOutline sampling machinery on each sub-path's boundary, offset
// by +/- half-width, joined into a closed ring. This is a round/round-equivalent
// approximation on the mask region's boundary (the miter/flat detail is a minor
// fringe effect on the small blocker region — see ITEM2_SPEC §EDIT 3 note).
function strokedRegionOutline(region, widthPx) {
  if (!region || widthPx <= 0) return null;
  const half = widthPx / 2;
  // A region from a boolean op may be a CompoundPath (multiple sub-paths). Stroke
  // each closed boundary and union the resulting bands.
  const subs = region.children && region.children.length ? region.children : [region];
  let out = null;
  for (const sub of subs) {
    const len = sub.length;
    if (!len) continue;
    const N = Math.max(8, Math.ceil(len / SAMPLE_STEP));
    const left = [], right = [];
    for (let i = 0; i <= N; i++) {
      const off = Math.min(len * i / N, len - 1e-4);
      const pt = sub.getPointAt(off);
      const nrm = sub.getNormalAt(off);
      if (!pt || !nrm) continue;
      left.push(pt.add(nrm.multiply(half)));
      right.push(pt.subtract(nrm.multiply(half)));
    }
    if (left.length < 2) continue;
    right.reverse();
    let band = new paper.Path({ segments: left.concat(right), closed: true });
    const cleaned = band.resolveCrossings();
    if (cleaned !== band) { band.remove(); band = cleaned; }
    if (!out) { out = band; }
    else { const u = out.unite(band); out.remove(); band.remove(); out = u; }
  }
  return out;
}

// Port of get_shadow_blocker_path (shader_utils.py:1876) + _get_mask_visual_path:
// base = mask VISUAL path (fill ∪ stroke regions); blocker = base UNION
// stroke(base boundary, width=MAX_BLUR*S). Subtracted from a caster->receiver
// shadow for a VISIBLE mask layered ABOVE the caster. Returns a path or null.
function buildShadowBlockerPath(ms, byLayer, P, enableThird, S) {
  const base = buildMaskVisualPath(ms, byLayer, P, enableThird, S);
  if (!base) return null;
  const stroked = strokedRegionOutline(base, MAX_BLUR * S);
  if (!stroked) return base; // degrade to base-only blocker
  const u = base.unite(stroked);
  base.remove();
  stroked.remove();
  return u;
}

// Subtract the rendered geometry of each named layer from `region`, IN ORDER.
// Masks use their mask path; hidden strands are skipped. Port of Qt
// _subtract_named_layer_paths. Returns the (possibly empty/null) region; the
// caller owns it. Breaks early once the region empties.
function subtractLayers(region, names, byLayer, strands, P, enableThird, S, blockerAcc) {
  if (!region || !names || !names.length) return region;
  for (const name of names) {
    const t = byLayer[name];
    if (!t || t.is_hidden === true) continue;
    const geom = t.type === 'MaskedStrand'
      ? buildMaskPath(t, byLayer, P, enableThird, S)
      : buildShadowReceiverGeom(t, strands, P, enableThird, S);
    if (!geom) continue;
    // Accumulate the union of subtracted geometry for the caller's clip blocker
    // (Qt _subtract_named_layer_paths returns this alongside the trimmed region).
    if (blockerAcc) {
      if (!blockerAcc.path) { blockerAcc.path = geom.clone(); }
      else { const u = blockerAcc.path.unite(geom); blockerAcc.path.remove(); blockerAcc.path = u; }
    }
    const r = region.subtract(geom);
    geom.remove();
    region.remove();
    region = r;
    if (!region || Math.abs(region.area || 0) <= 0.5) break;
  }
  return region;
}

// Qt get_default_shadow_visibility: a masked caster does NOT cast a regular
// shadow onto its own FIRST component by default (returns true otherwise). The
// SECOND component still receives (with the first component subtracted — see
// defaultSubtracted). Only consulted when no explicit `visibility` override.
function defaultShadowVisibilityFalse(s, o) {
  if (s.type !== 'MaskedStrand') return false;
  const parts = (s.layer_name || '').split('_');
  if (parts.length < 4) return false;
  const firstName = parts[0] + '_' + parts[1];
  return o.layer_name === firstName;
}

// Qt get_default_subtracted_layers: a masked caster's SECOND-component receiver
// defaults to subtracting the FIRST component's geometry. Returns [] otherwise.
function defaultSubtracted(s, o, byLayer) {
  if (s.type !== 'MaskedStrand') return [];
  const parts = (s.layer_name || '').split('_');
  if (parts.length < 4) return [];
  const firstName = parts[0] + '_' + parts[1];
  const secondName = parts[2] + '_' + parts[3];
  return o.layer_name === secondName ? [firstName] : [];
}

// Faithful port of draw_mask_strand_shadow (shader_utils.py:179). PORT-FOR-
// COMPLETENESS / UNMEASURED — no mask fixture in the corpus exercises this at the
// pixel level (the two masks in overhand_knot are themselves casters/receivers in
// the regular shadow loop, gated out by maskPairs). first = top, second = bottom.
// The call site passes canvas.max_blur_radius = 30 (NOT the 29.99 signature
// default), so widths are 15/30 and alphas 150/75 — the same table as the regular
// faded loop. No separate unclipped solid-core pass for masks (unlike strands);
// only the clipped faded strokes plus a clipped inner-core fill.
function drawMaskShadow(ms, first, second, fw, fsw, sw, ssw, P, enableThird, S) {
  const firstPath = strokedBodyAtWidth(first, P, enableThird, (fw + 2 * fsw) * S);
  const secondPath = strokedBodyAtWidth(second, P, enableThird, (sw + 2 * ssw) * S);
  if (!firstPath || !secondPath) {
    firstPath && firstPath.remove();
    secondPath && secondPath.remove();
    return;
  }
  // shading_path = (second_path ∩ first_path) minus deletion rects.
  let shading = secondPath.intersect(firstPath);
  shading = subtractDeletions(shading, ms, P, S);

  const items = [];
  if (shading && shading.area && Math.abs(shading.area) > 0.5) {
    for (const st of shadowBlurSteps()) {
      const item = shading.clone();
      item.fillColor = null;
      item.strokeColor = new paper.Color(SHADOW_COLOR.r / 255, SHADOW_COLOR.g / 255, SHADOW_COLOR.b / 255, st.alpha / 255);
      item.strokeWidth = st.width * S;
      item.strokeCap = 'butt';   // Qt FlatCap
      item.strokeJoin = 'round'; // Qt RoundJoin
      items.push(item);
    }
  }
  // inner-core = stroke(first centerline, fw+2fsw) ∩ second_path, filled SOLID at
  // full alpha 150. (Same stroke width as firstPath here, so == firstPath ∩ second.)
  const innerStroke = strokedBodyAtWidth(first, P, enableThird, (fw + 2 * fsw) * S);
  if (innerStroke) {
    let core = innerStroke.intersect(secondPath);
    core = subtractDeletions(core, ms, P, S);
    if (core && core.area && Math.abs(core.area) > 0.5) {
      core.fillColor = SHADOW_PAINT;
      core.strokeColor = null;
      items.push(core);
    } else {
      core && core.remove();
    }
    innerStroke.remove();
  }
  // All shadow items clipped to second_path (the receiving strand's body).
  if (items.length) {
    new paper.Group({ children: [secondPath.clone(), ...items], clipped: true });
  }
  shading && shading.remove();
  firstPath.remove();
  secondPath.remove();
}

// Faithful port of masked_strand.py. The crossing of the top strand (`first`)
// over the bottom (`second`) is painted as TWO regions filled directly:
//   stroke-color layer = stroked(first, w+2sw) ∩ stroked(second, w+2sw)
//   fill-color  layer  = stroked(first, w)     ∩ stroked(second, w+2sw+4)
// each unioned with the components' visible start circles, minus deletions.
function drawMasked(ms, byLayer, P, enableThird, S, shadowOnly) {
  // A hidden mask draws nothing (Qt MaskedStrand.draw early-returns on is_hidden,
  // masked_strand.py:465 — only a dashed edit-mode outline, absent in the offscreen
  // reference). So neither its masked body nor its own crossing shadow is painted.
  if (ms.is_hidden === true) return;
  const parts = (ms.layer_name || '').split('_');
  if (parts.length < 4) return;
  const first = byLayer[parts[0] + '_' + parts[1]];
  const second = byLayer[parts[2] + '_' + parts[3]];
  if (!first || !second) return;
  const fw = first.width || 0, fsw = first.stroke_width || 0;
  const sw = second.width || 0, ssw = second.stroke_width || 0;

  // Crossing shadow (only when shadows are on). Faithful port of
  // draw_mask_strand_shadow (PORT-FOR-COMPLETENESS — no mask fixture exercises
  // this at the pixel level, so it is UNMEASURED). first = top, second = bottom:
  //   first_path  = first body @ (fw+2fsw)   (NO blur inflation)
  //   second_path = second body @ (sw+2ssw)
  //   shading_path = (second_path ∩ first_path) minus deletion rects
  //   clipped to second_path, run NUM_STEPS faded boundary strokes over
  //     shading_path (15/30 widths, 150/75 alphas, FlatCap/RoundJoin); then
  //   inner-core = stroke(first center, fw+2fsw) ∩ second_path filled SOLID at
  //     alpha 150 (no separate unclipped solid-core pass for masks).
  // hide_shadow also suppresses the mask's own crossing shadow (OSS
  // masked_strand.py:516,665 gate draw_mask_strand_shadow on it).
  if (SHADOW_ENABLED && ms.hide_shadow !== true) {
    drawMaskShadow(ms, first, second, fw, fsw, sw, ssw, P, enableThird, S);
  }

  // shadow_only mask: it has cast its shadows (regular cast in the main loop +
  // the crossing shadow above) but paints no visible body (OSS masked_strand.py
  // skips all body rendering and returns early when self.shadow_only).
  if (shadowOnly) return;

  // stroke-color region: first@(w+2sw) ∩ second@(w+2sw)
  const fStroke = maskComponentPath(first, P, enableThird, S, fw + 2 * fsw);
  const sStroke = maskComponentPath(second, P, enableThird, S, sw + 2 * ssw);
  let strokeRegion = fStroke && sStroke ? fStroke.intersect(sStroke) : null;
  fStroke && fStroke.remove();
  sStroke && sStroke.remove();
  strokeRegion = subtractDeletions(strokeRegion, ms, P, S);

  // fill-color region: first@w ∩ second@(w+2sw+4)
  const fFill = maskComponentPath(first, P, enableThird, S, fw);
  const sExt = maskComponentPath(second, P, enableThird, S, sw + 2 * ssw + 4);
  let fillRegion = fFill && sExt ? fFill.intersect(sExt) : null;
  fFill && fFill.remove();
  sExt && sExt.remove();
  fillRegion = subtractDeletions(fillRegion, ms, P, S);

  if (strokeRegion) { strokeRegion.fillColor = toColor(first.stroke_color); strokeRegion.strokeColor = null; }
  if (fillRegion) { fillRegion.fillColor = toColor(first.color); fillRegion.strokeColor = null; }
  // Paint order: stroke layer under fill layer.
  const layers = [strokeRegion, fillRegion].filter(Boolean);
  if (layers.length) new paper.Group(layers);

  // Selection highlight (OSS MaskedStrand). Clicking a masked layer reddens it on
  // the canvas: stroke the mask intersection silhouette — get_mask_path() = the FILL
  // region (buildMaskPath) — ON TOP of the body with a semi-transparent red outline.
  // Faithful to draw_highlight (masked_strand.py:1187-1215): width 6px, RoundCap/
  // RoundJoin, NoBrush (fill null), color = highlight_color with alpha forced to 128
  // (rgba(255,0,0,128)). That is the default-zoom click highlight routed via
  // draw_highlighted_masked_strand; the 2px variant at masked_strand.py:763-775 is
  // only the zoomed/panned _draw_direct fallback. NOTE the intentional asymmetry vs
  // drawStrand — regular strands draw the halo UNDER the body, but a mask strokes its
  // outline OVER the body (OSS draws the mask body then draw_highlight last). Gated on
  // ms.is_selected so oracle fixtures (which never set it) are unaffected. buildMaskPath
  // returns null when the components don't intersect (area<=0.5), so guard before use;
  // the returned path is LEFT on the canvas to be painted (not removed).
  if (ms.is_selected) {
    const hl = buildMaskPath(ms, byLayer, P, enableThird, S);
    if (hl) {
      hl.fillColor = null;
      hl.strokeColor = toColor({ r: 255, g: 0, b: 0, a: 128 });
      hl.strokeWidth = 6 * S;
      hl.strokeCap = 'round';
      hl.strokeJoin = 'round';
    }
  }
}

// Render `strands` (flat array) using `meta` into the canvas #c.
window.renderFixture = function (strands, meta) {
  if (meta.curve_params) CURVE = meta.curve_params;
  SAMPLE_STEP = 1; // full-accuracy sampling for the oracle / pointer-up render
  const W = meta.image_width, H = meta.image_height;
  // Match the reference, which renders at `supersample`x then downscales.
  // Paper draws into an offscreen W*ss x H*ss canvas; we then downscale into
  // the visible 1x canvas with high-quality smoothing and screenshot that.
  // (Playwright's canvas screenshot captures the backing store, not the CSS
  // box, so an in-page downscale is the reliable way to supersample.)
  const ss = meta.supersample || 2;
  // Zoom is additive: when absent it is 1 and S === ss, so every length below is
  // identical to the pre-zoom renderer (fixtures stay pixel-identical). `S` is
  // the full content scale (supersample * zoom) applied to positions AND widths;
  // the content offset stays at `ss` so panning isn't scaled by zoom.
  const zoom = meta.zoom || 1;
  const S = ss * zoom;

  const hi = document.createElement('canvas');
  // Opt out of paper.js's automatic devicePixelRatio scaling: this renderer does
  // its own supersampling via the W*ss offscreen canvas + manual downscale, so
  // paper must treat 1 canvas px as 1 unit. Without this, a browser at DPR != 1
  // (display zoom/scaling) double-scales and the drawing lands at the wrong size.
  // Harness-safe: the Playwright reference runs at DPR=1, where pixelRatio is 1
  // either way.
  hi.setAttribute('hidpi', 'off');
  hi.width = W * ss;
  hi.height = H * ss;
  paper.setup(hi);

  const bg = new paper.Path.Rectangle(new paper.Point(0, 0), new paper.Size(W * ss, H * ss));
  bg.fillColor = 'white';

  const ox = meta.x_offset, oy = meta.y_offset;
  // world -> backing: position scaled by S (= ss*zoom), offset by ss. At zoom 1
  // this is exactly (pt + offset) * ss.
  const P = (pt) => new paper.Point(pt.x * S + ox * ss, pt.y * S + oy * ss);
  const enableThird = strands.some((s) => s.control_point_center != null);

  // Grid: painted AFTER the white background and BEFORE the strand loop so it
  // composites UNDER the bodies (OSS draws the grid behind the strands; the old
  // port drew it on the overlay layer on top — the bug this fixes). Backing space
  // uses scale S (= ss*zoom) and pan offset ox*ss / oy*ss; strokeWidth ss => 1px
  // after the ss downscale, matching the previous 1px overlay lines. LIVE EDITOR
  // ONLY: computeGridLines returns null when meta.show_grid is unset (oracle).
  {
    const grid = computeGridLines(meta, S, ox * ss, oy * ss, W * ss, H * ss);
    if (grid) {
      const gridColor = toColor({ r: 0, g: 0, b: 0, a: 20 }); // ~0.08 alpha
      for (const x of grid.xs) {
        const ln = new paper.Path.Line(new paper.Point(x, 0), new paper.Point(x, H * ss));
        ln.strokeColor = gridColor; ln.strokeWidth = ss;
      }
      for (const y of grid.ys) {
        const ln = new paper.Path.Line(new paper.Point(0, y), new paper.Point(W * ss, y));
        ln.strokeColor = gridColor; ln.strokeWidth = ss;
      }
    }
  }

  const byLayer = {};
  for (const s of strands) byLayer[s.layer_name] = s;

  // Honor the canonical layer_order from the Qt reference so the j<i z-order
  // semantics match OSS. Guard with every()+rank.has so a partial/missing order
  // falls back to the incoming array order. Sort a slice() copy so the caller's
  // array is not mutated; byLayer is keyed by layer_name and stays valid.
  if (Array.isArray(meta.layer_order) && meta.layer_order.length) {
    const rank = new Map(meta.layer_order.map((name, idx) => [name, idx]));
    if (strands.every((s) => rank.has(s.layer_name))) {
      strands = strands.slice().sort((a, b) => rank.get(a.layer_name) - rank.get(b.layer_name));
    }
  }

  // Replace each strand's stored has_circles with the render-time value OSS
  // computes on load (from actual attachments + manual overrides). Drives both
  // the end caps and the flat-end side lines.
  for (const s of strands) {
    if (s.type === 'MaskedStrand') continue;
    s.has_circles = computeHasCircles(s, strands);
  }

  const shadowEnabled = !!meta.shadow_enabled;
  SHADOW_ENABLED = shadowEnabled;
  SHADOW_PAINT = toColor(SHADOW_COLOR);
  ARROW_PARAMS = Object.assign({}, ARROW_DEFAULTS, meta.arrow_params || {});
  // Stash the per-pair override dict module-scoped so castStrandShadow can read
  // it in the Port phase without threading a new param. Inert until that phase.
  SHADOW_OVERRIDES = meta.shadow_overrides || {};

  // Pairs that are the two components of a mask don't shadow each other (the
  // mask owns that crossing).
  const maskPairs = new Set();
  for (const s of strands) {
    if (s.type !== 'MaskedStrand') continue;
    const p = (s.layer_name || '').split('_');
    if (p.length >= 4) {
      maskPairs.add(p[0] + '_' + p[1] + '|' + p[2] + '_' + p[3]);
      maskPairs.add(p[2] + '_' + p[3] + '|' + p[0] + '_' + p[1]);
    }
  }

  // Draw in list order (≈ Qt paint loop): for each strand, first cast its
  // faithful two-pass shadow onto already-drawn lower strands (SOLID CORE +
  // clipped FADED BLUR, see castStrandShadow), then paint its body. Drawing the
  // body after the cast means it covers its own inner shadow, leaving only the
  // fringe over lower strands. Masked strands repaint the top strand over the
  // bottom (and own their own crossing shadow).
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    // Hidden strands do not cast a shadow (Qt draw_strand_shadow early-returns on
    // is_hidden, shader_utils.py:457). Their body still routes to drawMasked/
    // drawStrand below, matching the pre-existing (unmeasured) body behavior.
    // hide_shadow (OSS 1.109 per-layer "Hide Shadow", shader_utils.py:466): the
    // strand casts nothing but still receives and paints its body normally.
    const casts = shadowEnabled && s.is_hidden !== true && s.hide_shadow !== true;
    if (s.type === 'MaskedStrand') {
      // A mask FIRST casts its crossing shadow onto lower NON-mask strands (the
      // receiver loop skips MaskedStrand receivers and the mask's own components),
      // THEN draws its body (which owns its own-component crossing shadow).
      if (casts) castStrandShadow(s, strands, byLayer, P, enableThird, S, maskPairs, i);
      // shadow_only mask (OSS masked_strand.py:561-568): still owns its crossing
      // shadow (drawn inside drawMasked) but paints NO body fill/stroke.
      drawMasked(s, byLayer, P, enableThird, S, s.shadow_only === true);
      continue;
    }

    if (casts) castStrandShadow(s, strands, byLayer, P, enableThird, S, maskPairs, i);
    // OSS shadow_only: the strand has already cast its shadow above; suppress its
    // own body/extension paint. Absent/false => normal full body (oracle-safe).
    // (Per-pair visibility/full/subtract overrides are handled inside
    // castStrandShadow via SHADOW_OVERRIDES — supersedes the group branch's
    // isShadowPairVisible gate.)
    if (s.shadow_only) continue;
    drawStrand(s, strands, P, enableThird, S);
  }

  paper.view.update();

  const vis = document.getElementById('c');
  vis.width = W;
  vis.height = H;
  vis.style.width = W + 'px';
  vis.style.height = H + 'px';
  const ctx = vis.getContext('2d');
  if (ss === 1) {
    ctx.drawImage(hi, 0, 0);
  } else if (meta.fast_downscale) {
    // LIVE EDITOR ONLY (gated on meta.fast_downscale, which the offline oracle /
    // fidelity harness never sets). Downscale the ss× supersampled offscreen with
    // the browser's native high-quality filter — a GPU blit — instead of the exact
    // JS box-average below (a W*ss × H*ss triple loop, ~200ms even for a single
    // strand on a 1400×680 canvas, which is the dominant pointer-up cost). Still
    // fully supersampled, so resting quality is ~indistinguishable; only the
    // offline path keeps the exact Qt-matching box average for byte-identity.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(hi, 0, 0, W * ss, H * ss, 0, 0, W, H);
  } else {
    // Match the Qt reference, which downsamples the ss× image with
    // QImage.scaled(..., Qt.SmoothTransformation). For an exact integer ss
    // downscale that is an ss×ss box average in sRGB space. Reproduce it exactly
    // here instead of relying on the browser's imageSmoothing filter (a wider,
    // engine-specific kernel that leaves a ~1px seam on high-contrast curved
    // edges versus Qt's average). The composited image is fully opaque (white
    // background), so a straight per-channel average needs no alpha handling.
    const src = hi.getContext('2d').getImageData(0, 0, W * ss, H * ss).data;
    const out = ctx.createImageData(W, H);
    const od = out.data;
    const rowSpan = W * ss;
    const inv = 1 / (ss * ss);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = 0; dy < ss; dy++) {
          let si = ((y * ss + dy) * rowSpan + x * ss) * 4;
          for (let dx = 0; dx < ss; dx++) {
            r += src[si]; g += src[si + 1]; b += src[si + 2]; a += src[si + 3];
            si += 4;
          }
        }
        const oi = (y * W + x) * 4;
        od[oi] = r * inv;
        od[oi + 1] = g * inv;
        od[oi + 2] = b * inv;
        od[oi + 3] = a * inv;
      }
    }
    ctx.putImageData(out, 0, 0);
  }

  // Tear down this frame's Paper project. renderFixture calls paper.setup() on a
  // fresh offscreen canvas every call; without removing the project here, every
  // render leaks a paper.Project into paper.projects. During a drag (one render
  // per frame) these pile up, so successive frames get progressively slower and
  // memory grows. The visible #c already holds the copied-out pixels, so dropping
  // the project changes no output (the harness screenshots #c, not Paper's view).
  paper.project.remove();

  return { drawn: strands.length, width: W, height: H, supersample: ss };
};

// ---- interactive drag fast-path (EDITOR ONLY; the headless harness never calls
// these — it only uses renderFixture/extractStrands) ---------------------------
// Dragging an endpoint re-renders every frame, and re-stroking ALL strands through
// Paper each frame is ~O(n) heavy boolean ops (hundreds of ms for busy scenes — see
// tools/bench_drag.mjs). The original OpenStrand Studio avoids this by drawing ONLY
// the moving strand over a cached "background" of everything else (move_mode.py's
// optimized paint handler, painting at native resolution with shadows effectively
// dropped). We mirror that: bake the static strands once into DRAG_BG, then per
// move draw only the moving strands on top — at supersample 1 (so no box-average
// downscale) and with shadows off. Full quality + shadows return via a normal
// renderFixture on pointer-up.
// bands: ordered z-segments separating the static scene around the moving set.
// Each entry is either { kind:'band', canvas } (a pre-baked maximal run of
// consecutive static strands) or { kind:'move' } (a placeholder where the moving
// strands are stroked live each frame). Walking `bands` in order and blitting /
// stroking reproduces the document's true z-order, so a static strand above the
// moving one still occludes it (mirrors move_mode.py's original_strands_order
// redraw, but with the static runs cached so per-frame cost stays O(moving)).
let DRAG_BG = null; // { bands, W, H, ox, oy, zoom, topo }

// Gesture-invariant topology shared by every frame of a drag. has_circles is the
// attachment structure (which endpoints carry caps / flat-end side lines); it is
// position-INDEPENDENT and so identical on every frame of an endpoint/CP drag
// (welded children move rigidly with their parent endpoint, so the attachment a
// child registers at its parent's endpoint never changes within the gesture).
// byLayer / enableThird are likewise topology, not position. Computing them ONCE
// at bake — instead of re-running the O(N^2) computeHasCircles pass every frame —
// is the per-frame win. Returns { hasCircles: Map<layer_name,[bool,bool]>,
// byLayer, enableThird }; has_circles is stored in the Map, NOT mutated onto s,
// so the bake/frame callers apply it only to the strands they actually draw.
function computeDragTopology(strands) {
  const enableThird = strands.some((s) => s.control_point_center != null);
  const byLayer = {};
  for (const s of strands) byLayer[s.layer_name] = s;
  const hasCircles = new Map();
  for (const s of strands) {
    if (s.type === 'MaskedStrand') continue;
    hasCircles.set(s.layer_name, computeHasCircles(s, strands));
  }
  return { hasCircles, byLayer, enableThird };
}

// Paint the strands for which shouldDraw(layer_name) is true into targetCanvas at
// native (supersample-1) scale, no shadows. Shared by the bake and per-frame paths.
// `topo` (from computeDragTopology) carries the gesture-invariant has_circles /
// byLayer / enableThird so the per-frame path skips the O(N^2) topology pass; when
// absent (defensive fallback) the per-frame topology is recomputed here so the
// function stays self-contained. Leaves the Paper project active for the caller to
// read / composite, then remove.
function _dragPaint(targetCanvas, strands, meta, shouldDraw, whiteBg, topo) {
  if (meta.curve_params) CURVE = meta.curve_params;
  SAMPLE_STEP = DRAG_SAMPLE_STEP; // coarse sampling keeps per-frame stroking cheap

  const W = meta.image_width, H = meta.image_height;
  const S = meta.zoom || 1; // supersample fixed at 1 on the drag path
  targetCanvas.setAttribute('hidpi', 'off');
  targetCanvas.width = W;
  targetCanvas.height = H;
  paper.setup(targetCanvas);
  if (whiteBg) {
    const bg = new paper.Path.Rectangle(new paper.Point(0, 0), new paper.Size(W, H));
    bg.fillColor = 'white';
  }
  const ox = meta.x_offset, oy = meta.y_offset;
  // Matches renderFixture's P at ss=1: P(pt) = pt*S + offset.
  const P = (pt) => new paper.Point(pt.x * S + ox, pt.y * S + oy);
  if (!topo) topo = computeDragTopology(strands); // defensive self-contained fallback
  const { hasCircles, byLayer, enableThird } = topo;
  SHADOW_ENABLED = false; // no shadows while dragging (restored by renderFixture on release)
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    if (!shouldDraw(s.layer_name)) continue;
    if (s.type === 'MaskedStrand') { drawMasked(s, byLayer, P, enableThird, S); continue; }
    // Apply the cached topology to the strand we are about to draw (the Map holds
    // every non-masked strand's value, computed once per gesture at bake).
    const hc = hasCircles.get(s.layer_name);
    if (hc) s.has_circles = hc;
    drawStrand(s, strands, P, enableThird, S);
  }
  paper.view.update();
}

// Bake the STATIC strands into per-band offscreen bitmaps, split by the moving
// set so true z-order is preserved during the gesture. Call once at the start of
// a drag. The strands array is already z-ordered (doc order); we walk it and let
// any moving-set layer act as a SEPARATOR. Each maximal run of consecutive static
// strands becomes its own band bitmap; the moving set's z-slot becomes a 'move'
// placeholder stroked live each frame. In the common case (moving set contiguous)
// this yields BELOW band, move, ABOVE band. Computes the gesture-invariant
// topology ONCE here and stashes it (with the bands) on DRAG_BG so every
// renderDragFrame reuses it instead of recomputing.
window.renderDragBackground = function (strands, meta) {
  const W = meta.image_width, H = meta.image_height;
  const moving = new Set((meta.drag && meta.drag.moving) || []);
  const topo = computeDragTopology(strands);
  // Partition strands into ordered segments: maximal runs of static strands
  // alternating with the moving-set slots. A MaskedStrand whose components move is
  // already in the moving set (movingStrandSet), so testing layer membership is
  // enough to keep masks that straddle a boundary out of a static band.
  const bands = [];
  let run = null; // current static layer-name run, or null
  let inMove = false; // last separator slot already recorded as 'move'?
  for (let i = 0; i < strands.length; i++) {
    const name = strands[i].layer_name;
    if (moving.has(name)) {
      if (run) { bands.push({ kind: 'band', names: run }); run = null; }
      // Collapse a contiguous cluster of moving strands into a single 'move' slot.
      if (!inMove) { bands.push({ kind: 'move' }); inMove = true; }
    } else {
      if (!run) run = new Set();
      run.add(name);
      inMove = false;
    }
  }
  if (run) bands.push({ kind: 'band', names: run });
  // Bake each static run into its own TRANSPARENT bitmap. The white backdrop is
  // painted once on the visible canvas in renderDragFrame (not baked into any
  // band) so the bands composite cleanly in any order regardless of which one is
  // first — including the case where the moving set is at the very bottom and no
  // BELOW band exists.
  for (const b of bands) {
    if (b.kind !== 'band') continue;
    const c = document.createElement('canvas');
    _dragPaint(c, strands, meta, (name) => b.names.has(name), false, topo);
    paper.project.remove();
    b.canvas = c;
    delete b.names; // names only needed during bake
  }
  DRAG_BG = {
    bands, W, H, ox: meta.x_offset, oy: meta.y_offset, zoom: meta.zoom || 1, topo,
  };
  return { baked: true, staticCount: strands.length - moving.size, bands: bands.length };
};

// Per-move frame: composite the pre-baked static bands and the live moving
// strokes in TRUE z-order, so a static strand above the moving one still occludes
// it. Falls back to a full renderFixture if no matching bake exists (e.g. the view
// changed mid-gesture). Reuses DRAG_BG.topo (baked once at gesture start) so the
// per-frame cost is O(moving) + k band blits, not O(all strands).
window.renderDragFrame = function (strands, meta) {
  const W = meta.image_width, H = meta.image_height;
  if (!DRAG_BG || DRAG_BG.W !== W || DRAG_BG.H !== H ||
      DRAG_BG.ox !== meta.x_offset || DRAG_BG.oy !== meta.y_offset ||
      DRAG_BG.zoom !== (meta.zoom || 1)) {
    return window.renderFixture(strands, meta);
  }
  const moving = new Set((meta.drag && meta.drag.moving) || []);
  // Stroke the moving strands once into a transparent offscreen bitmap; it gets
  // blitted at every 'move' slot in the band order (normally exactly one slot).
  const mv = document.createElement('canvas');
  _dragPaint(mv, strands, meta, (name) => moving.has(name), false, DRAG_BG.topo);
  paper.project.remove();
  const vis = document.getElementById('c');
  vis.width = W;
  vis.height = H;
  vis.style.width = W + 'px';
  vis.style.height = H + 'px';
  const ctx = vis.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H); // backdrop (baked into no band; see renderDragBackground)
  // Grid: same as the full render path, painted on the visible canvas after the
  // white backdrop and BEFORE the transparent static bands, so it sits under every
  // body during a drag. ss is fixed at 1 here, so scale == zoom and the offsets are
  // the raw meta pan. LIVE EDITOR ONLY (computeGridLines null-guards on show_grid).
  {
    const grid = computeGridLines(meta, meta.zoom || 1, meta.x_offset, meta.y_offset, W, H);
    if (grid) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      for (const x of grid.xs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (const y of grid.ys) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
      ctx.restore();
    }
  }
  // Composite bands bottom-to-top in document z-order, dropping in the moving
  // strokes at their z-slot. Per-frame work = k band blits + the one mv blit.
  for (const b of DRAG_BG.bands) {
    if (b.kind === 'move') ctx.drawImage(mv, 0, 0);
    else ctx.drawImage(b.canvas, 0, 0);
  }
  return { drawn: moving.size, mode: 'dragframe', bands: DRAG_BG.bands.length };
};

// Drop the cached background at the end of a gesture (or before any full render).
window.endDrag = function () { DRAG_BG = null; };

// ---- auto_shadow geometry probe (OSS auto_shadow.py, 1.109) ---------------
// For each requested {casting, receiving} pair, compute the RAW caster∩receiver
// overlap area and the SURVIVAL ratio after the renderer's own per-pair
// subtractions — via the same buildPairShadowRegion castStrandShadow uses, so
// the probe can never diverge from what actually renders. Pure computation:
// paper is set up on a throwaway offscreen canvas and nothing is kept (the next
// renderFixture call does its own paper.setup). Areas are returned in WORLD
// units² — call with meta.supersample = 1 and no zoom (S = 1) or they scale.
// The pair's own `visibility` override is intentionally NOT applied: the caller
// wipes auto entries first and skips user-authored pairs, matching
// recompute_auto_shadow_overrides.
window.computeShadowPairAreas = function (strands, meta, pairs) {
  if (meta.curve_params) CURVE = meta.curve_params;
  SAMPLE_STEP = 1;
  const ss = meta.supersample || 1;
  const zoom = meta.zoom || 1;
  const S = ss * zoom;
  const hi = document.createElement('canvas');
  hi.setAttribute('hidpi', 'off');
  hi.width = 8; hi.height = 8;
  paper.setup(hi);

  const ox = meta.x_offset || 0, oy = meta.y_offset || 0;
  const P = (pt) => new paper.Point(pt.x * S + ox * ss, pt.y * S + oy * ss);
  const enableThird = strands.some((s) => s.control_point_center != null);

  const byLayer = {};
  for (const s of strands) byLayer[s.layer_name] = s;
  if (Array.isArray(meta.layer_order) && meta.layer_order.length) {
    const rank = new Map(meta.layer_order.map((name, idx) => [name, idx]));
    if (strands.every((s) => rank.has(s.layer_name))) {
      strands = strands.slice().sort((a, b) => rank.get(a.layer_name) - rank.get(b.layer_name));
    }
  }
  for (const s of strands) {
    if (s.type === 'MaskedStrand') continue;
    s.has_circles = computeHasCircles(s, strands);
  }
  SHADOW_OVERRIDES = meta.shadow_overrides || {};

  const unit = S * S; // px² per world-unit²
  const idxOf = (name) => strands.findIndex((s) => s.layer_name === name);
  const out = [];
  for (const pr of pairs) {
    const i = idxOf(pr.casting), j = idxOf(pr.receiving);
    const res = { casting: pr.casting, receiving: pr.receiving, rawArea: 0, ratio: 0 };
    out.push(res);
    if (i < 0 || j < 0 || j >= i) continue;
    const s = strands[i], o = strands[j];
    if (s.type === 'MaskedStrand') continue; // candidates are body strands

    const core = buildShadowCasterCore(s, P, enableThird, S);
    if (!core) continue;
    const circles = buildShadowCasterCircles(s, strands, P, enableThird, S);
    let footprint = core.clone();
    if (circles) { const u = footprint.unite(circles); footprint.remove(); footprint = u; }

    // RAW overlap: caster footprint ∩ receiver rendered geometry, before any
    // gating/subtraction (auto_shadow.py "raw" / shader_utils.py:1950-1969).
    const recvRaw = o.type === 'MaskedStrand'
      ? buildMaskPath(o, byLayer, P, enableThird, S)
      : buildShadowReceiverGeom(o, strands, P, enableThird, S);
    if (recvRaw) {
      const raw = footprint.intersect(recvRaw);
      res.rawArea = Math.abs(raw.area || 0) / unit;
      raw.remove(); recvRaw.remove();
    }

    if (res.rawArea > 0) {
      const ov = (SHADOW_OVERRIDES[s.layer_name] || {})[o.layer_name] || null;
      const allowFull = !!(ov && ov.allow_full_shadow);
      const r = buildPairShadowRegion(
        s, i, o, j, strands, byLayer, P, enableThird, S, footprint, ov, allowFull, null);
      const survArea = r.region ? Math.abs(r.region.area || 0) / unit : 0;
      r.region && r.region.remove();
      r.recv && r.recv.remove();
      r.clipBlocker && r.clipBlocker.remove();
      res.ratio = survArea / res.rawArea;
    }

    footprint.remove(); core.remove(); circles && circles.remove();
  }
  return out;
};

// Extract the flat strands array from a fixture file (handles the
// OpenStrandStudioHistory wrapper). Mirrors js_render.mjs / reference_render.py.
window.extractStrands = function (data, step) {
  if (data && data.type === 'OpenStrandStudioHistory') {
    const target = step != null ? step : data.current_step;
    const state = (data.states || []).find((s) => s.step === target);
    return state ? state.data.strands : [];
  }
  return data.strands || [];
};
