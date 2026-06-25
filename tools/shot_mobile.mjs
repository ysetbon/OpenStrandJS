// Loads a multi-strand fixture into the live dev editor (via the Vite module
// graph + the DEV __store) then screenshots the mobile layer/group panels to
// confirm they're compact (no big empty gap). Usage: node tools/shot_mobile.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'artifacts');
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'box_stitch.json'), 'utf8'));

let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 787, height: 382 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto('http://localhost:5173/?mobile=1', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('.app', { timeout: 10000 });

  const loaded = await page.evaluate(async (fx) => {
    const mod = await import('/src/io/saveLoad.ts');
    const doc = mod.loadProject(fx);
    window.__store.getState().loadDocument(doc);
    return { order: window.__store.getState().doc.order };
  }, fixture);
  log('loaded layers:', JSON.stringify(loaded.order));
  await page.waitForTimeout(500);

  // Measure the empty gap between the control column and the first layer button.
  const gaps = await page.evaluate(() => {
    const cc = document.querySelector('.layer-panel .control-column, .layer-panel [class*="control"]');
    const firstItem = document.querySelector('.lp-list .lp-item');
    const list = document.querySelector('.lp-list');
    const gp = document.querySelector('.gp-tree');
    const r = (el) => el ? el.getBoundingClientRect() : null;
    return {
      listRect: r(list), firstItemRect: r(firstItem),
      gpRect: r(gp),
      // gap from list top to first item top (design px under the app transform are
      // screen px here; small gap == compact/top-aligned).
      listTopToFirstItem: list && firstItem ? Math.round(r(firstItem).top - r(list).top) : null,
    };
  });
  log('gap list-top → first layer (px):', gaps.listTopToFirstItem);
  await page.screenshot({ path: path.join(outDir, 'mobile_panels_compact.png') });

  console.log(JSON.stringify({ layers: loaded.order, gaps, errs }, null, 2));
} catch (e) {
  log('ERROR:', String(e));
} finally {
  if (browser) await browser.close();
}
process.exit(0);
