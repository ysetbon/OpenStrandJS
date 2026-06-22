// Drives the live editor (Vite dev server) with Playwright: loads a fixture via
// the real toolbar button, then verifies #c actually rendered something.
// Usage: node tools/verify_editor.mjs [fixtureName] [url]
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fixture = process.argv[2] || 'single_strand';
const url = process.argv[3] || 'http://localhost:5173/';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPng = path.join(root, 'artifacts', `editor_${fixture}.png`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// NOTE: a Vite dev server keeps an HMR websocket open, so 'networkidle' never
// fires — wait on 'load' instead.
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.getByRole('button', { name: fixture, exact: true }).click({ timeout: 10000 });
await page.waitForTimeout(1500);

const stats = await page.evaluate(() => {
  const c = document.getElementById('c');
  if (!c) return { ok: false, reason: 'no #c' };
  const ctx = c.getContext('2d');
  const { width, height } = c;
  const data = ctx.getImageData(0, 0, width, height).data;
  let nonWhite = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++;
  }
  return { ok: true, width, height, nonWhite, total: width * height };
});

await page.locator('#c').screenshot({ path: outPng });
await browser.close();

console.log(JSON.stringify({ fixture, stats, errors, screenshot: outPng }, null, 2));
process.exit(0);
