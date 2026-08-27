// Guard for the Tier-5 Shadow Path preview overlay (OSS
// strand_drawing_canvas.py:2794-2822 + shader_utils.py calculate_shadow_for_layer_pair).
//
// The overlay's whole claim is that it shows WHERE a shadow actually lands, so
// "it painted something blue" proves nothing. Every check below either pins the
// overlay's pixels to the receiver's own geometry or shows the overlay reacting
// to a setting that only the real shadow pipeline reads.
//
// Usage: node tools/tier5_check.mjs
//        OSS_CHROMIUM=/path/to/chrome node tools/tier5_check.mjs
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };

// Three strands. 1_1 lies underneath; 2_1 crosses it at right angles from above,
// so 2_1 casts onto 1_1 over a clean square-ish overlap. 3_1 is a second crosser
// used only as a subtraction blocker.
const mk = (name, idx, a, b, colour) => ({
  type: 'Strand', layer_name: name, set_number: Number(name.split('_')[0]), index: idx,
  start: a, end: b,
  control_points: [{ ...a }, { ...b }],
  control_point_center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  control_point_center_locked: false,
  width: 46, stroke_width: 4,
  color: colour, stroke_color: { r: 0, g: 0, b: 0, a: 255 },
  has_circles: [false, false], is_hidden: false,
});
const UNDER = mk('1_1', 0, { x: 150, y: 350 }, { x: 550, y: 350 }, { r: 200, g: 170, b: 230, a: 255 });
const OVER  = mk('2_1', 1, { x: 350, y: 150 }, { x: 350, y: 550 }, { r: 120, g: 200, b: 160, a: 255 });
// Deliberately at x=370, NOT clear of the action: the shadow of 2_1 on 1_1 is a
// ~46px square centred on (350,350), so a blocker must overlap THAT to subtract
// anything. Parked off to one side it removes nothing and section E passes
// whatever the code does.
const THIRD = mk('3_1', 2, { x: 370, y: 150 }, { x: 370, y: 550 }, { r: 230, g: 200, b: 120, a: 255 });

const BASE = {
  image_width: 700, image_height: 700, x_offset: 0, y_offset: 0,
  supersample: 1, shadow_enabled: true,
  curve_params: { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 },
};

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(root, 'web/render.html')).href + '?v=' + Date.now());
  await page.waitForFunction(() => typeof window.renderFixture === 'function');

  const render = (arr, meta) => page.evaluate(
    ({ arr, meta }) => window.renderFixture(arr, meta), { arr, meta });

  const hash = () => page.evaluate(() => {
    const cv = document.getElementById('c');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < px.length; i += 4) {
      h = Math.imul(h ^ (px[i] + 3 * px[i + 1] + 7 * px[i + 2] + i), 16777619) >>> 0;
    }
    return h;
  });

  // The overlay's fill is rgba(0,120,255,0.39) over whatever is beneath, so it is
  // identified by "markedly more blue than red", not by an exact colour.
  const bluePixels = () => page.evaluate(() => {
    const cv = document.getElementById('c');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const out = [];
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 2] - px[i] > 40 && px[i + 2] > 90) out.push(i / 4);
    }
    return out;
  });

  // Which pixels a given array paints at all (non-white) — the footprint a blue
  // pixel must fall inside.
  const inkSet = async (arr) => {
    await render(arr, BASE);
    return new Set(await page.evaluate(() => {
      const cv = document.getElementById('c');
      const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const out = [];
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) out.push(i / 4);
      }
      return out;
    }));
  };

  const SCENE = [UNDER, OVER];
  const withPaths = (pairs, extra = {}) => ({ ...BASE, visible_shadow_paths: pairs, ...extra });

  // ------------------------------------------- A. the fidelity invariant
  {
    await render(SCENE, BASE);
    const absent = await hash();
    await render(SCENE, { ...BASE, visible_shadow_paths: [] });
    ok('an empty preview list renders identically to no key at all',
      await hash() === absent);
    await render(SCENE, withPaths([['2_1', '1_1']]));
    ok('...and a requested pair does change the image (the check above is not vacuous)',
      await hash() !== absent);
  }

  // ------------------------------------------- B. it lands on the receiver
  {
    // Every pixel the receiver alone paints. The overlay is the caster's shadow
    // ON that receiver, so it cannot escape this footprint — a bug that painted
    // the caster's own body, or the raw un-intersected footprint, would.
    const receiverInk = await inkSet([UNDER]);

    await render(SCENE, withPaths([['2_1', '1_1']]));
    const blue = await bluePixels();
    ok('the preview paints a visible region', blue.length > 200, `${blue.length}px`);
    const escaped = blue.filter((p) => !receiverInk.has(p));
    // A couple of pixels of antialiased stroke may sit on the footprint's edge;
    // anything beyond that is the overlay landing somewhere it does not belong.
    ok('...entirely inside the RECEIVING strand, like a shadow',
      escaped.length <= blue.length * 0.05,
      `${escaped.length}/${blue.length}px fell outside 1_1`);
  }

  // ------------------------------------------- C. shadow falls downward only
  {
    await render(SCENE, BASE);
    const plain = await hash();
    await render(SCENE, withPaths([['1_1', '2_1']]));
    ok('a pair pointing UP the stack previews nothing (shader_utils.py:1957)',
      await hash() === plain);
  }

  // ------------------------------------------- D. the visibility gate
  {
    // The baseline must carry the SAME override: visibility:false also removes the
    // real shadow, so comparing against a plain render would differ for a reason
    // that has nothing to do with the overlay.
    const off = { shadow_overrides: { '2_1': { '1_1': { visibility: false } } } };
    await render(SCENE, { ...BASE, ...off });
    const plain = await hash();
    await render(SCENE, withPaths([['2_1', '1_1']], off));
    ok('a pair whose shadow is switched off previews nothing (shader_utils.py:1986)',
      await hash() === plain);
  }

  // ------------------------------------------- E. it runs the REAL pipeline
  {
    // subtracted_layers is applied deep inside buildPairShadowRegion. A preview
    // that were a naive caster-∩-receiver intersection would ignore it entirely,
    // so this is what distinguishes "shares the shadow code" from "looks similar".
    const scene = [UNDER, OVER, THIRD];
    const noShadow = { shadow_enabled: false };
    await render(scene, withPaths([['2_1', '1_1']], noShadow));
    const before = (await bluePixels()).length;
    await render(scene, withPaths([['2_1', '1_1']],
      { ...noShadow, shadow_overrides: { '2_1': { '1_1': { subtracted_layers: ['3_1'] } } } }));
    const after = (await bluePixels()).length;
    ok('the preview honours subtracted_layers, so it runs the real shadow pipeline',
      before > 0 && after < before,
      `${before}px -> ${after}px (unchanged means the overlay is its own intersection)`);
  }

  ok('no page errors along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exitCode = fails ? 1 : 0;
} finally {
  await browser.close();
}
