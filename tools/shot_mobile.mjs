// Screenshots the mobile view at several ?uiscale= values to find the biggest UI
// that still fits without the toolbar wrapping. Reports toolbar row height (a
// jump = wrapped to a second row) and whether the app fits the viewport.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'artifacts');
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// Their phone ≈ 787×382 CSS (1574×764 @ DPR2). Also a common 844×390.
const VP = { width: 787, height: 382 };
const SCALES = [1.5, 2, 2.5, 3];

let browser;
try {
  browser = await chromium.launch();
  const out = [];
  for (const us of SCALES) {
    const ctx = await browser.newContext({ viewport: VP, hasTouch: true });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`http://localhost:5173/?mobile=1&uiscale=${us}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.app', { timeout: 10000 });
    await page.waitForTimeout(500);
    const info = await page.evaluate(() => {
      const app = document.querySelector('.app');
      const r = app.getBoundingClientRect();
      // Toolbar = the row holding the mode buttons. Find the button labeled "View"
      // and report its toolbar container's design height (wrap → taller).
      const btns = [...app.querySelectorAll('button')];
      const view = btns.find((b) => b.textContent.trim() === 'View');
      const bar = view ? view.parentElement : null;
      return {
        appW: Math.round(r.width), appH: Math.round(r.height),
        designW: app.offsetWidth, designH: app.offsetHeight,
        toolbarDesignH: bar ? bar.offsetHeight : null,
        viewBtnDesignH: view ? view.offsetHeight : null,
      };
    });
    await page.screenshot({ path: path.join(outDir, `mobile_uiscale_${us}.png`) });
    out.push({ uiscale: us, ...info, fits: info.appW <= VP.width + 1 && info.appH <= VP.height + 1, errs });
    await ctx.close();
  }
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  log('ERROR:', String(e));
} finally {
  if (browser) await browser.close();
}
process.exit(0);
