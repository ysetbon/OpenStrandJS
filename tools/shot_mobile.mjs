// Loads a multi-strand fixture into the live dev editor and screenshots the
// mobile layer/group panels to confirm wasted HORIZONTAL space is gone: the
// panel + sub-columns hug their content and the canvas keeps the freed width.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'artifacts');
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'box_stitch.json'), 'utf8'));

async function shot(browser, rtl) {
  const ctx = await browser.newContext({ viewport: { width: 787, height: 382 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('http://localhost:5173/?mobile=1', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('.app', { timeout: 10000 });
  await page.evaluate(async ({ fx, rtl }) => {
    const mod = await import('/src/io/saveLoad.ts');
    window.__store.getState().loadDocument(mod.loadProject(fx));
    if (rtl) window.__store.getState().setSetting?.('language', 'he');
  }, { fx: fixture, rtl });
  await page.waitForTimeout(500);
  const w = await page.evaluate(() => {
    const px = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().width) : null; };
    return {
      vw: window.innerWidth,
      canvas: px('.left-widget'), panel: px('.layer-panel'),
      lpLeft: px('.lp-left'), lpRight: px('.lp-right'), gpPanel: px('.gp-panel'),
    };
  });
  await page.screenshot({ path: path.join(outDir, `mobile_panels_${rtl ? 'rtl' : 'ltr'}.png`) });
  await ctx.close();
  return { mode: rtl ? 'rtl' : 'ltr', widths: w, errs };
}

let browser;
try {
  browser = await chromium.launch();
  const ltr = await shot(browser, false);
  log('LTR widths:', JSON.stringify(ltr.widths));
  console.log(JSON.stringify(ltr, null, 2));
} catch (e) {
  log('ERROR:', String(e));
} finally {
  if (browser) await browser.close();
}
process.exit(0);
