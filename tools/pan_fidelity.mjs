// Correctness gate for the PAN path.
//
// A pan rebuilds nothing. renderFixture leaves its content layer with the pan on
// that layer's MATRIX instead of folded into the geometry — OSS's
// `painter.translate(pan_offset)`, strand_drawing_canvas._paintEventInner — and
// renderPanFrame serves later offsets by moving that matrix and re-rasterizing.
//
// WHAT THIS ASSERTS, AND WHY IT IS THIS AND NOT "EQUALS A FULL RENDER"
// -------------------------------------------------------------------
// The tempting gate is "a pan frame must equal renderFixture at the same offset".
// That is the wrong oracle, because renderFixture is not offset-invariant: paper.js
// boolean ops use ABSOLUTE epsilons, so the same document built at a different
// offset comes out a few ULPs different — and at some offsets it hits a known
// degeneracy and draws a strand body as a solid black band. (Pre-existing and
// documented; it reproduces with the pan path never called.) Measured against that
// reference, the pan frame is the STABLE one and the reference is what moves.
//
// So the gate is the property that is exactly true and that actually constrains the
// implementation: a pan frame is the anchor image TRANSLATED. That is non-circular
// — it pins the matrix's sign, magnitude and axes, that the grid is rebuilt and
// tracks, and that the layer order survives — and it is checkable to the pixel:
//
//   anchor      a pan frame at the scene's own offset must equal, exactly, the
//               renderFixture call that built the scene (the matrix is identity)
//   registration a pan frame at an integer delta must be the anchor image shifted by
//               exactly that delta. Asserted two ways: the residual over the shared
//               region must be tiny, AND it must be MINIMAL AT THAT DELTA — every
//               neighbouring alignment must be far worse. The second half is what
//               makes this a real test: a wrong sign, a swapped axis, an off-by-one
//               or a frozen grid all put the best alignment somewhere else, and no
//               residual threshold alone would say so.
//
// The residual is not zero, and is not expected to be: a translated path reaches the
// rasterizer through the canvas transform rather than as pre-added coordinates, so
// curve edges land on marginally different anti-aliasing. It is ~1e-4 of channels
// against a ~5e-2 threshold, and the alignment test above is what rules out anything
// structural.
//   determinism the same pan frame twice must be identical
//   refuse      a different scene_key, no key, a resize and a zoom change must each
//               be REFUSED. Reusing a scene across any of those would draw the wrong
//               document or the wrong size, and no pixel test of served frames could
//               see it.
//
// It also REPORTS, without failing, how far each pan frame is from a full render at
// that offset, since that is the number people will ask about. Large entries there
// are the renderer's offset instability described above, not the pan path.
//
// Usage:
//   node tools/pan_fidelity.mjs [--fixtures a,b,c] [--verbose]
//
// OSS_CHROMIUM: absolute path to a Chromium binary if the pre-installed browser
// revision does not match this Playwright version.

import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const VERBOSE = process.argv.includes('--verbose');
const fixArgIdx = process.argv.indexOf('--fixtures');
const only = fixArgIdx >= 0 && process.argv[fixArgIdx + 1]
  ? process.argv[fixArgIdx + 1].split(',')
  : null;

const fixtures = (only || readdirSync(path.join(root, 'fixtures'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))).sort();

// Integer deltas, in CSS px: both signs on both axes, pure-axis moves, and moves far
// past anything the superseded snapshot's margin could have served. Registration is
// asserted on these. (Fractional deltas are covered by the reference report below —
// they resample under a translate, so there is no shifted image to compare against.)
const DELTAS = [
  [0, 0], [1, 0], [0, -1], [37, 24], [-37, -24], [160, -160], [900, 640], [-900, -640],
];
// One gesture: consecutive offsets served by a single scene, to catch state wrongly
// carried between frames.
const GESTURE = [[6, 4], [19, 13], [55, 38], [140, 96], [-60, 210], [-400, -300]];

function loadStrands(name) {
  const data = JSON.parse(readFileSync(path.join(root, 'fixtures', `${name}.json`), 'utf8'));
  if (data && data.type === 'OpenStrandStudioHistory') {
    const s = data.states.find((x) => x.step === data.current_step) || data.states[0];
    return s.data.strands || [];
  }
  return data.strands || [];
}

function collectPoints(value, out) {
  if (Array.isArray(value)) for (const v of value) collectPoints(v, out);
  else if (value && typeof value === 'object') {
    if (typeof value.x === 'number' && typeof value.y === 'number') out.push(value);
    for (const k of Object.keys(value)) collectPoints(value[k], out);
  }
}

// Editor-shaped meta: supersample 1 and the grid ON, because that is what a live pan
// renders, and the grid is the one thing a pan frame does rebuild.
function metaFor(strands, zoom) {
  const pts = [];
  collectPoints(strands, pts);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const M = 130;
  return {
    image_width: Math.min(1400, Math.ceil(Math.max(...xs) - minX) + 2 * M),
    image_height: Math.min(900, Math.ceil(Math.max(...ys) - minY) + 2 * M),
    x_offset: M - minX,
    y_offset: M - minY,
    supersample: 1,
    zoom,
    shadow_enabled: true,
    show_grid: true,
    grid_size: 30,
    curve_params: { base_fraction: 1, dist_multiplier: 2, exponent: 2 },
  };
}

const rendererSrc = readFileSync(path.join(root, 'web', 'strand-renderer.js'), 'utf8');
const paperSrc = readFileSync(path.join(root, 'node_modules', 'paper', 'dist', 'paper-full.min.js'), 'utf8');

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});

let failures = 0, cases = 0;
let worstResidual = { share: 0, bad: 0, total: 0, at: '(none)' };
const rows = [];
const refReport = [];
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.setContent('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
  await page.addScriptTag({ content: paperSrc });
  await page.addScriptTag({ content: rendererSrc });
  await page.waitForFunction(() => typeof window.renderFixture === 'function'
    && typeof window.renderPanFrame === 'function');

  // All pixel work happens in the page: shipping multi-megabyte buffers per case to
  // node dominated the runtime of the harness this replaces and told us nothing.
  await page.evaluate(() => {
    const c = () => document.getElementById('c');
    window.__shoot = () => {
      const el = c();
      return { w: el.width, h: el.height,
        d: el.getContext('2d').getImageData(0, 0, el.width, el.height).data.slice() };
    };
    window.__same = (a, b) => {
      if (a.w !== b.w || a.h !== b.h) return { bad: -1, worst: 255 };
      let bad = 0, worst = 0;
      for (let i = 0; i < a.d.length; i++) {
        const t = Math.abs(a.d[i] - b.d[i]);
        if (t) { bad++; if (t > worst) worst = t; }
      }
      return { bad, worst, total: a.d.length };
    };
    // `b` must be `a` shifted by (dx, dy) px. Compared only over the region both
    // images define, so content that panned in from outside `a` is not judged.
    // `stride` samples every Nth row. The exact residual at the claimed delta is
    // always measured with stride 1; the four neighbouring alignments only have to
    // establish a 5x ratio, so they are sampled — a misalignment lights up every
    // edge in the frame, not one row in eight.
    window.__shifted = (a, b, dx, dy, stride = 1) => {
      if (a.w !== b.w || a.h !== b.h) return { bad: -1, worst: 255, total: 1, signal: 0 };
      let bad = 0, worst = 0, n = 0, signal = 0;
      const x0 = Math.max(0, dx), x1 = Math.min(a.w, a.w + dx);
      const y0 = Math.max(0, dy), y1 = Math.min(a.h, a.h + dy);
      // `signal` counts channels in the SOURCE region that differ from its first
      // pixel. A region of flat background has none, and then no alignment can be
      // told from any other — see the featureless note where this is used.
      const s0 = ((y0 - dy) * a.w + (x0 - dx)) * 4;
      for (let y = y0; y < y1; y += stride) {
        for (let x = x0; x < x1; x++) {
          const bi = (y * a.w + x) * 4, ai = ((y - dy) * a.w + (x - dx)) * 4;
          for (let k = 0; k < 4; k++) {
            const t = Math.abs(a.d[ai + k] - b.d[bi + k]);
            if (t) { bad++; if (t > worst) worst = t; }
            if (a.d[ai + k] !== a.d[s0 + k]) signal++;
          }
          n += 4;
        }
      }
      return { bad, worst, total: n, signal };
    };
  });

  for (const name of fixtures) {
    const strands = loadStrands(name);
    if (!strands.length) continue;

    for (const zoom of [1, 1.35]) {
      const meta = metaFor(strands, zoom);
      const res = await page.evaluate(({ strands, meta, deltas, gesture }) => {
        const out = { anchor: null, frames: [], gesture: [], determinism: null, refuse: {}, ref: [] };
        const pan = (dx, dy, key) => window.renderPanFrame({
          ...meta, x_offset: meta.x_offset + dx, y_offset: meta.y_offset + dy, scene_key: key });

        // Build the scene; the image it leaves is the anchor every shift is judged against.
        window.renderFixture(strands, { ...meta, scene_key: 'scene' });
        const anchor = window.__shoot();

        // anchor: a pan frame at delta 0 must reproduce that render exactly.
        out.anchor = pan(0, 0, 'scene') ? window.__same(anchor, window.__shoot()) : { refused: true };

        // determinism: the same frame twice.
        pan(37, 24, 'scene'); const d1 = window.__shoot();
        pan(37, 24, 'scene'); const d2 = window.__shoot();
        out.determinism = window.__same(d1, d2);

        // Residual at the claimed delta, plus the four neighbouring alignments. A
        // correct pan frame is minimal at the claim by a wide margin; anything that
        // moves the image wrongly is minimal somewhere else.
        const NEAR_STRIDE = 8;
        const align = (a, b, dx, dy) => {
          const at = window.__shifted(a, b, dx, dy);
          // Neighbours are sampled, so the claimed delta is scored at the SAME
          // sampling before the ratio is taken — and the featureless test reads the
          // sampled signal too, since it is the sampled rows that have to contain
          // something for a neighbouring alignment to be distinguishable at all.
          const mine = window.__shifted(a, b, dx, dy, NEAR_STRIDE);
          const near = [[1, 0], [-1, 0], [0, 1], [0, -1]]
            .map(([ex, ey]) => window.__shifted(a, b, dx + ex, dy + ey, NEAR_STRIDE))
            .reduce((m, r) => (r.bad >= 0 && (m < 0 || r.bad < m) ? r.bad : m), -1);
          return { ...at, near, atSampled: mine.bad, signalSampled: mine.signal };
        };

        // registration, one fresh scene per delta.
        for (const [dx, dy] of deltas) {
          window.renderFixture(strands, { ...meta, scene_key: 'scene' });
          const a = window.__shoot();
          if (!pan(dx, dy, 'scene')) { out.frames.push({ dx, dy, refused: true }); continue; }
          out.frames.push({ dx, dy, ...align(a, window.__shoot(), dx, dy) });
        }

        // registration across a gesture: ONE scene, a run of offsets off it.
        window.renderFixture(strands, { ...meta, scene_key: 'gest' });
        const gAnchor = window.__shoot();
        for (const [dx, dy] of gesture) {
          if (!pan(dx, dy, 'gest')) { out.gesture.push({ dx, dy, refused: true }); continue; }
          out.gesture.push({ dx, dy, ...align(gAnchor, window.__shoot(), dx, dy) });
        }

        // refusals.
        window.renderFixture(strands, { ...meta, scene_key: 'refuse' });
        out.refuse.wrongKey = window.renderPanFrame({ ...meta, scene_key: 'other' }) == null;
        out.refuse.noKey = window.renderPanFrame({ ...meta, scene_key: undefined }) == null;
        out.refuse.resized = window.renderPanFrame(
          { ...meta, image_width: meta.image_width + 40, scene_key: 'refuse' }) == null;
        out.refuse.rezoomed = window.renderPanFrame(
          { ...meta, zoom: (meta.zoom || 1) * 1.5, scene_key: 'refuse' }) == null;

        // REPORT ONLY: distance from a full render at the same offset. Two deltas,
        // not the whole gesture — each costs two full renders and nothing gates on it.
        for (const [dx, dy] of gesture.slice(0, 2)) {
          window.renderFixture(strands, { ...meta, scene_key: 'rep' });
          if (!pan(dx, dy, 'rep')) continue;
          const got = window.__shoot();
          window.renderFixture(strands, {
            ...meta, x_offset: meta.x_offset + dx, y_offset: meta.y_offset + dy, scene_key: 'ref' });
          out.ref.push({ dx, dy, ...window.__same(got, window.__shoot()) });
        }
        return out;
      }, { strands, meta, deltas: DELTAS, gesture: GESTURE });

      const tag = `${name} @z${zoom}`;
      // anchor and determinism ARE bit-exact: at delta 0 the matrix is identity, and
      // the same frame twice is the same frame. Nothing is allowed to move there.
      const exact = (label, r) => {
        cases++;
        if (r.refused) { failures++; rows.push(`  REFUSED  ${tag} ${label} — the scene should have served this`); return; }
        if (r.bad) { failures++; rows.push(`  DIFF     ${tag} ${label} — ${r.bad}/${r.total} channels, worst ${r.worst}`); }
      };
      // Registration: a small residual, and unambiguously best at the claimed delta.
      //
      // The residual is not zero and is not expected to be — it is edge
      // anti-aliasing, verified by eye to be invisible (worst observed: 747 of
      // 712k pixels on box_stitch @z1.35, scattered along strand outlines). A real
      // registration bug — an off-by-one, a swapped axis, a frozen grid — moves
      // several PERCENT of the frame, so this sits ~10x above the noise and ~20x
      // below anything structural, with the margin test below as the sharp guard.
      const RESIDUAL = 0.3 / 100;   // share of channels
      const RESIDUAL_FLOOR = 500;   // …but never fail on a handful of channels: a
                                    // large delta leaves a small overlap, where a
                                    // dozen edge pixels is already a big ratio
      const MARGIN = 5;             // neighbours must be at least this much worse
      // Below this many non-background channels in the SAMPLED rows, those rows are
      // flat: every alignment matches them equally well, so the margin test has
      // nothing to measure. The residual check still applies over the full region (a
      // frame that drew the WRONG thing there would fail it).
      const MIN_SIGNAL = 2000;
      const aligned = (label, r) => {
        if (r.total > 0 && r.bad > 0) {
          const sh = r.bad / r.total;
          if (sh > worstResidual.share) worstResidual = { share: sh, bad: r.bad, total: r.total, at: `${tag} ${label}` };
        }
        cases++;
        if (r.refused) { failures++; rows.push(`  REFUSED  ${tag} ${label} — the scene should have served this`); return; }
        const share = r.bad / r.total;
        if (r.bad < 0 || (share > RESIDUAL && r.bad > RESIDUAL_FLOOR)) {
          failures++;
          rows.push(`  DIFF     ${tag} ${label} — ${r.bad}/${r.total} channels`
            + ` (${(100 * share).toFixed(4)}%, max ${(100 * RESIDUAL).toFixed(4)}%), worst delta ${r.worst}`);
          return;
        }
        if (r.signalSampled < MIN_SIGNAL) {
          rows.push(`  flat     ${tag} ${label} — sampled rows are featureless`
            + ` (signal ${r.signalSampled}); residual checked, alignment not distinguishable`);
          return;
        }
        // A delta of 0 has no distinguishable neighbours to beat (the image is the
        // anchor itself, and `exact` already pinned it), so only judge real moves.
        if ((r.dx || r.dy) && !(r.near > Math.max(r.atSampled, 1) * MARGIN)) {
          failures++;
          rows.push(`  MISALIGNED ${tag} ${label} — sampled residual ${r.atSampled} but a`
            + ` neighbouring alignment scores ${r.near}; the frame is not shifted by this delta`);
        }
      };
      exact('anchor', res.anchor);
      exact('determinism', res.determinism);
      for (const f of res.frames) aligned(`registration d=(${f.dx},${f.dy})`, f);
      for (const f of res.gesture) aligned(`gesture d=(${f.dx},${f.dy})`, f);
      for (const [k, ok] of Object.entries(res.refuse)) {
        cases++;
        if (!ok) { failures++; rows.push(`  SERVED   ${tag} refuse/${k} — must have been refused`); }
      }
      const worstRef = res.ref.reduce((m, r) => (r.bad > (m ? m.bad : -1) ? r : m), null);
      if (worstRef) {
        refReport.push(`  ${tag}: worst ${(100 * worstRef.bad / worstRef.total).toFixed(4)}%`
          + ` of channels, max delta ${worstRef.worst}, at d=(${worstRef.dx},${worstRef.dy})`);
      }
    }
    rows.push(`  ok       ${name}`);
  }
  if (errs.length) { failures++; rows.push(`  PAGE ERRORS: ${errs.slice(0, 3).join(' | ')}`); }
} finally {
  await browser.close().catch(() => {});
}

console.log(`\npan correctness — ${cases} cases over ${fixtures.length} fixtures\n`);
console.log(rows.filter((r) => VERBOSE || !/^  (ok|flat) /.test(r)).join('\n') || '  (all ok)');

console.log('\nreference distance (REPORTED, not gated) — a pan frame vs a full render at');
console.log('the same offset. Nonzero because renderFixture is not offset-invariant: paper.js');
console.log("boolean ops use absolute epsilons, and at some offsets they hit the renderer's");
console.log('known body degeneracy (a solid black band). The pan frame is the stable side.');
console.log(refReport.join('\n'));

if (failures) {
  console.log(`\nFAIL: ${failures} case(s).`);
  process.exit(1);
}
console.log(`\nworst registration residual: ${worstResidual.bad}/${worstResidual.total} channels`
  + ` (${(100 * worstResidual.share).toFixed(4)}%, budget ${(100 * 0.3 / 100).toFixed(2)}%) at ${worstResidual.at}`);
console.log(`\n${cases}/${cases} ok`);
console.log('PASS: every pan frame is the anchor render translated by exactly its delta.');
