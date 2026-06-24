// Capture the live JS app canvas (#c) per theme into artifacts/canvas-theme/js_<theme>.png
// so the canvas background + grid can be compared to the real OSS grabs.
// Usage: node tools/capture_canvas_themes.mjs [url]   (default http://localhost:5173/)

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', 'artifacts', 'canvas-theme');
mkdirSync(dir, { recursive: true });
const url = process.argv[2] || 'http://localhost:5173/';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__store, null, { timeout: 10000 });
  for (const theme of ['default', 'light', 'dark']) {
    await page.evaluate((t) => {
      window.__store.getState().setSettings({ theme: t, show_grid: true });
      const dev = document.querySelector('.tb-dev'); if (dev) dev.style.display = 'none';
    }, theme);
    await page.waitForTimeout(500);
    const c = await page.$('#c');
    const out = path.join(dir, `js_${theme}.png`);
    await c.screenshot({ path: out });
    console.log('saved', out);
  }
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
process.exit(0);
