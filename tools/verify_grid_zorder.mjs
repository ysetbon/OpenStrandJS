// Verify the grid is drawn BEHIND strands in the live render path: render a strand
// via render.html's window.renderFixture with a grid meta, then assert that the
// strand body pixels are the strand color (grid covered) while empty cells show
// the grid over the theme bg.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixture = JSON.parse(readFileSync(path.join(root, 'fixtures', 'single_strand.json'), 'utf8'));
const strands = fixture.strands;
const meta = JSON.parse(readFileSync(path.join(root, 'artifacts', 'single_strand', 'reference.meta.json'), 'utf8'));
// Live-editor meta: dark theme backdrop + OSS grid.
meta.canvas_bg = '#2C2C2C';
meta.grid = { size: 28 };
meta.fast_downscale = true;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  const url = pathToFileURL(path.join(root, 'web', 'render.html')).href + '?v=' + Math.floor(Math.random() * 1e9);
  await page.goto(url);
  await page.waitForFunction(() => typeof window.renderFixture === 'function');
  const res = await page.evaluate(({ strands, meta }) => {
    window.renderFixture(strands, meta);
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    // Strand center: sample the middle of the canvas (single_strand runs through it).
    // Scan a vertical column at mid-x for the strand body (a saturated/colored band).
    const midX = Math.round(W / 2);
    const colors = [];
    for (let y = 0; y < H; y += 2) colors.push([y, px(midX, y)]);
    // Classify: bg ~ (44,44,44); grid ~ light gray (>100 all channels, near-equal);
    // strand body = colored (channels differ a lot OR not gray).
    const isGray = ([r, g, b]) => Math.abs(r - g) < 12 && Math.abs(g - b) < 12;
    const strandBand = colors.filter(([, c]) => !isGray(c));
    const sample = strandBand.length ? strandBand[Math.floor(strandBand.length / 2)] : null;
    // Count grid pixels (light gray, brighter than bg) in an empty top strip.
    let gridPx = 0, bgPx = 0;
    for (let x = 0; x < W; x += 1) {
      const c = px(x, 12);
      if (c[0] > 90 && isGray(c)) gridPx++;
      else if (c[0] < 70) bgPx++;
    }
    return { W, H, strandSample: sample, strandBandCount: strandBand.length, gridPxTopRow: gridPx, bgPxTopRow: bgPx };
  }, { strands, meta });
  console.log(JSON.stringify(res, null, 2));
  const c = await page.$('#c');
  await c.screenshot({ path: path.join(root, 'artifacts', 'canvas-theme', 'grid_zorder_dark.png') });
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
process.exit(0);
