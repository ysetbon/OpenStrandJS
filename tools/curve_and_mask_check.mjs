// Regression guard for the Tier-2 render-correctness fixes.
//
// 1. MASK STALENESS DURING A DRAG — the drag fast-path cached byLayer (a geometry
//    lookup) from the pointer-down bake, so a mask whose component was being
//    dragged kept rendering its pointer-down intersection until pointer-up.
// 2. enable_third_control_point — a USER SETTING in OSS (strand.py::_build_curve_profile
//    reads canvas.enable_third_control_point), previously inferred from the data so
//    the toggle did nothing.
// 3. Curvature bias — bias_control was hardcoded to 0.5, so a file authored with
//    bias rendered the wrong curve.
//
// Every check is written so it FAILS if the corresponding fix is reverted.
//
// Usage: node tools/curve_and_mask_check.mjs
//        OSS_CHROMIUM=/path/to/chrome node tools/curve_and_mask_check.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => {
  const raw = JSON.parse(readFileSync(path.join(root, 'fixtures', name), 'utf8'));
  const data = raw.type === 'OpenStrandStudioHistory'
    ? raw.states.find((s) => s.step === raw.current_step).data : raw;
  return data.strands.slice().sort((a, b) => a.index - b.index);
};

const BASE = {
  image_width: 700, image_height: 700, x_offset: 0, y_offset: 0,
  supersample: 1, shadow_enabled: false,
  curve_params: { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 },
};

let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(pathToFileURL(path.join(root, 'web/render.html')).href + '?v=' + Date.now());
  await page.waitForFunction(() => typeof window.renderFixture === 'function');

  const snap = () => page.evaluate(() => {
    const cv = document.getElementById('c');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0, h = 2166136261 >>> 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) ink++;
      h = Math.imul(h ^ (px[i] + 3 * px[i + 1] + 7 * px[i + 2] + i), 16777619) >>> 0;
    }
    return { ink, h };
  });
  const full = async (arr, meta) => {
    await page.evaluate(({ arr, meta }) => window.renderFixture(arr, meta), { arr, meta });
    return snap();
  };

  // ---------------------------------------------------------------- 1. mask drag
  {
    const all = load('box_stitch.json');
    const mask = all.find((s) => s.type === 'MaskedStrand');
    const [a, b, c, d] = mask.layer_name.split('_');
    const over = `${a}_${b}`, under = `${c}_${d}`;
    const trio = all.filter((s) => [mask.layer_name, over, under].includes(s.layer_name));
    const meta = { ...BASE, drag: { moving: [over, mask.layer_name] } };
    const shift = (s, dx) => (s.layer_name !== over ? { ...s } : {
      ...s,
      start: { x: s.start.x + dx, y: s.start.y },
      end: { x: s.end.x + dx, y: s.end.y },
      control_points: (s.control_points || []).map((p) => (p ? { x: p.x + dx, y: p.y } : p)),
      control_point_center: s.control_point_center
        ? { x: s.control_point_center.x + dx, y: s.control_point_center.y } : s.control_point_center,
    });

    // Pointer-down bake, then a frame with the component dragged 400px clear of
    // its partner. The bodies no longer overlap, so the mask must paint NOTHING.
    // Probe: render the frame with and without the mask in the array — identical
    // images mean it painted nothing.
    await page.evaluate(({ arr, meta }) => window.renderDragBackground(arr, meta),
      { arr: trio.map((s) => shift(s, 0)), meta });
    const moved = trio.map((s) => shift(s, 400));
    const frame = async (arr) => {
      await page.evaluate(({ arr, meta }) => window.renderDragFrame(arr, meta), { arr, meta });
      return snap();
    };
    const withMask = await frame(moved);
    const without = await frame(moved.filter((s) => s.layer_name !== mask.layer_name));
    ok('drag frame: mask follows its component (paints nothing once they separate)',
      withMask.h === without.h,
      `mask painted ${Math.abs(withMask.ink - without.ink)}px of pre-drag geometry`);

    const fWith = await full(moved, BASE);
    const fWithout = await full(moved.filter((s) => s.layer_name !== mask.layer_name), BASE);
    ok('full render agrees (control)', fWith.h === fWithout.h);
    await page.evaluate(() => window.endDrag && window.endDrag());
  }

  // ------------------------------------------- 2. enable_third_control_point gate
  {
    const arr = load('overhand_knot.json');
    const locked = arr.filter((s) => s.control_point_center_locked).length;
    ok('fixture exercises the third control point', locked > 0, `${locked} locked centers`);
    const on = await full(arr, { ...BASE, enable_third_control_point: true });
    const off = await full(arr, { ...BASE, enable_third_control_point: false });
    const absent = await full(arr, BASE);
    ok('third-CP setting changes the drawn curve', on.h !== off.h,
      'toggling it had no effect — the renderer is still inferring it');
    ok('absent meta keeps the Qt-oracle inference (reference_render.py:117-121)',
      absent.h === on.h);
  }

  // ------------------------------------------------------------- 3. curvature bias
  {
    // Bias only reshapes a CURVE. buildProfile early-returns 'line' when both
    // handles sit on the start, so bias must be injected into strands that are
    // genuinely curved or the check passes vacuously.
    const curved = (s) => {
      const cp = s.control_points || [];
      if (cp.length < 2 || !cp[0] || !cp[1]) return false;
      return Math.hypot(cp[0].x - s.start.x, cp[0].y - s.start.y) >= 1
        || Math.hypot(cp[1].x - s.start.x, cp[1].y - s.start.y) >= 1;
    };
    const src = load('box_stitch.json');
    const nCurved = src.filter(curved).length;
    ok('fixture exercises a real curve', nCurved > 0, `${nCurved} curved strands`);
    const arr = src.map((s) => (curved(s)
      ? { ...s, bias_control: { triangle_bias: 0.95, circle_bias: 0.05 } } : s));
    const on = await full(arr, { ...BASE, enable_curvature_bias_control: true });
    const off = await full(arr, { ...BASE, enable_curvature_bias_control: false });
    const absent = await full(arr, BASE);
    ok('bias changes the drawn curve when the setting is on', on.h !== off.h,
      'bias is still pinned to 0.5');
    ok('bias is ignored when the setting is off (OSS gate)', off.h === absent.h);
  }

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  // exitCode, NOT process.exit(): the latter tears the process down before the
  // finally block can await browser.close(), orphaning Chromium.
  process.exitCode = fails ? 1 : 0;
} finally {
  await browser.close();
}
