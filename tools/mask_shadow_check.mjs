// Oracle-free checks of the OSS 2.0 mask / joint shadow pipeline in
// web/strand-renderer.js, mirroring OpenStrand Studio's own tests:
//
//   tests/test_mask_piece_cover.py      which strands a mask's piece keeps clear of
//                                       (_covering_strands / _piece_keep)
//   tests/test_shadow_subtraction.py    _runs_under, _opaque_cover
//   tests/test_joint_shadow.py          the joint shadow cut (_caster_shadow_path,
//                                       _seam_slab) and lowered unfolded caps
//   tests/test_selection_outline_over_masks.py
//                                       a selected strand's outline stays whole
//                                       over a masked crossing (plain and zoomed)
//
// The geometry queries go through window.__maskShadowProbe (world units); the
// selection check renders with window.renderFixture. Runs in headless Chromium,
// no Qt needed, so CI runs it.
//
// Usage: node tools/mask_shadow_check.mjs
// OSS_CHROMIUM: absolute path to a Chromium binary if Playwright's own revision
// is not installed.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// The canvas's default curve settings (not saved in the files), as the OSS
// tests set them.
const CURVE = { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 };
const META = { curve_params: CURVE, max_blur_radius: 29.99, num_steps: 3, shadow_enabled: true };

function stateOf(name) {
  const data = JSON.parse(readFileSync(path.join(root, 'fixtures', `${name}.json`), 'utf8'));
  return data.type === 'OpenStrandStudioHistory'
    ? data.states.find((s) => s.step === data.current_step).data
    : data;
}
const strandsOf = (name) => stateOf(name).strands;
// Every strand of a sample at one width (test_joint_shadow.sample()).
function sampleAt(name, width, stroke) {
  return strandsOf(name).map((s) => (s.type === 'MaskedStrand' ? s : { ...s, width, stroke_width: stroke }));
}

// ---- strands built like test_joint_shadow.py ---------------------------------
const OPAQUE = { r: 0, g: 0, b: 0, a: 255 };
const CLEAR = { r: 0, g: 0, b: 0, a: 0 };
const WIDTH = 40, STROKE = 2; // full width 44: the disc's radius is 29.3
function strand(layer, start, end, extra = {}) {
  const s = { x: start[0], y: start[1] }, e = { x: end[0], y: end[1] };
  return {
    type: 'Strand', layer_name: layer, start: s, end: e, width: WIDTH, stroke_width: STROKE,
    color: { r: 200, g: 150, b: 80, a: 255 }, stroke_color: OPAQUE,
    has_circles: [false, false], control_points: [s, s], control_point_center: s,
    control_point_center_locked: false, start_line_visible: true, end_line_visible: true,
    circle_stroke_color: OPAQUE, start_circle_stroke_color: OPAQUE, end_circle_stroke_color: OPAQUE,
    ...extra,
  };
}
// A strand attached to `parent`'s end, joined seamlessly (transparent circles on
// both sides of the joint).
function attach(parent, end, layer) {
  parent.has_circles = [parent.has_circles[0], true];
  parent.end_circle_stroke_color = CLEAR;
  return strand(layer, [parent.end.x, parent.end.y], end, {
    type: 'AttachedStrand', attached_to: parent.layer_name, has_circles: [true, false],
    start_circle_stroke_color: CLEAR, is_setting_staring_circle: true,
  });
}

let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const browser = await chromium.launch(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  page.on('pageerror', (err) => { failures++; console.error('[pageerror]', err.message); });
  await page.goto(pathToFileURL(path.join(root, 'web', 'render.html')).href + '?v=' + Date.now());
  await page.waitForFunction(() => typeof window.__maskShadowProbe === 'function');
  const probe = (strands, q, meta = {}) => page.evaluate(
    ({ strands, meta, q }) => window.__maskShadowProbe(strands, meta, q), { strands, meta: { ...META, ...meta }, q });

  // ---- test_mask_piece_cover.py ---------------------------------------------
  console.log('mask piece cover (tests/test_mask_piece_cover.py)');
  const third = { enable_third_control_point: true };
  const EXPECTED = {
    neighbour_opaque: ['3_1'], third_strand_over: ['3_1'], diagonal_crossing: ['3_1', '4_1'],
    first_already_above: ['3_1'], neighbour_translucent: ['3_1'], neighbour_no_outline: ['3_1'],
    mask_mid_order: ['3_1'], third_strand_between: [], neighbour_shadow_only: [],
    neighbour_see_through: [], neighbour_hidden: [], joint_seamless: [], joint_circle: [],
  };
  for (const [design, expected] of Object.entries(EXPECTED)) {
    const got = await probe(strandsOf(`mp_${design}`), { op: 'covering', mask: '1_1_2_1' }, third);
    check(`${design}: piece keeps clear of ${JSON.stringify(expected)}`, same(got, expected), got);
  }
  {
    const k = await probe(strandsOf('mp_neighbour_opaque'), { op: 'keep', mask: '1_1_2_1', points: [[290, 300], [326, 300]] }, third);
    check('the piece is clipped around a solid neighbour', same(k, [true, false]), k);
    const k2 = await probe(strandsOf('mp_neighbour_no_outline'), { op: 'keep', mask: '1_1_2_1', points: [[319.5, 300], [328, 300]] }, third);
    check('the piece still covers a see-through outline', same(k2, [true, false]), k2);
    for (const d of ['neighbour_shadow_only', 'joint_seamless', 'third_strand_between']) {
      const k3 = await probe(strandsOf(`mp_${d}`), { op: 'keep', mask: '1_1_2_1', points: [] }, third);
      check(`${d}: nothing is clipped`, k3 === null, k3);
    }
  }

  // ---- test_shadow_subtraction.py -------------------------------------------
  console.log('runs under / opaque cover (tests/test_shadow_subtraction.py)');
  for (const overlap of [0.5, 4, 10, 20]) {
    const r = await probe([], { op: 'runsUnder', width: 46, stroke_width: 4, footprint: [160 - overlap, 60, 54, 130], piece: [100, 100, 60, 50] });
    check(`a strand beside the piece (overlap ${overlap}) does not run under it`, r === false, r);
  }
  check('a strand across the piece runs under it',
    (await probe([], { op: 'runsUnder', width: 46, stroke_width: 4, footprint: [110, 60, 54, 130], piece: [100, 100, 60, 50] })) === true);
  check('a strand clear of the piece does not run under it',
    (await probe([], { op: 'runsUnder', width: 46, stroke_width: 4, footprint: [300, 300, 10, 10], piece: [100, 100, 60, 50] })) === false);
  const cover = (fill, outline, flags = {}) => probe([], {
    op: 'opaqueCover', footprint: [100, 100, 60, 200], points: [[130, 200], [102, 200], [158, 200]],
    strand: { color: { r: 200, g: 100, b: 50, a: fill }, stroke_color: { r: 0, g: 0, b: 0, a: outline }, stroke_width: 4, ...flags },
  });
  check('an opaque strand covers its whole footprint', same(await cover(255, 255), [true, true, true]));
  check('a shadow-only strand covers nothing', (await cover(255, 255, { shadow_only: true })) === null);
  check('a translucent fill under an opaque outline covers all of it', same(await cover(140, 255), [true, true, true]));
  check('a see-through fill and outline cover nothing', (await cover(140, 0)) === null);
  const fillOnly = await cover(255, 0);
  check('a see-through outline: only the fill, 4 px in, covers', same(fillOnly, [true, false, false]), fillOnly);

  // ---- test_joint_shadow.py -------------------------------------------------
  console.log('joint shadows (tests/test_joint_shadow.py)');
  {
    const parent = strand('1_1', [60, 200], [200, 200]);
    const child = attach(parent, [340, 200], '1_2');
    const crossing = strand('2_1', [225, 80], [225, 320]);
    const r = await probe([parent, crossing, child], { op: 'outline', caster: '1_2', receiver: '2_1', points: [[206, 200], [206, 181], [215, 219]] });
    check('a strand crossing next to a joint keeps its shadow', r && same(r.contains, [true, true, true]), r);
  }
  const R = (WIDTH + 2 * STROKE) / 1.5;
  {
    const parent = strand('1_1', [60, 200], [200, 200]);
    const child = attach(parent, [300, 90], '1_2');
    const r = await probe([parent, child], { op: 'outline', caster: '1_2', receiver: '1_1', disc: { x: 200, y: 200, r: R } });
    check('the strand continuing the caster gets no halo', !r || r.discArea < 1.0, r);
  }
  {
    const lone = strand('1_1', [60, 200], [200, 200], { has_circles: [false, true], end_circle_stroke_color: CLEAR, manual_circle_visibility: [null, true] });
    const under = strand('2_1', [190, 80], [190, 320]);
    const r = await probe([under, lone], { op: 'outline', caster: '1_1', receiver: '2_1', disc: { x: 200, y: 200, r: R } });
    check('a free end with a transparent circle casts no halo', !!r && r.discArea < 1.0, r);
  }
  {
    const heart = sampleAt('sample_woven_heart', 80, 2);
    for (const [c, rcv] of [['2_2', '1_2'], ['3_3', '2_4'], ['2_7', '1_6'], ['2_7', '3_5']]) {
      const r = await probe(heart, { op: 'outline', caster: c, receiver: rcv });
      const inside = r && r.bounds && r.casterBounds
        && r.bounds[0] >= r.casterBounds[0] - 1e-6 && r.bounds[1] >= r.casterBounds[1] - 1e-6
        && r.bounds[0] + r.bounds[2] <= r.casterBounds[0] + r.casterBounds[2] + 1e-6
        && r.bounds[1] + r.bounds[3] <= r.casterBounds[1] + r.casterBounds[3] + 1e-6;
      check(`woven heart (3 grid squares): ${c} -> ${rcv} shadow stays on its caster`, !!inside, r);
    }
  }
  {
    const coin = sampleAt('sample_chinese_double_coin', 80, 2);
    const j1 = await probe(coin, { op: 'lowered', child: '1_10' });
    const j2 = await probe(coin, { op: 'lowered', child: '1_9' });
    check("double coin: 1_10's cap goes under 1_6", same(j1, { parent: '1_1', crossers: ['1_6'] }), j1);
    check("double coin: 1_9's cap goes under 1_10", same(j2, { parent: '1_8', crossers: ['1_10'] }), j2);
    for (const name of ['1_2', '1_3', '1_4', '1_5', '1_6', '1_7', '1_8']) {
      const j = await probe(coin, { op: 'lowered', child: name });
      check(`double coin: ${name} keeps its cap`, j === null, j);
    }
    const part = await probe(coin, { op: 'loweredCapPart', child: '1_10', distance: 20 });
    check('a lowered cap is part of the parent', same(part, [true, false, true]), part);
    const child = coin.find((s) => s.layer_name === '1_10');
    const shaded = await probe(coin, { op: 'outline', caster: '1_6', receiver: '1_1', disc: { x: child.start.x, y: child.start.y, r: 40 } });
    check('1_6 shades the lowered cap', !!shaded && shaded.discArea > 0, shaded);
    const saved = sampleAt('sample_chinese_double_coin', 28, 2);
    let none = true;
    for (const s of saved) if (s.type === 'AttachedStrand' && (await probe(saved, { op: 'lowered', child: s.layer_name })) !== null) none = false;
    check('double coin at its saved width keeps every cap', none);
  }

  // ---- test_selection_outline_over_masks.py ---------------------------------
  console.log('selection outline over masks (tests/test_selection_outline_over_masks.py)');
  {
    const base = strandsOf('mp_selected_over_crossing_sel');
    const names = base.map((s) => s.layer_name);
    check('design layers', same(names, ['1_1', '2_1', '3_1', '4_1', '2_1_3_1', '1_1_2_1']), names);
    const meta = {
      ...META, enable_third_control_point: true, image_width: 900, image_height: 760,
      x_offset: 40, y_offset: 40, supersample: 2, layer_order: names,
    };
    const red = (strands, m) => page.evaluate(({ strands, m }) => {
      window.renderFixture(JSON.parse(JSON.stringify(strands)), m);
      const c = document.getElementById('c');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const out = [];
      for (let k = 0; k < d.length; k += 4) if (d[k] === 255 && d[k + 1] === 0 && d[k + 2] === 0) out.push(k / 4);
      return out;
    }, { strands, m });
    for (const [view, m] of [['plain', meta], ['zoomed', { ...meta, zoom: 0.9, mask_direct: true }]]) {
      const shown = new Set(await red(base, m));
      const hidden = base.map((s) => (s.type === 'MaskedStrand' ? { ...s, is_hidden: true } : s));
      const whole = await red(hidden, m);
      const missing = whole.filter((k) => !shown.has(k));
      check(`${view}: the outline over a masked crossing is whole (${whole.length} px)`, whole.length > 1000 && missing.length === 0,
        { whole: whole.length, missing: missing.length });
    }
  }
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
