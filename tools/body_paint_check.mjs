// Guards for how a strand BODY is painted, and for the renderer's paint state.
//
// 1. WINDING-FILL BODY. Qt paints each body layer as one QPainterPath with
//    Qt.WindingFill — the stroked band plus every cap sub-path, appended with
//    addPath() and filled in a single drawPath (strand.py:2510-2680). OSS moved
//    off QPainterPath.united() on purpose: "Qt's Boolean union can discard the
//    body" (strand.py:1704-1709). This renderer used to do exactly what OSS
//    abandoned — resolveCrossings() on the band, then unite() per cap — and
//    paper.js's resolveCrossings() has the same failure on the self-overlapping
//    band a tightly curved centerline produces: it silently hands back a
//    fraction of the region. When it ate the FILL layer the strand painted as a
//    solid stroke-coloured silhouette (the "black band"); when it ate the
//    STROKE layer the outline vanished under the fill. Both were reachable by
//    dragging a control point in the editor.
//
//    The check recolours one strand to unique fill/stroke colours, sweeps its
//    first control point over a grid, and counts each colour on the canvas. The
//    stroke layer is a thin ring around the fill (stroke_width 4 vs width 46),
//    so visible stroke pixels are always a small fraction of fill pixels. A
//    collapsed layer inverts that, or zeroes one of them outright.
//
// 2. PAINT STATE IS PER-RENDER. The renderer keeps module-scoped paint state
//    (CURVE, SAMPLE_STEP, the SHADOW_* trio, BIAS_ENABLED, the geometry memo,
//    the retained pan scene). Every entry point must derive all of it from its
//    OWN meta, or the same document renders differently depending on what was
//    drawn before it. The checks render one document, run a different entry
//    point, and render it again expecting the identical image.
//
// Usage: node tools/body_paint_check.mjs
//        OSS_CHROMIUM=/path/to/chrome node tools/body_paint_check.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => {
  const raw = JSON.parse(readFileSync(path.join(root, 'fixtures', name), 'utf8'));
  const data = raw.type === 'OpenStrandStudioHistory'
    ? raw.states.find((s) => s.step === raw.current_step).data : raw;
  return data.strands.slice();
};

let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '   ' + x)); if (!c) fails++; };

// Strands whose curve is tight enough to fold the offset band back on itself at
// some point in the sweep — i.e. the ones that used to degenerate.
const SWEEP = [
  ['three_strand_braid.json', '3_3'],
  ['three_strand_braid.json', '1_3'],
  ['mxn_lh_1x1.json', '1_1'],
  ['closed_knot.json', '1_2'],
  ['overhand_knot.json', '1_2'],
  ['box_stitch.json', '1_2'],
];

const BASE = {
  image_width: 700, image_height: 700, x_offset: 0, y_offset: 0,
  supersample: 1, shadow_enabled: true,
  curve_params: { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 },
};

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(root, 'web/render.html')).href + '?v=' + Date.now());
  await page.waitForFunction(() => typeof window.renderFixture === 'function');

  // ---------------------------------------------------- 1. winding-fill body
  for (const [fx, layer] of SWEEP) {
    const strands = load(fx);
    const bad = await page.evaluate(({ strands, layer }) => {
      // Fit the whole document in view so a swept strand never leaves the frame
      // (an off-canvas strand would read as a collapsed layer).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of strands) {
        for (const p of [s.start, s.end, ...(s.control_points || [])]) {
          if (!p) continue;
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
      const pad = 200;
      const zoom = Math.min(900 / (maxX - minX + 2 * pad), 900 / (maxY - minY + 2 * pad));
      const meta = {
        image_width: 900, image_height: 900, supersample: 1, shadow_enabled: false, zoom,
        x_offset: -(minX - pad) * zoom, y_offset: -(minY - pad) * zoom,
      };
      const out = [];
      for (let dx = -60; dx <= 60; dx += 10) {
        for (let dy = -60; dy <= 60; dy += 10) {
          const moved = strands.map((s) => {
            const c = { ...s };
            if (s.layer_name === layer) {
              c.control_points = [
                { x: s.control_points[0].x + dx, y: s.control_points[0].y + dy },
                s.control_points[1],
              ];
              c.color = { r: 220, g: 40, b: 40, a: 255 };
              c.stroke_color = { r: 10, g: 90, b: 200, a: 255 };
            }
            return c;
          });
          window.renderFixture(moved, meta);
          const cv = document.getElementById('c');
          const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          let fill = 0, stroke = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(d[i] - 220) < 14 && Math.abs(d[i + 1] - 40) < 14 && Math.abs(d[i + 2] - 40) < 14) fill++;
            else if (Math.abs(d[i] - 10) < 14 && Math.abs(d[i + 1] - 90) < 14 && Math.abs(d[i + 2] - 200) < 14) stroke++;
          }
          // Ignore positions where the strand is almost entirely occluded by
          // higher layers — there is no body left to judge.
          if (fill + stroke > 200 && (stroke > fill * 0.6 || fill === 0)) out.push({ dx, dy, fill, stroke });
        }
      }
      return out;
    }, { strands, layer });
    ok(`${fx} ${layer}: no control-point position paints the body as a bare stroke layer`,
      bad.length === 0, `${bad.length} degenerate, first ${JSON.stringify(bad[0])}`);
  }

  // ------------------------------------------------ 2. paint state per render
  const snap = () => page.evaluate(() => {
    const cv = document.getElementById('c');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < d.length; i += 4) {
      h = Math.imul(h ^ (d[i] + 3 * d[i + 1] + 7 * d[i + 2] + i), 16777619) >>> 0;
    }
    return h;
  });
  const full = async (arr, meta) => {
    await page.evaluate(({ arr, meta }) => window.renderFixture(arr, meta), { arr, meta });
    return snap();
  };

  for (const fx of ['overhand_knot.json', 'three_strand_braid.json']) {
    const arr = load(fx);
    const a = await full(arr, BASE);
    ok(`${fx} the same render twice is the same image`, a === await full(arr, BASE));

    // The drag fast path raises SAMPLE_STEP and forces shadows off.
    const moving = [arr.find((s) => s.type !== 'MaskedStrand').layer_name];
    await page.evaluate(({ arr, meta }) => {
      window.renderDragBackground(arr, meta);
      window.renderDragFrame(arr, meta);
      window.endDrag();
    }, { arr, meta: { ...BASE, shadow_enabled: false, drag: { moving } } });
    ok(`${fx} a drag gesture leaves no paint state behind`, a === await full(arr, BASE));
    ok(`${fx} ...and no geometry memo behind`,
      (await page.evaluate(() => window.__geomCacheOpen())) === false);

    // The auto-shadow probe runs on its own throwaway paper project.
    const names = arr.filter((s) => s.type !== 'MaskedStrand').map((s) => s.layer_name);
    const before = await page.evaluate(() => paper.projects.length);
    await page.evaluate(({ arr, pairs }) => window.computeShadowPairAreas(
      arr, { supersample: 1, x_offset: 0, y_offset: 0, shadow_enabled: true }, pairs),
    { arr, pairs: [{ casting: names[names.length - 1], receiving: names[0] }] });
    const after = await page.evaluate(() => paper.projects.length);
    ok(`${fx} the auto-shadow probe leaves no paint state behind`, a === await full(arr, BASE));
    ok(`${fx} ...and frees its paper project`, after === before, `${before} -> ${after}`);

    // CURVE is the one paint setting that used to be assigned only when the key
    // was present, so a meta without it inherited the previous render's curve.
    const noCurve = { ...BASE };
    delete noCurve.curve_params;
    const e1 = await full(arr, noCurve);
    await page.evaluate(() => { CURVE = { base_fraction: 0.2, dist_multiplier: 0.4, exponent: 3.0 }; });
    ok(`${fx} a meta without curve_params renders from the defaults, not the last render`,
      e1 === await full(arr, noCurve));
  }

  ok('no page errors along the way', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(fails ? `\n${fails} FAILURES` : '\nall green');
process.exit(fails ? 1 : 0);
