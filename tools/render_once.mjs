// Render a fixture ONCE with web/render.html (renderFixture) and save the PNG.
// Self-contained (no Qt reference needed) — used for before/after byte-identity
// checks when strand-renderer.js is edited, and by compare_auto_shadow.mjs.
//
// Usage: node tools/render_once.mjs <fixture.json> <out.png> [overrides.json]
//   overrides.json (optional): a shadow_overrides dict merged into the meta.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const fixturePath = process.argv[2];
const outPng = process.argv[3];
const overridesPath = process.argv[4];
if (!fixturePath || !outPng) {
  console.error('usage: node tools/render_once.mjs <fixture.json> <out.png> [overrides.json]');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let data = JSON.parse(readFileSync(fixturePath, 'utf8'));
const strands = data.type === 'OpenStrandStudioHistory'
  ? data.states.find((s) => s.step === data.current_step).data.strands
  : data.strands;

const meta = {
  image_width: 900,
  image_height: 700,
  x_offset: 0,
  y_offset: 0,
  supersample: 2,
  shadow_enabled: true,
  shadow_overrides: overridesPath ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {},
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const url = pathToFileURL(path.join(root, 'web', 'render.html')).href + '?v=' + Math.floor(Math.random() * 1e9);
  await page.goto(url);
  await page.waitForFunction(() => typeof window.renderFixture === 'function');
  await page.evaluate(({ strands, meta }) => window.renderFixture(strands, meta), { strands, meta });
  const canvas = await page.$('#c');
  await canvas.screenshot({ path: outPng });
  console.log('rendered ->', outPng);
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
process.exit(0);
