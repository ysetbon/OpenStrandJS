// Why a strand body can read as "square-like" on screen while its selection
// highlight stays smooth, and why a drag makes it worse.
//
//   node tools/geometry_fidelity_check.mjs [fixture.json ...]
//
// OpenStrand Studio builds a strand body with QPainterPathStroker.createStroke()
// on the cubic Bezier (strand.py:2510-2519 / :2595-2600). That is an ANALYTIC
// offset: the boundary comes back as curves and only Qt's rasteriser flattens
// it, in device space, well under a pixel.
//
// OpenStrandJS has no stroker, so web/strand-renderer.js::strokedOutline()
// re-implements one by sampling the centreline every SAMPLE_STEP px of ARC
// LENGTH and offsetting each sample by +/- half the width along the normal. The
// result is a POLYGON: straight edges, no joins, no curve fitting.
//
// The catch this tool measures: the sampling is uniform along the CENTRELINE,
// but the boundary being drawn lives half a width away from it. On the outside
// of a bend of radius R that boundary is longer by (R + half) / R, so one
// "1px" step lands a facet (R + half) / R pixels long. Strand widths are tens
// of pixels and OpenStrandJS's own curve profile routinely bends at R = 2-10px,
// so the magnification reaches x10 - and the drag path triples the step again
// (DRAG_SAMPLE_STEP = 3).
//
// Reports, per strand:
//   * tightest bend radius, and the resulting arc-length magnification
//   * the longest facet actually laid down, at rest and mid-drag
//   * the bulge (sagitta) that facet has relative to the true offset
//   * whether the naive offset self-intersects (R < half), which is why the
//     body is filled with the nonzero rule instead of a boolean union
//   * how the selection highlight for that strand is built - a native Bezier
//     stroke (exact) or, for an unfolded end, a 101-point resample
// and, per fixture, how many painted pixels move when the pointer is released.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const files = process.argv.slice(2);
if (!files.length) files.push('fixtures/three_strand_braid.json');

const strandsOf = (f) => {
  const d = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
  return d.strands || d.states.find((s) => s.step === d.current_step).data.strands;
};

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {},
);
const page = await browser.newPage({ deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(pathToFileURL(path.join(root, 'web', 'render.html')).href + '?v=' + Date.now());
await page.waitForFunction(() => typeof window.renderFixture === 'function');

for (const f of files) {
  const strands = strandsOf(f);
  const r = await page.evaluate(({ strands }) => {
    const W = 2200, H = 1500;
    const c = document.getElementById('c');
    c.width = W; c.height = H; c.setAttribute('hidpi', 'off');
    paper.setup(c);
    CURVE = CURVE_DEFAULT;
    const P = (pt) => new paper.Point(pt.x, pt.y);
    const rows = [];

    for (const s of strands) {
      if (s.type === 'MaskedStrand') continue;
      const w = (s.width || 0) + 2 * (s.stroke_width || 0);
      const half = w / 2;
      const cl = buildCenterline(s, P, s.control_point_center != null);
      const L = cl.length;

      let minR = Infinity;
      for (let i = 0; i <= 4000; i++) {
        const k = Math.abs(cl.getCurvatureAt(Math.min(L * i / 4000, L - 1e-4)));
        if (Number.isFinite(k) && k > 1e-9) minR = Math.min(minR, 1 / k);
      }

      // Cusps: places where the centreline's normal swings more than 90deg
      // between adjacent samples, i.e. the curve doubles back on itself. The
      // offset there does not just bend, it jumps to the other side, so the
      // polygon lays down one edge a full width long straight across the body.
      // Nonzero winding still fills it, but resolveCrossings() - which every
      // shadow footprint and mask component goes through - does not survive it.
      let cusps = 0, prevN = null;
      const NS = Math.max(8, Math.ceil(L));
      for (let i = 0; i <= NS; i++) {
        const n = cl.getLocationAt(Math.min(L * i / NS, L - 1e-4)).normal;
        if (prevN && Math.abs(prevN.getDirectedAngle(n)) > 90) cusps++;
        prevN = n;
      }

      // Longest edge of the painted boundary, ignoring the two edges that jump
      // from one side of the band to the other - those are the flat end caps.
      const facet = (step) => {
        SAMPLE_STEP = step;
        const o = strokedOutline(cl, w);
        SAMPLE_STEP = 1;
        const segs = o.segments, hN = segs.length / 2;
        let max = 0;
        for (let i = 0; i < segs.length; i++) {
          if (i === hN - 1 || i === segs.length - 1) continue;
          max = Math.max(max, segs[i].point.getDistance(segs[(i + 1) % segs.length].point));
        }
        o.remove();
        return max;
      };
      const sag = (chord, Ro) => (Number.isFinite(Ro)
        ? Ro - Math.sqrt(Math.max(0, Ro * Ro - (chord / 2) * (chord / 2))) : 0);
      const Ro = minR + half;
      const f1 = facet(1), f3 = facet(3);

      // How drawHighlight builds this strand's halo.
      const sc = s.start_circle_stroke_color != null ? s.start_circle_stroke_color : s.circle_stroke_color;
      const ec = s.end_circle_stroke_color != null ? s.end_circle_stroke_color : s.circle_stroke_color;
      const a0 = sc && sc.a != null ? sc.a : 255, a1 = ec && ec.a != null ? ec.a : 255;
      const hlResampled = (a0 === 0 || a1 === 0) && L > 10;
      const hlHalf = (w + 10) / 2;
      const hlFacet = hlResampled
        ? (L / 100) * (Number.isFinite(minR) ? (minR + hlHalf) / minR : 1) : 0;

      rows.push({
        layer: s.layer_name, half, len: L, minR,
        magnify: Number.isFinite(minR) ? Ro / minR : 1,
        f1, f3, sag1: sag(f1, Ro), sag3: sag(f3, Ro),
        folds: minR < half, cusps, hlResampled, hlFacet,
      });
      cl.remove();
    }

    // Last drag frame vs the render that lands on pointer-up. Supersample,
    // shadows, pan and zoom are held equal, so SAMPLE_STEP is the only variable.
    const meta = {
      image_width: W, image_height: H, x_offset: 0, y_offset: 0,
      supersample: 1, zoom: 1, shadow_enabled: false, canvas_bg: 'white',
    };
    const grab = () => c.getContext('2d').getImageData(0, 0, W, H).data.slice();
    const names = strands.filter((s) => s.type !== 'MaskedStrand').map((s) => s.layer_name);
    window.endDrag();
    window.renderFixture(strands, meta);
    const rel = grab();
    const dmeta = { ...meta, drag: { moving: names } };
    window.renderDragBackground(strands, dmeta);
    window.renderDragFrame(strands, dmeta);
    const drg = grab();
    window.endDrag();
    let ink = 0, moved = 0;
    for (let i = 0; i < rel.length; i += 4) {
      if (rel[i] !== 255 || rel[i + 1] !== 255 || rel[i + 2] !== 255) ink++;
      const d = Math.max(Math.abs(rel[i] - drg[i]), Math.abs(rel[i + 1] - drg[i + 1]),
        Math.abs(rel[i + 2] - drg[i + 2]));
      if (d > 8) moved++;
    }
    return { rows, ink, moved };
  }, { strands });

  console.log(`\n=== ${f}`);
  console.log('layer    half   tightest R   outer arc x   longest painted facet     its bulge vs the true offset');
  console.log('                                            rest      drag           rest       drag');
  for (const x of r.rows) {
    console.log(
      `${x.layer.padEnd(8)} ${String(x.half).padStart(4)} ${(Number.isFinite(x.minR) ? x.minR.toFixed(1) : 'straight').padStart(12)}`
      + `   ${('x' + x.magnify.toFixed(2)).padStart(8)}   ${x.f1.toFixed(2).padStart(7)}px ${x.f3.toFixed(2).padStart(8)}px`
      + `      ${x.sag1.toFixed(3).padStart(7)}px ${x.sag3.toFixed(3).padStart(8)}px`
      + (x.folds ? '   [offset self-intersects]' : '')
      + (x.cusps ? `   [${x.cusps} cusp(s): the long edge is the offset jumping sides, not a bend facet]` : ''));
  }
  const resampled = r.rows.filter((x) => x.hlResampled);
  if (resampled.length) {
    console.log('\n  selection highlight built from a 101-point resample (unfolded end), longest halo facet:');
    for (const x of resampled) {
      console.log(`    ${x.layer.padEnd(8)} ${x.hlFacet.toFixed(1)}px`);
    }
  }
  console.log(`\n  painted pixels: ${r.ink};  pixels that move on pointer-up: ${r.moved}`
    + ` (${(r.moved / r.ink * 100).toFixed(2)}%)`);
}
await browser.close();
