// Renderer guard for the Tier-4 geometry, driven through the real Paper.js
// renderer in Chromium: dashed extension rays, arrow head textures, arrow shaft
// patterns, arrow_casts_shadow, and OSS's inverted arrow-colour rule.
//
// The extension check is not a "something changed" probe — it measures WHERE the
// ray lands, so a wrong dash-gap sign or a ray pointing into the body fails.
//
// Usage: node tools/tier4_ui_check.mjs
//        OSS_CHROMIUM=/path/to/chrome node tools/tier4_ui_check.mjs
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };

// A horizontal strand well inside a 700x700 canvas, so a 100px ray either side
// stays on-canvas and every measurement below is unambiguous.
const STRAND = {
  type: 'Strand', layer_name: '1_1', set_number: 1, index: 0,
  start: { x: 250, y: 350 }, end: { x: 450, y: 350 },
  control_points: [{ x: 250, y: 350 }, { x: 450, y: 350 }],
  control_point_center: { x: 350, y: 350 }, control_point_center_locked: false,
  width: 46, stroke_width: 4,
  color: { r: 200, g: 170, b: 230, a: 255 }, stroke_color: { r: 0, g: 0, b: 0, a: 255 },
  has_circles: [false, false], is_hidden: false,
};
const BASE = {
  image_width: 700, image_height: 700, x_offset: 0, y_offset: 0,
  supersample: 1, shadow_enabled: false,
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
    let ink = 0, h = 2166136261 >>> 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) ink++;
      h = Math.imul(h ^ (px[i] + 3 * px[i + 1] + 7 * px[i + 2] + i), 16777619) >>> 0;
    }
    return { ink, h };
  });

  // Inked x-positions along one scanline — how far the ray actually reaches.
  const rowInk = (y) => page.evaluate((yy) => {
    const cv = document.getElementById('c');
    const px = cv.getContext('2d').getImageData(0, yy, cv.width, 1).data;
    const xs = [];
    for (let x = 0; x < cv.width; x++) {
      const i = x * 4;
      if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) xs.push(x);
    }
    return xs;
  }, y);

  const shot = async (arr, meta) => { await render(arr, meta); return hash(); };

  // ------------------------------------------------- 1. absent flags draw nothing
  const plain = await shot([STRAND], BASE);
  const withFlagsOff = await shot([{ ...STRAND, start_extension_visible: false, end_extension_visible: false }], BASE);
  ok('extension flags absent / false render identically (fidelity invariant)',
    plain.h === withFlagsOff.h);

  // --------------------------------------------- 2. the ray lands where OSS puts it
  {
    const EXT = 100, GAP = 0;
    const meta = { ...BASE, extension_params: { length: EXT, dash_count: 1, dash_width: 6, dash_gap_length: GAP } };
    await render([{ ...STRAND, end_extension_visible: true }], meta);
    const xs = await rowInk(350);
    const maxX = Math.max(...xs);
    // dash_count 1 => one 50px dash then 50px of gap, so ink reaches ~450+50.
    ok('an end extension paints beyond the strand end', maxX > 455, `reached x=${maxX}`);
    ok('...and stops within the configured extension length',
      maxX <= 450 + EXT + 2, `reached x=${maxX}, limit ${450 + EXT}`);

    await render([{ ...STRAND, start_extension_visible: true }], meta);
    const xs2 = await rowInk(350);
    const minX = Math.min(...xs2);
    ok('a start extension paints before the strand start', minX < 245, `reached x=${minX}`);
    ok('...and stops within the configured extension length',
      minX >= 250 - EXT - 2, `reached x=${minX}, limit ${250 - EXT}`);
  }

  // --------------------------------- 3. dash_gap slides the ray AWAY from the body
  {
    const mk = (gap) => ({ ...BASE, extension_params: { length: 100, dash_count: 1, dash_width: 6, dash_gap_length: gap } });
    await render([{ ...STRAND, end_extension_visible: true }], mk(0));
    const a = Math.max(...await rowInk(350));
    await render([{ ...STRAND, end_extension_visible: true }], mk(30));
    const b = Math.max(...await rowInk(350));
    // OSS negates the gap and adds it to BOTH endpoints, so a positive setting
    // pushes the whole ray outward — the far end moves by exactly the gap.
    ok('a positive dash gap pushes the ray outward, not inward', b > a, `${a} -> ${b}`);
    ok('...by the gap distance', Math.abs((b - a) - 30) <= 2, `moved ${b - a}px, expected ~30`);
  }

  // ------------------------------------------------ 4. arrow textures and shafts
  {
    const arrowMeta = { ...BASE };
    const full = { ...STRAND, full_arrow_visible: true };
    const base = await shot([full], arrowMeta);
    for (const tex of ['stripes', 'dots', 'crosshatch']) {
      const t = await shot([{ ...full, arrow_texture: tex }], arrowMeta);
      ok(`arrow_texture '${tex}' changes the drawn head`, t.h !== base.h);
    }
    ok("arrow_texture 'none' is identical to absent",
      (await shot([{ ...full, arrow_texture: 'none' }], arrowMeta)).h === base.h);

    for (const st of ['tiles', 'stripes', 'dots']) {
      const t = await shot([{ ...full, arrow_shaft_style: st }], arrowMeta);
      ok(`arrow_shaft_style '${st}' changes the drawn shaft`, t.h !== base.h);
    }
    ok("arrow_shaft_style 'solid' is identical to absent",
      (await shot([{ ...full, arrow_shaft_style: 'solid' }], arrowMeta)).h === base.h);
  }

  // ------------------------------------------------------- 5. arrow_casts_shadow
  {
    // The scene has to be built so the ARROW is the only thing that can reach the
    // receiver. A caster whose BODY already overlaps proves nothing — the region
    // is caster ∩ receiver, so the arrow would add no area. Here the caster ends
    // 93px clear of the receiver band (further than the 30px blur reach), and only
    // a long head extends down into it.
    const mk = (o) => ({ ...STRAND, ...o });
    const recv = mk({ layer_name: '2_1', set_number: 2, index: 0,
      start: { x: 200, y: 500 }, end: { x: 700, y: 500 },
      control_points: [{ x: 200, y: 500 }, { x: 700, y: 500 }], control_point_center: { x: 450, y: 500 } });
    const caster = mk({ layer_name: '1_1', index: 1,
      start: { x: 400, y: 200 }, end: { x: 400, y: 380 },
      control_points: [{ x: 400, y: 200 }, { x: 400, y: 380 }], control_point_center: { x: 400, y: 290 },
      full_arrow_visible: true });
    const meta = {
      ...BASE, shadow_enabled: true,
      arrow_params: { head_length: 110, head_width: 50, head_stroke_width: 4, gap_length: 10, line_length: 20, line_width: 10 },
    };

    // Mean luminance of a box inside the receiver, beside the arrow head — where
    // the cast shadow lands. Ink COUNT is the wrong probe here: the shadow falls
    // on already-painted pixels, so it darkens without adding any.
    const boxLuma = () => page.evaluate(() => {
      const cv = document.getElementById('c');
      // Measured region: the shadow lands at x 381-418, y 477-504 in this scene.
      const d = cv.getContext('2d').getImageData(385, 480, 30, 20).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum / (d.length / 4) / 3;
    });

    await render([recv, caster], meta);
    const off = await boxLuma();
    await render([recv, { ...caster, arrow_casts_shadow: true }], meta);
    const on = await boxLuma();
    ok('arrow_casts_shadow darkens the receiver under the arrow',
      on < off - 1, `luma ${off.toFixed(1)} -> ${on.toFixed(1)}`);

    const plainHash = await shot([recv, caster], meta);
    ok('...and is off by default (every OSS drawing path defaults it false)',
      (await shot([recv, { ...caster, arrow_casts_shadow: false }], meta)).h === plainHash.h);
  }

  // ------------------------------- 6. the inverted use_default_arrow_color rule
  {
    const full = { ...STRAND, full_arrow_visible: true };
    const plainArrow = await shot([full], BASE);
    const fill = { r: 255, g: 0, b: 0, a: 255 };
    // FALSE is the branch that applies the configured colour (strand.py:2313).
    const applied = await shot([full], { ...BASE, use_default_arrow_color: false, default_arrow_fill_color: fill });
    ok('use_default_arrow_color FALSE repaints the head', applied.h !== plainArrow.h);
    const ticked = await shot([full], { ...BASE, use_default_arrow_color: true, default_arrow_fill_color: fill });
    ok('...and TRUE hands it back to the strand colour', ticked.h === plainArrow.h);
  }

  ok('no page errors along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exitCode = fails ? 1 : 0;
