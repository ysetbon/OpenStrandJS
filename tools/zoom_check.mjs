// Guard for the control-column zoom buttons, driven through the REAL app.
//
// The buttons shipped as `disabled` placeholders while zoom was still pinned in
// the renderer, and stayed that way after the renderer, the wheel and the
// overlay had all learned zoom — so the first assertion here is simply that
// they are live and that a press moves view.zoom. The rest pin the OSS
// behaviour they implement (strand_drawing_canvas.py:1560-1583):
//
//   * one press is 10% OF THE CURRENT zoom (zoom_percentage), so the steps are
//     geometric: in = x1.1, out = x0.9 (deliberately NOT inverses, as in OSS);
//   * the zoom range is OSS's [min_zoom 0.1, max_zoom 5.0], and the wheel
//     shares it;
//   * a step keeps the world point under the viewport centre pinned, so the
//     drawing cannot walk out of view;
//   * the step reaches the canvas — the drawing's inked bounding box grows and
//     shrinks with it — rather than only moving a number in the store.
//
// Runs against the dev server (not dist-editor) because the assertions read
// view.zoom through the DEV-only window.__store hook.
//
// Usage: node tools/zoom_check.mjs
//        OSS_CHROMIUM=/path/to/chrome node tools/zoom_check.mjs
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const project = JSON.parse(readFileSync(path.join(root, 'fixtures/box_stitch.json'), 'utf8'));

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  // strictPort: fail loudly on a busy port rather than serving from another one
  // while the page below still asks for this one.
  server: { port: 5207, strictPort: true, open: false, host: '127.0.0.1' },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://127.0.0.1:5207/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 30000 });
  await page.evaluate(({ project }) => {
    const st = window.__store.getState();
    st.loadDocument(window.__io.loadProject(project));
    st.setMode('move');
  }, { project });
  await page.waitForTimeout(1200);

  const zoomIn = page.locator('.control-column .cc-btn[title^="Zoom In"]');
  const zoomOut = page.locator('.control-column .cc-btn[title^="Zoom Out"]');
  const view = () => page.evaluate(() => ({ ...window.__store.getState().view }));
  const setView = (patch) => page.evaluate((p) => window.__store.getState().setView(p), patch);
  // World point under the middle of the canvas: the anchor a step must not move.
  const centreWorld = () => page.evaluate(() => {
    const v = window.__store.getState().view;
    return { x: (v.width / 2 - v.panX) / v.zoom, y: (v.height / 2 - v.panY) / v.zoom };
  });
  // Inked bounding box on the visible canvas, as a fraction of its size — the
  // drawing's on-screen extent, which is what a zoom step has to change.
  const inkSpan = () => page.evaluate(() => {
    const cv = document.getElementById('c');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        // Ignore the faint grid (near-white) so this measures the strands.
        if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (minX === Infinity) return 0;
    return Math.max(maxX - minX, maxY - minY) / cv.width;
  });
  // Presses are spaced: each one schedules a full render, and at 5x on this
  // fixture a burst of clicks can hold the main thread long enough for the next
  // click to time out — the tool would then fail on its own pacing rather than
  // on the behaviour it is checking.
  const press = async (btn, n = 1) => {
    for (let i = 0; i < n; i++) { await btn.click({ timeout: 15000 }); await page.waitForTimeout(120); }
    await page.waitForTimeout(700);   // let the render settle
  };

  const live = !(await zoomIn.isDisabled()) && !(await zoomOut.isDisabled());
  ok('the zoom buttons are enabled', live);
  // Everything below presses them; there is nothing to learn from 10 click
  // timeouts once they are inert.
  if (!live) { console.log('\nzoom buttons are disabled — the rest of the checks cannot run'); process.exit(1); }

  // ---------------------------------------------- 1. the OSS step, in and out
  await setView({ zoom: 1 });
  await press(zoomIn);
  let v = await view();
  ok('one Zoom In press is +10% of the current zoom (OSS zoom_percentage)', near(v.zoom, 1.1),
    `zoom=${v.zoom}`);
  await press(zoomOut);
  v = await view();
  ok('one Zoom Out press is -10% of the current zoom (1.1 -> 0.99, as in OSS)', near(v.zoom, 0.99),
    `zoom=${v.zoom}`);

  // ------------------------------------- 2. a step pins the viewport-centre point
  await setView({ zoom: 1, panX: -120, panY: 85 });   // panned: the hard case
  await page.waitForTimeout(400);
  const before = await centreWorld();
  await press(zoomIn, 3);
  const afterIn = await centreWorld();
  await press(zoomOut, 3);
  const afterOut = await centreWorld();
  ok('zooming in keeps the world point at the viewport centre pinned',
    near(before.x, afterIn.x, 1e-6) && near(before.y, afterIn.y, 1e-6),
    `${JSON.stringify(before)} -> ${JSON.stringify(afterIn)}`);
  ok('zooming out keeps it pinned too',
    near(before.x, afterOut.x, 1e-6) && near(before.y, afterOut.y, 1e-6),
    `${JSON.stringify(before)} -> ${JSON.stringify(afterOut)}`);

  // ------------------------------------------------ 3. OSS's [0.1, 5.0] limits
  // Started just inside each limit and pressed past it: the assertion is that
  // the steps stop exactly ON the limit and stay there however often the button
  // is pressed, which does not need the several dozen presses a walk all the
  // way from 1.0 would cost.
  await setView({ zoom: 0.13, panX: 0, panY: 0 });
  await press(zoomOut, 8);
  v = await view();
  ok('Zoom Out stops at OSS min_zoom 0.1', near(v.zoom, 0.1), `zoom=${v.zoom}`);
  await setView({ zoom: 4.6 });
  await press(zoomIn, 8);
  v = await view();
  ok('Zoom In stops at OSS max_zoom 5.0', near(v.zoom, 5), `zoom=${v.zoom}`);
  // The wheel shares the range, so the two paths cannot disagree about a limit.
  const box = await page.locator('#c').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
  v = await view();
  ok('the wheel clamps to the same max', near(v.zoom, 5), `zoom=${v.zoom}`);

  // -------------------------------------- 4. the step reaches the canvas, not just the store
  await setView({ zoom: 1, panX: 0, panY: 0 });
  await page.locator('.control-column .cc-btn[title^="Center"]').click();
  await page.waitForTimeout(900);
  const span1 = await inkSpan();
  await press(zoomIn, 7);                     // 1.1^7 ~ 1.95x
  const spanIn = await inkSpan();
  await press(zoomOut, 14);                   // back down well past 1x
  const spanOut = await inkSpan();
  ok('the drawing is bigger on canvas after Zoom In', spanIn > span1 * 1.4,
    `${span1.toFixed(3)} -> ${spanIn.toFixed(3)}`);
  ok('and smaller after Zoom Out', spanOut < span1 * 0.85,
    `${span1.toFixed(3)} -> ${spanOut.toFixed(3)}`);

  // ------------------------------------------------ 5. Reset restores zoom 1.0
  await page.locator('.control-column .cc-btn[title^="Reset"]').click();
  await page.waitForTimeout(700);
  v = await view();
  ok('Reset states returns to zoom 1.0 (OSS zoom_factor default)', near(v.zoom, 1), `zoom=${v.zoom}`);

  ok('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

console.log(fails ? `\n${fails} FAILED` : '\nall zoom checks passed');
process.exit(fails ? 1 : 0);
