import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const PORT = process.argv[2] || '5175';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'box_stitch.json'), 'utf8'));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => log('PAGEERR:', String(e)));
await page.goto(`http://localhost:${PORT}/?mobile=1`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.app');
await page.evaluate(async (fx) => {
  const mod = await import('/src/io/saveLoad.ts');
  window.__store.getState().loadDocument(mod.loadProject(fx));
}, fixture);
await page.waitForTimeout(400);

const pt = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('.layer-panel [role="button"]'))
    .filter((b) => b.querySelector('.nlb-label'))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === b || b.contains(hit))) {
      // capture-phase observers on the button to log the real event stream
      window.__ev = [];
      const t0 = performance.now();
      ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointercancel', 'contextmenu'].forEach((type) => {
        b.addEventListener(type, (e) => window.__ev.push({ type, t: Math.round(performance.now() - t0), touches: e.touches ? e.touches.length : null }), true);
      });
      return { x, y };
    }
  }
  return null;
});
log('point: ' + JSON.stringify(pt));

const cdp = await ctx.newCDPSession(page);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
await page.waitForTimeout(700);
const evs = await page.evaluate(() => window.__ev);
const menu = await page.$('.ctx-menu');
log('events during hold: ' + JSON.stringify(evs));
log('menu present after hold? ' + !!menu);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await browser.close();
process.exit(0);
