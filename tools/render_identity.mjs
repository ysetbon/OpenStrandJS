// Pixel-identity guard for renderer refactors.
//
// The renderer in web/strand-renderer.js is the pixel oracle: any change to it
// has to prove it changed NO pixels. This script renders every fixture twice —
// once through a BASELINE copy of the renderer, once through the working copy —
// and fails unless every rendered pixel is identical.
//
// It covers every entry point a drag touches:
//   full    window.renderFixture         (pointer-up / resting render)
//   bake    window.renderDragBackground  (pointer-down static bake)
//   frame   window.renderDragFrame       (the first per-move frame)
//   frames  four consecutive moves off one bake, each with the moving strand
//           somewhere different — the case that catches state wrongly carried
//           between frames (a reused bitmap, project or cached underlay)
//
// Usage:
//   node tools/render_identity.mjs <baseline-renderer.js> [--fixtures a,b,c]
//
// The baseline is any saved copy of web/strand-renderer.js (e.g. the file at the
// merge-base). Both renderers run in the same Chromium against the same inputs.
//
// OSS_CHROMIUM: absolute path to a Chromium binary if the pre-installed browser
// revision does not match this Playwright version.

import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const baselinePath = process.argv[2];
if (!baselinePath) {
  console.error('usage: node tools/render_identity.mjs <baseline-renderer.js> [--fixtures a,b]');
  process.exit(2);
}
const fixArgIdx = process.argv.indexOf('--fixtures');
const only = fixArgIdx >= 0 && process.argv[fixArgIdx + 1] ? process.argv[fixArgIdx + 1].split(',') : null;

const fixtures = (only || readdirSync(path.join(root, 'fixtures'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))).sort();

function loadStrands(name) {
  const data = JSON.parse(readFileSync(path.join(root, 'fixtures', `${name}.json`), 'utf8'));
  if (data && data.type === 'OpenStrandStudioHistory') {
    const s = data.states.find((x) => x.step === data.current_step) || data.states[0];
    return s.data.strands || [];
  }
  return data.strands || [];
}

// Size the canvas from the fixture's own coordinates so nothing is cropped
// (same approach as tools/ci_smoke.mjs).
function collectPoints(value, out) {
  if (Array.isArray(value)) for (const v of value) collectPoints(v, out);
  else if (value && typeof value === 'object') {
    if (typeof value.x === 'number' && typeof value.y === 'number') out.push(value);
    for (const k of Object.keys(value)) collectPoints(value[k], out);
  }
}

function metaFor(strands) {
  const pts = [];
  collectPoints(strands, pts);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const M = 130;
  return {
    image_width: Math.min(1600, Math.ceil(Math.max(...xs) - minX) + 2 * M),
    image_height: Math.min(1000, Math.ceil(Math.max(...ys) - minY) + 2 * M),
    x_offset: M - minX,
    y_offset: M - minY,
    supersample: 2,
    shadow_enabled: true,
    curve_params: { base_fraction: 1, dist_multiplier: 2, exponent: 2 },
  };
}

const rendererSrc = {
  baseline: readFileSync(path.isAbsolute(baselinePath) ? baselinePath : path.join(root, baselinePath), 'utf8'),
  working: readFileSync(path.join(root, 'web', 'strand-renderer.js'), 'utf8'),
};
const paperSrc = readFileSync(path.join(root, 'node_modules', 'paper', 'dist', 'paper-full.min.js'), 'utf8');

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});

// One page per renderer version, both loaded from the same blank document so the
// only difference between them is the renderer source.
async function makePage(src) {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.setContent('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
  await page.addScriptTag({ content: paperSrc });
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.renderFixture === 'function');
  return { page, errs };
}

const A = await makePage(rendererSrc.baseline);
const B = await makePage(rendererSrc.working);

// Everything from here on runs in a try/finally: every comparison below throws
// exactly when this harness finds what it exists to find, and a leaked Chromium
// on the failure path is the last thing anyone debugging a diff needs.
let failures = 0, cases = 0;
const rows = [];

// Render one case and return the raw RGBA of #c as a plain array (transferable).
async function shoot({ page }, strands, meta, kind, moving) {
  return page.evaluate(({ strands, meta, kind, moving }) => {
    const hash = () => {
      const c = document.getElementById('c');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      for (let i = 0; i < d.length; i++) {
        h1 = ((h1 ^ d[i]) * 16777619) >>> 0;
        h2 = ((h2 + d[i]) * 31) >>> 0;
      }
      return { w: c.width, h: c.height, h1, h2 };
    };
    const s = JSON.parse(JSON.stringify(strands));   // renderers mutate has_circles
    if (kind === 'full') {
      window.renderFixture(s, meta);
      return hash();
    }
    const m = { ...meta, supersample: 1, shadow_enabled: false, drag: { moving } };
    window.renderDragBackground(JSON.parse(JSON.stringify(strands)), m);
    if (kind === 'bake') {
      // renderDragBackground paints ONLY into offscreen per-band canvases — it
      // never touches #c. Hashing #c straight after it therefore measured
      // whatever the previous case left behind (the 'full' render, which runs
      // first in the loop), so this case silently duplicated 'full' and asserted
      // nothing about the bake. Composite the bands onto #c the way a real frame
      // does, but with an EMPTY moving set, so what gets hashed is exactly the
      // baked static background and nothing else.
      window.renderDragFrame(JSON.parse(JSON.stringify(strands)), { ...m, drag: { moving: [] } });
      const h = hash();
      window.endDrag();
      return h;
    }
    if (kind === 'frame') {
      window.renderDragFrame(s, m);
      const h = hash();
      window.endDrag();
      return h;
    }
    // kind === 'frames': SEVERAL consecutive frames off ONE bake, with the moving
    // strand displaced differently each time. This is the case that exercises the
    // state the fast path carries between frames — the reused scratch bitmap, the
    // reused paper project, the cached backdrop+grid underlay. A single frame
    // cannot catch a second frame that reuses something it should have rebuilt.
    const out = [];
    for (let f = 0; f < 4; f++) {
      const moved = JSON.parse(JSON.stringify(strands));
      for (const st of moved) {
        if (!moving.includes(st.layer_name)) continue;
        const dx = (f + 1) * 9, dy = (f + 1) * -6;
        st.end = { x: st.end.x + dx, y: st.end.y + dy };
        if (st.control_points && st.control_points[1]) {
          st.control_points[1] = { x: st.control_points[1].x + dx, y: st.control_points[1].y + dy };
        }
      }
      window.renderDragFrame(moved, m);
      out.push(hash());
    }
    window.endDrag();
    return out;
  }, { strands, meta, kind, moving });
}

// When hashes differ, pull both buffers and count/locate the differing pixels.
async function detail({ page }, strands, meta, kind, moving) {
  return page.evaluate(({ strands, meta, kind, moving }) => {
    const s = JSON.parse(JSON.stringify(strands));
    if (kind === 'full') window.renderFixture(s, meta);
    else {
      const m = { ...meta, supersample: 1, shadow_enabled: false, drag: { moving } };
      window.renderDragBackground(JSON.parse(JSON.stringify(strands)), m);
      if (kind === 'frame') window.renderDragFrame(s, m);
      window.endDrag();
    }
    const c = document.getElementById('c');
    return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
  }, { strands, meta, kind, moving });
}

mkdirSync(path.join(root, 'artifacts', 'render_identity'), { recursive: true });

try {
for (const name of fixtures) {
  const strands = loadStrands(name);
  if (!strands.length) continue;
  const meta = metaFor(strands);
  const first = strands.find((s) => s.type !== 'MaskedStrand') || strands[0];
  const moving = [first.layer_name];

  for (const kind of ['full', 'bake', 'frame', 'frames']) {
    cases++;
    const a = await shoot(A, strands, meta, kind, moving);
    const b = await shoot(B, strands, meta, kind, moving);
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (same) {
      const dims = Array.isArray(a) ? `${a[0].w}x${a[0].h} x${a.length}` : `${a.w}x${a.h}`;
      rows.push(`  ok    ${name} / ${kind}  ${dims}`);
      continue;
    }
    if (kind === 'frames') {
      failures++;
      const which = a.map((x, i) => (JSON.stringify(x) === JSON.stringify(b[i]) ? null : i)).filter((x) => x != null);
      rows.push(`  DIFF  ${name} / frames  diverged at frame(s) ${which.join(',')}`);
      continue;
    }
    failures++;
    const da = await detail(A, strands, meta, kind, moving);
    const db = await detail(B, strands, meta, kind, moving);
    let nDiff = 0, maxCh = 0, firstPix = -1;
    const n = Math.min(da.length, db.length);
    for (let i = 0; i < n; i += 4) {
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(da[i + k] - db[i + k]));
      if (d) { nDiff++; if (d > maxCh) maxCh = d; if (firstPix < 0) firstPix = i / 4; }
    }
    rows.push(`  DIFF  ${name} / ${kind}  ${a.w}x${a.h}  pixels=${nDiff} maxChannelDelta=${maxCh} firstPixel=${firstPix}`);
  }
}

} finally {
  await browser.close();
}

console.log(`\nrenderer pixel identity — ${cases} cases over ${fixtures.length} fixtures\n`);
for (const r of rows) console.log(r);
if (A.errs.length) console.log('\nbaseline page errors:', A.errs.slice(0, 5));
if (B.errs.length) console.log('\nworking page errors:', B.errs.slice(0, 5));
console.log(`\n${cases - failures}/${cases} identical`);
if (failures || B.errs.length) {
  console.error(`\nFAIL: ${failures} case(s) differ${B.errs.length ? ` + ${B.errs.length} page error(s)` : ''}`);
  process.exit(1);
}
console.log('PASS: every rendered pixel is identical to the baseline renderer.');
process.exit(0);
