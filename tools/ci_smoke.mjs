// CI smoke tests that need no Qt oracle — safe to run on any headless runner.
//
//   node tools/ci_smoke.mjs render <fixture.json> [more fixtures...]
//     Renders each fixture with the real Paper.js renderer (web/render.html in
//     Chromium) into a canvas sized from the fixture's own bounding box, then
//     fails unless the canvas contains non-white pixels and no page errors
//     occurred. PNGs land in artifacts/ci_smoke/ for upload/inspection.
//     This is NOT a fidelity check (that needs the Qt reference via prove.mjs);
//     it catches "renderer crashes / draws nothing" regressions.
//
//   node tools/ci_smoke.mjs editor <distDir>
//     Serves the built editor (dist-editor/) under the production base path
//     /OpenStrandJS/ on a local port, loads it in Chromium, and fails unless
//     the app boots cleanly: no page errors, a canvas is mounted, and the
//     renderer bridge exposed window.renderFixture.
//
// OSS_CHROMIUM: absolute path to a Chromium binary, for environments whose
// pre-installed browser revision doesn't match this Playwright version.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const mode = process.argv[2];
const args = process.argv.slice(3);
if (!mode || args.length === 0) {
  console.error('usage: node tools/ci_smoke.mjs render <fixture.json>... | editor <distDir>');
  process.exit(2);
}

const launchBrowser = () =>
  chromium.launch(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});

// Same fixture shapes as js_render.mjs: either a plain {strands} document or an
// OpenStrandStudioHistory file, where we render the current step.
function loadStrands(fixturePath) {
  const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (data && data.type === 'OpenStrandStudioHistory') {
    const state = data.states.find((s) => s.step === data.current_step);
    if (!state) throw new Error(`current_step ${data.current_step} not found in ${fixturePath}`);
    return state.data.strands;
  }
  return data.strands;
}

// Collect every {x, y} point in the strand tree (start/end/control_points/...)
// so the canvas can be sized to fit the drawing without a reference meta.json.
function collectPoints(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectPoints(item, out);
  } else if (value && typeof value === 'object') {
    if (typeof value.x === 'number' && typeof value.y === 'number') out.push(value);
    for (const key of Object.keys(value)) collectPoints(value[key], out);
  }
}

function syntheticMeta(strands) {
  const points = [];
  collectPoints(strands, points);
  if (points.length === 0) throw new Error('fixture contains no coordinates');
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  // Margin covers strand width + stroke + shadow spill outside the point bbox.
  const MARGIN = 120;
  return {
    image_width: Math.ceil(Math.max(...xs) - minX) + 2 * MARGIN,
    image_height: Math.ceil(Math.max(...ys) - minY) + 2 * MARGIN,
    x_offset: MARGIN - minX,
    y_offset: MARGIN - minY,
    supersample: 2,
  };
}

const countNonWhite = () => {
  const c = document.getElementById('c') || document.querySelector('canvas');
  if (!c) return { found: false };
  const { width, height } = c;
  const data = c.getContext('2d').getImageData(0, 0, width, height).data;
  let nonWhite = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++;
  }
  return { found: true, width, height, nonWhite };
};

async function smokeRender(fixtures) {
  const outDir = path.join(root, 'artifacts', 'ci_smoke');
  mkdirSync(outDir, { recursive: true });
  const browser = await launchBrowser();
  let failed = 0;
  try {
    for (const fixture of fixtures) {
      const name = path.basename(fixture).replace(/\.[^.]+$/, '');
      const strands = loadStrands(fixture);
      const meta = syntheticMeta(strands);

      const page = await browser.newPage({ deviceScaleFactor: 1 });
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(String(err)));

      // Cache-buster mirrors js_render.mjs: Chromium can cache file:// resources.
      const url =
        pathToFileURL(path.join(root, 'web', 'render.html')).href +
        '?v=' + Math.floor(Math.random() * 1e9);
      await page.goto(url);
      await page.waitForFunction(() => typeof window.renderFixture === 'function');
      await page.evaluate(({ strands, meta }) => window.renderFixture(strands, meta), { strands, meta });

      const stats = await page.evaluate(countNonWhite);
      const png = path.join(outDir, `${name}.png`);
      const canvas = await page.$('#c');
      if (canvas) await canvas.screenshot({ path: png });
      await page.close();

      const ok = pageErrors.length === 0 && stats.found && stats.nonWhite > 0;
      if (!ok) failed++;
      console.log(
        `${ok ? 'PASS' : 'FAIL'} render ${name}: ` +
          `${stats.found ? `${stats.nonWhite} non-white px @ ${stats.width}x${stats.height}` : 'no canvas'}` +
          (pageErrors.length ? `; page errors: ${pageErrors.join(' | ')}` : ''),
      );
    }
  } finally {
    await browser.close();
  }
  return failed === 0;
}

// Minimal static server for dist-editor/, mounted at the production base path
// so the built asset URLs (/OpenStrandJS/assets/...) resolve. `vite preview`
// can't be used here: its config resolves with command 'serve', where base is
// '/' (see vite.config.ts), which breaks the built asset paths.
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.woff2': 'font/woff2',
};

function serveDist(distDir, base) {
  const server = createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!rel.startsWith(base)) { res.writeHead(404); res.end(); return; }
    rel = rel.slice(base.length) || 'index.html';
    const file = path.join(distDir, rel);
    if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function smokeEditor(distArg) {
  const distDir = path.resolve(root, distArg);
  if (!existsSync(path.join(distDir, 'index.html'))) {
    console.error(`FAIL editor: ${distDir}/index.html not found — run \`npm run build:editor\` first`);
    return false;
  }
  const base = '/OpenStrandJS/';
  const server = await serveDist(distDir, base);
  const url = `http://127.0.0.1:${server.address().port}${base}`;

  const browser = await launchBrowser();
  const pageErrors = [];
  const consoleErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => typeof window.renderFixture === 'function', null, { timeout: 15000 });
    const canvases = await page.locator('canvas').count();

    const ok = pageErrors.length === 0 && canvases > 0;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} editor boot: renderFixture ready, ${canvases} canvas(es)` +
        (pageErrors.length ? `; page errors: ${pageErrors.join(' | ')}` : '') +
        (consoleErrors.length ? `; console errors: ${consoleErrors.join(' | ')}` : ''),
    );
    return ok;
  } finally {
    await browser.close();
    server.close();
  }
}

const ok = mode === 'render' ? await smokeRender(args)
  : mode === 'editor' ? await smokeEditor(args[0])
  : (console.error(`unknown mode: ${mode}`), false);
process.exit(ok ? 0 : 1);
