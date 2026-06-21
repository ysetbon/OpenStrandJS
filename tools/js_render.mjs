// Render a fixture with the JS (Paper.js) renderer in a real Chromium via
// Playwright, into a canvas sized from the reference meta.json, and screenshot
// it to <artifactDir>/js.png so it can be diffed against reference.png.
//
// Usage: node tools/js_render.mjs <fixture.json> <artifactDir>
// OSS_STEP overrides which history step to render (mirrors reference_render.py).

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const fixturePath = process.argv[2];
const artifactDir = process.argv[3];
if (!fixturePath || !artifactDir) {
  console.error('usage: node tools/js_render.mjs <fixture.json> <artifactDir>');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const meta = JSON.parse(readFileSync(path.join(artifactDir, 'reference.meta.json'), 'utf8'));

let data = JSON.parse(readFileSync(fixturePath, 'utf8'));
let strands;
if (data && data.type === 'OpenStrandStudioHistory') {
  const step = process.env.OSS_STEP ? Number(process.env.OSS_STEP) : data.current_step;
  const state = data.states.find((s) => s.step === step);
  if (!state) {
    console.error(`step ${step} not found in history`);
    process.exit(1);
  }
  strands = state.data.strands;
} else {
  strands = data.strands;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  page.on('console', (msg) => console.log('[page]', msg.text()));
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));

  // Cache-buster: Chromium can cache file:// resources, which would silently
  // serve a stale render.html after edits.
  const url = pathToFileURL(path.join(root, 'web', 'render.html')).href + '?v=' + Math.floor(Math.random() * 1e9);
  await page.goto(url);
  await page.waitForFunction(() => typeof window.renderFixture === 'function');

  const result = await page.evaluate(
    ({ strands, meta }) => window.renderFixture(strands, meta),
    { strands, meta },
  );

  const canvas = await page.$('#c');
  const outPng = path.join(artifactDir, 'js.png');
  await canvas.screenshot({ path: outPng });
  console.log('js render ->', outPng, JSON.stringify(result));
} finally {
  await browser.close().catch(() => {});
}
// Playwright can keep the event loop alive after close, hanging the process
// (which stalled chained diffs and background tasks). Force a clean exit.
process.exit(0);
