// Regression guard for the hidden-strand fix.
//
// OSS keeps hidden strands in canvas.strands and gates only the PAINT on
// is_hidden (strand.py:2279, masked_strand.py:489), so a mask whose component is
// hidden still draws. This port used to DROP hidden strands from the render array
// (toRenderArray), and since buildMaskPath resolves a mask's components through
// byLayer — built from that array — hiding one component silently took the whole
// mask down with it.
//
// The fix has two halves and this checks BOTH, because either one alone would
// resurrect the bug: the ADAPTER (src/renderer/toRenderArray.ts) has to keep
// hidden strands in the array, and the RENDERER has to skip painting them. The
// adapter is compiled on the fly with the repo's own tsc — it imports nothing at
// runtime (its only import is `import type`), so it loads standalone.
//
// Usage: node tools/hidden_strand_check.mjs
//        OSS_CHROMIUM=/path/to/chrome node tools/hidden_strand_check.mjs
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(readFileSync(path.join(root, 'fixtures/box_stitch.json'), 'utf8'));
const data = raw.type === 'OpenStrandStudioHistory'
  ? raw.states.find((s) => s.step === raw.current_step).data : raw;
const strands = data.strands.slice().sort((a, b) => a.index - b.index);

const mask = strands.find((s) => s.type === 'MaskedStrand');
if (!mask) throw new Error('fixture has no MaskedStrand');
const [a, b, c, d] = mask.layer_name.split('_');
const over = `${a}_${b}`;
const under = `${c}_${d}`;

const meta = {
  image_width: 700, image_height: 700, x_offset: 0, y_offset: 0,
  supersample: 2, shadow_enabled: true,
  curve_params: { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 },
};

// ---- compile and load the real adapter -------------------------------------
const outDir = mkdtempSync(path.join(tmpdir(), 'ossjs-adapter-'));
execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', 'src/renderer/toRenderArray.ts', '--outDir', outDir,
   '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
  { cwd: root, stdio: 'inherit' },
);
const { toRenderArray } = createRequire(import.meta.url)(
  path.join(outDir, 'renderer', 'toRenderArray.js'));

// Minimal EditorDocument over the fixture's strands. The loader routes unmodeled
// keys into `extra`, so mirror that here — it keeps the adapter's output faithful
// without pulling the whole loader in. `omit` drops a layer entirely (the old
// behavior); `hide` flags it (the new one).
function makeDoc({ only, omit, hide } = {}) {
  const doc = { order: [], strands: {} };
  for (const s of strands) {
    if (only && !only.includes(s.layer_name)) continue;
    if (omit === s.layer_name) continue;
    doc.strands[s.layer_name] = { ...s, extra: { ...s }, is_hidden: hide === s.layer_name };
    doc.order.push(s.layer_name);
  }
  return doc;
}

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(pathToFileURL(path.join(root, 'web/render.html')).href + '?v=' + Date.now());
  await page.waitForFunction(() => typeof window.renderFixture === 'function');

  // Render and return {ink, h}: ink = non-white pixel count, h = hash of the
  // whole buffer (ink alone can collide when a repaint only swaps colors).
  const shoot = (arr) => page.evaluate(({ arr, meta }) => {
    window.renderFixture(arr, meta);
    const cv = document.getElementById('c');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0, h = 2166136261 >>> 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) ink++;
      h = Math.imul(h ^ (px[i] + 3 * px[i + 1] + 7 * px[i + 2] + i), 16777619) >>> 0;
    }
    return { ink, h };
  }, { arr, meta });

  const hide = (name) => strands.map((s) => (s.layer_name === name ? { ...s, is_hidden: true } : { ...s }));
  const drop = (name) => strands.filter((s) => s.layer_name !== name).map((s) => ({ ...s }));
  // The mask plus its two components, so the mask's own ink is isolated.
  const trioNames = [mask.layer_name, over, under];
  const trio = strands.filter((s) => trioNames.includes(s.layer_name));

  const base = await shoot(strands.map((s) => ({ ...s })));
  const componentHidden = await shoot(hide(over));
  const maskHidden = await shoot(hide(mask.layer_name));
  const trioHidden = await shoot(trio.map((s) => (s.layer_name === over ? { ...s, is_hidden: true } : { ...s })));
  const trioDropped = await shoot(trio.filter((s) => s.layer_name !== over).map((s) => ({ ...s })));
  const trioNoMask = await shoot(trio
    .filter((s) => s.layer_name !== over && s.layer_name !== mask.layer_name).map((s) => ({ ...s })));

  let fails = 0;
  const ok = (n, cond, extra = '') => {
    console.log((cond ? 'PASS  ' : 'FAIL  ') + n + (cond ? '' : '  ' + extra));
    if (!cond) fails++;
  };

  // ---- ADAPTER half: hidden strands must survive src/renderer/toRenderArray.ts.
  // These are the assertions that go red if the `if (s.is_hidden) continue;`
  // filter is ever reinstated there — the pixel checks below cannot see that,
  // because they hand the renderer an array the adapter never touched.
  const adapted = toRenderArray(makeDoc({ hide: over }));
  const hiddenRow = adapted.find((s) => s.layer_name === over);
  ok('adapter keeps a hidden strand in the array', !!hiddenRow,
    `${over} was dropped by toRenderArray`);
  ok('adapter flags it is_hidden for the renderer', hiddenRow?.is_hidden === true,
    `is_hidden was ${hiddenRow?.is_hidden}`);
  ok('adapter still emits the mask that depends on it',
    adapted.some((s) => s.layer_name === mask.layer_name));

  // End-to-end through the adapter: its output, rendered, still shows the mask.
  const viaAdapter = await shoot(toRenderArray(makeDoc({ only: trioNames, hide: over })));
  const viaAdapterDropped = await shoot(toRenderArray(makeDoc({ only: trioNames, omit: over })));
  ok('adapter output renders the mask when a component is hidden',
    viaAdapter.h !== viaAdapterDropped.h,
    'hiding and dropping produced the same image — the adapter is filtering');

  // ---- RENDERER half -------------------------------------------------------
  ok('canvas renders at all', base.ink > 0);
  ok('hiding a component drops its own body + shadow', componentHidden.ink < base.ink,
    `${componentHidden.ink} !< ${base.ink}`);
  ok('hiding a component KEEPS its mask painted', trioHidden.ink > trioNoMask.ink,
    `${trioHidden.ink} should exceed the mask-less baseline ${trioNoMask.ink}`);
  ok('dropping a component from the array loses the mask (the old bug)',
    trioDropped.h === trioNoMask.h, 'the drop path should be indistinguishable from having no mask');
  ok('hidden != dropped, so the gate is doing the work', trioHidden.h !== trioDropped.h);
  ok('hiding the mask itself still changes the image', maskHidden.h !== base.h);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
} finally {
  await browser.close();
  rmSync(outDir, { recursive: true, force: true });
}
