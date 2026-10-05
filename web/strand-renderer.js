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
  // Index the lines (i * g) rather than accumulating (x += g). The accumulation
  // starts at a different multiple of g for every pan offset, and floating-point
  // addition is not associative, so the SAME grid line came out a few ULPs apart
  // depending on where the walk began — enough to move a 1px line onto different
  // anti-aliasing. Indexing makes line i the same double at every offset, so the
  // grid translates with the content exactly instead of shimmering under a pan.
  for (let i = Math.floor(worldLeft / g); i * g <= worldRight; i++) xs.push(i * g * scale + ox);
  for (let i = Math.floor(worldTop / g); i * g <= worldBottom; i++) ys.push(i * g * scale + oy);
  return { xs, ys };
}

// Curve-shape parameters. These are canvas-level settings (NOT stored per
// strand in the JSON); the reference renderer exports the canvas's values
// into meta.curve_params. Defaults match the braid fixtures.
//
// Like every other paint setting (see applyPaintSettings) this is re-derived
// from `meta` at EVERY render entry point, falling back to the constant below
// when the key is absent. It used to be assigned only when the key WAS present,
// which made a render that omitted it inherit whatever curve the previous
// render had been given — the same document drawn with two different curves
// depending on what was rendered before it.
const CURVE_DEFAULT = { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 };
let CURVE = CURVE_DEFAULT;

// Centerline sampling step (px) used to build stroked outlines. renderFixture (the
// pixel oracle) always uses 1 (~1px, full accuracy). The interactive drag path sets
// it coarser via DRAG_SAMPLE_STEP so a long curvy strand isn't sampled thousands of
// times per frame; the body is a hair less smooth mid-drag and snaps back to full
// accuracy on pointer-up. Only _dragPaint raises it, and renderFixture resets it to
// 1 on entry, so the harness output is unaffected.
let SAMPLE_STEP = 1;
const DRAG_SAMPLE_STEP = 3;

// ---- per-render geometry memo -------------------------------------------------
// The shadow pass is a nested walk: for every caster i it visits every receiver
// j < i, and for each (i, j) pair it subtracts the geometry of every layer
// between them and of every mask above the caster. The geometry each of those
// steps needs — a receiver's rendered outline, a mask's crossing region, a mask's
// blocker — depends ONLY on the strand plus the render-wide constants (P,
// enableThird, S, SAMPLE_STEP). It does not depend on which pair is being
// processed. Rebuilding it inside the loops therefore made the pass do O(N^2)
// outline builds and O(N^3) subtraction builds, and every one of those builds
// resamples a centerline at ~1px and runs resolveCrossings. On a 60-strand
// document that is multiple seconds of Paper.js path construction on pointer-up
// — the release hang.
//
// So memoize, scoped to ONE render. Opening the cache at the top of a render and
// closing it before the frame is composited gives two guarantees: an entry can
// never outlive the paper project it was built in, and geometry that changed
// between renders can never be served stale.
//
// Masters are held DETACHED (removed from the drawing tree) so they paint
// nothing and are skipped by every bounds/hit walk; each lookup hands back a
// fresh clone re-inserted at the top of the active layer, which is exactly where
// a freshly built path lands. Callers keep their existing ownership contract —
// mutate it, feed it to boolean ops, remove it when done — and the pixels are
// identical to rebuilding it from scratch.
let GEOM_CACHE = null;
// The paper project the masters in GEOM_CACHE belong to. A render that throws
// between geomCacheBegin() and geomCacheEnd() leaves the cache open, and the
// scheduler swallows renderer errors to keep the rAF loop alive — so the next
// paint would otherwise find a populated cache whose masters belong to a project
// that has since been removed, and serve clones of them. Pinning the project
// makes that impossible by construction rather than by every entry point
// remembering to clear first: a cache from another project simply reads as
// closed, and the builders run fresh.
let GEOM_PROJECT = null;

function geomCacheBegin() {
  geomCacheEnd();
  GEOM_CACHE = new Map();
  GEOM_PROJECT = paper.project;
  esCacheBegin();
}

// Is the memo open AND still owned by the project being drawn into?
function geomCacheLive() {
  return GEOM_CACHE !== null && GEOM_PROJECT === paper.project;
}

function geomCacheEnd() {
  const cache = GEOM_CACHE;
  GEOM_CACHE = null;                  // clear first: a render that threw must not
  GEOM_PROJECT = null;                // leave a half-open cache behind
  esCacheEnd();
  if (!cache) return;
  for (const e of cache.values()) {
    // The project these masters belong to may already be gone (a render that
    // threw part-way). Detaching a stale item is not worth failing the next frame.
    try { if (e && e.item) e.item.remove(); } catch { /* project already torn down */ }
  }
}

// The cache entry for `key`, building it on first use. `null` geometry is cached
// too, so a build that legitimately yields nothing is not retried once per pair.
function geomEntry(key, build) {
  let e = GEOM_CACHE.get(key);
  if (e === undefined) {
    const item = build();
    if (item) item.remove();          // hold the master out of the drawing tree
    e = { item, bounds: item ? item.bounds : null };
    GEOM_CACHE.set(key, e);
  }
  return e;
}

// Memoized geometry, handed back as an owned clone inserted where a fresh build
// would sit. Falls through to a plain build when no cache is open (the module's
// other entry points, and the auto-shadow probe, call these builders directly).
function cachedGeom(key, build) {
  if (!geomCacheLive()) return build();
  const e = geomEntry(key, build);
  if (!e.item) return null;
  const c = e.item.clone({ insert: false });
  paper.project.activeLayer.addChild(c);
  return c;
}

// Is a memo currently open? The keys carry no coordinates, so the cache is only
// correct while it is scoped to a single paint; tools/drag_perf_check.mjs asserts
// this is false after every render so a future edit cannot quietly widen the
// scope and freeze the dragged strand at its pointer-down shape. Deliberately the
// LITERAL open flag, not geomCacheLive(): the guard should catch a cache left
// behind even though the project pin would stop it being used.
window.__geomCacheOpen = function () { return GEOM_CACHE !== null; };

// Bounds of the memoized geometry WITHOUT paying for a clone — lets a caller run
// a cheap bounding-box reject before it commits to the real path.
function cachedGeomBounds(key, build) {
  if (!geomCacheLive()) return undefined;  // undefined = "unknown", caller must build
  return geomEntry(key, build).bounds;
}

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
// These three are SETTINGS in the desktop app (Settings -> General: Shadow Color,
// Shadow Blur Steps, Shadow Blur Radius). The values below are what the reference
// user_settings.txt loads, and therefore what the Qt pixel oracle renders — so they
// stay the defaults, and a meta that does not carry the keys (every fixture render)
// produces byte-identical output. applyPaintSettings overrides them per render for
// the live editor, where the three General-page controls previously did nothing.
const SHADOW_COLOR_DEFAULT = { r: 0, g: 0, b: 0, a: 150 };
let SHADOW_COLOR = SHADOW_COLOR_DEFAULT;
let MAX_BLUR = 30;
let NUM_STEPS = 2; // loaded reference setting (user_settings.txt NumSteps:2)
// OSS canvas.highlight_color (default opaque red, strand_drawing_canvas.py:175),
// used for the selected-strand halo and — with alpha forced to 128 — the selected
// mask's outline (masked_strand.py:1228-1231).
const HIGHLIGHT_COLOR_DEFAULT = { r: 255, g: 0, b: 0, a: 255 };
let HIGHLIGHT_COLOR = HIGHLIGHT_COLOR_DEFAULT;
// OSS routes a masked strand through MaskedStrand._draw_direct instead of draw()
// whenever the canvas is zoomed or panned (masked_strand.py:668). meta.mask_direct
// says which of the two paths this frame mirrors; absent => draw(), which is what
// the oracle renders at zoom 1 with no pan.
let MASK_DIRECT = false;

// Apply the shadow/highlight settings carried on `meta`, falling back to the oracle
// constants for any key the caller omits. Called at EVERY render entry point so a
// value set by one frame can never leak into the next.
function applyPaintSettings(meta) {
  const m = meta || {};
  SHADOW_COLOR = m.shadow_color && m.shadow_color.a != null ? m.shadow_color : SHADOW_COLOR_DEFAULT;
  MAX_BLUR = typeof m.max_blur_radius === 'number' && m.max_blur_radius > 0 ? m.max_blur_radius : 30;
  // Guard the step count: shadowBlurSteps divides by it and OSS's own spin box is
  // bounded to 1..10 (settings_dialog.py), so a 0 would make every width NaN.
  NUM_STEPS = Number.isFinite(m.num_steps) && m.num_steps >= 1 ? Math.round(m.num_steps) : 2;
  HIGHLIGHT_COLOR = m.highlight_color && m.highlight_color.a != null ? m.highlight_color : HIGHLIGHT_COLOR_DEFAULT;
  MASK_DIRECT = !!m.mask_direct;
  ARROW_PARAMS = Object.assign({}, ARROW_DEFAULTS, m.arrow_params || {});
  EXTENSION_PARAMS = Object.assign({}, EXTENSION_DEFAULTS, m.extension_params || {});
  // Absent => true => the strand's own colour, which is what the oracle renders.
  USE_DEFAULT_ARROW_COLOR = m.use_default_arrow_color !== false;
  DEFAULT_ARROW_FILL = m.default_arrow_fill_color && m.default_arrow_fill_color.a != null
    ? m.default_arrow_fill_color : null;
  // Shadow Path preview pairs, [[caster, receiver], ...]. LIVE EDITOR ONLY: the
  // shadow editor sets them while it is open and clears them on close. Absent =>
  // [] => drawVisibleShadowPaths paints nothing, so the Qt oracle — which never
  // sets the key — renders exactly as before.
  VISIBLE_SHADOW_PATHS = Array.isArray(m.visible_shadow_paths) ? m.visible_shadow_paths : [];
}
// Curvature-bias gate (OSS canvas.enable_curvature_bias_control). Module-scoped
// like CURVE/SHADOW_ENABLED because buildProfile is reached through a dozen
// buildCenterline call sites. Set from meta at every render entry point; ABSENT
// => false => bias pinned to 0.5, which is the pre-existing behavior and what
// the Qt oracle renders (reference_render.py never enables it).
let BIAS_ENABLED = false;
let SHADOW_ENABLED = false; // set per-fixture from meta.shadow_enabled
let SHADOW_PAINT = null;    // paper.Color for shadows (solid-core paint)
let SHADOW_OVERRIDES = {};  // meta.shadow_overrides, keyed [caster][receiver] (consumed in the Port phase)
let VISIBLE_SHADOW_PATHS = []; // meta.visible_shadow_paths, [[caster, receiver], ...]

// Faithful port of strand.py::_build_curve_profile. Returns {mode, segments}
// in world coordinates; each segment is a cubic {p0, cp1, cp2, p3}.
// enable_third_control_point is a USER SETTING in OSS (canvas.enable_third_control_point,
// read by strand.py::_build_curve_profile), not a property of the data. Take it from
// meta when the caller supplies it; fall back to inferring it from the strands when
// absent, because that is exactly what the Qt oracle does
// (reference_render.py:117-121 "Enable third control point if any strand uses one").
// So the fidelity path is unchanged and the live editor now honors the toggle.
function resolveEnableThird(strands, meta) {
  if (meta && meta.enable_third_control_point != null) return !!meta.enable_third_control_point;
  return strands.some((s) => s.control_point_center != null);
}

function buildProfile(s, enableThird) {
  const start = s.start, end = s.end;
  const cps = s.control_points || [];
  const control_point1 = cps[0] || start;
  const control_point2 = cps[1] || end;
  const base_fraction = CURVE.base_fraction;
  const dist_multiplier = CURVE.dist_multiplier;
  const exponent = CURVE.exponent;
  // OSS strand.py::_build_curve_profile reads bias_control.triangle_bias/circle_bias,
  // but ONLY while canvas.enable_curvature_bias_control is on; otherwise both stay
  // 0.5. Same gate here, same neutral default.
  const bc = BIAS_ENABLED ? s.bias_control : null;
  const bias_triangle = bc && bc.triangle_bias != null ? bc.triangle_bias : 0.5;
  const bias_circle = bc && bc.circle_bias != null ? bc.circle_bias : 0.5;

  const thirdLocked = enableThird && s.control_point_center_locked && s.control_point_center;

  if (thirdLocked) {
    const p0 = start, p1 = control_point1, p2 = s.control_point_center, p3 = control_point2, p4 = end;
    if (s.type === 'AttachedStrand') {
      // AttachedStrand overrides get_path / get_shadow_path with its own locked-
      // centre curve (attached_strand.py get_path): ONE fraction, capped at 0.49
      // before the exponent, and a NORMALISED centre tangent. OSS draws the body,
      // the shadows and every mask built on the strand from this curve.
      const in_n = vnorm(vsub(p2, p1)), out_n = vnorm(vsub(p3, p2));
      const ctn = vnorm({ x: 0.5 * in_n.x + 0.5 * out_n.x, y: 0.5 * in_n.y + 0.5 * out_n.y });
      const dist12 = vdist(p2, p1), dist23 = vdist(p3, p2);
      let fraction = Math.min(0.1 + base_fraction * 0.13, 3.77);
      fraction = Math.min(fraction * dist_multiplier, 0.49);
      if (exponent !== 1.0) fraction = Math.pow(fraction, 1 / exponent);
      const cp1 = vadd(p0, vmul(vsub(p1, p0), fraction * (0.5 + bias_triangle)));
      const cp2 = vsub(p2, vmul(ctn, dist12 * fraction * (0.5 + bias_triangle)));
      const cp3 = vadd(p2, vmul(ctn, dist23 * fraction * (0.5 + bias_circle)));
      const cp4 = vadd(p4, vmul(vsub(p3, p4), fraction * (0.5 + bias_circle)));
      return { mode: 'multi', segments: [{ p0, cp1, cp2, p3: p2 }, { p0: p2, cp1: cp3, cp2: cp4, p3: p4 }] };
    }
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
// This is the single hottest function in the renderer: every body, every shadow
// caster/receiver and every mask component goes through it, at ~1px sampling.
// Two things make it cheap without moving a pixel:
//   * ONE getLocationAt(off) per sample instead of getPointAt(off) +
//     getNormalAt(off). Both of those are literally `getLocationAt(off).point` /
//     `.normal` in paper.js, so asking twice ran the arc-length -> curve-time
//     solve (getTimeOf, the profiler's #2 cost) twice for the same offset.
//   * plain [x, y] pairs instead of Point arithmetic. `pt.add(nrm.multiply(half))`
//     allocated two paper.Points per side per sample — six per sample in total —
//     purely to be re-read into a Segment straight afterwards. The arithmetic
//     below is the same expression in the same order on the same doubles, so the
//     coordinates are bit-identical.
function strokedOutline(centerline, width) {
  const len = centerline.length;
  if (len === 0 || width <= 0) return null;
  const half = width / 2;
  const N = Math.max(8, Math.ceil(len / SAMPLE_STEP)); // ~1px sampling (coarser while dragging)
  const left = [], right = [];
  for (let i = 0; i <= N; i++) {
    const off = Math.min(len * i / N, len - 1e-4);
    const loc = centerline.getLocationAt(off);
    const pt = loc && loc.point;
    const nrm = loc && loc.normal;
    if (!pt || !nrm) continue;
    left.push([pt.x + nrm.x * half, pt.y + nrm.y * half]);
    right.push([pt.x - nrm.x * half, pt.y - nrm.y * half]);
  }
  right.reverse();
  return new paper.Path({ segments: left.concat(right), closed: true });
}

// Stroked body outline at an arbitrary width (pixel space), with
// self-intersections (from offsetting a tightly curved centerline) resolved
// into a clean boundary. Returns a paper path or null. The masking primitive.
function strokedBodyAtWidth(s, P, enableThird, widthPx, centerline) {
  const cl = centerline || buildCenterline(s, P, enableThird);
  let outline = strokedOutline(cl, widthPx);
  if (!centerline) cl.remove();
  if (!outline) return null;
  const cleaned = outline.resolveCrossings();
  if (cleaned !== outline) { outline.remove(); outline = cleaned; }
  return outline;
}

// The RAW stroked band: this strand's centerline offset by +/- half `widthPx`,
// with its self-overlaps left in place. This is Qt's
// QPainterPathStroker.createStroke() output, and it is what the PAINTED body is
// built from — see windingFillLayer for why the cleaned bodyOutline below must
// not be used there. Memoized per render like bodyOutline (same paint, same
// band, asked for once per body layer).
function bodyBand(s, P, enableThird, widthPx, centerline) {
  return cachedGeom(`band|${s.layer_name}|${widthPx}`, () => {
    const cl = centerline || buildCenterline(s, P, enableThird);
    const outline = strokedOutline(cl, widthPx);
    if (!centerline) cl.remove();
    return outline;
  });
}

// Paint one body layer the way Qt paints it: ONE QPainterPath with
// Qt.WindingFill holding the stroked band plus every cap sub-path (strand.py
// :2515/:2600 set the fill rule, :2604-2680 addPath() the caps), filled in a
// single drawPath. A paper CompoundPath with fillRule 'nonzero' is that path —
// paper's CompoundPath#_draw emits every child into one ctx.beginPath() and
// issues one ctx.fill(fillRule).
//
// It is deliberately NOT built with resolveCrossings()/unite(). Both are
// boolean operations, and OSS itself abandoned QPainterPath.united() here for
// exactly this reason (strand.py:1704-1709: "Components are appended with
// WindingFill instead of combined with QPainterPath.united(). Qt's Boolean
// union can discard the body"). paper.js's resolveCrossings() has the same
// failure on the self-overlapping band a tightly curved centerline produces: it
// silently returns a fraction of the region (measured at ~23% of the band's
// area on mxn_lh_1x1's 1_1 and ~35% on three_strand_braid's 3_3 during a
// control-point drag). When it eats the FILL layer the strand paints as a solid
// stroke-coloured silhouette — the black-band bug; when it eats the STROKE layer
// the outline disappears under the fill.
//
// Every piece here is additive (band, cap circles, half-circles, side rects,
// end quads — no holes), so each sub-path is forced clockwise first: under the
// nonzero rule two overlapping sub-paths of OPPOSITE orientation would cancel to
// a hole, where Qt's stroker and ellipse builders hand it consistently wound
// sub-paths. Same orientation => the composite is exactly their union.
function windingFillLayer(pieces, color) {
  const children = [];
  for (const item of pieces) {
    if (!item) continue;
    // A boolean result (the half-circle caps) can be a CompoundPath; paper's
    // CompoundPath#insertChildren splices those apart for us, so hand it over
    // whole and let it flatten.
    if (item.children && !item.children.length) { item.remove(); continue; }
    if (!item.children && !(item.segments && item.segments.length)) { item.remove(); continue; }
    children.push(item);
  }
  if (!children.length) return null;
  const cp = new paper.CompoundPath({ children, fillRule: 'nonzero' });
  for (const ch of cp.children) ch.setClockwise(true);
  cp.fillColor = color;
  cp.strokeColor = null;
  return cp;
}

// The one primitive every SHADOW footprint and MASK component is built from:
// this strand's centerline stroked at `widthPx` and cleaned into a simple
// boundary. Those consumers feed the result straight into intersect()/subtract()
// and need a non-self-intersecting input; the painted body does not go through
// here (see bodyBand / windingFillLayer above). In a single render the SAME
// (strand, width) outline is asked for repeatedly — the shadow caster core wants
// the body at w+2sw, the shadow receiver geometry wants it again, and a mask
// component often wants it once more. Each build resamples the centerline at
// ~1px and then runs resolveCrossings over a few hundred segments, so the
// duplicates were the bulk of the remaining cost. Memoized per render (see the geometry memo above), which
// hands back an owned clone, so every caller keeps its existing contract.
function bodyOutline(s, P, enableThird, widthPx, centerline) {
  return cachedGeom(`body|${s.layer_name}|${widthPx}`,
    () => strokedBodyAtWidth(s, P, enableThird, widthPx, centerline));
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
function collectCaps(s, strands, centerline, P, S, startCapLowered = false) {
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
      // false (editor-supplied) suppresses it. A lowered cap is painted by the
      // parent instead (shader_utils.lowered_start_cap, attached_strand.py
      // `_start_cap_lowered`).
      if (!startCapLowered) fill.push(capInner(cStart, wpx));
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
  // An AttachedStrand's start is its attachment cap: OSS never draws a start
  // side line there, even with the circle hidden (attached_strand.py:600 only
  // ever draws the END line; strand.py:2766 draws both for a plain Strand).
  // A styled end paints its side line as the band along its profile instead
  // (strand.py _draw_side_lines), so the classic bar is skipped there.
  if (s.type !== 'AttachedStrand' && s.start_line_visible !== false && !hc[0] && !esActiveStyle(s, 0)) {
    const a = tangentAngle(centerline, 0), c = P(s.start);
    // start shift is opposite the tangent (angle + pi)
    out.push(bar({ x: c.x + shift * Math.cos(a + Math.PI), y: c.y + shift * Math.sin(a + Math.PI) }, a));
  }
  if (s.end_line_visible !== false && !hc[1] && !esActiveStyle(s, 1)) {
    const a = tangentAngle(centerline, len), c = P(s.end);
    // end shift is along the tangent
    out.push(bar({ x: c.x + shift * Math.cos(a), y: c.y + shift * Math.sin(a) }, a));
  }
  return out;
}

// ---- Stylized free ends (OSS 1.111 "Stylize End Side", end_style.py) ---------
// A free end (an end with no circle) can carry an end style: the shape of its
// edge (straight / angled / rounded / pointed / notched / concave), a tilt, a
// depth, an extend/trim offset along the tangent, and the thickness / colour of
// the side line drawn along it. Everything rendered at a styled end derives
// from ONE profile P(y) in the local frame of the end (origin at the endpoint,
// +x outward along the tangent, y across the width), exactly as in OSS:
//   * the OUTER footprint (stroke colour) is the flat-capped body with
//     everything beyond the profile removed and the region between the
//     endpoint plane and the profile added;
//   * the INNER fill is the fill body cut back to the side line's inner edge
//     (the profile offset inward by the side-line thickness);
//   * the side-line BAND is the strip between that inner edge and the profile,
//     painted in the side-line colour clipped to the body;
//   * shadows use the outer footprint (pushed outward by the blur margin) and
//     masks intersect the same footprint.
// Nothing ahead of the endpoint plane is ever removed from the classic body, so
// a strand that bends back in front of its own end keeps every pixel it has
// today, and an unstyled strand never enters this code at all (esGeometry
// returns null), so the fidelity oracle is byte-identical.
//
// All lengths here are PIXEL space (world * S), so every absolute constant OSS
// expresses in canvas units (the 0.1 edge clearance, the 0.5 cut plane, the 12
// px zone reach ...) is multiplied by S.

const ES_SHAPES = ['straight', 'angled', 'rounded', 'pointed', 'notched', 'concave'];
const ES_TILT_MAX = 60;
const ES_MIN_LINE_WIDTH = 0.5;
// Qt's path clipper mishandles a polygon vertex that lies exactly on an edge of
// the other operand (and paper's boolean ops are no happier); the cut polygons
// keep this far from the body's long edges and its endpoint plane.
const ES_EDGE_CLEARANCE = 0.1;
// The cut plane sits a hair ahead of the endpoint plane, so the body's own flat
// cap (and the mitre spike a tight bend leaves along it) falls cleanly inside
// the cut instead of straddling its edge.
const ES_CUT_PLANE = 0.5;

// end_style.normalize_style: a clean record, or null for the classic look.
function esNormalize(style) {
  if (!style) return null;
  const num = (v, fb) => { const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : fb; };
  const shape = ES_SHAPES.includes(style.shape) ? style.shape : 'straight';
  let tilt = Math.max(-ES_TILT_MAX, Math.min(ES_TILT_MAX, num(style.tilt, 0)));
  if (shape === 'straight') tilt = 0;
  const depth = Math.max(0, Math.min(1, num(style.depth, 0.5)));
  const offset = num(style.offset, 0);
  const lineWidth = style.line_width == null ? null : Math.max(ES_MIN_LINE_WIDTH, num(style.line_width, 0));
  const lc = style.line_color;
  const lineColor = lc && typeof lc === 'object'
    ? { r: num(lc.r, 0), g: num(lc.g, 0), b: num(lc.b, 0), a: num(lc.a, 255) } : null;
  if (shape === 'straight' && Math.abs(tilt) < 1e-9 && Math.abs(offset) < 1e-9 && lineWidth == null && !lineColor) return null;
  return { shape, tilt, depth, offset, line_width: lineWidth, line_color: lineColor };
}

// A style renders only on a FREE end: a circle cap always wins and the style
// goes dormant until the end is free again; an attached strand's start is glued
// to its parent (strand.py _end_style_active). Reads the render-time has_circles.
function esActiveStyle(s, side) {
  const styles = s.end_styles;
  if (!Array.isArray(styles) || styles.length !== 2) return null;
  if (side === 0 && s.type === 'AttachedStrand') return null;
  const hc = s.has_circles || [false, false];
  if (hc[side]) return null;
  return esNormalize(styles[side]);
}

function esHasStyledEnd(s) {
  return s.type !== 'MaskedStrand' && (esActiveStyle(s, 0) !== null || esActiveStyle(s, 1) !== null);
}

// -- profile in the local frame of the end ---------------------------------------
function esProfilePoints(shape, half, depth, tiltDeg, baseX, steps = 24) {
  let pts = [];
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
  // QTransform().translate(base_x, 0).rotate(tilt).map(p): rotate, then shift.
  const a = tiltDeg * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  return esFitToBand(pts.map((p) => ({ x: baseX + p.x * c - p.y * sn, y: p.x * sn + p.y * c })), half);
}

// After a tilt the profile no longer reaches y = +-half. Extend its first and
// last segments straight on until they do (a hair beyond, so the corner never
// sits exactly on the body's edge).
function esFitToBand(pts, half) {
  if (pts.length < 2) return pts;
  half = half + ES_EDGE_CLEARANCE_PX;
  const hit = (a, b, targetY) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dy) < 1e-9) return b;
    const t = (targetY - a.y) / dy;
    return { x: a.x + dx * t, y: targetY };
  };
  const ascending = pts[0].y < pts[pts.length - 1].y;
  const first = hit(pts[1], pts[0], ascending ? -half : half);
  const last = hit(pts[pts.length - 2], pts[pts.length - 1], ascending ? half : -half);
  return [first].concat(pts.slice(1, -1), [last]);
}
// esFitToBand runs inside esProfilePoints, before the StyledEnd knows S; the
// clearance in px is set per end (esStyledEnd) right before the profile is built.
let ES_EDGE_CLEARANCE_PX = ES_EDGE_CLEARANCE;

// Where the profile's chord (first -> last point), continued past both ends,
// reaches |y| = ylim (1.5*half by default). The cut continues straight along
// that line through whatever part of a curved body bulges past the width right
// behind its endpoint, instead of turning square.
function esChordExtended(prof, half, ylim) {
  if (ylim == null) ylim = 1.5 * half;
  const a = prof[0], b = prof[prof.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dy) < 1e-9) return [{ x: a.x, y: -ylim }, { x: b.x, y: ylim }];
  const sgn = dy > 0 ? 1 : -1;
  const ta = (-sgn * ylim - a.y) / dy, tb = (sgn * ylim - a.y) / dy;
  return [{ x: a.x + dx * ta, y: a.y + dy * ta }, { x: a.x + dx * tb, y: a.y + dy * tb }];
}

// The polyline restricted to |y| <= ylim (crossing points inserted).
function esClipPolylineY(pts, ylim) {
  const out = [];
  let prev = null;
  for (const p of pts) {
    const inside = Math.abs(p.y) <= ylim;
    if (prev !== null) {
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

// Runs of consecutive points ahead of (x > x0) or behind (x < x0) the plane,
// each starting and ending on the plane.
function esRunsByX(pts, x0, ahead) {
  const runs = [];
  let run = [];
  const cross = (a, b) => { const t = (x0 - a.x) / (b.x - a.x); return { x: x0, y: a.y + (b.y - a.y) * t }; };
  let prev = null;
  for (const p of pts) {
    const keep = ahead ? p.x > x0 : p.x < x0;
    if (prev !== null) {
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

// Close each run back along the plane x = x0 into a simple polygon (a point list).
function esRunsToPolygons(runs, x0) {
  return runs.map((run) => [{ x: x0, y: run[0].y }].concat(run, [{ x: x0, y: run[run.length - 1].y }]));
}

// The region between the plane x = x0 (just behind the endpoint) and the
// profile, where the profile is ahead of it, within |y| <= yLim: the cap piece
// ADDED to the classic body. Built directly, so no boolean op is needed.
function esAheadPolygons(prof, half, yLim, x0) {
  const [first, last] = esChordExtended(prof, half, yLim + ES_UNIT_PX);
  const pts = esClipPolylineY([first].concat(prof, [last]), yLim);
  return esRunsToPolygons(esRunsByX(pts, x0, true), x0);
}

// The region outward of the profile but behind the plane x = x0: what a cut
// REMOVES from the classic body. Nothing ahead of the endpoint plane is ever
// removed, so a body that bends back in front of its own end keeps every pixel.
function esBehindPolygons(prof, half, yLim, x0) {
  const [first, last] = esChordExtended(prof, half, yLim);
  return esRunsToPolygons(esRunsByX([first].concat(prof, [last]), x0, false), x0);
}

// Local-frame strip between the profile and its inward offset (the side line's
// inner edge), both continued along their chords to |y| = yLim.
function esBandRegion(prof, innerProf, half, yLim) {
  const [first, last] = esChordExtended(prof, half, yLim);
  // The inner edge continues parallel to the profile's own continuation (its
  // own chord can point elsewhere once a steep flank has been offset).
  const p0 = prof[0], pn = prof[prof.length - 1];
  const i0 = innerProf[0], iN = innerProf[innerProf.length - 1];
  const innerFirst = { x: i0.x + (first.x - p0.x), y: i0.y + (first.y - p0.y) };
  const innerLast = { x: iN.x + (last.x - pn.x), y: iN.y + (last.y - pn.y) };
  return [first].concat(prof, [last, innerLast], innerProf.slice().reverse(), [innerFirst]);
}

// Shift a polyline a hair backwards if any of its vertices (or its chord
// continuation) would sit on the endpoint plane x = 0, where the stroked body
// has vertices of its own.
function esClearOfEndpointPlane(pts) {
  const xs = pts.map((p) => p.x);
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(b.y - a.y) > 1e-9) {
      const slope = (b.x - a.x) / (b.y - a.y);
      for (const y of [-2 * Math.abs(a.y) - ES_UNIT_PX, 2 * Math.abs(b.y) + ES_UNIT_PX]) xs.push(a.x + slope * (y - a.y));
    }
  }
  const clearance = ES_EDGE_CLEARANCE_PX;
  if (xs.every((x) => Math.abs(x) >= clearance)) return pts;
  const shift = -clearance - Math.max(...xs.filter((x) => Math.abs(x) < clearance));
  return pts.map((p) => ({ x: p.x + shift, y: p.y }));
}

// The profile moved `distance` inward (toward the strand body) along its own
// normals, with mitred vertices: the inner edge of the side line.
function esOffsetProfile(prof, distance) {
  if (distance <= 0 || prof.length < 2) return prof.slice();
  const normals = [];
  for (let i = 0; i < prof.length - 1; i++) {
    const vx = prof[i + 1].x - prof[i].x, vy = prof[i + 1].y - prof[i].y;
    const len = Math.hypot(vx, vy);
    // Walking the profile from y=-half to y=+half, the body is on the left.
    normals.push(len > 1e-9 ? { x: -vy / len, y: vx / len } : null);
  }
  const result = [];
  for (let i = 0; i < prof.length; i++) {
    const p = prof[i];
    const n1 = i > 0 ? normals[i - 1] : null, n2 = i < normals.length ? normals[i] : null;
    if (!n1 && !n2) { result.push({ x: p.x, y: p.y }); continue; }
    let n, factor;
    if (!n1 || !n2) { n = n2 || n1; factor = 1; } else {
      const sx = n1.x + n2.x, sy = n1.y + n2.y, len = Math.hypot(sx, sy);
      if (len < 1e-9) { n = n1; factor = 1; } else {
        n = { x: sx / len, y: sy / len };
        factor = 1 / Math.max(0.25, n.x * n1.x + n.y * n1.y);
      }
    }
    result.push({ x: p.x + n.x * distance * factor, y: p.y + n.y * distance * factor });
  }
  return result;
}

// Absolute constants OSS writes in canvas units, as pixels for the current
// render (set by esGeometry before any end is built).
let ES_UNIT_PX = 1;

// The local-frame pieces of one styled end, mapped to pixel coordinates.
function esStyledEnd(s, side, style, lineVisible, point, angle, S) {
  const swPx = (s.stroke_width || 0) * S;
  const total = ((s.width || 0) + 2 * (s.stroke_width || 0)) * S;
  const half = total / 2;
  const lineWidth = (style.line_width == null ? (s.stroke_width || 0) : style.line_width) * S;
  const bandWidth = lineVisible ? lineWidth : 0;
  const baseX = bandWidth + style.offset * S;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const map = (p) => new paper.Point(point.x + p.x * cos - p.y * sin, point.y + p.x * sin + p.y * cos);
  const poly = (pts) => new paper.Path({ segments: pts.map(map), closed: true });

  const profile = esClearOfEndpointPlane(esProfilePoints(style.shape, half, style.depth, style.tilt, baseX));
  const innerProfile = bandWidth > 0 ? esClearOfEndpointPlane(esOffsetProfile(profile, bandWidth)) : profile;
  let maxX = -Infinity, minX = Infinity;
  for (const p of profile) { if (p.x > maxX) maxX = p.x; if (p.x < minX) minX = p.x; }
  const cutPlane = ES_CUT_PLANE * S;
  return {
    side, style, half, total, strokeWidth: swPx, bandWidth, point, angle, cos, sin, map,
    // How far the edge's farthest point sits beyond where the classic end
    // (endpoint plane + side line) would put it, in px: decorations anchored on
    // the endpoint (dash extension, small arrow) are shifted by this.
    extentShift: maxX - bandWidth,
    // Polygons removed from the classic body (outward of the profile, behind
    // the endpoint plane) for a body stroked `margin` wider.
    behindCuts: (margin = 0) => esBehindPolygons(profile, half, 1.5 * half + margin, cutPlane).map(poly),
    // The same for the fill, along the side line's inner edge.
    behindFillCuts: () => esBehindPolygons(bandWidth > 0 ? innerProfile : profile, half, 1.5 * half, cutPlane).map(poly),
    // Polygons added ahead of the endpoint plane to the stroke body of
    // half-width `half + margin`.
    aheadPieces: (margin = 0) => esAheadPolygons(profile, half, half + margin, -ES_UNIT_PX).map(poly),
    // Polygons added ahead of the endpoint plane to the fill body.
    aheadFillPieces: () => esAheadPolygons(bandWidth > 0 ? innerProfile : profile, half, half - swPx, -ES_UNIT_PX).map(poly),
    // The side-line band: the strip between the side line's inner edge and the
    // profile, across exactly the strand's width. A plain polygon, not clipped
    // to the body: callers paint it clipped to the (uncut) body.
    band: () => (bandWidth <= 0 ? null : poly(esBandRegion(profile, innerProfile, half, half + ES_EDGE_CLEARANCE_PX))),
    // Local rectangle around the cap, mapped to pixel coords.
    zone: (margin = 0) => {
      const xMin = Math.min(minX, -ES_UNIT_PX) - 2 * margin - 2 * ES_UNIT_PX;
      const xMax = maxX + half + margin + 12 * ES_UNIT_PX;
      const y = 1.5 * half + margin;
      return poly([{ x: xMin, y: -y }, { x: xMax, y: -y }, { x: xMax, y }, { x: xMin, y }]);
    },
  };
}

// Boolean helpers on paper items. Each consumes its operands.
function esSubtractAll(base, cuts) {
  let out = base;
  for (const cut of cuts) {
    if (!out) { cut.remove(); continue; }
    const r = out.subtract(cut);
    out.remove(); cut.remove();
    out = r;
  }
  return out;
}
function esUniteAll(base, pieces) {
  let out = base;
  for (const piece of pieces) {
    if (!out) { out = piece; continue; }
    const r = out.unite(piece);
    out.remove(); piece.remove();
    out = r;
  }
  return out;
}

// Outer footprint / inner fill / side-line bands of a strand whose free end(s)
// carry a style (end_style.EndStyleGeometry), or null when no end is styled.
// Owns nothing that outlives the render: every path it hands out is fresh and
// the caller removes it, like every other builder here.
// Per-render memo of the descriptor below, keyed by layer name: the highlight,
// the body, both extension rays, both small arrows and every footprint width
// ask for the same strand's ends in one frame. It holds plain numbers and
// closures (no paper items), so it is cleared with the geometry memo rather
// than held in it. The centerline is rebuilt only for the ends' frames, which
// depend on nothing but the strand and the render-wide constants.
let ES_CACHE = null;
function esCacheBegin() { ES_CACHE = new Map(); }
function esCacheEnd() { ES_CACHE = null; }

function esGeometry(s, P, enableThird, S, centerline) {
  if (!esHasStyledEnd(s)) return null;
  const live = ES_CACHE !== null && geomCacheLive();
  if (live && ES_CACHE.has(s.layer_name)) return ES_CACHE.get(s.layer_name);
  const g = esBuildGeometry(s, P, enableThird, S, centerline);
  if (live) ES_CACHE.set(s.layer_name, g);
  return g;
}

function esBuildGeometry(s, P, enableThird, S, centerline) {
  const cl = centerline || buildCenterline(s, P, enableThird);
  const len = cl.length;
  ES_UNIT_PX = S;
  ES_EDGE_CLEARANCE_PX = ES_EDGE_CLEARANCE * S;
  const ends = {};
  for (const side of [0, 1]) {
    const style = esActiveStyle(s, side);
    if (!style) continue;
    const visible = side === 0 ? s.start_line_visible !== false : s.end_line_visible !== false;
    // end_frame: the endpoint and the OUTWARD tangent angle (the start tangent
    // points into the body, so it is flipped).
    const point = P(side === 0 ? s.start : s.end);
    const angle = side === 0 ? tangentAngle(cl, 0) + Math.PI : tangentAngle(cl, len);
    ends[side] = esStyledEnd(s, side, style, visible, point, angle, S);
  }
  if (!centerline) cl.remove();
  const width = (s.width || 0) * S;
  const total = ((s.width || 0) + 2 * (s.stroke_width || 0)) * S;
  const list = Object.values(ends);
  const each = (fn) => list.flatMap(fn);
  // Body builders go through the per-render memos (bodyOutline / bodyBand),
  // never the caller's centerline: the descriptor outlives this call.
  const classicClean = (w) => bodyOutline(s, P, enableThird, w);
  const classicRaw = (w) => bodyBand(s, P, enableThird, w);

  const geometry = {
    ends,
    // (classic − cuts) ∪ pieces, for the path consumers. The classic body is the
    // CLEANED outline (paper's boolean ops need a simple input; Qt's clipper
    // takes the raw WindingFill stroker output).
    outer: (margin = 0) => {
      const base = classicClean(total + 2 * margin);
      if (!base) return null;
      let out = esSubtractAll(base, each((e) => e.behindCuts(margin)));
      out = esUniteAll(out, each((e) => e.aheadPieces(margin)));
      if (out) out.fillRule = 'nonzero';
      return out;
    },
    inner: () => {
      const base = classicClean(width);
      if (!base) return null;
      let out = esSubtractAll(base, each((e) => e.behindFillCuts()));
      out = esUniteAll(out, each((e) => e.aheadFillPieces()));
      if (out) out.fillRule = 'nonzero';
      return out;
    },
    // The outer footprint pushed outward by `margin` (shadow and mask helpers).
    // Unstyled ends keep the classic flat cap (the body is simply stroked
    // wider, exactly like the classic shadow and mask helpers); styled ends get
    // the exact offset of their profile.
    dilated: (margin) => {
      if (margin <= 0) return geometry.outer();
      let result = geometry.outer(margin);
      const outer = geometry.outer();
      if (!result || !outer) { outer && outer.remove(); return result; }
      for (const e of list) {
        const z = e.zone(margin);
        const piece = outer.intersect(z);
        z.remove();
        if (piece && piece.area && Math.abs(piece.area) > 0.5) {
          // A hair wider than the body stroke so the union never sees two
          // coincident long edges.
          const ring = strokedRegionOutline(piece, 2 * (margin + 0.3 * S));
          let grown = piece;
          if (ring) { grown = piece.unite(ring); piece.remove(); ring.remove(); }
          const u = result.unite(grown);
          result.remove(); grown.remove();
          result = u;
        } else {
          piece && piece.remove();
        }
      }
      outer.remove();
      if (result) result.fillRule = 'nonzero';
      return result;
    },
    // PAINT bodies: the raw stroker band plus the cap pieces, as one
    // WindingFill path each (no boolean ops — see windingFillLayer), to be
    // painted under the matching keep-clip.
    bodyPieces: (extra) => {
      const band = classicRaw(total);
      return band ? [band].concat(each((e) => e.aheadPieces()), extra || []) : null;
    },
    fillPieces: (extra) => {
      const band = classicRaw(width);
      return band ? [band].concat(each((e) => e.aheadFillPieces()), extra || []) : null;
    },
    // Winding-filled clip: a big rectangle (+1) minus the cut polygons
    // (oriented against the rectangle). Clip paths honour fill rules, so this
    // is exact where a boolean subtraction of the raw band is not.
    keepClip: (bounds, cuts) => {
      const pad = 6 * total + 20 * S;
      const rect = new paper.Path.Rectangle(bounds.expand(2 * pad));
      rect.clockwise = true;
      for (const cut of cuts) cut.clockwise = false;
      return new paper.CompoundPath({ children: [rect].concat(cuts), fillRule: 'nonzero' });
    },
    keepOuterClip: (bounds) => geometry.keepClip(bounds, each((e) => e.behindCuts())),
    keepInnerClip: (bounds) => geometry.keepClip(bounds, each((e) => e.behindFillCuts())),
    band: (side) => (ends[side] ? ends[side].band() : null),
    extentShift: (side) => (ends[side] ? ends[side].extentShift : 0),
    isStyled: (side) => !!ends[side],
  };
  return geometry;
}

// The strand's rendered footprint at world width `widthW`, the way every
// shadow and mask helper asks for it: the classic cleaned outline when no end
// is styled, else the styled footprint that width maps to — the fill area for
// the strand's own width, the outer footprint for width + 2*stroke, and the
// outer footprint pushed outward by half the excess for anything wider
// (masked_strand.py _styled_footprint's inner / margin arguments). Memoized per
// render like bodyOutline. Returns an owned path or null.
function strandFootprintAtWidth(s, P, enableThird, S, widthW) {
  if (!esHasStyledEnd(s)) return bodyOutline(s, P, enableThird, widthW * S);
  return cachedGeom(`esfoot|${s.layer_name}|${widthW}`, () => {
    const g = esGeometry(s, P, enableThird, S);
    if (!g) return bodyOutline(s, P, enableThird, widthW * S);
    const w = s.width || 0, total = w + 2 * (s.stroke_width || 0);
    if (Math.abs(widthW - w) < 1e-6) return g.inner();
    if (widthW <= total + 1e-6) return g.outer();
    return g.dilated(((widthW - total) / 2) * S);
  });
}

// Endpoint shifted to the styled edge's farthest point along the outward
// tangent, in WORLD units: the anchor for the dash extension and the small
// arrow, so they never sit on top of an extended cap or float away from a
// trimmed one (strand.py _end_anchor). Unstyled ends return the endpoint.
function esEndAnchor(s, side, worldPt, outwardAngle, P, enableThird, S, centerline) {
  const g = esGeometry(s, P, enableThird, S, centerline);
  if (!g) return worldPt;
  const shift = g.extentShift(side) / S;
  if (Math.abs(shift) < 1e-9) return worldPt;
  return { x: worldPt.x + Math.cos(outwardAngle) * shift, y: worldPt.y + Math.sin(outwardAngle) * shift };
}

// A box covering the last `distance` px of an UNSTYLED end (plus the room
// outside it), bounded by the end's perpendicular plane so a body that curls
// back past the endpoint is left alone (strand.py _end_slab). Pixel space.
function esEndSlab(s, side, point, outwardAngle, distancePx, S) {
  const full = ((s.width || 0) + 2 * (s.stroke_width || 0)) * S;
  const half = full / 2 + 12 * S;
  const depth = distancePx + full;
  const ox = Math.cos(outwardAngle), oy = Math.sin(outwardAngle);
  const px = -oy, py = ox;
  const near = { x: point.x - ox * distancePx, y: point.y - oy * distancePx };
  return new paper.Path({
    segments: [
      new paper.Point(near.x + px * half, near.y + py * half),
      new paper.Point(near.x - px * half, near.y - py * half),
      new paper.Point(near.x - px * half + ox * depth, near.y - py * half + oy * depth),
      new paper.Point(near.x + px * half + ox * depth, near.y + py * half + oy * depth),
    ],
    closed: true,
  });
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
  const pieces = buildShadowReceiverPieces(s, strands, P, enableThird, S);
  if (!pieces) return null;
  let path = pieces[0];
  for (let k = 1; k < pieces.length; k++) {
    const u = path.unite(pieces[k]);
    path.remove();
    pieces[k].remove();
    path = u;
  }
  return path;
}

// The same geometry as separate subpaths, the way build_rendered_geometry hands
// it to Qt: the body outline, then each visible end circle added with addPath
// (not united). Only matters where Qt evaluates them EVEN-ODD (the Pass B clip
// after a subtraction, see castStrandShadow); everywhere else they are united.
function buildShadowReceiverPieces(s, strands, P, enableThird, S) {
  const w = s.width || 0, sw = s.stroke_width || 0;
  const td = (w + 2 * sw) * S;          // full diameter (px) for the body + cap circles
  const cl = buildCenterline(s, P, enableThird);
  // A stylized free end replaces the flat cap with its own footprint
  // (shader_utils.py build_rendered_geometry, 1.111).
  const body = esHasStyledEnd(s)
    ? strandFootprintAtWidth(s, P, enableThird, S, w + 2 * sw)
    : bodyOutline(s, P, enableThird, td, cl);
  if (!body) { cl.remove(); return null; }
  const pieces = [body];
  const hc = s.has_circles || [false, false];
  const startA = circleStrokeAlpha(effStartStroke(s));
  const endA = circleStrokeAlpha(effEndStroke(s));
  const len = cl.length;
  const isAttached = s.type === 'AttachedStrand';
  const addCircle = (centre, angle, which) => {
    pieces.push(isAttached
      ? (which === 0 ? capOuterStart(centre, angle, td) : capOuterEnd(centre, angle, td))
      : new paper.Path.Circle(centre, td / 2));
  };
  // Only where a strand is actually attached at that end (shader_utils.py
  // _build_rendered_geometry: `has_attachment`); an attached strand's own start
  // circle is not part of it unless another strand starts there too.
  if (hc[0] && startA > 0 && hasAttachedChildAt(s.start, strands, s)) addCircle(P(s.start), tangentAngle(cl, 0), 0);
  if (hc[1] && endA > 0 && hasAttachedChildAt(s.end, strands, s)) addCircle(P(s.end), tangentAngle(cl, len), 1);
  cl.remove();
  return pieces;
}

// Does Qt hand back get_mask_path() (masked_strand.py:246) as an ODD-EVEN path?
// It is component outline ∩ component outline. QPathClipper resolves that into
// a fresh OddEvenFill path, unless one outline is an axis-aligned rectangle (a
// straight, horizontal or vertical component with nothing united onto it): then
// it clips the other outline by the rectangle and keeps THAT outline's rule,
// winding for a plain stroker outline, even-odd once a start circle was united
// in. A deletion rectangle that reaches it resolves it again (even-odd).
function qtMaskPathOddEven(ms, byLayer, P, enableThird, S) {
  const parts = (ms.layer_name || '').split('_');
  const first = byLayer[parts[0] + '_' + parts[1]], second = byLayer[parts[2] + '_' + parts[3]];
  if (!first || !second) return true;
  const circled = (t) => t.type === 'AttachedStrand' && (t.has_circles || [])[0] && circleStrokeAlpha(effStartStroke(t)) > 0;
  const isRect = (t) => !circled(t) && !esHasStyledEnd(t) && buildProfile(t, enableThird).mode === 'line'
    && (t.start.x === t.end.x || t.start.y === t.end.y);
  const r1 = isRect(first), r2 = isRect(second);
  let oddEven = !(r1 || r2) || (r1 && !r2 && circled(second)) || (r2 && !r1 && circled(first));
  if (!oddEven && (ms.deletion_rectangles || []).length) {
    const region = buildMaskPath(ms, byLayer, P, enableThird, S);
    if (region) {
      for (const rect of ms.deletion_rectangles) {
        const rp = deletionPath(rect, P, S);
        if (rp && rp.bounds.intersects(region.bounds)) oddEven = true;
        rp && rp.remove();
      }
      region.remove();
    }
  }
  return oddEven;
}

// build_shadow_geometry(strand, 0, include_circles=False): the caster CORE =
// body stroked at (w+2sw) with NO blur inflation, no circles. Returns a paper
// path (caller removes it) or null.
function buildShadowCasterCore(s, P, enableThird, S) {
  const w = s.width || 0, sw = s.stroke_width || 0;
  // Stylized free ends: the styled footprint, so the cast shadow follows the
  // end's profile (shader_utils.py build_shadow_geometry, 1.111).
  return strandFootprintAtWidth(s, P, enableThird, S, w + 2 * sw);
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
function buildShadowCasterCircles(s, P, S) {
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

// The pre-2.0 per-pair shadow region, kept ONLY as auto_shadow.py's legacy
// measure (_surviving_shadow, 407728c): caster ∩ receiver rendered geometry,
// then IN ORDER the subtracted layers, the shadow blockers of the visible masks
// above the caster, the blockers of the visible masks the receiver is a
// component of (_subtract_visible_component_mask_coverage), and the strands in
// between. AUTO_HIDE_SURVIVAL_RATIO was tuned on it, so the pairs auto_shadow
// hides stay the same; the renderer itself no longer cuts mask blockers (see the
// 2.0 pipeline: pairShadow / collectShadow).
// Returns {region, recv, clipBlocker} — any may be null; the CALLER removes all
// three paths. `rejectBounds` (optional) short-circuits far-away receivers.
function legacySurvivingRegion(s, i, o, j, strands, byLayer, P, enableThird, S, casterFootprint, ov, allowFull, rejectBounds) {
  // A mask receiver uses its crossing FILL region (get_proper_masked_strand_path
  // = get_mask_path); a regular/attached receiver uses its rendered body+circles.
  // Memoized per render: the same receiver is visited once per caster above it,
  // and its geometry is identical every time (see the geometry memo above).
  const recvKey = 'recv|' + o.layer_name;
  const recvBuild = () => (o.type === 'MaskedStrand'
    ? buildMaskPath(o, byLayer, P, enableThird, S)
    : buildShadowReceiverGeom(o, strands, P, enableThird, S));
  // Bounding-box reject BEFORE the clone. The original built the full receiver
  // path and then threw it away when the bounds missed; with the memo the bounds
  // are already known, so a far-apart pair costs nothing at all.
  const recvBounds = cachedGeomBounds(recvKey, recvBuild);
  if (recvBounds !== undefined) {
    if (!recvBounds) return { region: null, recv: null, clipBlocker: null };
    if (rejectBounds && !rejectBounds.intersects(recvBounds)) {
      return { region: null, recv: null, clipBlocker: null };
    }
  }
  const recv = cachedGeom(recvKey, recvBuild);
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
    // An override that carries the key wins even when its list is empty (Qt
    // get_subtracted_layers: `'subtracted_layers' in override_data`), so a user
    // who cleared the mask->second-component default keeps it cleared.
    const subNames = ov && 'subtracted_layers' in ov
      ? (ov.subtracted_layers || [])
      : defaultSubtracted(s, o, byLayer);
    const subAcc = { path: null };
    region = subtractLayers(region, subNames, byLayer, strands, P, enableThird, S, subAcc);
    clipBlocker = subAcc.path; // fed into the Pass B clip (shader_utils.py:985-987)

    // (b) mask-blocking (gated !allowFull): subtract every VISIBLE mask whose
    //     layer rank is strictly ABOVE the caster (k > i) and that is not the
    //     receiver itself.
    if (!allowFull && region && Math.abs(region.area || 0) > 0.5) {
      for (let k = i + 1; k < strands.length; k++) {
        const m = strands[k];
        if (m.type !== 'MaskedStrand' || m.is_hidden === true) continue;
        if (m.layer_name === o.layer_name) continue; // self-block guard
        // The blocker (and its complement) is memoized per mask: it is the same
        // for every pair it blocks and one of the most expensive builds here.
        region = subtractBlocker(region, m, byLayer, P, enableThird, S);
        if (!region || Math.abs(region.area || 0) <= 0.5) break;
      }
    }

    // (b2) visible-component mask coverage (gated !allowFull), Qt
    //     _subtract_visible_component_mask_coverage (shader_utils.py:119): when
    //     the RECEIVER is a component of a visible mask layered above it, that
    //     mask's blocker is cut out of the shadow, whatever the mask's rank
    //     relative to the caster (so a strand above the mask still leaves the
    //     crossing and its blur ring clear on the component underneath).
    if (!allowFull && region && Math.abs(region.area || 0) > 0.5) {
      for (let k = j + 1; k < strands.length; k++) {
        const m = strands[k];
        if (m.type !== 'MaskedStrand' || m.is_hidden === true) continue;
        const mp = (m.layer_name || '').split('_');
        if (mp.length < 4) continue;
        if (o.layer_name !== mp[0] + '_' + mp[1] && o.layer_name !== mp[2] + '_' + mp[3]) continue;
        region = subtractBlocker(region, m, byLayer, P, enableThird, S);
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

// The full arrow's own casting footprint (strand.py get_arrow_shadow_path,
// :1110-1155): the whole centerline stroked at arrow_line_width, plus the head
// triangle whose BASE sits on the endpoint and whose tip extends outward along
// the tangent. Returns null unless the arrow is visible AND opted into casting.
// Gated on arrow_casts_shadow, which every OSS drawing path defaults to false, so
// a fixture that never sets it produces exactly the previous footprint.
function buildArrowShadowPath(s, P, enableThird, S) {
  if (s.full_arrow_visible !== true || s.arrow_casts_shadow !== true) return null;
  const cl = buildCenterline(s, P, enableThird);
  const len = cl.length;
  if (len <= 0) { cl.remove(); return null; }
  let out = strokedOutline(cl, ARROW_PARAMS.line_width * S);
  if (out) {
    const cleaned = out.resolveCrossings();
    if (cleaned !== out) { out.remove(); out = cleaned; }
  }
  if (s.arrow_head_visible !== false) {
    const a = tangentAngle(cl, len);
    const ux = Math.cos(a), uy = Math.sin(a);
    const px = -uy, py = ux;
    const hw = (ARROW_PARAMS.head_width * S) / 2, hl = ARROW_PARAMS.head_length * S;
    const e = P(s.end);
    const head = new paper.Path([
      new paper.Point(e.x + ux * hl, e.y + uy * hl),   // tip
      new paper.Point(e.x + px * hw, e.y + py * hw),   // base left
      new paper.Point(e.x - px * hw, e.y - py * hw),   // base right
    ]);
    head.closed = true;
    if (out) {
      const u = out.unite(head);
      out.remove(); head.remove();
      out = u;
    } else {
      out = head;
    }
  }
  cl.remove();
  return out;
}

// OSS's Shadow Path preview (strand_drawing_canvas.py, "Draw visible shadow
// path(s)"; shader_utils.shadow_preview, 407728c): for each pair the shadow
// editor has toggled on, the area the canvas shades — the pair's filled area and
// its soft edge as far as it reaches — in translucent blue, with the outline of
// the whole area, clipped like the shadow itself (the receiver's clip, the
// "subtracted layers", and the pieces of masks drawn over it later). It comes
// from the very code the canvas draws with (pairShadow / collectShadow), so the
// preview cannot disagree with the shadow. A mask's row previews the shadow the
// mask paints on its second strand (its first strand's lift shadow). Drawn last,
// over the finished image, and never persisted.
function shadowPreview(castName, recvName) {
  const sCast = FC.byLayer[castName], oRecv = FC.byLayer[recvName];
  if (!sCast || !oRecv || !SHADOW_ENABLED) return null;
  const ci = rankOf(castName), ri = rankOf(recvName);
  if (ci < 0 || ri < 0) return null;
  let clips, fill, col, liftedLayer;
  if (isMask(sCast)) {
    const parts = maskParts(sCast);
    if (!parts || parts.second.layer_name !== recvName || sCast.is_hidden === true
        || !intersectionShadowVisible(sCast)) return null;
    col = collectShadow(parts.first);
    if (!col || !col.lifts.length) return null;
    const clip = maskLiftClip(sCast);
    if (!clip) return null;
    clips = [clip];
    fill = unionOf(col.lifts);
    liftedLayer = parts.first.layer_name;
  } else {
    if (sCast.is_hidden === true && !(sCast.full_arrow_visible === true && sCast.arrow_casts_shadow === true)) return null;
    if (sCast.hide_shadow === true || ri >= ci) return null;
    col = collectShadow(sCast);
    if (!col) return null;
    const cs = casterShadowPath(sCast);
    const near = masksNear(sCast);
    const b = boundsOf(sCast);
    const pair = pairShadow(sCast, oRecv, {
      shadowPath: cs.shadowPath, joints: cs.joints, circles: cs.circles, footprint: cs.footprint, near,
      lifted: liftedNear(sCast, near), lowered: loweredNear(sCast, near),
      reach: b ? b.expand(2 * ((sCast.width || 0) + 2 * (sCast.stroke_width || 0) + MAX_BLUR) * FC.S) : null,
    });
    if (!pair || pair.lift || pEmpty(pair.clip)) return null;
    clips = [pair.clip];
    if (!pEmpty(pair.clipBlocker)) clips.push(outsidePath(pair.clipBlocker, pair.clip.bounds));
    fill = pair.fill || pair.outline;
    liftedLayer = castName;
  }
  const rect = clips[0].bounds;
  // _outside_covering_pieces: the pieces of the masks drawn after the caster.
  for (const m of FC.strands.slice(ci + 1)) {
    if (!isMask(m) || m.is_hidden === true) continue;
    const parts = maskParts(m);
    if (parts && parts.first.layer_name === liftedLayer) continue;
    const piece = piecePath(m);
    if (!pEmpty(piece) && piece.bounds.intersects(rect)) clips.push(outsidePath(piece, rect));
  }
  // The area: the fill plus the soft edge's reach (the stroke source stroked at
  // the blur width, round joins) — every outline's band of half the blur.
  const sources = col.outlines.map((x) => x.path).concat(col.lifts, col.circles ? [col.circles] : [])
    .filter((p) => !pEmpty(p) && p.bounds.expand(2 * (MAX_BLUR / 2 + 2) * FC.S).intersects(rect));
  const half = (MAX_BLUR / 2) * FC.S;
  const sets = [pathRings(fill)];
  for (const src of sources) {
    const rings = pathRings(src);
    sets.push(rings, rings.map((r) => offsetRing(r, half)), rings.map((r) => offsetRing(r, -half)));
  }
  const area = cyclesToPath(ringRegion(sets, (w) => {
    if (w[0] > 0) return true;
    for (let k = 1; k + 2 < w.length; k += 3) {
      const inside = w[k] > 0;
      if ((inside || w[k + 1] > 0) && !(inside && w[k + 2] > 0)) return true;
    }
    return false;
  }));
  return area ? { area, clips } : null;
}
// _outside: a clip for the part of `rect` (grown by 2) outside `path`.
function outsidePath(path, rect) {
  const box = new paper.Path.Rectangle({ rectangle: rect.expand(4 * FC.S), insert: false });
  const kids = path.children && path.children.length ? path.children.map((k) => k.clone({ insert: false })) : [path.clone({ insert: false })];
  return new paper.CompoundPath({ children: [box, ...kids], fillRule: 'evenodd', insert: false });
}
function drawVisibleShadowPaths(strands, byLayer, P, enableThird, S) {
  if (!VISIBLE_SHADOW_PATHS.length || !FC) return;
  const seen = new Set();
  for (const pair of VISIBLE_SHADOW_PATHS) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const key = pair[0] + '|' + pair[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const pv = shadowPreview(pair[0], pair[1]);
    if (!pv) continue;
    const fillItem = pv.area.clone({ insert: false });
    fillItem.fillColor = new paper.Color(0, 120 / 255, 1, 100 / 255);
    fillItem.strokeColor = null;
    // The outline of the whole area, not of each overlapping part. Scaled by S
    // like every other stroke, so the 2px Qt pen stays 2px on screen.
    const outline = pv.area.clone({ insert: false });
    outline.fillColor = null;
    outline.strokeColor = new paper.Color(0, 120 / 255, 1, 200 / 255);
    outline.strokeWidth = 2 * S;
    paintClipped([fillItem, outline], pv.clips, null);
  }
}

// The edges Qt's Pass B strokes (every survivor outline plus the caster's circle
// outlines) cover exactly the points within half a pen width of ANY of them,
// round joins making every corner a disk. Handing paper those outlines as-is
// puts each edge two survivors share into the path twice, and coincident edges
// anti-alias unstably (their coverage conflates and shifts with sub-pixel
// position). So this draws the same covered area with each edge once: the
// union's outline, plus the pieces' edges that lie strictly inside the union, as
// open runs (their round caps stand in for Qt's round joins where the piece's
// outline turns onto the union outline). Returns a CompoundPath (caller removes).
function passBOutline(pieces, circles, combined) {
  const kidsOf = (it) => (it.children && it.children.length ? it.children : [it]);
  let union = combined.clone();
  if (circles) { const u = union.unite(circles); union.remove(); union = u; }
  const out = new paper.CompoundPath({ children: [] });
  for (const k of kidsOf(union)) out.addChild(k.clone({ insert: false }));
  const EPS = 0.05;
  const seen = new Set();
  const key = (p) => Math.round(p.x * 1e4) + ',' + Math.round(p.y * 1e4);
  for (const piece of [...pieces, ...(circles ? [circles] : [])]) {
    for (const kid of kidsOf(piece)) {
      let src = kid;
      if (kid.hasHandles()) { src = kid.clone({ insert: false }); src.flatten(0.05); }
      const pts = src.segments.map((sg) => sg.point);
      const n = pts.length;
      const inner = pts.map((a, i) => {
        const b = pts[(i + 1) % n];
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
        if (l < 1e-9) return false;
        const k1 = key(a), k2 = key(b);
        const k = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        if (seen.has(k)) return false;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, nx = -dy / l * EPS, ny = dx / l * EPS;
        const ok = union.contains(new paper.Point(mx + nx, my + ny)) && union.contains(new paper.Point(mx - nx, my - ny));
        if (ok) seen.add(k);
        return ok;
      });
      if (inner.every(Boolean)) {
        out.addChild(new paper.Path({ segments: pts.map((q) => q.clone()), closed: true, insert: false }));
      } else {
        // Walk the ring from an edge on the union outline so a run never wraps.
        const start = inner.findIndex((v) => !v);
        let run = null;
        for (let t = 1; t <= n; t++) {
          const i = (start + t) % n;
          if (inner[i]) {
            if (!run) run = [pts[i].clone()];
            run.push(pts[(i + 1) % n].clone());
          } else if (run) {
            out.addChild(new paper.Path({ segments: run, closed: false, insert: false }));
            run = null;
          }
        }
        if (run) out.addChild(new paper.Path({ segments: run, closed: false, insert: false }));
      }
      if (src !== kid) src.remove();
    }
  }
  union.remove();
  return out;
}

// ============================================================================
// OSS 2.0 shadow pipeline (shader_utils.py at 3e1b02f). One paint of the canvas
// works out, per caster, every shadow it casts (draw_strand_shadow /
// _pair_shadow), keeps the result for the masks drawn later in the same paint
// (the painter's _frame_cache), and a mask casts nothing of its own: it paints
// its first strand's shadow on its second strand again on top
// (draw_mask_lift_shadow), its piece, and the shadows the piece covers
// (draw_mask_restored_shadows). Near a mask the strands are restacked as at a
// genuine crossing (_mask_sides). Unfolded joints whose cap must lie under the
// strands crossing the joint are drawn by the parent (lowered_start_cap).
//
// Geometry is PIXEL space (world * S). Every helper below returns a DETACHED
// paper item that the caller owns (boolean ops on detached operands stay
// detached), so nothing is painted unless it is added to the layer on purpose.
// ============================================================================

// The frame cache (shader_utils._frame_cache): built at the start of a paint,
// dropped at its end. Holds the strands in layer order and the memoised geometry.
let FC = null;

function fcBegin(strands, byLayer, P, enableThird, S) {
  const rank = new Map();
  strands.forEach((s, k) => rank.set(s.layer_name, k));
  FC = { strands, byLayer, P, enableThird, S, rank, memo: new Map(), highlights: [] };
  return FC;
}
function fcEnd() { FC = null; }

const det = (it) => { if (it) it.remove(); return it; };
const dclone = (it) => (it ? it.clone({ insert: false }) : null);
const pArea = (p) => (p ? Math.abs(p.area || 0) : 0);
// QPainterPath.isEmpty() after a boolean op: no area left.
const pEmpty = (p) => !p || pArea(p) <= 1e-6;
// World-unit area thresholds (OSS compares path areas in canvas units).
const wArea = (a) => a * FC.S * FC.S;
function fcMemo(key, build) {
  if (FC.memo.has(key)) return FC.memo.get(key);
  const v = build();
  FC.memo.set(key, v);
  return v;
}
// A memoised path, handed out as a fresh detached clone.
function fcPath(key, build) {
  const m = fcMemo(key, () => { const p = build(); return p ? det(p) : null; });
  return dclone(m);
}
const pInter = (a, b) => (a && b ? det(a.intersect(b, { insert: false })) : null);
const pSub = (a, b) => (a ? (b ? det(a.subtract(b, { insert: false })) : dclone(a)) : null);
const pUnite = (a, b) => (a ? (b ? det(a.unite(b, { insert: false })) : dclone(a)) : dclone(b));
// QPainterPath.intersects(path): the fills overlap or the outlines cross.
function pIntersects(a, b) {
  if (!a || !b || !a.bounds.intersects(b.bounds)) return false;
  const i = pInter(a, b);
  if (!pEmpty(i)) return true;
  return a.getIntersections(b).length > 0;
}
function circlePath(c, r) { return new paper.Path.Circle({ center: c, radius: r, insert: false }); }

const isMask = (t) => t && t.type === 'MaskedStrand';
const rankOf = (name) => (FC.rank.has(name) ? FC.rank.get(name) : -1);
function maskParts(m) {
  const p = (m.layer_name || '').split('_');
  if (p.length < 4) return null;
  const first = FC.byLayer[p[0] + '_' + p[1]], second = FC.byLayer[p[2] + '_' + p[3]];
  return first && second ? { first, second } : null;
}
function maskOf(name) {
  // byLayer of the mask layers whose components are (first, second), visible ones.
  return fcMemo('masksByPair', () => {
    const m = new Map();
    for (const t of FC.strands) {
      if (!isMask(t) || t.is_hidden === true) continue;
      const parts = maskParts(t);
      if (!parts) continue;
      const key = parts.first.layer_name + '|' + parts.second.layer_name;
      if (!m.has(key)) m.set(key, t);
    }
    return m;
  }).get(name);
}
function overrideOf(c, r) { return (SHADOW_OVERRIDES[c] || {})[r] || null; }
// layer_state_manager.get_shadow_visibility (with get_default_shadow_visibility).
function shadowVisible(c, r) {
  const ov = overrideOf(c, r);
  if (ov && 'visibility' in ov) return !!ov.visibility;
  const cs = FC.byLayer[c];
  if (isMask(cs)) { const parts = maskParts(cs); if (parts && parts.first.layer_name === r) return false; }
  return true;
}
// layer_state_manager.get_subtracted_layers (with its masked-caster default).
function subtractedLayersOf(c, r) {
  const ov = overrideOf(c, r);
  if (ov && 'subtracted_layers' in ov) return ov.subtracted_layers || [];
  const cs = FC.byLayer[c];
  if (isMask(cs)) {
    const parts = maskParts(cs);
    if (parts && parts.second.layer_name === r) return [parts.first.layer_name];
  }
  return [];
}
// MaskedStrand._intersection_shadow_visible: the (mask -> second) row.
function intersectionShadowVisible(m) {
  const parts = maskParts(m);
  return !parts || shadowVisible(m.layer_name, parts.second.layer_name);
}
// _shadow_shown_for: the strand's draw paints its shadow pass.
function shadowShownFor(t) { return SHADOW_ENABLED && t.hide_shadow !== true; }
// _ends_at: a visible strand (not a mask) with an end on `pt` (world).
function endsAt(t, pt) {
  if (!t || isMask(t) || t.is_hidden === true) return false;
  for (const e of [t.start, t.end]) if (e && Math.abs(e.x - pt.x) < 0.5 && Math.abs(e.y - pt.y) < 0.5) return true;
  return false;
}
// _joined: `item` continues one of `strands` at a joint.
function joinedTo(item, strands) {
  for (const s of strands) for (const pt of [s.start, s.end]) if (pt && endsAt(item, pt)) return true;
  return false;
}

// ---- geometry -----------------------------------------------------------------
// _build_rendered_geometry (body + visible circles; a mask's get_mask_path).
function geomRaw(t) {
  return fcPath('raw|' + t.layer_name, () => det(isMask(t)
    ? buildMaskPath(t, FC.byLayer, FC.P, FC.enableThird, FC.S)
    : buildShadowReceiverGeom(t, FC.strands, FC.P, FC.enableThird, FC.S)));
}
// build_rendered_geometry: plus the lowered start caps the strand paints.
function geomRendered(t) {
  if (isMask(t)) return geomRaw(t);
  const lowered = loweredCapsOf(t);
  if (!lowered.length) return geomRaw(t);
  return fcPath('rend|' + t.layer_name, () => {
    if (lowered.length === 1) return dclone(lowered[0].info.parentGeometry);
    let g = geomRaw(t);
    for (const { info } of lowered) g = pUnite(g, info.cap);
    return g;
  });
}
// get_body_selection_path: the body at full width (styled footprint when styled).
function bodySelection(t) {
  const w = t.width || 0, sw = t.stroke_width || 0;
  return fcPath('body|' + t.layer_name, () => det(strandFootprintAtWidth(t, FC.P, FC.enableThird, FC.S, w + 2 * sw)));
}
// get_selection_path: the body plus what draw() paints at each end (the cap
// circle, else the side-line band, else an attached strand's inner cap fill).
function selectionPath(t) {
  if (isMask(t)) return piecePath(t);
  return fcPath('sel|' + t.layer_name, () => {
    let g = bodySelection(t);
    if (!g) return null;
    const S = FC.S;
    const w = t.width || 0, sw = t.stroke_width || 0;
    const td = (w + 2 * sw) * S;
    const cl = det(buildCenterline(t, FC.P, FC.enableThird));
    const len = cl.length;
    const hc = t.has_circles || [false, false];
    const cc = t.closed_connections || [false, false];
    const attached = t.type === 'AttachedStrand';
    for (const side of [0, 1]) {
      const alpha = circleStrokeAlpha(side === 0 ? effStartStroke(t) : effEndStroke(t));
      const pt = side === 0 ? t.start : t.end;
      const centre = FC.P(pt);
      let deco = null;
      const junction = hasAttachedChildAt(pt, FC.strands, t) || !!cc[side];
      const circleVisible = hc[side] && alpha > 0 && ((attached && side === 0) || junction);
      if (attached && side === 0 && hc[0] && alpha === 0 && t.is_setting_staring_circle !== false) {
        deco = circlePath(centre, (w * S) / 2);
      } else if (circleVisible) {
        deco = circlePath(centre, td / 2);
      } else if (!hc[side] && !(attached && side === 0)
                 && (side === 0 ? t.start_line_visible !== false : t.end_line_visible !== false)
                 && !esActiveStyle(t, side)) {
        // the side-line band: stroke_width thick, the full visible width, just
        // outside the flat end (update_side_line)
        const a = tangentAngle(cl, side === 0 ? 0 : len);
        const shift = (sw * S) / 2 * (side === 0 ? -1 : 1);
        const c = { x: centre.x + Math.cos(a) * shift, y: centre.y + Math.sin(a) * shift };
        deco = det(localRect(c, -(sw * S) / 2, -td / 2, sw * S, td, a));
      } else if (attached && side === 1 && hc[1]) {
        deco = circlePath(centre, (w * S) / 2);
      }
      if (deco) g = pUnite(g, deco);
    }
    return g;
  });
}
// _drawn_footprint
function drawnFootprint(t) {
  if (!isMask(t) && loweredStartCap(t)) return geomRaw(t);
  return selectionPath(t);
}
// get_mask_path / get_mask_path_stroke / _mask_footprint (the piece).
function maskFillPath(m) { return fcPath('mfill|' + m.layer_name, () => det(buildMaskPath(m, FC.byLayer, FC.P, FC.enableThird, FC.S))); }
function maskStrokePath(m) { return fcPath('mstroke|' + m.layer_name, () => det(buildMaskStrokePath(m, FC.byLayer, FC.P, FC.enableThird, FC.S))); }
function piecePath(m) {
  return fcPath('piece|' + m.layer_name, () => {
    const f = maskFillPath(m), s = maskStrokePath(m);
    return f && s ? pUnite(s, f) : (f || s);
  });
}
// _erased_area
function erasedPath(m) {
  return fcPath('erased|' + m.layer_name, () => {
    let area = null;
    for (const rect of m.deletion_rectangles || []) {
      const rp = det(deletionPath(rect, FC.P, FC.S));
      if (rp) area = area ? pUnite(area, rp) : rp;
    }
    return area;
  });
}
const wholeMask = (m) => !(m.deletion_rectangles && m.deletion_rectangles.length);
// _zone_of: the piece grown by the blur radius, minus the erased parts.
function zonePath(m) {
  return fcPath('zone|' + m.layer_name, () => {
    const piece = piecePath(m);
    if (pEmpty(piece)) return null;
    let zone = grownPath(piece, MAX_BLUR * FC.S);
    const erased = erasedPath(m);
    if (zone && erased) zone = pSub(zone, erased);
    return zone;
  });
}
// strand.boundingRect() (mask: its strands' rects intersected), for _may_touch.
function boundsOf(t) {
  return fcMemo('bounds|' + t.layer_name, () => {
    if (isMask(t)) {
      const parts = maskParts(t);
      if (!parts) return null;
      const a = boundsOf(parts.first), b = boundsOf(parts.second);
      return a && b ? a.intersect(b) : null;
    }
    // The rendered body (+ circles) and a stroke width more for the side lines
    // just past the flat ends: cheaper than the selection path, and conservative.
    const g = geomRaw(t);
    return g ? g.bounds.expand(2 * ((t.stroke_width || 0) + 1) * FC.S) : null;
  });
}
// _may_touch: cheap and conservative.
function mayTouch(t, rect) {
  const b = boundsOf(t);
  if (!b || !rect) return true;
  const owner = isMask(t) ? (maskParts(t) || {}).first || t : t;
  const margin = ((owner.width || 0) + 2 * (owner.stroke_width || 0) + 4) * FC.S;
  return b.expand(2 * margin).intersects(rect);
}

// ---- lowered start caps (shader_utils.lowered_start_cap) ----------------------
function loweredStartCap(t) {
  if (isMask(t) || t.type !== 'AttachedStrand') return null;
  return fcMemo('lowered|' + t.layer_name, () => computeLoweredStartCap(t));
}
function computeLoweredStartCap(t) {
  const parent = FC.byLayer[t.attached_to];
  if (!parent || isMask(parent) || t.is_hidden === true || parent.is_hidden === true) return null;
  const hc = t.has_circles || [false, false];
  if (!hc[0] || circleStrokeAlpha(effStartStroke(t)) !== 0 || t.is_setting_staring_circle === false) return null;
  const low = rankOf(parent.layer_name), high = rankOf(t.layer_name);
  if (low < 0 || high < 0 || high - low < 2) return null;
  const candidates = FC.strands.slice(low + 1, high).filter((c) => !isMask(c) && c.is_hidden !== true);
  if (!candidates.length) return null;
  const S = FC.S, w = t.width || 0, sw = t.stroke_width || 0;
  const start = FC.P(t.start);
  const cap = circlePath(start, (w * S) / 2);   // unfolded_start_cap (circular)
  const capRect = cap.bounds;
  const near = circlePath(start, (w * S) / 2 + 2 * S);   // _grown(cap, 2.0)
  const nearJoint = pInter(bodySelection(parent), near);
  const ownNearJoint = pInter(geomRaw(t), near);
  const crossers = [];
  for (const item of candidates) {
    const b = boundsOf(item);
    if (b && !b.expand(8 * S).intersects(capRect)) continue;
    const fp = selectionPath(item);
    if (pEmpty(fp) || !pIntersects(fp, cap)) continue;
    if (pArea(pInter(fp, nearJoint)) > wArea(1.0) && pArea(pInter(fp, ownNearJoint)) <= wArea(1.0)) {
      crossers.push({ item, fp });
    }
  }
  if (!crossers.length) return null;
  let covered = null;
  for (const c of crossers) covered = covered ? pUnite(covered, c.fp) : dclone(c.fp);
  const cl = det(buildCenterline(t, FC.P, FC.enableThird));
  const angle = tangentAngle(cl, 0);
  const strip = det(localRect(start, -2.5 * S, -(w * S) / 2, 5 * S, w * S, angle));
  const patch = pSub(strip, covered);
  const own = pUnite(geomRaw(t), strip);
  const reach = circlePath(start, (w + 2 * sw) * S);
  let shadeZone = null;
  if (SHADOW_ENABLED) {
    shadeZone = pSub(pInter(own, reach), covered);
    for (const c of crossers) {
      const over = pInter(pInter(c.fp, own), reach);
      if (pArea(over) > wArea(1.0)) shadeZone = pSub(shadeZone, grownPath(over, (MAX_BLUR / 2 + 2) * S));
    }
  }
  const parentGeometry = pUnite(geomRaw(parent), cap);
  return { parent, cap, crossers: crossers.map((c) => c.item), patch, shadeZone, parentGeometry };
}
// lowered_caps_of: the lowered caps `t` paints for its attached strands.
function loweredCapsOf(t) {
  if (isMask(t)) return [];
  return fcMemo('loweredOf|' + t.layer_name, () => {
    const res = [];
    for (const c of FC.strands) {
      if (c.type !== 'AttachedStrand' || c.attached_to !== t.layer_name) continue;
      const info = loweredStartCap(c);
      if (info && info.parent === t) res.push({ child: c, info });
    }
    return res;
  });
}

// ---- local restacking near masks (_mask_sides and friends) --------------------
function liftedPairs() {
  return fcMemo('liftedPairs', () => {
    const set = new Set();
    for (const t of FC.strands) {
      if (!isMask(t) || t.is_hidden === true) continue;
      const parts = maskParts(t);
      if (parts) set.add(parts.first.layer_name + '|' + parts.second.layer_name);
    }
    return set;
  });
}
// _overlap_within
function overlapWithin(a, b, zone) {
  if (!a || !b || !a.bounds.intersects(b.bounds)) return false;
  const shared = pInter(a, b);
  if (pEmpty(shared)) return false;
  return pArea(pInter(shared, zone)) > wArea(1.0);
}
function maskSides(m) {
  return fcMemo('sides|' + m.layer_name, () => {
    const parts = maskParts(m);
    if (!parts || m.is_hidden === true) return null;
    const { first, second } = parts;
    const fi = rankOf(first.layer_name), si = rankOf(second.layer_name);
    if (fi < 0 || si < 0) return null;
    if (pEmpty(piecePath(m))) return null;
    const zone = zonePath(m);
    if (!zone) return null;
    const zoneRect = zone.bounds;
    const firstGeom = geomRendered(first), secondGeom = geomRendered(second);
    const lifted = liftedPairs();
    const upper = new Set([first.layer_name]), lower = new Set([second.layer_name]), between = new Set();
    for (const other of FC.strands) {
      const name = other.layer_name;
      if (other === first || other === second || isMask(other) || other.is_hidden === true) continue;
      const idx = rankOf(name);
      if ((idx <= fi && idx >= si) || !mayTouch(other, zoneRect)) continue;
      const g = geomRendered(other);
      const overFirst = idx > fi && !lifted.has(first.layer_name + '|' + name) && overlapWithin(g, firstGeom, zone);
      const underSecond = idx < si && !lifted.has(name + '|' + second.layer_name) && overlapWithin(g, secondGeom, zone);
      if (overFirst && underSecond) between.add(name);
      else if (overFirst) upper.add(name);
      else if (underSecond) lower.add(name);
    }
    return { mask: m, zone: det(zone), zoneRect, upper, lower, between,
      first: first.layer_name, second: second.layer_name, whole: wholeMask(m) };
  });
}
const sortByRank = (names) => [...names].sort((a, b) => rankOf(a) - rankOf(b));
// _masks_near
function masksNear(t) {
  const b = boundsOf(t);
  const reach = b ? b.expand(2 * MAX_BLUR * FC.S) : null;
  const near = [];
  for (const m of FC.strands) {
    if (!isMask(m) || m.is_hidden === true) continue;
    const sides = maskSides(m);
    if (sides && (!reach || sides.zoneRect.intersects(reach))) near.push(sides);
  }
  return near;
}
// _lifted_near_masks
function liftedNear(t, near) {
  const out = [];
  for (const sd of near) {
    if (!sd.lower.has(t.layer_name)) continue;
    const upper = new Set(sd.upper);
    if (t.layer_name === sd.second && sd.whole) { out.push({ zone: null, names: new Set([sd.first]) }); upper.delete(sd.first); }
    if (upper.size) out.push({ zone: sd.zone, names: upper });
  }
  return out;
}
// _sunk_near_masks
function sunkNear(recv, near) {
  const out = [];
  for (const sd of near) {
    if (!sd.upper.has(recv)) continue;
    const lower = new Set(sd.lower);
    if (recv === sd.first && sd.whole) { out.push({ zone: null, names: new Set([sd.second]) }); lower.delete(sd.second); }
    if (lower.size) out.push({ zone: sd.zone, names: lower });
  }
  return out;
}
const restackedAbove = (u, l, near) => near.some((sd) => sd.upper.has(u) && sd.lower.has(l));
// _raised_near_masks
function raisedNear(recv, caster, near) {
  const out = [];
  const ri = rankOf(recv), ci = rankOf(caster);
  if (!near.length || ri < 0 || ci < 0) return out;
  for (const sd of near) {
    if (!sd.lower.has(recv) || sd.lower.has(caster)) continue;
    for (const name of sortByRank(sd.upper)) {
      const idx = rankOf(name);
      if (name === caster || idx >= ri || idx >= ci || restackedAbove(name, caster, near)) continue;
      const everywhere = sd.whole && recv === sd.second && name === sd.first;
      out.push({ area: everywhere ? null : sd.zone, name });
    }
  }
  return out;
}
// _lowered_near_masks
function loweredNear(t, near) {
  const out = [];
  const ti = rankOf(t.layer_name);
  if (!near.length || ti < 0) return out;
  for (const sd of near) {
    if (!sd.upper.has(t.layer_name)) continue;
    const below = [];
    for (const name of sortByRank(sd.lower)) {
      if (rankOf(name) <= ti) continue;
      const everywhere = sd.whole && t.layer_name === sd.first && name === sd.second;
      below.push({ name, idx: rankOf(name), area: everywhere ? null : sd.zone });
    }
    if (below.length) out.push({ upper: sd.upper, below });
  }
  return out;
}
// _mask_lift_zone: {zone (null = everywhere), mask} when a visible mask lifts
// `first` over `second`.
function maskLiftZone(first, second) {
  const m = maskOf(first + '|' + second);
  if (!m || pEmpty(piecePath(m))) return null;
  return { zone: wholeMask(m) ? null : zonePath(m), mask: m };
}

// ---- subtractions --------------------------------------------------------------
// _subtract_named_layer_paths -> {region, blocker}
function subtractNamed(region, names) {
  let blocker = null;
  if (pEmpty(region) || !names || !names.length) return { region, blocker };
  for (const name of names) {
    const t = FC.byLayer[name];
    if (!t || t.is_hidden === true) continue;
    const sub = isMask(t) ? maskFillPath(t) : geomRendered(t);
    if (pEmpty(sub)) continue;
    region = pSub(region, sub);
    blocker = blocker ? pUnite(blocker, sub) : sub;
    if (pEmpty(region)) break;
  }
  return { region, blocker };
}
// _subtract_intermediates -> {outline, fill}
function subtractIntermediates(region, names, exemptions) {
  const exempt = new Map();
  if (exemptions && exemptions.length) {
    const between = new Set(names);
    for (const { zone, names: set } of exemptions) for (const name of set) {
      if (!between.has(name)) continue;
      if (!exempt.has(name)) exempt.set(name, []);
      exempt.get(name).push(zone);
    }
  }
  if (!exempt.size) return { outline: subtractNamed(region, names).region, fill: null };
  let cover = null;
  const rect = region ? region.bounds : null;
  for (const name of names) {
    const t = FC.byLayer[name];
    if (!t || t.is_hidden === true || !mayTouch(t, rect)) continue;
    let g = isMask(t) ? maskFillPath(t) : geomRendered(t);
    if (pEmpty(g)) continue;
    for (const zone of exempt.get(name) || []) {
      let covered;
      if (zone === null) { g = null; covered = drawnFootprint(t); }
      else { g = pSub(g, zone); covered = pInter(drawnFootprint(t), zone); }
      cover = cover ? pUnite(cover, covered) : covered;
      if (pEmpty(g)) break;
    }
    if (!pEmpty(g)) region = pSub(region, g);
  }
  const fill = cover && !pEmpty(cover) ? pSub(region, cover) : dclone(region);
  return { outline: region, fill };
}
// _clip_off_lifted_strands -> {clip, changed}
function clipOffLifted(recvPath, lifted, between) {
  if (!lifted.length || !between.length) return { clip: dclone(recvPath), changed: false };
  let keepOff = null;
  const rect = recvPath.bounds;
  for (const { zone, names } of lifted) {
    for (const name of between) {
      if (!names.has(name)) continue;
      const t = FC.byLayer[name];
      if (!t || !mayTouch(t, rect)) continue;
      let piece = drawnFootprint(t);
      if (zone) piece = pInter(piece, zone);
      if (!pEmpty(piece)) keepOff = keepOff ? pUnite(keepOff, piece) : piece;
    }
  }
  if (!keepOff) return { clip: dclone(recvPath), changed: false };
  return { clip: pSub(recvPath, keepOff), changed: true };
}
// _clip_off_hidden_rows
function clipOffHiddenRows(clip, caster, between) {
  let changed = false;
  if (!between.length || pEmpty(clip)) return { clip, changed };
  const rect = clip.bounds;
  for (const name of between) {
    if (shadowVisible(caster, name)) continue;
    const t = FC.byLayer[name];
    if (!t || t.is_hidden === true || !mayTouch(t, rect)) continue;
    const fp = isMask(t) ? piecePath(t) : drawnFootprint(t);
    if (pEmpty(fp)) continue;
    clip = pSub(clip, fp);
    changed = true;
  }
  return { clip, changed };
}

// ---- the caster ----------------------------------------------------------------
// _seam_slab: a 2*depth band across the flat end `idx`, a little past both edges.
function seamSlab(t, idx, cl, depth = 2.0) {
  const S = FC.S;
  const len = cl.length;
  if (len <= 0) return null;
  const step = Math.min(1.0 * S, len / 2);
  const end = cl.getPointAt(idx === 0 ? 0 : len);
  const inner = cl.getPointAt(idx === 0 ? step : len - step);
  if (!end || !inner) return null;
  const along = Math.atan2(inner.y - end.y, inner.x - end.x);
  const half = ((t.width || 0) + 2 * (t.stroke_width || 0)) / 2 + 2.0;
  return det(localRect(end, -depth * S, -half * S, 2 * depth * S, 2 * half * S, along));
}
// _caster_shadow_path -> {shadowPath, joints: [{centre (world), disc}]}
function casterShadowPath(t) {
  return fcMemo('caster|' + t.layer_name, () => {
    const S = FC.S;
    let shadowPath = det(buildShadowCasterCore(t, FC.P, FC.enableThird, S));
    const joints = [];
    if (shadowPath) {
      const hc = t.has_circles || [false, false];
      const w = t.width || 0, sw = t.stroke_width || 0;
      const radius = ((w + 2 * sw) / 1.5) * S;
      let cl = null;
      for (const idx of [0, 1]) {
        if (!hc[idx] || circleStrokeAlpha(idx === 0 ? effStartStroke(t) : effEndStroke(t)) !== 0) continue;
        const centre = idx === 0 ? t.start : t.end;
        const disc = circlePath(FC.P(centre), radius);
        if (FC.strands.some((o) => o !== t && endsAt(o, centre))) {
          joints.push({ centre, disc });
          if (!cl) cl = det(buildCenterline(t, FC.P, FC.enableThird));
          const slab = seamSlab(t, idx, cl);
          if (slab) shadowPath = pSub(shadowPath, slab);
        } else {
          shadowPath = pSub(shadowPath, disc);
        }
      }
      // A full arrow that casts unites into the caster (strand.py:2281), after the
      // end cuts, which describe the body's own ends.
      const arrow = det(buildArrowShadowPath(t, FC.P, FC.enableThird, S));
      if (arrow) shadowPath = pUnite(shadowPath, arrow);
    }
    const circles = det(buildShadowCasterCircles(t, FC.P, S));
    const footprint = shadowPath && circles ? pUnite(shadowPath, circles) : shadowPath;
    return { shadowPath, joints, circles, footprint };
  });
}

// _pair_shadow: the shadow `s` casts on `o`, or null.
function pairShadow(s, o, cc) {
  if (o === s || !o.layer_name) return null;
  if (o.is_hidden === true && o.full_arrow_visible !== true) return null;
  const ti = rankOf(s.layer_name), oi = rankOf(o.layer_name);
  if (ti < 0 || oi < 0) return null;
  const shouldBeAbove = ti > oi;
  const maskLift = maskLiftZone(s.layer_name, o.layer_name);
  let lift = maskLift;
  if (maskLift && shouldBeAbove && maskLift.zone === null) lift = null;
  if (!shouldBeAbove && !lift) return null;
  // Both strands are components of the same visible mask: the mask owns their crossing.
  const sameMask = maskOf(s.layer_name + '|' + o.layer_name) !== undefined
    || maskOf(o.layer_name + '|' + s.layer_name) !== undefined;
  if (sameMask && !maskLift) return null;
  // Quick reject (conservative).
  const ob = boundsOf(o);
  if (ob && cc.reach && !cc.reach.intersects(ob.expand(2 * ((o.width || 0) + 2 * (o.stroke_width || 0) + MAX_BLUR) * FC.S))) return null;

  let recv = isMask(o) ? maskFillPath(o) : geomRendered(o);
  const lowered = loweredCapsOf(o);
  if (!isMask(o) && lowered.length && lowered.some(({ info }) => !info.crossers.includes(s))) {
    recv = geomRaw(o);
    for (const { info } of lowered) if (info.crossers.includes(s)) recv = pUnite(recv, info.cap);
  }
  if (pEmpty(recv)) return null;
  // The caster's shadow area plus its circles; a strand that continues the
  // caster at a hidden joint gets no halo around the joint (the disc).
  let inter;
  const discs = cc.joints.filter((j) => endsAt(o, j.centre));
  if (discs.length) {
    inter = dclone(cc.shadowPath);
    for (const j of discs) inter = pSub(inter, j.disc);
    if (cc.circles) inter = pUnite(inter, cc.circles);
  } else {
    inter = cc.footprint;
  }
  inter = pInter(inter, recv);
  if (lift && lift.zone) inter = pInter(inter, lift.zone);
  if (pEmpty(inter)) return null;

  let ov = null;
  if (lift) {
    if (!intersectionShadowVisible(lift.mask)) return null;
  } else {
    ov = overrideOf(s.layer_name, o.layer_name);
    if (!shadowVisible(s.layer_name, o.layer_name)) return null;
  }
  const allowFull = !!(ov && ov.allow_full_shadow);
  const sub = subtractNamed(inter, subtractedLayersOf(s.layer_name, o.layer_name));
  let outline = sub.region, fill = null;
  if (!allowFull && !pEmpty(outline)) {
    const names = lift ? [] : FC.strands.slice(Math.min(ti, oi) + 1, Math.max(ti, oi)).map((x) => x.layer_name);
    const r = subtractIntermediates(outline, names, cc.lifted.concat(sunkNear(o.layer_name, cc.near)));
    outline = r.outline; fill = r.fill;
  }
  if (!pEmpty(outline)) {
    const cuts = [];
    for (const { upper, below } of cc.lowered) {
      if (upper.has(o.layer_name)) continue;
      for (const b of below) {
        if (oi < b.idx && !restackedAbove(o.layer_name, b.name, cc.near)) cuts.push({ area: b.area, name: b.name });
      }
    }
    for (const c of raisedNear(o.layer_name, s.layer_name, cc.near)) cuts.push(c);
    for (const { area, name } of cuts) {
      let cut = geomRendered(FC.byLayer[name]);
      if (area) cut = pInter(cut, area);
      if (pEmpty(cut)) continue;
      outline = pSub(outline, cut);
      if (fill) fill = pSub(fill, cut);
    }
  }
  if (pEmpty(outline)) return null;
  let clip = null, plain = false;
  if (!lift) {
    const between = FC.strands.slice(Math.min(ti, oi) + 1, Math.max(ti, oi)).map((x) => x.layer_name);
    const a = clipOffLifted(recv, cc.lifted, between);
    const b = clipOffHiddenRows(a.clip, s.layer_name, between);
    clip = b.clip;
    plain = !a.changed && !b.changed && !loweredCapsOf(o).length;
  }
  return { outline, fill, lift: lift ? lift.mask : null, recv, clip, plain, clipBlocker: sub.blocker, o };
}

// draw_strand_shadow(collect_only=True), once per paint: every shadow `s` casts.
// Returns null when it casts none, else {fills, outlines: [{recv, path}],
// lifts: [path], circles, clip, total (the stroked outline, see passBOutline)}.
function collectShadow(s) {
  if (!SHADOW_ENABLED || isMask(s) || s.hide_shadow === true) return null;
  if (s.is_hidden === true && !(s.full_arrow_visible === true && s.arrow_casts_shadow === true)) return null;
  return fcMemo('collected|' + s.layer_name, () => {
    const cs = casterShadowPath(s);
    if (pEmpty(cs.shadowPath)) return null;
    const near = masksNear(s);
    const b = boundsOf(s);
    const cc = {
      shadowPath: cs.shadowPath, joints: cs.joints, circles: cs.circles, footprint: cs.footprint, near,
      lifted: liftedNear(s, near), lowered: loweredNear(s, near),
      reach: b ? b.expand(2 * ((s.width || 0) + 2 * (s.stroke_width || 0) + MAX_BLUR) * FC.S) : null,
    };
    const fills = [], outlines = [], lifts = [];
    let clip = null, plainClip = true, clipOddEven = false;
    for (const o of FC.strands) {
      const pair = pairShadow(s, o, cc);
      if (!pair) continue;
      if (pair.lift) { lifts.push(pair.outline); continue; }
      if (!clip) {
        clip = pair.clip;
        plainClip = pair.plain;
        clipOddEven = pair.plain && isMask(o) && qtMaskPathOddEven(o, FC.byLayer, FC.P, FC.enableThird, FC.S);
      } else if (plainClip && pair.plain && clipOddEven) {
        // An odd-even mask path seeded the clip: addPath XORs each receiver in.
        const pieces = isMask(o) ? [maskFillPath(o)]
          : (buildShadowReceiverPieces(o, FC.strands, FC.P, FC.enableThird, FC.S) || []).map(det);
        for (const piece of pieces) if (piece) clip = det(clip.exclude(piece, { insert: false }));
      } else {
        clip = pUnite(clip, pair.clip);
        if (!(plainClip && pair.plain)) plainClip = false;
      }
      if (!pEmpty(pair.clipBlocker) && clip) {
        if (clip.bounds.intersects(pair.clipBlocker.bounds)) clip = pSub(clip, pair.clipBlocker);
        plainClip = false;
      }
      if (pEmpty(clip)) clip = null;
      fills.push(pair.fill || pair.outline);
      outlines.push({ recv: o.layer_name, path: pair.outline });
    }
    if (!outlines.length && !lifts.length) return null;
    const res = { fills, outlines, lifts, circles: cs.circles, clip };
    res.total = strokeTotal(outlines.map((x) => x.path).concat(lifts), cs.circles);
    return res;
  });
}
// The stroke source of a collected shadow (total_shadow_path): every outline,
// the lift outlines and the caster's circles, drawn with each edge once.
function strokeTotal(paths, circles) {
  const pieces = paths.filter((p) => !pEmpty(p));
  if (!pieces.length && !circles) return null;
  let union = null;
  for (const p of pieces) union = union ? pUnite(union, p) : dclone(p);
  if (!union) union = dclone(circles);
  const out = passBOutline(pieces, circles, union);
  det(out);
  return out;
}
function unionOf(paths) {
  let u = null;
  for (const p of paths) if (!pEmpty(p)) u = u ? pUnite(u, p) : dclone(p);
  return u;
}
// The blur strokes of a stroke source (Pass B / _paint_collected_shadow).
function blurStrokeItems(total) {
  const items = [];
  if (!total) return items;
  for (const st of shadowBlurSteps()) {
    const item = total.clone({ insert: false });
    item.fillColor = null;
    item.strokeColor = new paper.Color(SHADOW_COLOR.r / 255, SHADOW_COLOR.g / 255, SHADOW_COLOR.b / 255, st.alpha / 255);
    item.strokeWidth = st.width * FC.S;
    item.strokeCap = 'round';
    item.strokeJoin = 'round';
    items.push(item);
  }
  return items;
}
// Paint `items` with the painter clipped to every path in `clips` in turn (the
// painter intersects them) and off `clipOut` (a compound path, see
// highlightClipOut). Adds one nested clipped group to the active layer.
function paintClipped(items, clips, clipOut) {
  let children = items.filter(Boolean);
  if (!children.length) return null;
  const all = clips.filter((c) => c !== undefined);
  if (clipOut) all.push(clipOut);
  for (let k = all.length - 1; k >= 0; k--) {
    const c = all[k];
    if (!c) { for (const it of children) it.remove(); return null; }
    children = [new paper.Group({ children: [dclone(c), ...children], clipped: true, insert: false })];
  }
  const g = children.length === 1 ? children[0] : new paper.Group({ children, insert: false });
  paper.project.activeLayer.addChild(g);
  return g;
}
// _paint_collected_shadow: the fill, then the same faded edge, clipped.
function paintCollected(total, clips, fill, clipOut) {
  const items = [];
  if (fill && !pEmpty(fill)) {
    const f = fill.clone({ insert: false });
    f.fillColor = SHADOW_PAINT;
    f.strokeColor = null;
    items.push(f);
  }
  items.push(...blurStrokeItems(total));
  return paintClipped(items, clips, clipOut);
}

// The strand's own shadow pass (draw_strand_shadow, painting): Pass A, the
// filled areas, unclipped; Pass B, the faded edge, clipped to the receivers.
function castStrandShadow(s) {
  const col = collectShadow(s);
  if (!col || !col.outlines.length) return;
  const combined = unionOf(col.fills);
  if (combined) {
    combined.fillColor = SHADOW_PAINT;
    combined.strokeColor = null;
    paper.project.activeLayer.addChild(combined);
  }
  if (!col.clip) return;   // only a mask partner receives it; the mask paints it
  paintClipped(blurStrokeItems(col.total), [col.clip], null);
}

// ---- selection outlines a mask keeps clear of (note_painted_highlight) ----------
// The pixels (device = this render's offscreen) Qt's combined_highlight paints:
// the body outline stroked 10 px (MiterJoin, FlatCap), the side-line bars and
// the C-shape rings. Drawn on a scratch canvas from the paper items.
function noteHighlight(s, items) {
  if (FC) FC.highlights.push({ strand: s, items: items.map((it) => it.clone({ insert: false })) });
}
// _highlight_region as a clip path: everything but the touched pixels, or null.
function highlightClipOut(m) {
  const parts = maskParts(m);
  if (!parts || !FC.highlights.length) return null;
  return fcMemo('hlregion|' + m.layer_name, () => {
    const above = Math.max(rankOf(parts.first.layer_name), rankOf(parts.second.layer_name));
    const kept = FC.highlights.filter(({ strand }) => rankOf(strand.layer_name) > above && !isMask(strand)
      && !joinedTo(strand, [parts.first, parts.second]));
    if (!kept.length) return null;
    const piece = piecePath(m);
    if (!piece) return null;
    const margin = (MAX_BLUR + 8) * FC.S;
    const reach = piece.bounds.expand(2 * margin);
    let bounds = null;
    for (const { items } of kept) for (const it of items) {
      const b = it.strokeBounds || it.bounds;
      bounds = bounds ? bounds.unite(b) : b;
    }
    if (!bounds) return null;
    bounds = bounds.intersect(reach);
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    const x0 = Math.floor(bounds.x) - 1, y0 = Math.floor(bounds.y) - 1;
    const W = Math.ceil(bounds.x + bounds.width) + 1 - x0, H = Math.ceil(bounds.y + bounds.height) + 1 - y0;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.translate(-x0, -y0);
    ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
    for (const { items } of kept) for (const it of items) {
      const p2 = new Path2D(it.pathData);
      if (it.strokeWidth && it.strokeColor) {
        ctx.lineWidth = it.strokeWidth;
        ctx.lineCap = it.strokeCap || 'butt';
        ctx.lineJoin = it.strokeJoin || 'miter';
        ctx.miterLimit = it.miterLimit || 10;
        ctx.stroke(p2);
      }
      if (it.fillColor) ctx.fill(p2, 'nonzero');
    }
    const data = ctx.getImageData(0, 0, W, H).data;
    // Runs of touched pixels per row, merged into rectangles (QRegion bands).
    const rects = [];
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        while (x < W && data[(y * W + x) * 4 + 3] === 0) x++;
        if (x >= W) break;
        const sx = x;
        while (x < W && data[(y * W + x) * 4 + 3] !== 0) x++;
        rects.push([x0 + sx, y0 + y, x - sx, 1]);
      }
    }
    if (!rects.length) return null;
    const big = new paper.Path.Rectangle({ point: [x0 - 1e5, y0 - 1e5], size: [W + 2e5, H + 2e5], insert: false });
    const children = [big, ...rects.map(([x, y, w, h]) => new paper.Path.Rectangle({ point: [x, y], size: [w, h], insert: false }))];
    return new paper.CompoundPath({ children, fillRule: 'evenodd', insert: false });
  });
}

// ---- the mask -------------------------------------------------------------------
// _mask_lift_clip: the part of the second strand that shows (only near the mask
// when part of it is erased).
function maskLiftClip(m) {
  const parts = maskParts(m);
  if (!parts || pEmpty(piecePath(m))) return null;
  const { second } = parts;
  let visible = geomRendered(second);
  if (!visible) return null;
  const si = rankOf(second.layer_name), mi = rankOf(m.layer_name);
  if (si >= 0 && mi >= 0) {
    const area = visible.bounds;
    const covering = FC.strands.slice(Math.min(si, mi) + 1, Math.max(si, mi))
      .filter((t) => mayTouch(t, area)).map((t) => t.layer_name);
    visible = subtractNamed(visible, covering).region;
  }
  if (pEmpty(visible)) return null;
  if (!wholeMask(m)) visible = pInter(visible, zonePath(m));
  return pEmpty(visible) ? null : visible;
}
// _opaque_cover
function opaqueCover(t, fp) {
  if (t.shadow_only === true || t.full_arrow_visible === true) return null;
  const sw = t.stroke_width || 0;
  const strokeA = t.stroke_color ? (t.stroke_color.a == null ? 255 : t.stroke_color.a) : 255;
  if (sw > 0 && strokeA === 255) return fp;
  const fillA = t.color ? (t.color.a == null ? 255 : t.color.a) : 255;
  if (fillA < 255) return null;
  if (sw <= 0) return fp;
  return erodedPath(fp, sw * FC.S);
}
// _covering_strands
function coveringStrands(m) {
  return fcMemo('covering|' + m.layer_name, () => {
    const out = [];
    const parts = maskParts(m);
    if (!parts) return out;
    const piece = piecePath(m);
    if (pEmpty(piece)) return out;
    const mi = rankOf(m.layer_name), above = Math.max(rankOf(parts.first.layer_name), rankOf(parts.second.layer_name));
    if (mi < 0 || above < 0) return out;
    const area = piece.bounds;
    for (const t of FC.strands) {
      const idx = rankOf(t.layer_name);
      if (!(above < idx && idx < mi) || isMask(t) || t.is_hidden === true || !mayTouch(t, area)
          || joinedTo(t, [parts.first, parts.second])) continue;
      const solid = opaqueCover(t, drawnFootprint(t));
      if (solid && pArea(pInter(solid, piece)) > wArea(1.0)) out.push({ t, solid: det(solid) });
    }
    return out;
  });
}
// _piece_keep: where the piece may paint, or null for everywhere.
function pieceKeep(m) {
  return fcMemo('keep|' + m.layer_name, () => {
    const covering = coveringStrands(m);
    if (!covering.length) return null;
    const stroke = maskStrokePath(m), piece = piecePath(m);
    let b = piece.bounds;
    if (stroke) b = b.unite(stroke.bounds);
    let keep = new paper.Path.Rectangle({ rectangle: b.expand(8 * FC.S), insert: false });
    for (const { solid } of covering) keep = pSub(keep, solid);
    return keep;
  });
}
// _runs_under
function runsUnder(t, fp, piece) {
  const shared = pInter(fp, piece);
  if (pEmpty(shared)) return false;
  const reach = Math.max(2.0, ((t.width || 0) + 2 * (t.stroke_width || 0)) / 4.0) * FC.S;
  const d = reach * 0.7071;
  let core = shared;
  for (const [dx, dy] of [[reach, 0], [-reach, 0], [0, reach], [0, -reach], [d, d], [d, -d], [-d, d], [-d, -d]]) {
    const moved = shared.clone({ insert: false });
    moved.translate(new paper.Point(dx, dy));
    core = pInter(core, moved);
    if (pEmpty(core)) return false;
  }
  return pArea(core) > wArea(0.5);
}
// _cut_on_receiver: the collected shadow with its outlines on `recv` cut by `cut`.
function cutOnReceiver(col, recv, cut, key) {
  return fcMemo('cuton|' + key, () => {
    if (!col.outlines.some((x) => x.recv === recv)) return { fill: unionOf(col.outlines.map((x) => x.path)), total: col.total };
    const outlines = col.outlines.map((x) => (x.recv === recv && pIntersects(x.path, cut) ? pSub(x.path, cut) : x.path));
    return { fill: unionOf(outlines), total: strokeTotal(outlines.concat(col.lifts), col.circles) };
  });
}
// draw_mask_restored_shadows
function drawRestoredShadows(m, clipOut) {
  const parts = maskParts(m);
  if (!parts || !SHADOW_ENABLED) return;
  const { first, second } = parts;
  const mi = rankOf(m.layer_name), fi = rankOf(first.layer_name);
  if (mi < 0 || fi < 0) return;
  const piece = piecePath(m);
  if (pEmpty(piece)) return;
  const area = piece.bounds;
  const reach = area.expand(2 * MAX_BLUR * FC.S);
  const uncovered = new Set(coveringStrands(m).map((c) => c.t));
  const keep = pieceKeep(m);
  for (const item of FC.strands) {
    if (item === m || item === first || item === second) continue;
    const idx = rankOf(item.layer_name);
    if (idx < 0 || idx > mi) continue;
    let total, fill, zone = null;
    if (isMask(item)) {
      const ip = maskParts(item);
      if (!ip || ip.second !== first || item.is_hidden === true) continue;
      if (!shadowShownFor(item) || !intersectionShadowVisible(item) || !mayTouch(item, reach)) continue;
      const col = collectShadow(ip.first);
      if (!col || !col.lifts.length) continue;
      fill = unionOf(col.lifts);
      total = col.total;
      zone = wholeMask(item) ? null : zonePath(item);
    } else {
      if (idx < fi) continue;
      if (!shadowShownFor(item) || !mayTouch(item, reach)) continue;
      const col = collectShadow(item);
      if (!col || !col.outlines.some((x) => x.recv === first.layer_name)) continue;
      if (!uncovered.has(item) && mayTouch(item, area)) {
        const fp = drawnFootprint(item);
        if (joinedTo(item, [first, second])) {
          if (pIntersects(fp, piece)) continue;
        } else if (runsUnder(item, fp, piece)) {
          continue;
        }
      }
      const r = cutOnReceiver(col, second.layer_name, piece, item.layer_name + '|' + m.layer_name);
      fill = r.fill;
      total = r.total;
    }
    if (!fill && !total) continue;
    const near = area.expand(2 * (MAX_BLUR / 2 + 2) * FC.S);
    if ((!fill || !fill.bounds.intersects(area)) && (!total || !total.bounds.intersects(near))) continue;
    const clips = [piece];
    if (zone !== null) clips.push(zone);
    if (keep) clips.push(keep);
    paintCollected(total, clips, fill, clipOut);
  }
}
// MaskedStrand.draw / _draw_direct (the mask paints at its own place in the order).
function drawMask(m, shadowOnly) {
  if (m.is_hidden === true) return;
  const parts = maskParts(m);
  if (!parts) return;
  const { first } = parts;
  const clipOut = highlightClipOut(m);
  // The first strand's shadow on the second strand, where the mask lifts it.
  if (SHADOW_ENABLED && m.hide_shadow !== true && intersectionShadowVisible(m)) {
    const col = collectShadow(first);
    if (col && col.lifts.length) {
      const clip = maskLiftClip(m);
      if (clip) paintCollected(col.total, [clip], unionOf(col.lifts), clipOut);
    }
  }
  if (shadowOnly) return;
  // The piece: stroke layer under fill layer, kept off the strands above it.
  const strokeRegion = maskStrokePath(m), fillRegion = maskFillPath(m);
  if (strokeRegion) { strokeRegion.fillColor = toColor(first.stroke_color); strokeRegion.strokeColor = null; }
  if (fillRegion) { fillRegion.fillColor = toColor(first.color); fillRegion.strokeColor = null; }
  const keep = pieceKeep(m);
  const items = [strokeRegion, fillRegion].filter(Boolean);
  if (items.length) {
    if (keep || clipOut) paintClipped(items, keep ? [keep] : [], clipOut);
    else paper.project.activeLayer.addChild(new paper.Group({ children: items, insert: false }));
  }
  drawRestoredShadows(m, clipOut);
  // Selected: _draw_direct strokes the mask path 2 px (inside the draw's clip)
  // before the canvas's own 6 px highlight (masked_strand.py draw_highlight).
  if (m.is_selected) {
    const hl = maskFillPath(m);
    if (hl) {
      const color = toColor({ r: HIGHLIGHT_COLOR.r, g: HIGHLIGHT_COLOR.g, b: HIGHLIGHT_COLOR.b, a: 128 });
      if (MASK_DIRECT) {
        const thin = hl.clone({ insert: false });
        thin.fillColor = null; thin.strokeColor = color; thin.strokeWidth = 2 * FC.S;
        thin.strokeCap = 'round'; thin.strokeJoin = 'round';
        if (clipOut) paintClipped([thin], [], clipOut); else paper.project.activeLayer.addChild(thin);
      }
      hl.fillColor = null; hl.strokeColor = color; hl.strokeWidth = 6 * FC.S;
      hl.strokeCap = 'round'; hl.strokeJoin = 'round';
      paper.project.activeLayer.addChild(hl);
    }
  }
}

// ---- unfolded joints whose cap is lowered (draw_with_lowered_cap) --------------
// After the child's body: the seam strip in fill colour, then the crossers'
// soft edges again over the child next to the joint (_draw_crosser_edges).
function drawLoweredCapExtras(t, info) {
  if (!pEmpty(info.patch)) {
    const p = info.patch.clone({ insert: false });
    p.fillColor = toColor(t.color); p.strokeColor = null;
    paper.project.activeLayer.addChild(p);
  }
  if (!SHADOW_ENABLED || pEmpty(info.shadeZone)) return;
  for (const crosser of info.crossers) {
    if (!shadowShownFor(crosser) || !shadowVisible(crosser.layer_name, info.parent.layer_name)) continue;
    const cs = casterShadowPath(crosser);
    if (pEmpty(cs.shadowPath)) continue;
    paintCollected(cs.shadowPath, [info.shadeZone], null, null);
  }
}
// draw_lowered_caps: the caps `t` paints for its attached strands, in their colour.
function drawLoweredCaps(t) {
  for (const { child, info } of loweredCapsOf(t)) {
    const c = info.cap.clone({ insert: false });
    c.fillColor = toColor(child.color); c.strokeColor = null;
    paper.project.activeLayer.addChild(c);
  }
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
  const red = toColor(hcA && hcA.a != null ? hcA : HIGHLIGHT_COLOR);
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
  // Stylized free ends (1.111, strand.py highlight_footprint_path): the styled
  // footprint already carries the cap and the band, so the halo is a 10px ring
  // along its boundary (Qt strokes the footprint outline 10 wide); an unstyled
  // end with a transparent circle stroke is trimmed by an end slab instead of
  // the resampled band below.
  const styledGeom = esGeometry(s, P, enableThird, S, cl);
  // The same outer footprint the shadow caster / receiver ask for (memoized).
  const styledFootprint = styledGeom ? strandFootprintAtWidth(s, P, enableThird, S, w + 2 * sw) : null;
  if (styledFootprint) {
    band.remove();
    let fp = styledFootprint;
    for (const side of [0, 1]) {
      const alpha = side === 0 ? startA : endA;
      if (alpha !== 0 || styledGeom.isStyled(side)) continue;
      const trim = (side === 0 ? (isAttached ? 5.5 : 5.0) : (isAttached ? 3.5 : 5.0)) * S;
      const angle = side === 0 ? tangentAngle(cl, 0) + Math.PI : tangentAngle(cl, len);
      const slab = esEndSlab(s, side, P(side === 0 ? s.start : s.end), angle, trim, S);
      const cut = fp.subtract(slab);
      fp.remove(); slab.remove();
      fp = cut;
    }
    band = fp;
    band.fillColor = red;
    band.strokeColor = red;
    band.strokeWidth = 10 * S;
    band.strokeCap = 'butt';
    band.strokeJoin = 'miter';
    items.push(band);
  } else if ((startA === 0 || endA === 0) && len > 10 * S) {
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
  if (!styledFootprint) {
    band.strokeColor = red;
    band.strokeWidth = td + 10 * S;
    band.strokeCap = 'butt';
    band.strokeJoin = 'round';
    band.fillColor = null;
    items.push(band);
  }

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
  // A styled end's band lies inside the styled footprint (strand.py:2367-2385
  // gate the bars on `not self._end_style_active(side)`).
  const styled0 = !!(styledGeom && styledGeom.isStyled(0)), styled1 = !!(styledGeom && styledGeom.isStyled(1));
  if (s.start_line_visible !== false && !hc[0] && startA > 0 && !styled0) bar(P(s.start), tangentAngle(cl, 0), -1);  // shift opposite tangent
  if (s.end_line_visible !== false && !hc[1] && endA > 0 && !styled1) bar(P(s.end), tangentAngle(cl, len), 1);       // shift along tangent

  cl.remove();
  if (items.length) new paper.Group(items);

  // Masks drawn later in this paint keep clear of the outline Qt paints here
  // (note_painted_highlight): combined_highlight is the body outline stroked
  // 10 px (MiterJoin, FlatCap), plus the side-line bars and C-shapes. The band
  // above is painted solid (the body covers its inside); the region is the ring.
  if (FC) {
    const region = [];
    for (const it of items) {
      if (it === band) {
        let ring;
        if (styledFootprint) {
          ring = it.clone({ insert: false });
          ring.fillColor = null;
        } else {
          ring = strokedOutline(it, td);
          if (ring) ring.remove();
        }
        if (!ring) continue;
        ring.strokeColor = red;
        ring.strokeWidth = 10 * S;
        ring.strokeJoin = 'miter';
        ring.strokeCap = 'butt';
        region.push(ring);
      } else {
        region.push(it);
      }
    }
    noteHighlight(s, region);
  }
}

// ---- Arrows (OSS 1.109 §7: strand.py start/end arrows + full strand arrow) --
// Canvas-level arrow dimensions (Qt settings dialog; the oracle renders with
// these defaults). The editor may override via meta.arrow_params.
// Dashed extension lines (Settings -> Layer Panel). Canvas-level like the arrow
// dimensions; extension_dash_width falls back to the strand's own stroke_width
// when unset (strand.py:2783).
const EXTENSION_DEFAULTS = { length: 100, dash_count: 10, dash_width: null, dash_gap_length: null };
let EXTENSION_PARAMS = EXTENSION_DEFAULTS;

const ARROW_DEFAULTS = {
  head_length: 20, head_width: 10, gap_length: 10,
  line_length: 20, line_width: 10, head_stroke_width: 4,
};
let ARROW_PARAMS = ARROW_DEFAULTS;

// ---- Dashed extension lines (strand.py:2779-2815) -------------------------
// A straight dashed ray running OUT of each end along that end's tangent, gated
// per-strand on start/end_extension_visible. Faithful details:
//   * colour  = stroke_color with its alpha REPLACED by the fill colour's alpha
//     (side_color, :2776-2777) — not the stroke's own alpha;
//   * width   = extension_dash_width, defaulting to this strand's stroke_width;
//   * dashes  = ext_len / (2 * dash_count) on and the same off. Qt expresses a
//     CustomDashLine pattern in units of PEN WIDTH, so its pattern_len =
//     dash_seg / dash_width becomes dash_seg once multiplied back out — which is
//     what a canvas dash array wants directly;
//   * offset  = extension_dash_gap_length NEGATED (:2788), applied to BOTH
//     endpoints, so the ray slides along its own direction rather than growing.
//     Absent, it defaults to dash_seg.
// The rays are straight lines, not curve continuations: OSS takes the unit
// tangent once and walks it (:2798-2815).
// Absent flags => nothing drawn, so the fidelity oracle is unaffected.
function drawExtensions(s, P, enableThird, S) {
  const wantStart = s.start_extension_visible === true;
  const wantEnd = s.end_extension_visible === true;
  if (!wantStart && !wantEnd) return;

  const ep = EXTENSION_PARAMS;
  const extLen = ep.length;
  const dashCount = ep.dash_count;
  const dashWidth = ep.dash_width != null ? ep.dash_width : (s.stroke_width || 0);
  const dashSeg = dashCount > 0 ? extLen / (2 * dashCount) : extLen;
  const dashGap = -(ep.dash_gap_length != null ? ep.dash_gap_length : dashSeg);
  if (dashWidth <= 0) return;

  const col = toColor(s.stroke_color);
  col.alpha = ((s.color && s.color.a != null ? s.color.a : 255)) / 255;

  const cl = buildCenterline(s, P, enableThird);
  const len = cl.length;
  if (len <= 0) { cl.remove(); return; }

  const ray = (worldPt, angle, sign) => {
    // sign +1 walks along the tangent (the END ray), -1 against it (the START).
    const ux = Math.cos(angle) * sign, uy = Math.sin(angle) * sign;
    const a = P(worldPt);
    const b = P({ x: worldPt.x + ux * extLen, y: worldPt.y + uy * extLen });
    // OSS shifts BOTH endpoints by the same vector, expressed against the RAW
    // tangent: +unit*dash_gap at the start (:2803-2804), -unit*dash_gap at the end
    // (:2812-2813). `ux` already carries `sign`, so folding the two cases together
    // leaves -ux*dash_gap, which slides the ray along its own direction (dash_gap
    // is itself negated, so a positive gap setting pushes the ray outward).
    const ox = -ux * dashGap * S, oy = -uy * dashGap * S;
    const line = new paper.Path.Line(
      new paper.Point(a.x + ox, a.y + oy),
      new paper.Point(b.x + ox, b.y + oy),
    );
    line.strokeColor = col;
    line.strokeWidth = dashWidth * S;
    line.strokeCap = 'butt';
    line.dashArray = [dashSeg * S, dashSeg * S];
  };

  // A stylized free end anchors its ray on the styled edge's farthest point
  // (strand.py _end_anchor), never on top of an extended cap.
  const aS = tangentAngle(cl, 0), aE = tangentAngle(cl, len);
  if (wantStart) ray(esEndAnchor(s, 0, s.start, aS + Math.PI, P, enableThird, S, cl), aS, -1);
  if (wantEnd) ray(esEndAnchor(s, 1, s.end, aE, P, enableThird, S, cl), aE, 1);
  cl.remove();
}

// ---- Arrow patterns (strand.py apply_arrow_texture_brush / draw_arrow_shaft_with_pattern)
//
// Qt paints these with QBrush(QPixmap) — a tiled bitmap brush. Paper.js has no
// pattern fill, so the same tile is reproduced as GEOMETRY: the tile's strokes and
// dots are emitted across the shape's bounding box and clipped to the shape. The
// tile is a fixed pixel grid in Qt, and OSS never calls setBrushTransform, so the
// brush rides the painter transform and the tile scales with zoom — hence * S.
//
// PORT-FOR-COMPLETENESS / UNMEASURED: no fixture in the corpus sets arrow_texture
// or arrow_shaft_style (both default to the plain value), so the Qt pixel oracle
// never exercises these paths and cannot confirm them.
function tiledInside(shape, tilePx, emit) {
  // `shape` is consumed: it becomes the clip mask of the returned group.
  const b = shape.bounds;
  if (!b || b.width <= 0 || b.height <= 0 || tilePx <= 0) { shape.remove(); return null; }
  const items = [];
  const x0 = Math.floor(b.left / tilePx) * tilePx;
  const y0 = Math.floor(b.top / tilePx) * tilePx;
  // Guard against a pathological tile/bounds ratio producing millions of items.
  const cols = Math.ceil((b.right - x0) / tilePx), rows = Math.ceil((b.bottom - y0) / tilePx);
  if (cols * rows > 20000) { shape.remove(); return null; }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) emit(x0 + c * tilePx, y0 + r * tilePx, items);
  }
  if (!items.length) { shape.remove(); return null; }
  const g = new paper.Group([shape, ...items]);
  g.clipped = true;
  return g;
}

// Head fill texture. Qt's tile is 10x10 with the ARROW FILL COLOUR as the pen
// (strand.py:1002-1041), drawn over the already-filled triangle.
function applyArrowTexture(shape, texture, fillColor, S) {
  const tile = 10 * S;
  if (texture === 'stripes') {
    // pen(fill, 2), vertical lines at i = 0,3,6,9
    return tiledInside(shape, tile, (tx, ty, out) => {
      for (let i = 0; i < 10; i += 3) {
        const ln = new paper.Path.Line(
          new paper.Point(tx + i * S, ty), new paper.Point(tx + i * S, ty + tile));
        ln.strokeColor = fillColor; ln.strokeWidth = 2 * S; ln.strokeCap = 'butt';
        out.push(ln);
      }
    });
  }
  if (texture === 'dots') {
    // NoPen, brush(fill), drawEllipse(x-1, y-1, 2, 2) for x,y in 2,6 -> r=1 dots
    return tiledInside(shape, tile, (tx, ty, out) => {
      for (let x = 2; x < 10; x += 4) {
        for (let y = 2; y < 10; y += 4) {
          const d = new paper.Path.Circle(new paper.Point(tx + x * S, ty + y * S), 1 * S);
          d.fillColor = fillColor; d.strokeColor = null;
          out.push(d);
        }
      }
    });
  }
  if (texture === 'crosshatch') {
    // pen(fill, 1), lines at i = 0,3,6,9 in BOTH axes
    return tiledInside(shape, tile, (tx, ty, out) => {
      for (let i = 0; i < 10; i += 3) {
        const v = new paper.Path.Line(
          new paper.Point(tx + i * S, ty), new paper.Point(tx + i * S, ty + tile));
        const h = new paper.Path.Line(
          new paper.Point(tx, ty + i * S), new paper.Point(tx + tile, ty + i * S));
        for (const ln of [v, h]) { ln.strokeColor = fillColor; ln.strokeWidth = 1 * S; ln.strokeCap = 'butt'; }
        out.push(v, h);
      }
    });
  }
  shape.remove();
  return null;   // 'none' -> the solid fill already drawn is the whole story
}

// Shaft overlay. OSS always strokes the shaft SOLID first, then paints the
// pattern inside the stroke outline (strand.py:871-882). The overlays are
// translucent white/black diagonals, so they read as shading on any shaft colour.
function applyArrowShaftPattern(shaftPath, style, lineW, S) {
  if (style !== 'tiles' && style !== 'stripes' && style !== 'dots') return;
  const outline = strokedOutline(shaftPath, lineW);
  if (!outline) return;

  if (style === 'tiles') {
    // 12px tile, two diagonals, white @80/255, pen 3 (strand.py:896-912).
    const tile = 12 * S;
    const col = toColor({ r: 255, g: 255, b: 255, a: 80 });
    tiledInside(outline, tile, (tx, ty, out) => {
      for (const [x1, y1, x2, y2] of [[0, tile, tile, 0], [-tile / 2, tile, tile / 2, 0]]) {
        const ln = new paper.Path.Line(
          new paper.Point(tx + x1, ty + y1), new paper.Point(tx + x2, ty + y2));
        ln.strokeColor = col; ln.strokeWidth = 3 * S; ln.strokeCap = 'butt';
        out.push(ln);
      }
    });
    return;
  }

  if (style === 'stripes') {
    // Slash density derived from the shaft width (strand.py:928-931): stripe
    // width = clamp(lineW * 0.22, 2, 6), spacing = max(stripe * 1.6, 5),
    // tile = spacing * 2 so the period tiles exactly. Bright and dark pens
    // alternate. lineW here is already in PIXELS, so undo S for the ratio.
    const wWorld = lineW / S;
    const stripeW = Math.max(2, Math.min(6, Math.trunc(wWorld * 0.22)));
    const spacing = Math.max(Math.trunc(stripeW * 1.6), 5);
    const tile = spacing * 2 * S;
    const bright = toColor({ r: 255, g: 255, b: 255, a: 80 });
    const dark = toColor({ r: 0, g: 0, b: 0, a: 80 });
    tiledInside(outline, tile, (tx, ty, out) => {
      const half = tile / 2;
      const mk = (off, col) => {
        const ln = new paper.Path.Line(
          new paper.Point(tx + off, ty + tile), new paper.Point(tx + off + tile, ty));
        ln.strokeColor = col; ln.strokeWidth = stripeW * S; ln.strokeCap = 'butt';
        out.push(ln);
      };
      mk(0, bright);
      mk(half, dark);
    });
    return;
  }

  // dots: a light stipple over the shaft.
  const tile = 8 * S;
  const col = toColor({ r: 255, g: 255, b: 255, a: 90 });
  tiledInside(outline, tile, (tx, ty, out) => {
    const d = new paper.Path.Circle(new paper.Point(tx + tile / 2, ty + tile / 2), Math.max(1, 1.5 * S));
    d.fillColor = col; d.strokeColor = null;
    out.push(d);
  });
}

// Arrow-head FILL colour, with OSS's inverted default rule (strand.py:2310-2313,
// 1098-1106; attached_strand.py:765-771). The setting is labelled "Use Default
// Arrow Color", but the branch is `if NOT use_default_arrow_color: use
// canvas.default_arrow_fill_color`. So leaving the box UNticked is what makes the
// configured default colour apply; ticking it hands the head back to the strand's
// own colour. Reproduced as-is — the label is upstream's to fix.
let USE_DEFAULT_ARROW_COLOR = true;
let DEFAULT_ARROW_FILL = null;
function defaultArrowFill(s) {
  if (!USE_DEFAULT_ARROW_COLOR && DEFAULT_ARROW_FILL) return DEFAULT_ARROW_FILL;
  return s.color;
}

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
  const texture = s.arrow_texture || 'none';
  const shaftStyle = s.arrow_shaft_style || 'solid';
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
    // Texture rides ON TOP of the solid fill (OSS sets the textured brush and
    // fills the same triangle), and UNDER the border, which is stroked last.
    if (texture !== 'none') applyArrowTexture(poly.clone(), texture, fillColor, S);
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
    drawHead(s1, dir, toColor(defaultArrowFill(s)));
  };

  // The small arrows anchor on a stylized end's farthest edge point too
  // (strand.py _end_anchor); the full arrow's head stays on the endpoint.
  if (s.start_arrow_visible === true) {
    const a = tangentAngle(cl, 0);
    endArrow(esEndAnchor(s, 0, s.start, a + Math.PI, P, enableThird, S, cl), a, -1);
  }
  if (s.end_arrow_visible === true) {
    const a = tangentAngle(cl, len);
    endArrow(esEndAnchor(s, 1, s.end, a, P, enableThird, S, cl), a, 1);
  }

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
    // The pattern overlay goes on after the solid shaft, clipped to its outline.
    applyArrowShaftPattern(cl, shaftStyle, lineW, S);
    if (s.arrow_head_visible !== false) {
      const a = tangentAngle(cl, len);
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const fill = toColor(s.arrow_color ? s.arrow_color : defaultArrowFill(s));
      fill.alpha = alpha;
      drawHead(P(s.end), dir, fill);
    }
  }
  cl.remove();
}

function drawStrand(s, strands, P, enableThird, S, startCapLowered = false) {
  drawHighlight(s, strands, P, enableThird, S);   // under the body
  const centerline = buildCenterline(s, P, enableThird);
  const w = s.width || 0, sw = s.stroke_width || 0;
  // Qt strokes the body TWICE — once at width+2*stroke for the stroke layer and
  // once at width for the fill layer — and adds each layer's caps to that layer's
  // own WindingFill path (strand.py:2510-2600).
  const band = bodyBand(s, P, enableThird, (w + 2 * sw) * S, centerline);
  const inner = bodyBand(s, P, enableThird, w * S, centerline);
  if (!band || !inner) {
    band && band.remove();
    inner && inner.remove();
    centerline.remove();
    return;
  }

  const caps = collectCaps(s, strands, centerline, P, S, startCapLowered);
  const sideLines = collectSideLines(s, centerline, P, S);

  // Stylized free ends (OSS 1.111 strand.py draw + _paint_body_paths): the
  // bodies are the uncut extended bands plus the cap pieces, painted with the
  // painter clipped to everything but the cut polygons; the side line of a
  // styled end is its band, clipped to the uncut body.
  const geometry = esGeometry(s, P, enableThird, S, centerline);
  centerline.remove();
  if (geometry) {
    band.remove();
    inner.remove();
    const strokePath = windingFillLayer(geometry.bodyPieces(caps.stroke), toColor(s.stroke_color));
    const fillPath = windingFillLayer(geometry.fillPieces(caps.fill), toColor(s.color));
    const bounds = (strokePath || fillPath).bounds;
    const layers = [];
    if (strokePath) layers.push(new paper.Group({ children: [geometry.keepOuterClip(bounds), strokePath], clipped: true }));
    if (fillPath) layers.push(new paper.Group({ children: [geometry.keepInnerClip(bounds), fillPath], clipped: true }));
    layers.push(...sideLines);
    for (const side of [0, 1]) {
      if (!geometry.isStyled(side)) continue;
      const visible = side === 0 ? s.start_line_visible !== false : s.end_line_visible !== false;
      if (!visible) continue;
      const bandPath = geometry.band(side);
      if (!bandPath) continue;
      const style = geometry.ends[side].style;
      bandPath.fillColor = toColor(style.line_color || s.stroke_color);
      bandPath.strokeColor = null;
      // The band is a plain strip; the (uncut) body clips it.
      const clip = windingFillLayer(geometry.bodyPieces(), 'black');
      if (!clip) { bandPath.remove(); continue; }
      layers.push(new paper.Group({ children: [clip, bandPath], clipped: true }));
    }
    new paper.Group(layers.filter(Boolean));
  } else {
    const strokePath = windingFillLayer([band, ...caps.stroke], toColor(s.stroke_color));
    const fillPath = windingFillLayer([inner, ...caps.fill], toColor(s.color));

    // Paint stroke layer, then fill layer, then side bars (top), in order.
    new paper.Group([strokePath, fillPath, ...sideLines].filter(Boolean));
  }

  // Extension rays sit above the body and BELOW the arrows, matching OSS's
  // in-draw order (:2779 extensions, then :2818 arrow heads).
  drawExtensions(s, P, enableThird, S);

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
  // A component with a stylized free end contributes its styled footprint at
  // this width (masked_strand.py _styled_footprint), so the mask follows a
  // trimmed, angled or extended end.
  let path = strandFootprintAtWidth(s, P, enableThird, S, widthW);
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
// geometries (these match drawMask's piece exactly):
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
  // Memoized per render and keyed by (component, width): a mask's fill and stroke
  // regions ask for the same two component outlines at four widths, and a strand
  // that is a component of several masks is stroked once per mask. The intersect
  // and the deletion-rectangle subtraction below stay per call, so the region
  // handed back is always a fresh, caller-owned path.
  const a = cachedGeom(`mcomp|${first.layer_name}|${wA}`,
    () => maskComponentPath(first, P, enableThird, S, wA));
  const b = cachedGeom(`mcomp|${second.layer_name}|${wB}`,
    () => maskComponentPath(second, P, enableThird, S, wB));
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
// drawMask's fill layer. Returns a paper path (caller removes) or null.
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
      // One location lookup + plain arithmetic, same as strokedOutline above.
      const loc = sub.getLocationAt(off);
      const pt = loc && loc.point;
      const nrm = loc && loc.normal;
      if (!pt || !nrm) continue;
      left.push([pt.x + nrm.x * half, pt.y + nrm.y * half]);
      right.push([pt.x - nrm.x * half, pt.y - nrm.y * half]);
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

// ---- Qt QStroker port (polylines; MiterJoin, FlatCap) ----------------------
// get_shadow_blocker_path builds its blocker with QPainterPathStroker, and the
// blocker's EVEN-ODD fill makes the stroker's exact output matter: every loop
// the stroker emits, including the "inner join" excursions it makes back through
// the original corner point, flips the parity of what it encloses. This is a
// line-for-line port of qstroker.cpp (qt_stroke_side + QStroker::joinPoints) for
// closed polylines, which is all the blocker ever strokes (QPathClipper output is
// always flattened). It reproduces Qt 5.15's element list to ~1e-10 px.
const qtFuzzy = (a, b) => Math.abs(a - b) * 1e12 <= Math.min(Math.abs(a), Math.abs(b));
function qtLineAngle(l) {                    // QLineF::angle
  const t = Math.atan2(-(l[3] - l[1]), l[2] - l[0]) * 180 / Math.PI;
  const n = t < 0 ? t + 360 : t;
  return qtFuzzy(n, 360) ? 0 : n;
}
function qtAngleTo(a, b) {                   // QLineF::angleTo (this = a)
  if ((qtFuzzy(a[0], a[2]) && qtFuzzy(a[1], a[3])) || (qtFuzzy(b[0], b[2]) && qtFuzzy(b[1], b[3]))) return 0;
  const d = qtLineAngle(b) - qtLineAngle(a);
  return qtFuzzy(d, 360) ? 0 : (d < 0 ? d + 360 : d);
}
function qtIntersects(a, b) {                // QLineF::intersects: 0 none, 1 bounded, 2 unbounded
  const ax = a[2] - a[0], ay = a[3] - a[1], bx = b[0] - b[2], by = b[1] - b[3];
  const cx = a[0] - b[0], cy = a[1] - b[1];
  const den = ay * bx - ax * by;
  if (den === 0 || !Number.isFinite(den)) return { type: 0 };
  const rec = 1 / den;
  const na = (by * cx - bx * cy) * rec;
  const x = a[0] + ax * na, y = a[1] + ay * na;
  if (na < 0 || na > 1) return { type: 2, x, y };
  const nb = (ax * cy - ay * cx) * rec;
  return { type: nb < 0 || nb > 1 ? 2 : 1, x, y };
}
// Stroke one CLOSED polyline (first point repeated at the end) at `width` and
// return the stroker's subpaths ([[x, y], ...]).
function qtStrokeClosedPolyline(pts, width, miterLimit) {
  const offset = width / 2, limit = width * miterLimit;
  const loops = [];
  let cur = null, b1x = 0, b1y = 0, b2x = 0, b2y = 0;
  const emit = (x, y, move) => {
    b2x = b1x; b2y = b1y; b1x = x; b1y = y;
    if (move) { cur = [[x, y]]; loops.push(cur); } else cur.push([x, y]);
  };
  const join = (fx, fy, nl) => {
    if (qtFuzzy(b1x, nl[0]) && qtFuzzy(b1y, nl[1])) return;   // already connected
    const prev = [b2x, b2y, b1x, b1y];
    const is = qtIntersects(prev, nl);
    const ang = qtAngleTo([b1x, b1y, nl[0], nl[1]], prev);
    if (is.type === 1 || (ang > 90 && !qtFuzzy(ang, 90))) {   // inner join: via the corner
      emit(fx, fy);
      emit(nl[0], nl[1]);
      return;
    }
    if (is.type === 0 || Math.hypot(is.x - b1x, is.y - b1y) > limit) {
      const pl = Math.hypot(prev[2] - prev[0], prev[3] - prev[1]);
      const nlen = Math.hypot(nl[2] - nl[0], nl[3] - nl[1]);
      emit(prev[2] + (prev[2] - prev[0]) / pl * limit, prev[3] + (prev[3] - prev[1]) / pl * limit);
      emit(nl[0] - (nl[2] - nl[0]) / nlen * limit, nl[1] - (nl[3] - nl[1]) / nlen * limit);
    } else {
      emit(is.x, is.y);
    }
    emit(nl[0], nl[1]);
  };
  const side = (seq) => {
    const sx = seq[0][0], sy = seq[0][1];
    let px = sx, py = sy, first = true, startTangent = null;
    for (let i = 1; i < seq.length; i++) {
      const ex = seq[i][0], ey = seq[i][1];
      if (px === ex && py === ey) continue;
      const dx = ex - px, dy = ey - py, l = Math.hypot(dx, dy);
      const nx = dy / l * offset, ny = -dx / l * offset;          // QLineF::normalVector
      const line = [px + nx, py + ny, ex + nx, ey + ny];
      if (first) { emit(line[0], line[1], true); startTangent = line; first = false; }
      else join(px, py, line);
      emit(line[2], line[3]);
      px = ex; py = ey;
    }
    if (!first && qtFuzzy(sx, px) && qtFuzzy(sy, py)) join(px, py, startTangent);
  };
  side(pts);
  side(pts.slice().reverse());
  return loops;
}

// A region's boundary as closed polylines the way QPathClipper hands them to the
// stroker: curves flattened, the first point repeated at the end, duplicate and
// collinear points dropped (QPainterPath::simplified merges parallel lines).
function regionPolylines(region) {
  const out = [];
  const kids = region.children && region.children.length ? region.children : [region];
  for (const kid of kids) {
    let src = kid;
    if (kid.hasHandles && kid.hasHandles()) { src = kid.clone({ insert: false }); src.flatten(0.25); }
    const raw = src.segments.map((sg) => [sg.point.x, sg.point.y]);
    const pts = [];
    for (const p of raw) {
      const q = pts[pts.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
    }
    while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    // Boolean ops on the sampled outlines leave micro-edges and near-straight
    // vertices QPathClipper never produces. Each would make the stroker throw a
    // 15px spike whose parity sliver is thinner than 0.02px, invisible, but
    // enough to derail paper's boolean. Merge them away first.
    let changed = true;
    while (changed && pts.length > 3) {
      changed = false;
      for (let i = 0; i < pts.length && pts.length > 3; i++) {
        const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
        const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
        const cross = ux * vy - uy * vx, dot = ux * vx + uy * vy;
        if (lu < 0.05 || (dot > 0 && Math.abs(cross) <= 1e-3 * lu * lv)) {
          pts.splice(i, 1); i--; changed = true;
        }
      }
    }
    if (pts.length >= 3) { pts.push(pts[0].slice()); out.push(pts); }
  }
  return out;
}

// The EVEN-ODD region of a set of closed rings, returned as the boundary cycles
// of its odd faces: simple polygons that never cross (they may touch at a
// corner). paper.js can't be handed the rings directly: its crossing resolver
// keeps one copy of two coincident edges (right for unions, wrong for even-odd,
// where they cancel) and stumbles on rings passing through a shared corner.
// So this builds the planar arrangement itself: coincident collinear edges are
// cancelled mod 2, every edge is split at every crossing, the faces are traced
// in angular order, and each face is classified by exact ray-cast parity
// against the original rings. rings: [[x, y], ...], implicitly closed.
function evenOddFaces(rings) {
  // -- 1. edges, with exactly overlapping collinear edges cancelled mod 2
  const raw = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    if (a[0] !== b[0] || a[1] !== b[1]) raw.push([a, b]);
  }
  const lines = raw.map((e, idx) => {
    let dx = e[1][0] - e[0][0], dy = e[1][1] - e[0][1];
    const L = Math.hypot(dx, dy); dx /= L; dy /= L;
    if (dy < 0 || (dy === 0 && dx < 0)) { dx = -dx; dy = -dy; }
    return { idx, ang: Math.atan2(dy, dx), off: -dy * e[0][0] + dx * e[0][1], dx, dy };
  }).sort((p, q) => p.ang - q.ang || p.off - q.off);
  const segs = [];
  for (let s = 0; s < lines.length;) {
    let e = s + 1;
    while (e < lines.length && lines[e].ang - lines[e - 1].ang <= 1e-9 && Math.abs(lines[e].off - lines[e - 1].off) <= 1e-7) e++;
    if (e - s === 1) segs.push(raw[lines[s].idx]);
    else {
      const { dx, dy } = lines[s];
      const marks = [], ivs = [];
      for (let k = s; k < e; k++) {
        const [a, b] = raw[lines[k].idx];
        const ta = a[0] * dx + a[1] * dy, tb = b[0] * dx + b[1] * dy;
        marks.push([ta, a], [tb, b]); ivs.push(ta < tb ? [ta, tb] : [tb, ta]);
      }
      marks.sort((p, q) => p[0] - q[0]);
      const ts = [], tp = [];
      for (const [t, p] of marks) if (!ts.length || t - ts[ts.length - 1] > 1e-9) { ts.push(t); tp.push(p); }
      for (let k = 0; k + 1 < ts.length; k++) {
        const mid = (ts[k] + ts[k + 1]) / 2;
        let c = 0;
        for (const iv of ivs) if (iv[0] < mid && mid < iv[1]) c++;
        if (c & 1) segs.push([tp[k], tp[k + 1]]);
      }
    }
    s = e;
  }
  // -- 2. split every segment at every crossing / T-junction
  const n = segs.length;
  const cuts = segs.map(() => []);
  const order = segs.map((sg, i) => i).sort((i, j) => Math.min(segs[i][0][0], segs[i][1][0]) - Math.min(segs[j][0][0], segs[j][1][0]));
  const EPS = 1e-9;
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const [p1, p2] = segs[i];
    const maxXi = Math.max(p1[0], p2[0]);
    const minYi = Math.min(p1[1], p2[1]), maxYi = Math.max(p1[1], p2[1]);
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj];
      const [q1, q2] = segs[j];
      if (Math.min(q1[0], q2[0]) > maxXi) break;
      if (Math.max(q1[1], q2[1]) < minYi || Math.min(q1[1], q2[1]) > maxYi) continue;
      const rx = p2[0] - p1[0], ry = p2[1] - p1[1], sx = q2[0] - q1[0], sy = q2[1] - q1[1];
      const den = rx * sy - ry * sx;
      if (den === 0) continue;                               // parallel (overlaps already cancelled)
      const qpx = q1[0] - p1[0], qpy = q1[1] - p1[1];
      const t = (qpx * sy - qpy * sx) / den, u = (qpx * ry - qpy * rx) / den;
      if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) continue;
      const x = p1[0] + t * rx, y = p1[1] + t * ry;
      if (t > EPS && t < 1 - EPS) cuts[i].push([t, [x, y]]);
      if (u > EPS && u < 1 - EPS) cuts[j].push([u, [x, y]]);
    }
  }
  // -- 3. vertices (snapped), sub-edges, second mod-2 cancellation
  const vid = new Map(), verts = [];
  const V = (p) => {
    const k = Math.round(p[0] * 1e6) + ',' + Math.round(p[1] * 1e6);
    let id = vid.get(k);
    if (id === undefined) { id = verts.length; verts.push(p); vid.set(k, id); }
    return id;
  };
  const edgeCount = new Map();
  for (let i = 0; i < n; i++) {
    const pts = [[0, segs[i][0]], ...cuts[i].sort((a, b) => a[0] - b[0]), [1, segs[i][1]]];
    let prev = V(pts[0][1]);
    for (let k = 1; k < pts.length; k++) {
      const cur = V(pts[k][1]);
      if (cur !== prev) {
        const key = prev < cur ? prev + ':' + cur : cur + ':' + prev;
        edgeCount.set(key, (edgeCount.get(key) || 0) ^ 1);
      }
      prev = cur;
    }
  }
  // -- 4. half-edges sorted by angle around each vertex
  const out = verts.map(() => []);
  for (const [key, c] of edgeCount) {
    if (!c) continue;
    const [a, b] = key.split(':').map(Number);
    out[a].push(b); out[b].push(a);
  }
  for (let v = 0; v < verts.length; v++) {
    const [vx, vy] = verts[v];
    out[v].sort((a, b) => Math.atan2(verts[a][1] - vy, verts[a][0] - vx) - Math.atan2(verts[b][1] - vy, verts[b][0] - vx));
  }
  // -- 5. faces: from half-edge u->v continue with the neighbour of v that comes
  //    just before u in angular order (keeps the face on one consistent side)
  const visited = new Set();
  const cycles = [];
  for (let u = 0; u < verts.length; u++) for (const v0 of out[u]) {
    if (visited.has(u + '>' + v0)) continue;
    const cyc = [];
    let a = u, b = v0, guard = 0;
    while (!visited.has(a + '>' + b) && guard++ < 1e6) {
      visited.add(a + '>' + b);
      cyc.push(a);
      const nb = out[b];
      const idx = nb.indexOf(a);
      const c = nb[(idx - 1 + nb.length) % nb.length];
      a = b; b = c;
    }
    if (cyc.length >= 3) cycles.push(cyc.map((k) => verts[k]));
  }
  // -- 6. keep the cycles whose face (on the side we traced) has odd parity
  const parity = (x, y) => {
    let inside = false;
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const kept = [];
  for (const cyc of cycles) {
    let area = 0;
    for (let i = 0; i < cyc.length; i++) { const p = cyc[i], q = cyc[(i + 1) % cyc.length]; area += p[0] * q[1] - q[0] * p[1]; }
    if (Math.abs(area) < 1e-12) continue;
    // sample just to the face side of the longest edge
    let best = 0, bl = -1;
    for (let i = 0; i < cyc.length; i++) { const p = cyc[i], q = cyc[(i + 1) % cyc.length]; const l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l > bl) { bl = l; best = i; } }
    const p = cyc[best], q = cyc[(best + 1) % cyc.length];
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    const nx = -(q[1] - p[1]) / bl, ny = (q[0] - p[0]) / bl;
    // The walk keeps its face on the left (+90deg) side of every edge, for outer
    // boundaries and hole boundaries alike; the unbounded face comes out odd-free.
    const e = Math.min(1e-5, bl * 1e-3);
    if (parity(mx + nx * e, my + ny * e)) kept.push(cyc);
  }
  return kept;
}

// ---- winding regions of ring sets (robust polygon booleans) ---------------
// The region where `rule(w)` holds, w[k] being the winding number of ring set k
// (sets: [[ring, ...], ...], ring = [[x, y], ...] implicitly closed), returned as
// boundary cycles with the region on their left. Same planar-arrangement idea as
// evenOddFaces, but generalised: every edge is split at every crossing and
// T-junction (collinear overlaps included), the faces are traced, each face is
// classified by its winding numbers, and only the edges with a kept face on one
// side and a dropped face on the other are traced into the result. The output
// therefore never has two coincident edges, which is what paper's own boolean
// ops cannot promise for inputs that overlap themselves (a Qt stroker band, a
// raw offset ring). Used for the grown/eroded shapes of the OSS 2.0 mask shadow
// pipeline (_grown, _opaque_cover), which Qt builds with QPainterPathStroker.
function ringRegion(sets, rule) {
  const segs = [];
  const ringBoxes = sets.map((rings) => rings.map((r) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of r) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return [x0, y0, x1, y1];
  }));
  for (const rings of sets) for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    if (a[0] !== b[0] || a[1] !== b[1]) segs.push([a, b]);
  }
  const n = segs.length;
  const cuts = segs.map(() => []);
  const order = segs.map((sg, i) => i).sort((i, j) => Math.min(segs[i][0][0], segs[i][1][0]) - Math.min(segs[j][0][0], segs[j][1][0]));
  const EPS = 1e-9;
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const [p1, p2] = segs[i];
    const maxXi = Math.max(p1[0], p2[0]);
    const minYi = Math.min(p1[1], p2[1]), maxYi = Math.max(p1[1], p2[1]);
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj];
      const [q1, q2] = segs[j];
      if (Math.min(q1[0], q2[0]) > maxXi) break;
      if (Math.max(q1[1], q2[1]) < minYi || Math.min(q1[1], q2[1]) > maxYi) continue;
      const rx = p2[0] - p1[0], ry = p2[1] - p1[1], sx = q2[0] - q1[0], sy = q2[1] - q1[1];
      const den = rx * sy - ry * sx;
      const qpx = q1[0] - p1[0], qpy = q1[1] - p1[1];
      const lr = Math.hypot(rx, ry), ls = Math.hypot(sx, sy);
      if (Math.abs(den) <= 1e-12 * lr * ls) {
        // parallel: split collinear overlaps at each other's endpoints
        if (Math.abs(qpx * ry - qpy * rx) > 1e-9 * lr) continue;
        const rr = rx * rx + ry * ry, ss2 = sx * sx + sy * sy;
        for (const q of [q1, q2]) {
          const t = ((q[0] - p1[0]) * rx + (q[1] - p1[1]) * ry) / rr;
          if (t > EPS && t < 1 - EPS) cuts[i].push([t, q]);
        }
        for (const p of [p1, p2]) {
          const u = ((p[0] - q1[0]) * sx + (p[1] - q1[1]) * sy) / ss2;
          if (u > EPS && u < 1 - EPS) cuts[j].push([u, p]);
        }
        continue;
      }
      const t = (qpx * sy - qpy * sx) / den, u = (qpx * ry - qpy * rx) / den;
      if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) continue;
      const x = p1[0] + t * rx, y = p1[1] + t * ry;
      if (t > EPS && t < 1 - EPS) cuts[i].push([t, [x, y]]);
      if (u > EPS && u < 1 - EPS) cuts[j].push([u, [x, y]]);
    }
  }
  const vid = new Map(), verts = [];
  const V = (p) => {
    const k = Math.round(p[0] * 1e6) + ',' + Math.round(p[1] * 1e6);
    let id = vid.get(k);
    if (id === undefined) { id = verts.length; verts.push(p); vid.set(k, id); }
    return id;
  };
  const edges = new Set();
  for (let i = 0; i < n; i++) {
    const pts = [[0, segs[i][0]], ...cuts[i].sort((a, b) => a[0] - b[0]), [1, segs[i][1]]];
    let prev = V(pts[0][1]);
    for (let k = 1; k < pts.length; k++) {
      const cur = V(pts[k][1]);
      if (cur !== prev) edges.add(prev < cur ? prev + ':' + cur : cur + ':' + prev);
      prev = cur;
    }
  }
  const out = verts.map(() => []);
  for (const key of edges) {
    const [a, b] = key.split(':').map(Number);
    out[a].push(b); out[b].push(a);
  }
  for (let v = 0; v < verts.length; v++) {
    const [vx, vy] = verts[v];
    out[v].sort((a, b) => Math.atan2(verts[a][1] - vy, verts[a][0] - vx) - Math.atan2(verts[b][1] - vy, verts[b][0] - vx));
  }
  const prevAround = (b, a) => { const nb = out[b]; const idx = nb.indexOf(a); return nb[(idx - 1 + nb.length) % nb.length]; };
  // Faces: half-edge "a>b" -> face id; the walk keeps its face on the left.
  const faceOf = new Map();
  const faces = [];
  for (let u = 0; u < verts.length; u++) for (const v0 of out[u]) {
    if (faceOf.has(u + '>' + v0)) continue;
    const id = faces.length;
    const cyc = [];
    let a = u, b = v0, guard = 0;
    while (!faceOf.has(a + '>' + b) && guard++ < 1e7) {
      faceOf.set(a + '>' + b, id);
      cyc.push(a);
      const c = prevAround(b, a);
      a = b; b = c;
    }
    faces.push(cyc);
  }
  const winding = (x, y, rings, boxes) => {
    let w = 0;
    for (let k = 0; k < rings.length; k++) {
      const bx = boxes[k];
      if (y < bx[1] || y > bx[3] || x > bx[2]) continue;
      const r = rings[k];
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if (yj <= y) {
          if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w++;
        } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w--;
      }
    }
    return w;
  };
  const kept = faces.map((cyc) => {
    if (cyc.length < 3) return false;
    let area = 0;
    for (let i = 0; i < cyc.length; i++) { const p = verts[cyc[i]], q = verts[cyc[(i + 1) % cyc.length]]; area += p[0] * q[1] - q[0] * p[1]; }
    if (Math.abs(area) < 1e-12) return false;
    let best = -1, bl = -1;
    for (let i = 0; i < cyc.length; i++) {
      const p = verts[cyc[i]], q = verts[cyc[(i + 1) % cyc.length]];
      // only edges whose other side is a different face are true boundaries
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > bl && faceOf.get(cyc[(i + 1) % cyc.length] + '>' + cyc[i]) !== faceOf.get(cyc[i] + '>' + cyc[(i + 1) % cyc.length])) { bl = l; best = i; }
    }
    if (best < 0) return false;
    const p = verts[cyc[best]], q = verts[cyc[(best + 1) % cyc.length]];
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    const nx = -(q[1] - p[1]) / bl, ny = (q[0] - p[0]) / bl;
    const e = Math.min(1e-5, bl * 1e-3);
    const x = mx + nx * e, y = my + ny * e;
    return !!rule(sets.map((rings, k) => winding(x, y, rings, ringBoxes[k])));
  });
  // Boundary: half-edges with a kept face on the left and a dropped one on the right.
  const isB = (a, b) => kept[faceOf.get(a + '>' + b)] && !kept[faceOf.get(b + '>' + a)];
  const used = new Set();
  const cycles = [];
  for (let u = 0; u < verts.length; u++) for (const v0 of out[u]) {
    if (used.has(u + '>' + v0) || !isB(u, v0)) continue;
    const cyc = [];
    let a = u, b = v0, guard = 0;
    while (!used.has(a + '>' + b) && guard++ < 1e7) {
      used.add(a + '>' + b);
      cyc.push(verts[a]);
      // next boundary half-edge out of b: rotate from a until one is found
      let x = a, c, spin = 0;
      do { c = prevAround(b, x); x = c; } while (!isB(b, c) && ++spin < out[b].length + 1);
      a = b; b = c;
    }
    if (cyc.length >= 3) cycles.push(cyc);
  }
  return cycles;
}

// paper path from ringRegion cycles (detached; null when empty).
function cyclesToPath(cycles) {
  if (!cycles.length) return null;
  return new paper.CompoundPath({
    children: cycles.map((c) => new paper.Path({ segments: c, closed: true, insert: false })),
    fillRule: 'nonzero',
    insert: false,
  });
}

// A paper region's boundary as closed rings ([[x, y], ...], not repeated), curves
// flattened to `tol` px, oriented so the region (nonzero rule) lies on the left
// of every ring.
function pathRings(path, tol = 0.02) {
  if (!path) return [];
  const kids = path.children && path.children.length ? path.children : (path.segments ? [path] : []);
  const rings = [];
  for (const kid of kids) {
    let src = kid;
    if (kid.hasHandles && kid.hasHandles()) { src = kid.clone({ insert: false }); src.flatten(tol); }
    const pts = [];
    for (const sg of src.segments) {
      const q = pts[pts.length - 1];
      if (!q || q[0] !== sg.point.x || q[1] !== sg.point.y) pts.push([sg.point.x, sg.point.y]);
    }
    while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length >= 3) rings.push(pts);
  }
  // Orient: region on the left (+90deg of the direction, (-dy, dx)).
  for (const r of rings) {
    let best = 0, bl = -1;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > bl) { bl = l; best = i; }
    }
    const p = r[best], q = r[(best + 1) % r.length];
    const e = Math.min(1e-3, bl * 1e-3);
    const x = (p[0] + q[0]) / 2 - (q[1] - p[1]) / bl * e, y = (p[1] + q[1]) / 2 + (q[0] - p[0]) / bl * e;
    if (!path.contains(new paper.Point(x, y))) r.reverse();
  }
  return rings;
}

// The raw offset ring of `ring` (region on its left) pushed `r` px to its
// RIGHT (r > 0: away from the region) — Clipper's construction: a round join
// (arc to within `tol`) where the path turns away from the offset side, a pivot
// through the corner where it turns into it. The positive-winding region of the
// offset rings is the region grown (r > 0) or shrunk (r < 0) by |r|, exactly
// what a round-joined QPainterPathStroker band adds or removes.
function offsetRing(ring, r, tol = 0.02) {
  const n = ring.length;
  const out = [];
  const ar = Math.abs(r);
  const dirs = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    dirs.push([dx / l, dy / l]);
  }
  // right normal of direction d: (dy, -dx); left normal: (-dy, dx)
  const sgn = r >= 0 ? 1 : -1;
  const nrm = (d) => [d[1] * sgn, -d[0] * sgn];
  const step = ar > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / ar)) : Math.PI / 4;
  for (let i = 0; i < n; i++) {
    const v = ring[i];
    const d1 = dirs[(i - 1 + n) % n], d2 = dirs[i];
    const n1 = nrm(d1), n2 = nrm(d2);
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    const dot = d1[0] * d2[0] + d1[1] * d2[1];
    // turning toward the left normal (cross > 0) opens a gap on the right side
    const opens = sgn > 0 ? cross > 1e-12 : cross < -1e-12;
    if (opens) {
      const a1 = Math.atan2(n1[1], n1[0]);
      let a2 = Math.atan2(n2[1], n2[0]);
      let sweep = a2 - a1;
      if (sgn > 0) { while (sweep < 0) sweep += 2 * Math.PI; while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI; }
      else { while (sweep > 0) sweep -= 2 * Math.PI; while (sweep < -2 * Math.PI) sweep += 2 * Math.PI; }
      const k = Math.max(1, Math.ceil(Math.abs(sweep) / step));
      for (let s = 0; s <= k; s++) {
        const t = a1 + sweep * (s / k);
        out.push([v[0] + Math.cos(t) * ar, v[1] + Math.sin(t) * ar]);
      }
    } else if (dot > 0 && Math.abs(cross) <= 1e-12) {
      out.push([v[0] + n2[0] * ar, v[1] + n2[1] * ar]);
    } else {
      out.push([v[0] + n1[0] * ar, v[1] + n1[1] * ar]);
      out.push([v[0], v[1]]);
      out.push([v[0] + n2[0] * ar, v[1] + n2[1] * ar]);
    }
  }
  return out;
}

// shader_utils._grown(path, radius): `path` grown by `rPx` on every side (the
// union with a round-joined stroker band of width 2*r). Detached, or null.
function grownPath(path, rPx) {
  if (!path) return null;
  const rings = pathRings(path);
  if (!rings.length) return null;
  if (rPx <= 0) return cyclesToPath(ringRegion([rings], (w) => w[0] > 0));
  const off = rings.map((r) => offsetRing(r, rPx));
  return cyclesToPath(ringRegion([rings, off], (w) => w[0] > 0 || w[1] > 0));
}

// `path` shrunk by `rPx` (what is left once a stroker band of width 2*r along
// its outline is subtracted). Detached, or null.
function erodedPath(path, rPx) {
  if (!path) return null;
  const rings = pathRings(path);
  if (!rings.length) return null;
  const off = rings.map((r) => offsetRing(r, -rPx));
  return cyclesToPath(ringRegion([rings, off], (w) => w[0] > 0 && w[1] > 0));
}

// Port of get_shadow_blocker_path (shader_utils.py:1902). Qt builds
//   blocker = QPainterPath(base); blocker.addPath(stroker.createStroke(base))
// with base = _get_mask_visual_path (fill ∪ stroke region, simplified() => an
// OddEvenFill path) and a MiterJoin/FlatCap stroker of width max_blur_radius.
// addPath keeps the base's EVEN-ODD rule, so the blocker is the parity of the
// base and both stroke loops: the band INSIDE the mask outline is not blocked
// (it is covered twice), the band outside is, and every inner-join excursion of
// the stroker toggles a wedge back. That lattice is what OSS subtracts, so it is
// what this subtracts. Returns a compound path of simple faces (or null).
function buildShadowBlockerPath(ms, byLayer, P, enableThird, S) {
  const base = buildMaskVisualPath(ms, byLayer, P, enableThird, S);
  if (!base) return null;
  const polys = regionPolylines(base);
  base.remove();
  const rings = [];
  for (const poly of polys) {
    rings.push(poly.slice(0, -1));
    for (const loop of qtStrokeClosedPolyline(poly, MAX_BLUR * S, 2)) rings.push(loop);
  }
  const faces = rings.length ? evenOddFaces(rings) : [];
  if (!faces.length) return null;
  const cp = new paper.CompoundPath({
    children: faces.map((f) => new paper.Path({ segments: f, closed: true })),
    fillRule: 'evenodd',
  });
  // One pass through paper's own boolean (against a far-away speck) turns the
  // faces into its canonical region: collinear pieces merged, orientation fixed.
  // The faces never cross, so this is safe; and later subtractions that share
  // edges with the mask outline (a component casting past its own mask) are
  // only reliable against that canonical form.
  const far = new paper.Path.Rectangle(new paper.Point(-1e7, -1e7), new paper.Size(1, 1));
  const blocker = cp.subtract(far);
  cp.remove();
  far.remove();
  if (blocker && blocker.area && Math.abs(blocker.area) > 0.5) return blocker;
  blocker && blocker.remove();
  return null;
}

// region − blocker(mask), phrased as region ∩ (far rectangle − blocker). The
// blocker's hairline lattice slivers share edges with a region cast by one of
// the mask's own components (both come from the same memoised outline), and
// paper's subtract can come back inside-out on that combination; intersecting
// with the precomputed complement (which shares no edges with anything) does
// not. Memoized per mask per render like the blocker itself.
function subtractBlocker(region, m, byLayer, P, enableThird, S) {
  if (!region) return region;
  const bounds = cachedGeomBounds('blocker|' + m.layer_name,
    () => buildShadowBlockerPath(m, byLayer, P, enableThird, S));
  if (bounds === null) return region;                          // mask blocks nothing
  if (bounds && !bounds.intersects(region.bounds)) return region;
  const comp = cachedGeom('blockerComp|' + m.layer_name, () => {
    const blk = cachedGeom('blocker|' + m.layer_name,
      () => buildShadowBlockerPath(m, byLayer, P, enableThird, S));
    if (!blk) return null;
    const far = new paper.Path.Rectangle(blk.bounds.expand(1e5));
    const c = far.subtract(blk);
    far.remove();
    blk.remove();
    return c;
  });
  if (!comp) return region;
  const r = region.intersect(comp);
  comp.remove();
  region.remove();
  return r;
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
    // Same geometry the receiver pass builds, so it shares the same memo entry.
    // This is the O(N^3) leg of the old cost: every (caster, receiver) pair
    // subtracted every layer between them, rebuilding each one from scratch.
    const geom = cachedGeom('recv|' + name, () => (t.type === 'MaskedStrand'
      ? buildMaskPath(t, byLayer, P, enableThird, S)
      : buildShadowReceiverGeom(t, strands, P, enableThird, S)));
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

// Widget background + grid, in VIEWPORT space (no pan transform). Mirrors the
// order and the coordinate space OSS paints them in: _paintEventInner fills the
// widget and calls draw_grid inside the painter transform but derives the lines
// from the VISIBLE rect, so both track the current offset rather than the content.
// strokeWidth ss => 1px after the ss downscale. LIVE EDITOR ONLY: computeGridLines
// returns null when meta.show_grid is unset (the oracle never sets it).
function paintBackdrop(meta, W, H, ss, S, ox, oy) {
  // canvas_bg 'transparent' (PNG export only): paint NO backdrop, so the frame
  // keeps the clear offscreen it started on, the way OSS save_canvas_as_image
  // fills its QImage with Qt.transparent before painting (main_window.py).
  if (meta.canvas_bg !== 'transparent') {
    const bg = new paper.Path.Rectangle(new paper.Point(0, 0), new paper.Size(W * ss, H * ss));
    bg.fillColor = meta.canvas_bg || 'white'; // themed live editor (OSS dark #2C2C2C); oracle leaves it white
  }
  const grid = computeGridLines(meta, S, ox * ss, oy * ss, W * ss, H * ss);
  if (!grid) return;
  const gridColor = meta.grid_color || toColor({ r: 0, g: 0, b: 0, a: 20 }); // OSS #C8C8C8/#B4B4B4; legacy faint fallback
  // Line width in OUTPUT px (before the ss downscale). Absent => 1px, the live
  // editor's grid. The PNG export passes OSS's pen width under its painter scale.
  const gridWidth = (meta.grid_line_width || 1) * ss;
  for (const x of grid.xs) {
    const ln = new paper.Path.Line(new paper.Point(x, 0), new paper.Point(x, H * ss));
    ln.strokeColor = gridColor; ln.strokeWidth = gridWidth;
  }
  for (const y of grid.ys) {
    const ln = new paper.Path.Line(new paper.Point(0, y), new paper.Point(W * ss, y));
    ln.strokeColor = gridColor; ln.strokeWidth = gridWidth;
  }
}

// Copy the ss-supersampled offscreen `hi` down into the visible canvas. Shared by
// renderFixture and renderPanFrame so a pan frame is composited by exactly the
// same code as the render it stands in for.
function compositeTo(vis, hi, W, H, ss, meta) {
  vis.width = W;
  vis.height = H;
  vis.style.width = W + 'px';
  vis.style.height = H + 'px';
  const ctx = vis.getContext('2d');
  if (ss === 1) {
    ctx.drawImage(hi, 0, 0);
    return;
  }
  if (meta.fast_downscale) {
    // LIVE EDITOR ONLY (gated on meta.fast_downscale, which the offline oracle /
    // fidelity harness never sets). Downscale the ss× supersampled offscreen with
    // the browser's native high-quality filter — a GPU blit — instead of the exact
    // JS box-average below (a W*ss × H*ss triple loop, ~200ms even for a single
    // strand on a 1400×680 canvas). Still fully supersampled, so resting quality is
    // ~indistinguishable; only the offline path keeps the exact Qt-matching box
    // average for byte-identity.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(hi, 0, 0, W * ss, H * ss, 0, 0, W, H);
    return;
  }
  // Match the Qt reference, which downsamples the ss× image with
  // QImage.scaled(..., Qt.SmoothTransformation). For an exact integer ss downscale
  // that is an ss×ss box average in sRGB space. Reproduce it exactly here instead
  // of relying on the browser's imageSmoothing filter (a wider, engine-specific
  // kernel that leaves a ~1px seam on high-contrast curved edges versus Qt's
  // average). The composited image is fully opaque (white background), so a
  // straight per-channel average needs no alpha handling.
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

// Strand.draw: draw_with_lowered_cap around the strand's own drawing (its
// shadow pass, highlight and body), then the lowered caps it paints for its
// attached strands. Hidden strands cast nothing and paint no body (Qt
// draw_strand_shadow / strand.py early-return on is_hidden); hide_shadow (OSS
// 1.109 per-layer "Hide Shadow") casts nothing but still paints; shadow_only
// casts but paints no body.
function drawStrandWithCaps(s, strands, P, enableThird, S) {
  const info = loweredStartCap(s);
  if (SHADOW_ENABLED && s.is_hidden !== true && s.hide_shadow !== true) castStrandShadow(s);
  if (s.is_hidden !== true && !s.shadow_only) drawStrand(s, strands, P, enableThird, S, !!info);
  if (info) drawLoweredCapExtras(s, info);
  drawLoweredCaps(s);
}

// Render `strands` (flat array) using `meta` into the canvas #c.
// `target` (optional, LIVE EDITOR ONLY) composites the frame into that canvas
// instead of #c and retains nothing: the Stylize End Side dialog paints its
// preview picture and shape icons through the very same code the canvas uses
// (end_style_dialog.py _paint_preview / _shape_icon), without disturbing the
// scene the last on-screen render left behind. The offline oracle never passes it.
window.renderFixture = function (strands, meta, target) {
  CURVE = meta.curve_params || CURVE_DEFAULT;
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

  const ox = meta.x_offset, oy = meta.y_offset;

  // A render replaces whatever scene was retained (see PAN_SCENE): each one owns a
  // paper project and an offscreen canvas, and exactly one is ever live. A
  // preview render into `target` leaves the retained scene alone.
  if (!target) dropScene();

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

  // BACKDROP layer — VIEWPORT space, no pan transform. Qt fills the widget itself
  // and derives the grid from the VISIBLE rect (draw_grid,
  // strand_drawing_canvas.py), so neither rides the pan; both are rebuilt for the
  // current offset. Painted first so it composites under the bodies.
  const backdrop = paper.project.activeLayer;
  paintBackdrop(meta, W, H, ss, S, ox, oy);

  // CONTENT layer — the strands, with the pan carried by this layer's MATRIX
  // rather than rebuilt into the geometry. This is OSS's arrangement:
  // _paintEventInner sets up the painter with
  // `painter.translate(self.pan_offset_x, self.pan_offset_y)` and then builds every
  // path in plain canvas coordinates, so a pan moves one transform and invalidates
  // no geometry. renderPanFrame is what cashes that in.
  //
  // The layer is ANCHORED at this render's offset: geometry is built at the offset
  // below (so the matrix starts out identity) and the matrix later carries the
  // DELTA from it. Anchoring rather than building at a bare pt*S is deliberate.
  // paper.js's boolean ops (resolveCrossings/unite) use ABSOLUTE epsilons, so their
  // output is sensitive to coordinate magnitude — this renderer has a known
  // coordinate-dependent degeneracy where a body comes out as a solid black band,
  // and building at raw world*S walks three_strand_braid straight into it. Keeping
  // the build coordinates exactly where they have always been makes every full
  // render bit-identical to before this change, and costs the pan nothing: what a
  // reused scene requires is that the geometry not depend on the CURRENT pan, and
  // an anchor fixed for the scene's lifetime satisfies that just as well as zero.
  const content = new paper.Layer();
  content.applyMatrix = false;   // keep it a transform; don't bake it into children
  content.activate();

  // world -> content space, anchored at this scene's offset. Unchanged from the
  // pre-refactor P: at the anchor the layer matrix is identity, so the coordinates
  // that reach the rasterizer are the same doubles as before.
  const P = (pt) => new paper.Point(pt.x * S + ox * ss, pt.y * S + oy * ss);
  const enableThird = resolveEnableThird(strands, meta);
  BIAS_ENABLED = !!(meta && meta.enable_curvature_bias_control);
  applyPaintSettings(meta);
  // Memoize per-strand shadow geometry for the duration of THIS render (see the
  // geometry memo near the top). Scoped to the paper project set up above and
  // closed before the frame is composited.
  geomCacheBegin();

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
  // Stash the per-pair override dict module-scoped so castStrandShadow can read
  // it in the Port phase without threading a new param. Inert until that phase.
  SHADOW_OVERRIDES = meta.shadow_overrides || {};

  // Draw in layer order (Qt's paint loop): each strand's own shadow pass, then
  // its body; a mask paints at its own place (see drawMask). The frame cache
  // holds what one strand's pass works out for the masks drawn later.
  fcBegin(strands, byLayer, P, enableThird, S);
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    if (s.type === 'MaskedStrand') {
      // shadow_only mask (OSS masked_strand.py): its lift shadow, no piece.
      drawMask(s, s.shadow_only === true);
      continue;
    }
    drawStrandWithCaps(s, strands, P, enableThird, S);
  }

  // After every body, so the preview reads over the finished drawing.
  drawVisibleShadowPaths(strands, byLayer, P, enableThird, S);
  fcEnd();

  // Drop the memo (and its detached masters) before the frame is composited, so
  // no entry can outlive this render's paper project.
  geomCacheEnd();

  paper.view.update();
  if (target) {
    compositeTo(target, hi, W, H, ss, meta);
    // A preview owns nothing past this frame: free its project and hand the
    // active slot back to the retained on-screen scene (if any).
    const previewProject = paper.project;
    try { previewProject.remove(); } catch { /* already gone */ }
    if (PAN_SCENE) { try { PAN_SCENE.project.activate(); } catch { /* torn down */ } }
    return;
  }
  compositeTo(document.getElementById('c'), hi, W, H, ss, meta);

  // RETAIN this render's project as the live scene. renderFixture used to remove
  // it here, because a fresh project per render otherwise piles up in
  // paper.projects and every later frame gets slower. That invariant is kept by
  // dropScene() at the top of this function: exactly one project is ever retained,
  // and the next render frees it. What retention buys is that a pan gesture never
  // has to build anything — the resting render already left the scene it needs.
  PAN_SCENE = { project: paper.project, hi, content, backdrop, key: meta.scene_key, W, H, ss, S, zoom, ox, oy };

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
let DRAG_BG = null; // { bands, W, H, ox, oy, zoom, topo, under }
// Scratch bitmap the moving strands are stroked into each frame, reused across
// frames and across gestures (see renderDragFrame), together with the paper
// Project bound to it. paper.setup() is not cheap: it measures the canvas via
// getBoundingClientRect (a forced style+layout flush), installs the whole
// pointer/touch listener set and writes several vendor-prefixed style
// properties. Doing that once per gesture instead of once per pointer move
// takes a guaranteed reflow out of every drag frame.
let DRAG_MV = null;
let DRAG_MV_PROJECT = null;

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
function computeDragTopology(strands, meta) {
  const enableThird = resolveEnableThird(strands, meta);
  BIAS_ENABLED = !!(meta && meta.enable_curvature_bias_control);
  applyPaintSettings(meta);
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
function _dragPaint(targetCanvas, strands, meta, shouldDraw, whiteBg, topo, persistent) {
  CURVE = meta.curve_params || CURVE_DEFAULT;
  SAMPLE_STEP = DRAG_SAMPLE_STEP; // coarse sampling keeps per-frame stroking cheap

  const W = meta.image_width, H = meta.image_height;
  const S = meta.zoom || 1; // supersample fixed at 1 on the drag path
  targetCanvas.setAttribute('hidpi', 'off');
  // Assigning canvas.width/height reallocates the backing store and clears it —
  // several megabytes of churn per drag frame on a full-window canvas. Only pay
  // it when the size actually changed; paper's view.update() clears the canvas
  // before it draws, so a same-size reuse still starts from a blank surface.
  const resized = targetCanvas.width !== W || targetCanvas.height !== H;
  if (resized) {
    targetCanvas.width = W;
    targetCanvas.height = H;
  }
  if (persistent && DRAG_MV_PROJECT && !resized) {
    // Reuse this gesture's project: activate it (every `new paper.Path` targets
    // the globally active project, so this must precede all drawing) and empty
    // last frame's contents. Removing the children marks the view dirty, so the
    // view.update() at the end still repaints.
    DRAG_MV_PROJECT.activate();
    DRAG_MV_PROJECT.activeLayer.removeChildren();
  } else {
    if (persistent && DRAG_MV_PROJECT) { DRAG_MV_PROJECT.remove(); DRAG_MV_PROJECT = null; }
    paper.setup(targetCanvas);
    if (persistent) DRAG_MV_PROJECT = paper.project;
  }
  if (whiteBg) {
    const bg = new paper.Path.Rectangle(new paper.Point(0, 0), new paper.Size(W, H));
    bg.fillColor = meta.canvas_bg || 'white'; // themed backdrop under drag bands (live editor); oracle unused
  }
  const ox = meta.x_offset, oy = meta.y_offset;
  // Matches renderFixture's P at ss=1: P(pt) = pt*S + offset.
  const P = (pt) => new paper.Point(pt.x * S + ox, pt.y * S + oy);
  if (!topo) topo = computeDragTopology(strands, meta); // defensive self-contained fallback
  const { hasCircles, enableThird } = topo;
  // byLayer is a GEOMETRY lookup, not topology, so it must be rebuilt from THIS
  // frame's array. Taking it from the bake (as hasCircles/enableThird correctly do)
  // froze every mask at its pointer-down shape: drawMask resolves a mask's two
  // components through byLayer, and the store hands the renderer freshly cloned
  // strand objects each frame, so a mask whose component was being dragged kept
  // rendering the intersection computed from pre-drag positions until pointer-up.
  const byLayer = {};
  for (const s of strands) byLayer[s.layer_name] = s;
  BIAS_ENABLED = !!(meta && meta.enable_curvature_bias_control);
  applyPaintSettings(meta);
  SHADOW_ENABLED = false; // no shadows while dragging (restored by renderFixture on release)
  // Memoize component outlines for this paint — but only when something can
  // actually ask for the same outline twice, which on the drag path means a mask
  // (its fill and stroke regions share component outlines, and a selected mask's
  // highlight asks for the fill region again). A band of plain strands is all
  // cold misses, and on a miss the memo costs an extra detach + clone per
  // outline for nothing: measured ~10% on the pointer-down bake of a mask-free
  // document. With no mask in the drawn set the builders fall through to exactly
  // the un-memoized path.
  let memo = false;
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    if (s.type === 'MaskedStrand' && s.is_hidden !== true && shouldDraw(s.layer_name)) { memo = true; break; }
  }
  if (memo) geomCacheBegin();
  // Apply the cached topology (the Map holds every non-masked strand's value,
  // computed once per gesture at bake): a mask's piece keeps clear of the strands
  // above its crossing, drawn or not, so all of them need it.
  for (const s of strands) {
    const hc = hasCircles.get(s.layer_name);
    if (hc) s.has_circles = hc;
  }
  // The same per-paint frame as renderFixture (masks are layers whose piece
  // keeps off the strands above it; lowered joint caps), shadows off.
  fcBegin(strands, byLayer, P, enableThird, S);
  try {
    for (let i = 0; i < strands.length; i++) {
      const s = strands[i];
      if (!shouldDraw(s.layer_name)) continue;
      if (s.is_hidden === true) continue; // same paint gate as renderFixture
      if (s.type === 'MaskedStrand') { drawMask(s, false); continue; }
      drawStrandWithCaps(s, strands, P, enableThird, S);
    }
  } finally {
    fcEnd();
  }
  geomCacheEnd();   // no-op when the memo was never opened; masters die with this paint's project
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
  const topo = computeDragTopology(strands, meta);
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
  // "Draw only affected strand when dragging" (OSS Settings -> General; move_mode.py
  // :668-671 "do NOT draw any strands in the background cache"). Every static band
  // is dropped, leaving the 'move' slot as the only thing renderDragFrame
  // composites over the backdrop, so a drag shows the moved strand alone. Absent
  // from meta => false => every band is baked, which is the existing behaviour.
  const onlyAffected = !!(meta && meta.draw_only_affected_strand);
  // Bake each static run into its own TRANSPARENT bitmap. The white backdrop is
  // painted once on the visible canvas in renderDragFrame (not baked into any
  // band) so the bands composite cleanly in any order regardless of which one is
  // first — including the case where the moving set is at the very bottom and no
  // BELOW band exists.
  for (const b of bands) {
    if (b.kind !== 'band') continue;
    if (onlyAffected) { b.canvas = null; delete b.names; continue; }
    const c = document.createElement('canvas');
    _dragPaint(c, strands, meta, (name) => b.names.has(name), false, topo);
    paper.project.remove();
    b.canvas = c;
    delete b.names; // names only needed during bake
  }
  DRAG_BG = {
    bands, W, H, ox: meta.x_offset, oy: meta.y_offset, zoom: meta.zoom || 1, topo,
    under: null,   // backdrop + grid bitmap, built lazily on the first frame
  };
  return { baked: true, staticCount: strands.length - moving.size, bands: bands.length };
};

// Per-move frame: composite the pre-baked static bands and the live moving
// strokes in TRUE z-order, so a static strand above the moving one still occludes
// it. Falls back to a full renderFixture if no matching bake exists (e.g. the view
// changed mid-gesture). Reuses DRAG_BG.topo (baked once at gesture start) so the
// per-frame cost is O(moving) + k band blits, not O(all strands).
// The backdrop and grid for the current gesture, painted once and cached on
// DRAG_BG. Deliberately reproduces the old per-frame code EXACTLY, including one
// stroke() per grid line: the grid colour can be translucent, so every crossing
// is composited twice and comes out darker. Folding the lines into a single path
// would composite each crossing once and visibly lighten them — the same picture
// only if you never look at an intersection.
function dragUnderlay(meta, W, H) {
  if (DRAG_BG.under) return DRAG_BG.under;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = meta.canvas_bg || 'white'; // themed backdrop (live editor); oracle leaves it white
  ctx.fillRect(0, 0, W, H);
  // ss is fixed at 1 on the drag path, so scale == zoom and the offsets are the
  // raw meta pan. LIVE EDITOR ONLY (computeGridLines null-guards on show_grid).
  const grid = computeGridLines(meta, meta.zoom || 1, meta.x_offset, meta.y_offset, W, H);
  if (grid) {
    ctx.save();
    ctx.strokeStyle = meta.grid_color || 'rgba(0,0,0,0.08)'; // OSS grid color; legacy faint fallback
    ctx.lineWidth = 1;
    for (const x of grid.xs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (const y of grid.ys) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
  }
  DRAG_BG.under = c;
  return c;
}

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
  // The bitmap is reused across frames: a fresh <canvas> per pointermove meant a
  // multi-megabyte allocation (and eventual GC) on every frame of every drag.
  // _dragPaint resizes it only when the size changes and paper clears it before
  // drawing, so each frame still starts from a fully transparent surface.
  if (!DRAG_MV) DRAG_MV = document.createElement('canvas');
  const mv = DRAG_MV;
  _dragPaint(mv, strands, meta, (name) => moving.has(name), false, DRAG_BG.topo, true);
  // The project stays alive for the rest of the gesture; endDrag() removes it.
  const vis = document.getElementById('c');
  // Same story for the visible canvas: writing .width reallocates and clears it.
  // Only touch it on a real size change; the underlay blit below repaints every pixel.
  if (vis.width !== W) vis.width = W;
  if (vis.height !== H) vis.height = H;
  const wpx = W + 'px', hpx = H + 'px';
  if (vis.style.width !== wpx) vis.style.width = wpx;
  if (vis.style.height !== hpx) vis.style.height = hpx;
  const ctx = vis.getContext('2d');
  // Backdrop + grid are identical on every frame of a gesture (the bake key
  // covers size, pan and zoom), so they are baked ONCE into DRAG_BG.under and
  // blitted here. They used to be repainted per frame: a full-canvas clear, a
  // full-canvas fill, and one beginPath/stroke per grid line — on a 1400x900
  // canvas with a 28px grid that is ~80 separate rasterizer submissions every
  // pointer move, all producing the same pixels.
  ctx.drawImage(dragUnderlay(meta, W, H), 0, 0);
  // Composite bands bottom-to-top in document z-order, dropping in the moving
  // strokes at their z-slot. Per-frame work = k band blits + the one mv blit.
  for (const b of DRAG_BG.bands) {
    if (b.kind === 'move') ctx.drawImage(mv, 0, 0);
    else if (b.canvas) ctx.drawImage(b.canvas, 0, 0);  // null when draw_only_affected_strand suppressed the bake
  }
  return { drawn: moving.size, mode: 'dragframe', bands: DRAG_BG.bands.length };
};

// Drop the cached background at the end of a gesture (or before any full render).
window.endDrag = function () {
  DRAG_BG = null;
  if (DRAG_MV_PROJECT) { DRAG_MV_PROJECT.remove(); DRAG_MV_PROJECT = null; }
};

// ---- pan: OSS's painter transform, not a rebuild ------------------------------
// OSS does no work at all to pan. strand_drawing_canvas.mouseMoveEvent (4430) sets
// pan_offset_x/y and calls update(); _paintEventInner then does a FULL repaint with
// `painter.translate(self.pan_offset_x, self.pan_offset_y)` in front of it. That is
// affordable there because a Qt repaint is cheap — every strand body is
// QPainterPathStroker.createStroke() plus drawPath() with WindingFill, i.e. native
// C++ with no boolean algebra anywhere.
//
// Ours is not cheap: ~95% of a render is paper.js resolveCrossings/unite/intersect
// (measured 364ms + 294ms of a 702ms render on three_strand_braid). So we take the
// half of OSS's design that matters — the pan is a TRANSFORM, not an input to the
// geometry — and keep the geometry across frames. renderFixture leaves its content
// layer anchored at the offset it was built for; renderPanFrame serves any later
// offset by putting the delta on that layer's matrix and re-rasterizing. There is
// no snapshot to retake, no margin to run out of, and no full-quality repaint owed
// on pointer-up.
//
// WHAT A PAN FRAME IS, EXACTLY. It is the anchor render TRANSLATED by the delta —
// tools/pan_fidelity.mjs asserts that per fixture and per delta, including that the
// residual is uniquely minimal at the claimed delta. It is NOT bit-identical to a
// fresh renderFixture at the panned offset, and cannot be: renderFixture is not
// offset-invariant (paper.js boolean ops use absolute epsilons, and at some offsets
// they hit the renderer's known body degeneracy). Between the two, the pan frame is
// the stable side — one build serves the whole gesture instead of every frame
// rolling the dice at a new offset.
//
// The delta the caller sends is still rounded to whole pixels, but that is OSS
// parity (Qt hands it integer QPoint deltas, strand_drawing_canvas.py:4430), not
// something this path needs: a fractional delta is served here just as exactly.
//
// The retained scene lives in PAN_SCENE, tagged with the caller's `scene_key`:
// every renderFixture input EXCEPT the pan offset. A key mismatch means the scene
// is for a different document/view, and the caller must render instead.
let PAN_SCENE = null; // { project, hi, content, backdrop, key, W, H, ss, S, zoom, ox, oy }

function dropScene() {
  if (!PAN_SCENE) return;
  const sc = PAN_SCENE;
  PAN_SCENE = null;   // clear first: a remove() that throws must not leave it live
  try { sc.project.remove(); } catch { /* project already torn down */ }
}

// One pan frame. Returns null when the retained scene cannot serve this meta — the
// caller must then do a full render, which retains a scene the next frame can use.
window.renderPanFrame = function (meta) {
  const sc = PAN_SCENE;
  if (!sc) return null;
  const W = meta.image_width, H = meta.image_height;
  const ss = meta.supersample || 2;
  // The key covers everything but the offset; W/H/ss/zoom are re-checked because
  // they size the offscreen and scale the content, and a caller that forgot to fold
  // them into its key would otherwise get a silently wrong frame.
  if (sc.key == null || sc.key !== meta.scene_key) return null;
  if (sc.W !== W || sc.H !== H || sc.ss !== ss || sc.zoom !== (meta.zoom || 1)) return null;

  sc.project.activate();   // every paper construction below targets the active project
  // The pan itself: one matrix, exactly OSS's painter.translate(pan_offset). The
  // scene's geometry sits at the offset it was built at (sc.ox/sc.oy), so what the
  // matrix carries is the delta from there.
  sc.content.matrix = new paper.Matrix(
    1, 0, 0, 1, (meta.x_offset - sc.ox) * ss, (meta.y_offset - sc.oy) * ss);
  // Background + grid are viewport-space (see paintBackdrop), so they are the one
  // thing a pan does rebuild. It is a handful of straight lines — no geometry.
  sc.backdrop.activate();
  sc.backdrop.removeChildren();
  paintBackdrop(meta, W, H, ss, sc.S, meta.x_offset, meta.y_offset);

  sc.project.view.update();
  compositeTo(document.getElementById('c'), sc.hi, W, H, ss, meta);
  return { mode: 'panframe' };
};

// Free the retained scene. Nothing requires this for correctness — the scene is
// keyed, so a stale one can never be served — but a caller that knows no pan is
// coming can hand back the project and its offscreen canvas early.
window.endPan = function () { dropScene(); };

// ---- auto_shadow geometry probe (OSS auto_shadow.py, 2.0) ----------------
// For each requested {casting, receiving} pair: the RAW caster∩receiver overlap
// area and the SURVIVAL ratio measured the way auto_shadow.py does it
// (_surviving_shadow: the legacy, blocker-cutting region above), and, for a pair
// that ratio would hide, how many pixels of its shadow the canvas would show
// (_visible_shadow_px, through the 2.0 pipeline's own preview). Pure computation
// on a throwaway project; nothing is kept. Areas are in WORLD units² — call with
// meta.supersample = 1 and no zoom (S = 1). The pair's own `visibility` override
// is intentionally NOT applied: the caller wipes auto entries first and skips
// user-authored pairs, matching recompute_auto_shadow_overrides.
// _visible_shadow_px (auto_shadow.py): how many pixels of the pair's shadow
// the canvas would show — the Shadow Editor preview of the pair (shadowPreview,
// the renderer's own computation) within its clips, minus the caster and every
// strand drawn after it — counted by filling it (world units, 1 px each).
function visibleShadowPx(cast, recv) {
  const pv = shadowPreview(cast.layer_name, recv.layer_name);
  if (!pv) return 0;
  const rect = pv.clips[0].bounds.intersect(pv.area.bounds).expand(4 * FC.S);
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const ci = rankOf(cast.layer_name);
  const covers = [drawnFootprint(cast)];
  for (const t of FC.strands.slice(ci + 1)) {
    if (isMask(t) || t.is_hidden === true) continue;
    const fp = drawnFootprint(t);
    if (!pEmpty(fp) && fp.bounds.intersects(rect)) covers.push(fp);
  }
  const W = Math.ceil(rect.width / FC.S) + 2, H = Math.ceil(rect.height / FC.S) + 2;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.scale(1 / FC.S, 1 / FC.S);
  ctx.translate(-rect.x, -rect.y);
  for (const c of pv.clips) ctx.clip(new Path2D(c.pathData), c.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
  for (const fp of covers) {
    if (!fp) continue;
    const out = outsidePath(fp, rect);
    ctx.clip(new Path2D(out.pathData), 'evenodd');
  }
  ctx.fillStyle = '#fff';
  ctx.fill(new Path2D(pv.area.pathData), 'nonzero');
  const data = ctx.getImageData(0, 0, W, H).data;
  let shown = 0;
  for (let k = 0; k < data.length; k += 4) if (data[k + 3] > 127) shown++;
  return shown;
}

window.computeShadowPairAreas = function (strands, meta, pairs) {
  CURVE = meta.curve_params || CURVE_DEFAULT;
  SAMPLE_STEP = 1;
  const ss = meta.supersample || 1;
  const zoom = meta.zoom || 1;
  const S = ss * zoom;
  const hi = document.createElement('canvas');
  hi.setAttribute('hidpi', 'off');
  hi.width = 8; hi.height = 8;
  // The probe runs on its own throwaway project, which must be handed back on
  // the way out and the caller's left active again. It is called from inside a
  // store commit — once per mask-affecting edit — so leaving the project behind
  // grew paper.projects without bound, and left a project that is NOT the
  // retained scene active for whatever drew next.
  const callerProject = paper.project;
  paper.setup(hi);
  const probeProject = paper.project;
  try {
    const ox = meta.x_offset || 0, oy = meta.y_offset || 0;
    const P = (pt) => new paper.Point(pt.x * S + ox * ss, pt.y * S + oy * ss);
    const enableThird = resolveEnableThird(strands, meta);
    BIAS_ENABLED = !!(meta && meta.enable_curvature_bias_control);
    applyPaintSettings(meta);

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
    SHADOW_ENABLED = true;
    SHADOW_PAINT = toColor(SHADOW_COLOR);
    fcBegin(strands, byLayer, P, enableThird, S);

    const unit = S * S; // px² per world-unit²
    const idxOf = (name) => strands.findIndex((s) => s.layer_name === name);
    const out = [];
    for (const pr of pairs) {
      const i = idxOf(pr.casting), j = idxOf(pr.receiving);
      const res = { casting: pr.casting, receiving: pr.receiving, rawArea: 0, ratio: 0, visiblePx: 0 };
      out.push(res);
      if (i < 0 || j < 0 || j >= i) continue;
      const s = strands[i], o = strands[j];
      if (s.type === 'MaskedStrand') continue; // candidates are body strands

      // _surviving_shadow (auto_shadow.py): the caster grown by a fixed 30 px
      // (build_shadow_geometry(cs, 30, include_circles=False)) plus its circles,
      // on the receiver, then the old pipeline's cuts (subtracted layers, mask
      // shadow blockers grown by 30, intermediate strands). The renderer no
      // longer cuts blockers, but AUTO_HIDE_SURVIVAL_RATIO was tuned on this.
      const w = s.width || 0, sw = s.stroke_width || 0;
      const blurSaved = MAX_BLUR;
      MAX_BLUR = 30.0;
      let footprint = null, circles = null, core = null;
      try {
        core = strandFootprintAtWidth(s, P, enableThird, S, w + 2 * sw + 60);
        if (!core) continue;
        circles = buildShadowCasterCircles(s, P, S);
        footprint = core.clone();
        if (circles) { const u = footprint.unite(circles); footprint.remove(); footprint = u; }
        // RAW overlap: caster footprint ∩ receiver rendered geometry.
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
          const r = legacySurvivingRegion(
            s, i, o, j, strands, byLayer, P, enableThird, S, footprint, ov, allowFull, null);
          const survArea = r.region ? Math.abs(r.region.area || 0) / unit : 0;
          r.region && r.region.remove();
          r.recv && r.recv.remove();
          r.clipBlocker && r.clipBlocker.remove();
          res.ratio = survArea / res.rawArea;
        }
      } finally {
        MAX_BLUR = blurSaved;
        footprint && footprint.remove(); core && core.remove(); circles && circles.remove();
      }
      // _visible_shadow_px: only asked for a pair the ratio would hide.
      if (res.rawArea > 0 && res.ratio < 0.45) res.visiblePx = visibleShadowPx(s, o);
    }
    return out;
  } finally {
    fcEnd();
    probeProject.remove();
    // activate() on a project torn down by a concurrent render would throw, and
    // the probe's answer must not be lost to bookkeeping.
    try { if (callerProject && callerProject !== probeProject) callerProject.activate(); } catch { /* gone */ }
  }
};

// Test hook for tools/mask_shadow_check.mjs (the OSS tests test_joint_shadow.py,
// test_mask_piece_cover.py, test_shadow_subtraction.py): runs one query against
// the 2.0 shadow pipeline's internals on a throwaway project, in WORLD units
// (S = 1, no offset), with every shadow shown. Nothing is drawn or kept.
//   {op: 'covering', mask}                 -> layer names the piece keeps clear of
//   {op: 'keep', mask, points}             -> null (no clip) or [inside?] per point
//   {op: 'lowered', child}                 -> null or {parent, crossers}
//   {op: 'loweredCapPart', child, distance} -> [in cap, in raw parent, in parent] at the
//        point `distance` past the joint along the child's start tangent
//   {op: 'outline', caster, receiver, points, disc?: {x, y, r}}
//        -> null (no shadow there) or {contains: [...], discArea, bounds, casterBounds}
//   {op: 'runsUnder', width, stroke_width, footprint: rect, piece: rect} -> bool
//   {op: 'opaqueCover', strand, footprint: rect, points} -> null or [inside?]
// Debugging aids (compare with the same OSS internals when chasing a diff):
//   {op: 'at', point}            -> the outlines / fills / lifts / clips at a point
//   {op: 'outlines', caster}     -> a caster's receivers with bounds and areas
//   {op: 'zone', mask, strand?}  -> the mask's zone and piece (and strand ∩ zone)
//   {op: 'near', caster}         -> _masks_near: [first, second, upper, lower, between]
window.__maskShadowProbe = function (strands, meta, q) {
  CURVE = meta.curve_params || CURVE_DEFAULT;
  SAMPLE_STEP = 1;
  const hi = document.createElement('canvas');
  hi.setAttribute('hidpi', 'off');
  hi.width = 8; hi.height = 8;
  const callerProject = paper.project;
  paper.setup(hi);
  const probeProject = paper.project;
  try {
    const P = (pt) => new paper.Point(pt.x, pt.y);
    const enableThird = resolveEnableThird(strands, meta);
    BIAS_ENABLED = !!(meta && meta.enable_curvature_bias_control);
    applyPaintSettings(meta);
    const byLayer = {};
    for (const s of strands) byLayer[s.layer_name] = s;
    for (const s of strands) if (s.type !== 'MaskedStrand') s.has_circles = computeHasCircles(s, strands);
    SHADOW_OVERRIDES = meta.shadow_overrides || {};
    SHADOW_ENABLED = true;
    SHADOW_PAINT = toColor(SHADOW_COLOR);
    fcBegin(strands, byLayer, P, enableThird, 1);
    const rect = (r) => new paper.Path.Rectangle({ point: [r[0], r[1]], size: [r[2], r[3]], insert: false });
    const inside = (path, pts) => pts.map((p) => !!path && path.contains(new paper.Point(p[0], p[1])));
    const box = (b) => (b ? [b.x, b.y, b.width, b.height] : null);
    switch (q.op) {
      case 'covering': return coveringStrands(byLayer[q.mask]).map((c) => c.t.layer_name).sort();
      case 'keep': { const k = pieceKeep(byLayer[q.mask]); return k ? inside(k, q.points) : null; }
      case 'lowered': {
        const info = loweredStartCap(byLayer[q.child]);
        return info ? { parent: info.parent.layer_name, crossers: info.crossers.map((t) => t.layer_name) } : null;
      }
      case 'loweredCapPart': {
        const child = byLayer[q.child];
        const info = loweredStartCap(child);
        if (!info) return null;
        const cl = det(buildCenterline(child, P, enableThird));
        const a = tangentAngle(cl, 0);
        const pt = [child.start.x + q.distance * Math.cos(a), child.start.y + q.distance * Math.sin(a)];
        const parent = info.parent;
        return [inside(info.cap, [pt])[0], inside(geomRaw(parent), [pt])[0], inside(geomRendered(parent), [pt])[0]];
      }
      case 'outline': {
        const col = collectShadow(byLayer[q.caster]);
        const o = col && col.outlines.find((x) => x.recv === q.receiver);
        if (!o) return null;
        let discArea = 0;
        if (q.disc) discArea = pArea(pInter(o.path, circlePath(new paper.Point(q.disc.x, q.disc.y), q.disc.r)));
        const caster = byLayer[q.caster];
        const grown = strandFootprintAtWidth(caster, P, enableThird, 1, (caster.width || 0) + 2 * (caster.stroke_width || 0) + 2);
        return { contains: inside(o.path, q.points || []), discArea, bounds: box(o.path.bounds), casterBounds: box(grown && grown.bounds) };
      }
      case 'at': {
        // Debug: every caster's outlines / lifts / clip containing a point.
        const pt = new paper.Point(q.point[0], q.point[1]);
        const out = [];
        for (const t of strands) {
          if (isMask(t)) { const pc = piecePath(t); if (pc && pc.contains(pt)) out.push(`piece ${t.layer_name}`); continue; }
          const col = collectShadow(t);
          if (!col) continue;
          for (const o of col.outlines) if (o.path.contains(pt)) out.push(`${t.layer_name}->${o.recv}`);
          for (const f of col.fills) if (f.contains(pt)) out.push(`${t.layer_name} fill`);
          if (col.lifts.some((l) => l.contains(pt))) out.push(`${t.layer_name} lift`);
          if (col.clip && col.clip.contains(pt)) out.push(`${t.layer_name} clip`);
        }
        return out;
      }
      case 'outlines': {
        const col = collectShadow(byLayer[q.caster]);
        if (!col) return null;
        return {
          outlines: col.outlines.map((o) => [o.recv, box(o.path.bounds), pArea(o.path)]),
          lifts: col.lifts.map((l) => [box(l.bounds), pArea(l)]),
          clip: col.clip ? box(col.clip.bounds) : null,
        };
      }
      case 'zone': {
        const m = byLayer[q.mask];
        const z = zonePath(m), pc = piecePath(m);
        const g = q.strand ? geomRendered(byLayer[q.strand]) : null;
        return { zone: z && [box(z.bounds), pArea(z)], piece: pc && [box(pc.bounds), pArea(pc)],
          cut: g && z ? pArea(pInter(g, z)) : null, whole: wholeMask(m) };
      }
      case 'near': return masksNear(byLayer[q.caster]).map((sd) => [sd.first, sd.second, [...sd.upper].sort(), [...sd.lower].sort(), [...sd.between].sort()]);
      case 'runsUnder': return runsUnder({ width: q.width, stroke_width: q.stroke_width }, rect(q.footprint), rect(q.piece));
      case 'opaqueCover': { const c = opaqueCover(q.strand, rect(q.footprint)); return c ? inside(c, q.points) : null; }
      default: throw new Error('unknown probe op ' + q.op);
    }
  } finally {
    fcEnd();
    probeProject.remove();
    try { if (callerProject && callerProject !== probeProject) callerProject.activate(); } catch { /* gone */ }
  }
};

// The FILL region of one mask (Qt get_mask_path(), exactly the region drawMask
// paints) handed back for the "Draw Names" label: OSS draw_strand_label centres a
// mask's label on mask_path.boundingRect() and clips the text to that path
// (strand_drawing_canvas.py draw_strand_label). Pure computation on a throwaway
// project, like computeShadowPairAreas above, and nothing is kept. Geometry is
// in WORLD units (identity P, S = 1) so the caller applies its own view
// transform. Returns { pathData, bounds: {x, y, width, height} } or null when
// the mask has no region (missing component, fully erased).
window.maskLabelClip = function (maskName, strands, meta) {
  CURVE = meta.curve_params || CURVE_DEFAULT;
  SAMPLE_STEP = 1;
  const hi = document.createElement('canvas');
  hi.setAttribute('hidpi', 'off');
  hi.width = 8; hi.height = 8;
  const callerProject = paper.project;
  paper.setup(hi);
  const probeProject = paper.project;
  try {
    const P = (pt) => new paper.Point(pt.x, pt.y);
    const enableThird = resolveEnableThird(strands, meta);
    BIAS_ENABLED = !!(meta && meta.enable_curvature_bias_control);
    applyPaintSettings(meta);
    const byLayer = {};
    for (const s of strands) byLayer[s.layer_name] = s;
    const ms = byLayer[maskName];
    if (!ms || ms.type !== 'MaskedStrand') return null;
    for (const s of strands) {
      if (s.type === 'MaskedStrand') continue;
      s.has_circles = computeHasCircles(s, strands);
    }
    const region = buildMaskPath(ms, byLayer, P, enableThird, 1);
    if (!region) return null;
    const b = region.bounds;
    const out = { pathData: region.pathData, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } };
    region.remove();
    return out;
  } finally {
    probeProject.remove();
    try { if (callerProject && callerProject !== probeProject) callerProject.activate(); } catch { /* gone */ }
  }
};

// The SELECTION footprint of one mask (Qt MaskedStrand.get_selection_path():
// get_mask_path_stroke() UNITED with get_mask_path(), masked_strand.py:281-287 —
// the stroke layer plus the fill layer, minus the deletion rectangles) as SVG
// path data in WORLD units. It is what OSS hovers, highlights and hit-tests a
// mask against, and the editor's overlay / hitTest use it for exactly that.
// Same throwaway-project pattern as maskLabelClip; nothing is kept. Returns
// { pathData, bounds } or null when the mask has no region.
window.maskSelectionPath = function (maskName, strands, meta) {
  CURVE = meta.curve_params || CURVE_DEFAULT;
  SAMPLE_STEP = 1;
  const hi = document.createElement('canvas');
  hi.setAttribute('hidpi', 'off');
  hi.width = 8; hi.height = 8;
  const callerProject = paper.project;
  paper.setup(hi);
  const probeProject = paper.project;
  try {
    const P = (pt) => new paper.Point(pt.x, pt.y);
    const enableThird = resolveEnableThird(strands, meta);
    BIAS_ENABLED = !!(meta && meta.enable_curvature_bias_control);
    applyPaintSettings(meta);
    const byLayer = {};
    for (const s of strands) byLayer[s.layer_name] = s;
    const ms = byLayer[maskName];
    if (!ms || ms.type !== 'MaskedStrand') return null;
    for (const s of strands) {
      if (s.type === 'MaskedStrand') continue;
      s.has_circles = computeHasCircles(s, strands);
    }
    const region = buildMaskVisualPath(ms, byLayer, P, enableThird, 1);
    if (!region) return null;
    const b = region.bounds;
    const out = { pathData: region.pathData, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } };
    region.remove();
    return out;
  } finally {
    probeProject.remove();
    try { if (callerProject && callerProject !== probeProject) callerProject.activate(); } catch { /* gone */ }
  }
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
