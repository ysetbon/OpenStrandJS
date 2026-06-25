// Verifies the mobile presentation: opens at 150% (DEFAULT_ZOOM) of fit, and a
// synthetic two-finger pinch changes the app's effective scale (clamped to fit
// at the low end). Logs each step so a hang is locatable.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'artifacts');
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => { process.stderr.write(a.join(' ') + '\n'); };

let browser;
try {
  log('launching…');
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  log('goto…');
  await page.goto('http://localhost:5173/?mobile=1', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('.app', { timeout: 10000 });
  await page.waitForTimeout(800);
  log('loaded');

  const readScale = () => page.evaluate(() => {
    const app = document.querySelector('.app');
    const t = getComputedStyle(app).transform;
    const m = t && t !== 'none' ? new DOMMatrixReadOnly(t) : null;
    return m ? { scale: +m.a.toFixed(4), tx: Math.round(m.e), ty: Math.round(m.f) } : { scale: null, raw: t };
  });

  const atOpen = await readScale();
  log('open scale =', JSON.stringify(atOpen));
  await page.screenshot({ path: path.join(outDir, 'mobile_default_150.png') });

  const pinch = (d0, d1) => page.evaluate(({ d0, d1 }) => {
    const cx = 422, cy = 195;
    const mk = (id, x, y) => new Touch({ identifier: id, target: document.body, clientX: x, clientY: y });
    const ev = (type, touches) => window.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, cancelable: true, bubbles: true }));
    ev('touchstart', [mk(1, cx - d0 / 2, cy), mk(2, cx + d0 / 2, cy)]);
    ev('touchmove', [mk(1, cx - d1 / 2, cy), mk(2, cx + d1 / 2, cy)]);
    ev('touchend', []);
  }, { d0, d1 });

  log('pinch out…');
  await pinch(200, 600);
  const afterIn = await readScale();
  log('after pinch-out =', JSON.stringify(afterIn));

  log('pinch in to floor…');
  await pinch(600, 60);
  const afterOut = await readScale();
  log('after pinch-in =', JSON.stringify(afterOut));

  console.log(JSON.stringify({
    open: atOpen, afterPinchOut: afterIn, afterPinchInToFloor: afterOut,
    ratio_open_to_floor: atOpen.scale && afterOut.scale ? +(atOpen.scale / afterOut.scale).toFixed(3) : null,
    errors,
  }, null, 2));
} catch (e) {
  log('ERROR:', String(e));
} finally {
  if (browser) await browser.close();
  log('closed');
}
process.exit(0);
