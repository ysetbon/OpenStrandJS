// Regression guard for the hidden-strand fix.
//
// OSS keeps hidden strands in canvas.strands and gates only the PAINT on
// is_hidden (strand.py:2279, masked_strand.py:489), so a mask whose component is
// hidden still draws. This port used to DROP hidden strands from the render array
// (toRenderArray), and since buildMaskPath resolves a mask's components through
// byLayer — built from that array — hiding one component silently took the whole
// mask down with it.
//
// Usage: node tools/hidden_strand_check.mjs
//        OSS_CHROMIUM=/path/to/chrome node tools/hidden_strand_check.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
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
  const trio = strands.filter((s) => [mask.layer_name, over, under].includes(s.layer_name));

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
}
