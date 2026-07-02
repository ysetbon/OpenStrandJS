// Validate window.computeAutoShadowHiddenPairs (the JS port of OpenStrandStudio's
// auto_shadow.py) against the masked-weave artifact scene:
//   1. print the full candidate ratio table for the fixture,
//   2. assert the auto-hidden pairs equal the ground-truth manual fix
//      (4_3->{3_1,4_1}, 4_2->{3_1,4_1} on the default fixture),
//   3. render broken (no overrides), manual (ground truth), and auto
//      (computed) variants and pixel-diff: auto vs manual must be 0.
//
// Usage: node tools/compare_auto_shadow.mjs [fixture.json]
//   default fixture: fixtures/mask_shadow_weave.json
// Artifacts land in artifacts/auto_shadow/.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixturePath = path.resolve(root, process.argv[2] || 'fixtures/mask_shadow_weave.json');
const outDir = path.join(root, 'artifacts', 'auto_shadow');
mkdirSync(outDir, { recursive: true });

const GROUND_TRUTH = {
  '4_3': { '3_1': { visibility: false }, '4_1': { visibility: false } },
  '4_2': { '3_1': { visibility: false }, '4_1': { visibility: false } },
};

const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
const strands = data.type === 'OpenStrandStudioHistory'
  ? data.states.find((s) => s.step === data.current_step).data.strands
  : data.strands;

const baseMeta = {
  image_width: 900, image_height: 700, x_offset: 0, y_offset: 0,
  supersample: 2, shadow_enabled: true,
};

const browser = await chromium.launch();
let failures = 0;
const expect = (cond, label) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label);
  if (!cond) failures++;
};
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const url = pathToFileURL(path.join(root, 'web', 'render.html')).href + '?v=' + Math.floor(Math.random() * 1e9);
  await page.goto(url);
  await page.waitForFunction(() => typeof window.computeAutoShadowHiddenPairs === 'function');

  const shot = async (overrides, name) => {
    await page.evaluate(
      ({ strands, meta }) => window.renderFixture(strands, meta),
      { strands, meta: { ...baseMeta, shadow_overrides: overrides } },
    );
    const png = path.join(outDir, name);
    await (await page.$('#c')).screenshot({ path: png });
    return png;
  };
  const diff = (aPath, bPath, name) => {
    const a = PNG.sync.read(readFileSync(aPath));
    const b = PNG.sync.read(readFileSync(bPath));
    const d = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, d.data, a.width, a.height, { threshold: 0.05 });
    writeFileSync(path.join(outDir, name), PNG.sync.write(d));
    return n;
  };

  // 1) ratio table + computed pairs
  const table = await page.evaluate(
    ({ strands }) => window.computeAutoShadowHiddenPairs(strands, { shadow_overrides: {} }),
    { strands },
  );
  console.log('casting -> receiving   raw_area   ratio   hide');
  for (const p of [...table].sort((x, y) => x.ratio - y.ratio)) {
    console.log(
      `${p.casting.padStart(7)} -> ${p.receiving.padEnd(9)} ${String(Math.round(p.raw_area)).padStart(8)}` +
      `   ${p.ratio.toFixed(3)}   ${p.hide ? 'HIDE' : ''}`,
    );
  }
  const hidden = table.filter((p) => p.hide);
  const auto = {};
  for (const p of hidden) (auto[p.casting] ??= {})[p.receiving] = { visibility: false, auto: true };

  const want = Object.entries(GROUND_TRUTH).flatMap(([c, m]) => Object.keys(m).map((r) => `${c}->${r}`)).sort();
  const got = hidden.map((p) => `${p.casting}->${p.receiving}`).sort();
  expect(JSON.stringify(got) === JSON.stringify(want),
    `auto pairs == ground truth (want ${want.join(', ')}; got ${got.join(', ') || 'none'})`);

  // 2) renders + diffs
  const broken = await shot({}, 'broken.png');
  const manual = await shot(GROUND_TRUTH, 'manual.png');
  const autoPng = await shot(auto, 'auto.png');
  const dBM = diff(broken, manual, 'diff_broken_vs_manual.png');
  const dMA = diff(manual, autoPng, 'diff_manual_vs_auto.png');
  console.log(`broken vs manual: ${dBM} px (artifact size); manual vs auto: ${dMA} px`);
  expect(dBM > 0, 'fixture reproduces the artifact (broken != manual)');
  expect(dMA === 0, 'auto render is pixel-identical to the manual ground truth');
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
process.exit(failures ? 1 : 0);
