// UI side-by-side: capture the OpenStrandJS chrome at 1400x860 (default theme,
// English, empty doc) via headless Chromium, then composite it next to the real
// OpenStrand Studio main-window grab (artifacts/ui_compare/oss_main.png) and emit
// a pixel-diff heatmap.
//
// NOTE: a literal pixel-% is NOT the meaningful "99%" kind here — unlike the
// canvas renderer, the chrome is Qt-painted (oss) vs browser-painted (js) with
// different fonts/AA, and the offscreen Qt grab omits button *text*. The
// side-by-side is the useful artifact; the diff just localizes layout shifts.
//
// Usage: node tools/ui_compare.mjs [jsURL]   (default http://localhost:5175/)

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', 'artifacts', 'ui_compare');
const W = 1400, H = 860;
const jsURL = process.argv[2] || 'http://localhost:5175/';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(jsURL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__store, null, { timeout: 8000 });
  // Force the comparison state: default theme, English, empty doc; hide the
  // dev-only sample loader so the chrome matches a production build.
  await page.evaluate(() => {
    window.__store.getState().setSettings({ theme: 'default', language: 'en' });
    const dev = document.querySelector('.tb-dev'); if (dev) dev.style.display = 'none';
  });
  await page.waitForTimeout(400);
  const jsPng = path.join(dir, 'js_main.png');
  await page.screenshot({ path: jsPng, clip: { x: 0, y: 0, width: W, height: H } });
  console.log('js grab ->', jsPng);

  // Compose side-by-side + diff.
  const oss = PNG.sync.read(readFileSync(path.join(dir, 'oss_main.png')));
  const js = PNG.sync.read(readFileSync(jsPng));
  const w = Math.min(oss.width, js.width), h = Math.min(oss.height, js.height);

  const GAP = 16;
  const side = new PNG({ width: w * 2 + GAP, height: h });
  side.data.fill(0x88);
  blit(oss, side, 0, 0, w, h);
  blit(js, side, w + GAP, 0, w, h);
  writeFileSync(path.join(dir, 'ui_sidebyside.png'), PNG.sync.write(side));

  const diff = new PNG({ width: w, height: h });
  const n = pixelmatch(crop(oss, w, h).data, crop(js, w, h).data, diff.data, w, h, { threshold: 0.18 });
  writeFileSync(path.join(dir, 'ui_diff.png'), PNG.sync.write(diff));
  console.log(`sidebyside -> ${path.join(dir, 'ui_sidebyside.png')}`);
  console.log(`diff -> ${path.join(dir, 'ui_diff.png')}  changedPixels=${n} (${(100 * n / (w * h)).toFixed(1)}% — font/AA/engine noise, not strand-renderer fidelity)`);
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
process.exit(0);

function crop(src, w, h) {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (src.width * y + x) << 2, d = (w * y + x) << 2;
    out.data[d] = src.data[s]; out.data[d + 1] = src.data[s + 1];
    out.data[d + 2] = src.data[s + 2]; out.data[d + 3] = src.data[s + 3];
  }
  return out;
}
function blit(src, dst, ox, oy, w, h) {
  for (let y = 0; y < h && y < src.height; y++) for (let x = 0; x < w && x < src.width; x++) {
    const s = (src.width * y + x) << 2, d = (dst.width * (y + oy) + (x + ox)) << 2;
    dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1];
    dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = 255;
  }
}
