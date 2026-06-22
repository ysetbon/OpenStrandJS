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

// Curve-shape parameters. These are canvas-level settings (NOT stored per
// strand in the JSON); the reference renderer exports the canvas's values
// into meta.curve_params. Defaults match the braid fixtures.
let CURVE = { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 };

// Shadow parameters (canvas defaults): default_shadow_color (0,0,0,150) and
// max_blur_radius 30. A strand casts a shadow onto every lower-ordered strand
// as (over-body expanded by blur) ∩ (under-body), drawn just under the over
// strand's body so only the fringe beyond it shows.
const SHADOW_COLOR = { r: 0, g: 0, b: 0, a: 150 };
const MAX_BLUR = 30;
let SHADOW_ENABLED = false; // set per-fixture from meta.shadow_enabled
let SHADOW_PAINT = null;    // paper.Color for shadows

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
  const N = Math.max(8, Math.ceil(len)); // ~1px sampling
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
    const endAtt = hasAttachedChildAt(s.end, strands, s);
    return [true, mcv[1] != null ? mcv[1] : endAtt];
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
  const startA = circleStrokeAlpha(s.start_circle_stroke_color);
  const endA = circleStrokeAlpha(s.end_circle_stroke_color);
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
    } else if (startA === 0 && s.is_setting_staring_circle && hc[0]) {
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

function drawStrand(s, strands, P, enableThird, S) {
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
    circleStrokeAlpha(s.start_circle_stroke_color) > 0
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

// Faithful port of masked_strand.py. The crossing of the top strand (`first`)
// over the bottom (`second`) is painted as TWO regions filled directly:
//   stroke-color layer = stroked(first, w+2sw) ∩ stroked(second, w+2sw)
//   fill-color  layer  = stroked(first, w)     ∩ stroked(second, w+2sw+4)
// each unioned with the components' visible start circles, minus deletions.
function drawMasked(ms, byLayer, P, enableThird, S) {
  const parts = (ms.layer_name || '').split('_');
  if (parts.length < 4) return;
  const first = byLayer[parts[0] + '_' + parts[1]];
  const second = byLayer[parts[2] + '_' + parts[3]];
  if (!first || !second) return;
  const fw = first.width || 0, fsw = first.stroke_width || 0;
  const sw = second.width || 0, ssw = second.stroke_width || 0;

  // Crossing shadow (only when shadows are on): over strand expanded by blur ∩
  // under strand body, drawn first so the over-strand redraw covers all but the
  // fringe on the under strand.
  if (SHADOW_ENABLED) {
    const firstExp = strokedBodyAtWidth(first, P, enableThird, (fw + 2 * fsw + MAX_BLUR) * S);
    const secondBody = strokedBodyAtWidth(second, P, enableThird, (sw + 2 * ssw) * S);
    if (firstExp && secondBody) {
      let sh = firstExp.intersect(secondBody);
      sh = subtractDeletions(sh, ms, P, S);
      if (sh && sh.area && Math.abs(sh.area) > 0.5) { sh.fillColor = SHADOW_PAINT; sh.strokeColor = null; }
      else if (sh) sh.remove();
    }
    firstExp && firstExp.remove();
    secondBody && secondBody.remove();
  }

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
}

// Render `strands` (flat array) using `meta` into the canvas #c.
window.renderFixture = function (strands, meta) {
  if (meta.curve_params) CURVE = meta.curve_params;
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

  const byLayer = {};
  for (const s of strands) byLayer[s.layer_name] = s;

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

  // Precompute each regular strand's full body and blur-expanded body once
  // (kept invisible; reused for all shadow pairs).
  const fullBody = {}, expBody = {};
  if (shadowEnabled) {
    for (const s of strands) {
      if (s.type === 'MaskedStrand') continue;
      const w = s.width || 0, sw = s.stroke_width || 0;
      const fb = strokedBodyAtWidth(s, P, enableThird, (w + 2 * sw) * S);
      const eb = strokedBodyAtWidth(s, P, enableThird, (w + 2 * sw + MAX_BLUR) * S);
      if (fb) fb.visible = false;
      if (eb) eb.visible = false;
      fullBody[s.layer_name] = fb;
      expBody[s.layer_name] = eb;
    }
  }
  const shadowCol = toColor(SHADOW_COLOR);

  // Draw in list order (≈ Qt paint loop): for each strand, first cast its
  // shadow onto already-drawn lower strands, then paint its body. Masked
  // strands repaint the top strand over the bottom.
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    if (s.type === 'MaskedStrand') { drawMasked(s, byLayer, P, enableThird, S); continue; }

    if (shadowEnabled && expBody[s.layer_name]) {
      for (let j = 0; j < i; j++) {
        const o = strands[j];
        if (o.type === 'MaskedStrand' || !fullBody[o.layer_name]) continue;
        if (maskPairs.has(s.layer_name + '|' + o.layer_name)) continue;
        const region = expBody[s.layer_name].intersect(fullBody[o.layer_name]);
        if (!region) continue;
        if (region.area && Math.abs(region.area) > 0.5) {
          region.fillColor = shadowCol;
          region.strokeColor = null;
        } else {
          region.remove();
        }
      }
    }
    drawStrand(s, strands, P, enableThird, S);
  }

  // Remove the invisible helper bodies.
  for (const k in fullBody) { if (fullBody[k]) fullBody[k].remove(); }
  for (const k in expBody) { if (expBody[k]) expBody[k].remove(); }

  paper.view.update();

  const vis = document.getElementById('c');
  vis.width = W;
  vis.height = H;
  vis.style.width = W + 'px';
  vis.style.height = H + 'px';
  const ctx = vis.getContext('2d');
  if (ss === 1) {
    ctx.drawImage(hi, 0, 0);
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

  return { drawn: strands.length, width: W, height: H, supersample: ss };
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
