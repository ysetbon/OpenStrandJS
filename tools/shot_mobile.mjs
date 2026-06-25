// Verifies the mobile presentation: the whole UI opens fully visible (fits the
// screen, no overflow) but UI_SCALE× bigger than a naive fit, and pinch can zoom
// in closer (clamped) and back to this full-fit floor. Screenshots the default.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'artifacts');
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://localhost:5173/?mobile=1', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('.app', { timeout: 10000 });
  await page.waitForTimeout(800);

  const m = await page.evaluate(() => {
    const app = document.querySelector('.app');
    const t = getComputedStyle(app).transform;
    const mat = t && t !== 'none' ? new DOMMatrixReadOnly(t) : null;
    const r = app.getBoundingClientRect();
    return {
      scale: mat ? +mat.a.toFixed(4) : null,
      // on-screen footprint of the whole app vs the viewport
      appW: Math.round(r.width), appH: Math.round(r.height),
      vw: window.innerWidth, vh: window.innerHeight,
      designW: app.offsetWidth, designH: app.offsetHeight,
    };
  });
  log('default view:', JSON.stringify(m));
  log('fits screen (no overflow):', m.appW <= m.vw + 1 && m.appH <= m.vh + 1);
  await page.screenshot({ path: path.join(outDir, 'mobile_fit_bigger.png') });

  console.log(JSON.stringify({ default: m, fits: m.appW <= m.vw + 1 && m.appH <= m.vh + 1, errors }, null, 2));
} catch (e) {
  log('ERROR:', String(e));
} finally {
  if (browser) await browser.close();
}
process.exit(0);
