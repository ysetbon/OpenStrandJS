// Regression guard for the curvature bias controls — the port of OpenStrand
// Studio's curvature_bias_control.py ("Enable curvature bias controls" on the
// General settings page). Two small green squares (triangle / circle icon) sit
// on the centre->cp1 / centre->cp2 lines of a strand whose third control point
// is locked; sliding one along its line sets that half's bias in [0, 1], and the
// renderer scales the cubic handles by (0.5 + bias).
//
// The pure half compiles the model/geometry with the repo's own tsc and pins:
//   * the projection + clamp that turns a pointer into a bias;
//   * the show/grab gate (both settings, locked centre, moved triangle,
//     control points shown or a single strand);
//   * move-mode grab priority (bias squares before cp1/cp2/centre, 50px square);
//   * moveHandle writing ONLY the bias (control points untouched);
//   * the hit-test centerline honouring the bias only while the setting is on;
//   * undo dedup treating a bias change as visible;
//   * save (positions refreshed) / load round-trip and Control-Points copy/paste.
// The browser half drives a real hover + drag in the editor and checks the
// document, the undo stack and the overlay pixels.
//
// Usage: node tools/bias_check.mjs
// OSS_CHROMIUM: absolute path to a Chromium binary if the pre-installed browser
// revision does not match this Playwright version.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const P = (x, y) => ({ x, y });

// ================================================================ pure half
const out = mkdtempSync(path.join(tmpdir(), 'ossjs-bias-'));
try {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', 'src/store/actions.ts', 'src/interaction/hitTest.ts', 'src/model/biasControl.ts',
     'src/store/visualEqual.ts', 'src/io/saveLoad.ts', 'src/store/strandClipboard.ts',
     '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch { /* tsc reports import.meta under --module commonjs; it still emits */ }
(function strip(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { strip(p); continue; }
    if (!p.endsWith('.js')) continue;
    const s = readFileSync(p, 'utf8');
    if (!s.includes('import.meta')) continue;
    writeFileSync(p, s.replace(/if \(import\.meta\.env\?\.DEV\)\s*\{[\s\S]*?\n\}\n?/g, '')
                     .replace(/if \(import\.meta\.env\?\.DEV\)[^\n]*\n(?:\s{4}[^\n]*\n)*/g, ''));
  }
})(out);
writeFileSync(path.join(out, 'package.json'), '{"type":"commonjs"}');
try { symlinkSync(path.join(root, 'node_modules'), path.join(out, 'node_modules'), 'dir'); } catch { /* exists */ }
const require = createRequire(path.join(out, 'x.js'));
const { moveHandle } = require(path.join(out, 'store/actions.js'));
const { moveGrab } = require(path.join(out, 'interaction/hitTest.js'));
const { sampleCenterline, geometryParams, maskCentroid, strandsCross } = require(path.join(out, 'interaction/hitGeometry.js'));
const bias = require(path.join(out, 'model/biasControl.js'));
const { strandVisualEqual } = require(path.join(out, 'store/visualEqual.js'));
const { serializeProject, loadProject } = require(path.join(out, 'io/saveLoad.js'));
const { snapshotStrandData, applyStrandData } = require(path.join(out, 'store/strandClipboard.js'));

const CURVE = { base_fraction: 0.4, dist_multiplier: 1.2, exponent: 1.5 };
const SETTINGS = (over = {}) => ({
  enable_third_control_point: true, enable_curvature_bias_control: true, curve_params: CURVE,
  move_selected_only: false, show_cp_selected_only: false, grid_size: 28, snap_to_grid_enabled: false, ...over,
});
// A shaped strand: cp1/cp2 off the endpoints, centre LOCKED at (300, 100).
const mk = (over = {}) => ({
  type: 'Strand', layer_name: '1_1', set_number: 1,
  start: P(100, 300), end: P(500, 300),
  control_points: [P(200, 100), P(400, 100)],
  control_point_center: P(300, 100), control_point_center_locked: true,
  triangle_has_moved: true, control_point2_shown: true, control_point2_activated: true,
  width: 46, stroke_width: 4,
  color: { r: 200, g: 170, b: 230, a: 255 }, stroke_color: { r: 0, g: 0, b: 0, a: 255 },
  has_circles: [false, false], is_hidden: false, shadow_only: false, hide_shadow: false,
  circle_stroke_color: null, knot_connections: {}, extra: {},
  ...over,
});
const mkDoc = (strands, over = {}) => ({
  order: strands.map((s) => s.layer_name),
  strands: Object.fromEntries(strands.map((s) => [s.layer_name, s])),
  groups: {}, selected_strand_name: null, locked_layers: [], lock_mode: false,
  shadow_enabled: true, show_control_points: true, shadow_overrides: {}, extra: {},
  ...over,
});
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('--- pointer -> bias projection (handle_mouse_move)');
{
  const s = mk();
  // centre (300,100) -> cp1 (200,100): the line runs LEFT. Midpoint = 0.5 regardless of y.
  ok('midpoint of the line is neutral 0.5', near(bias.biasFromPointer(s, 'triangle', P(250, 140)), 0.5));
  ok('past the control point clamps to 1', near(bias.biasFromPointer(s, 'triangle', P(50, 90)), 1));
  ok('behind the centre clamps to 0', near(bias.biasFromPointer(s, 'triangle', P(380, 100)), 0));
  ok('circle side projects onto centre->cp2', near(bias.biasFromPointer(s, 'circle', P(375, 20)), 0.75));
  const zero = mk({ control_points: [P(300, 100), P(400, 100)] });
  ok('a degenerate line keeps the current bias', near(bias.biasFromPointer(zero, 'triangle', P(0, 0)), 0.5));
}

console.log('--- positions + writes (update_positions_from_biases / setBias)');
{
  const s = mk();
  const p0 = bias.biasPositions(s);
  ok('neutral squares sit halfway along each line', near(p0.triangle.x, 250) && near(p0.triangle.y, 100)
    && near(p0.circle.x, 350) && near(p0.circle.y, 100));
  const before = s.extra;
  bias.setBias(s, 'triangle', 0.2);
  const bc = s.extra.bias_control;
  ok('setBias writes extra.bias_control with both biases', near(bc.triangle_bias, 0.2) && near(bc.circle_bias, 0.5));
  ok('positions are stored alongside (OSS serialization shape)',
    near(bc.triangle_position.x, 280) && near(bc.circle_position.x, 350));
  ok('a fresh extra object is installed (no aliasing into an undo baseline)', s.extra !== before);
  ok('values are clamped to [0, 1]', (bias.setBias(s, 'circle', 1.7), near(bias.readBias(s).circle, 1)));
  ok('absent data reads as neutral', bias.isNeutralBias(mk()));
  const dirty = mk({ extra: { bias_control: { triangle_bias: 4, circle_bias: -2 } } });
  ok('out-of-range stored values are clamped at the read boundary',
    near(bias.readBias(dirty).triangle, 1) && near(bias.readBias(dirty).circle, 0));
  const junk = mk({ extra: { bias_control: { triangle_bias: 'x', circle_bias: NaN } } });
  ok('non-numeric stored values read as neutral', bias.isNeutralBias(junk));
}

console.log('--- show / grab gate (should_show_controls)');
{
  const doc = mkDoc([mk(), mk({ layer_name: '2_1', set_number: 2 })]);
  const s = doc.strands['1_1'];
  ok('shown with both settings, a locked centre and a moved triangle', bias.biasControlsVisible(s, SETTINGS(), doc));
  ok('hidden when the bias setting is off', !bias.biasControlsVisible(s, SETTINGS({ enable_curvature_bias_control: false }), doc));
  ok('hidden when the third control point is off', !bias.biasControlsVisible(s, SETTINGS({ enable_third_control_point: false }), doc));
  ok('hidden while the centre is not locked', !bias.biasControlsVisible(mk({ control_point_center_locked: false }), SETTINGS(), doc));
  ok('hidden before the triangle has moved', !bias.biasControlsVisible(mk({ triangle_has_moved: false }), SETTINGS(), doc));
  const hiddenCps = mkDoc([mk(), mk({ layer_name: '2_1', set_number: 2 })], { show_control_points: false });
  ok('hidden with control points off (two strands)', !bias.biasControlsVisible(s, SETTINGS(), hiddenCps));
  const single = mkDoc([mk()], { show_control_points: false });
  ok('...but a lone strand still shows them (OSS test-mode clause)', bias.biasControlsVisible(single.strands['1_1'], SETTINGS(), single));
}

console.log('--- move-mode grab (try_move_control_points order, 50px squares)');
{
  const doc = mkDoc([mk()]);
  const hitT = moveGrab(P(250 + 20, 100 - 20), doc, SETTINGS());
  ok('a click inside the triangle square grabs bias_triangle', hitT && hitT.handle === 'bias_triangle', JSON.stringify(hitT));
  const hitC = moveGrab(P(350, 100), doc, SETTINGS());
  ok('a click on the circle square grabs bias_circle', hitC && hitC.handle === 'bias_circle', JSON.stringify(hitC));
  ok('just outside the 50px square it is not a bias grab', moveGrab(P(250, 100 + 26), doc, SETTINGS()) === null);
  const off = moveGrab(P(250, 100), doc, SETTINGS({ enable_curvature_bias_control: false }));
  ok('with the setting off the same click grabs nothing (no bias, no other square there)', off === null, JSON.stringify(off));
  ok('cp1 is still grabbable on its own square', moveGrab(P(200, 100), doc, SETTINGS()).handle === 'control_point1');
  // bias at 1.0 sits ON cp1: the bias square is tested first and wins (OSS order).
  const d2 = mkDoc([mk()]); bias.setBias(d2.strands['1_1'], 'triangle', 1);
  ok('a bias square over cp1 wins the grab (bias tested first)', moveGrab(P(200, 100), d2, SETTINGS()).handle === 'bias_triangle');
  const unlocked = mkDoc([mk({ control_point_center_locked: false })]);
  const u = moveGrab(P(250, 100), unlocked, SETTINGS());
  ok('an unlocked centre offers no bias square', !u || !String(u.handle).startsWith('bias_'), JSON.stringify(u));
}

console.log('--- moveHandle on a bias handle');
{
  const doc = mkDoc([mk()]);
  const s = doc.strands['1_1'];
  moveHandle(doc, '1_1', 'bias_triangle', P(220, 60), CURVE);
  ok('the pointer projects to a bias of 0.8', near(bias.readBias(s).triangle, 0.8), String(bias.readBias(s).triangle));
  ok('cp1 / cp2 / centre are untouched', near(s.control_points[0].x, 200) && near(s.control_points[1].x, 400)
    && near(s.control_point_center.x, 300) && s.control_point_center_locked === true);
  moveHandle(doc, '1_1', 'bias_circle', P(450, 100), CURVE);
  ok('the circle bias clamps at the control point (1.0)', near(bias.readBias(s).circle, 1));
  ok('the triangle bias survives the circle drag', near(bias.readBias(s).triangle, 0.8));
}

console.log('--- hit-test centerline honours the bias only while enabled');
{
  const neutral = mk();
  const biased = mk(); bias.setBias(biased, 'triangle', 1); bias.setBias(biased, 'circle', 0);
  const a = sampleCenterline(neutral, CURVE, 18, true);
  const b = sampleCenterline(biased, CURVE, 18, true);
  const c = sampleCenterline(biased, CURVE, 18, false);
  const maxDiff = (u, v) => Math.max(...u.map((p, i) => Math.hypot(p.x - v[i].x, p.y - v[i].y)));
  ok('a biased strand samples a different centerline when the setting is on', maxDiff(a, b) > 5, String(maxDiff(a, b)));
  ok('...and the same centerline as neutral when the setting is off', maxDiff(a, c) < 1e-9, String(maxDiff(a, c)));
  ok('endpoints are fixed either way', near(b[0].x, 100) && near(b[b.length - 1].x, 500));
  // The mask helpers take the same Curve object; geometryParams(settings) carries the
  // toggle so mask creation / centroid drift see the same centerline as hit-testing.
  const geoOn = geometryParams(SETTINGS()), geoOff = geometryParams(SETTINGS({ enable_curvature_bias_control: false }));
  ok('geometryParams carries the toggle', geoOn.enable_curvature_bias_control === true && geoOff.enable_curvature_bias_control === false
    && near(geoOn.base_fraction, CURVE.base_fraction));
  const d1 = sampleCenterline(biased, geoOn), d2 = sampleCenterline(biased, geoOff);
  ok('sampleCenterline defaults its bias gate from the Curve object', maxDiff(d1, b) < 1e-9 && maxDiff(d2, a) < 1e-9);
  // A vertical crosser through the biased strand: its mask centroid moves with the bias.
  const cross = mk({ layer_name: '2_1', set_number: 2, start: P(300, 100), end: P(300, 500), control_points: [P(300, 233), P(300, 366)],
    control_point_center: P(300, 300), control_point_center_locked: false, triangle_has_moved: false });
  const cOn = maskCentroid(biased, cross, geoOn), cOff = maskCentroid(biased, cross, geoOff);
  ok('maskCentroid follows the bias when the toggle is on', cOn && cOff && Math.hypot(cOn.x - cOff.x, cOn.y - cOff.y) > 1,
    JSON.stringify([cOn, cOff]));
  ok('strandsCross still detects the crossing under either setting', strandsCross(biased, cross, geoOn) && strandsCross(biased, cross, geoOff));
}

console.log('--- undo dedup');
{
  const a = mk(), b = mk();
  bias.setBias(b, 'triangle', 0.5004);
  ok('a sub-1e-3 bias wiggle is not a visible change', strandVisualEqual(a, b));
  bias.setBias(b, 'triangle', 0.6);
  ok('a real bias change IS a visible change (creates an undo step)', !strandVisualEqual(a, b));
}

console.log('--- save / load round-trip');
{
  const doc = mkDoc([mk()]);
  bias.setBias(doc.strands['1_1'], 'triangle', 0.3);
  // Move cp1 afterwards through the editor's handle path. OSS stores the square
  // positions on the CurvatureBiasControl and re-places them when a main control
  // point moves (get_bias_control_positions), so the saved pair follows the move.
  moveHandle(doc, '1_1', 'control_point1', P(100, 100));
  const json = serializeProject(doc);
  const st = json.strands[0];
  ok('bias_control is written', st.bias_control && near(st.bias_control.triangle_bias, 0.3) && near(st.bias_control.circle_bias, 0.5));
  ok('positions follow a handle move (update_positions_from_biases on the new geometry)',
    near(st.bias_control.triangle_position.x, 300 + (100 - 300) * 0.3) && near(st.bias_control.triangle_position.y, 100));
  const back = loadProject(clone(json));
  ok('load keeps the biases', near(bias.readBias(back.strands['1_1']).triangle, 0.3));
  // Every strand on an OSS canvas owns a bias control (strand.py:423-430 creates
  // one whenever the canvas is assigned), so serialize_strand always writes the
  // key — neutral with no positions for a strand nothing ever biased.
  const plain = serializeProject(mkDoc([mk()]));
  ok('a strand that never had a bias control still writes the neutral OSS record',
    plain.strands[0].bias_control && near(plain.strands[0].bias_control.triangle_bias, 0.5)
    && near(plain.strands[0].bias_control.circle_bias, 0.5));
  ok('...with no positions until something places the squares',
    plain.strands[0].bias_control.triangle_position === null && plain.strands[0].bias_control.circle_position === null);
  // With the setting OFF the loader drops the biases (deserialize_strand:624-626)
  // and the canvas recreates a blank control, so the save writes neutral.
  const off = serializeProject(loadProject(clone(json), { enable_curvature_bias_control: false }),
    { enable_curvature_bias_control: false });
  ok('the setting off writes the neutral record regardless of the saved biases',
    near(off.strands[0].bias_control.triangle_bias, 0.5) && off.strands[0].bias_control.triangle_position === null);
}

console.log('--- copy / paste (Control Points property)');
{
  const src = mk(); bias.setBias(src, 'triangle', 0.25); bias.setBias(src, 'circle', 0.9);
  const snap = snapshotStrandData(src, ['control_points']);
  ok('the snapshot carries both biases', snap.control_points.bias && near(snap.control_points.bias.triangle_bias, 0.25)
    && near(snap.control_points.bias.circle_bias, 0.9));
  const doc = mkDoc([mk({ layer_name: '2_1', set_number: 2, start: P(1100, 300), end: P(1500, 300) })]);
  applyStrandData(doc, snap, '2_1', 'start');
  ok('paste applies them to the target', near(bias.readBias(doc.strands['2_1']).triangle, 0.25)
    && near(bias.readBias(doc.strands['2_1']).circle, 0.9));
  const snapNeutral = snapshotStrandData(mk(), ['control_points']);
  ok('a neutral source snapshots the neutral biases (OSS gives every strand a bias control)',
    snapNeutral.control_points.bias && near(snapNeutral.control_points.bias.triangle_bias, 0.5));
  applyStrandData(doc, snapNeutral, '2_1', 'start');
  ok('...so pasting it onto a biased target resets the target to neutral', bias.isNeutralBias(doc.strands['2_1']));
  ok('the snapshot is a value copy', (bias.setBias(src, 'triangle', 0.7), near(snap.control_points.bias.triangle_bias, 0.25)));
}
rmSync(out, { recursive: true, force: true });

// ============================================================= browser half
// One shaped strand with a locked centre, placed where the viewport can see it.
const strand = mk({ start: P(200, 500), end: P(700, 500), control_points: [P(300, 300), P(600, 300)],
  control_point_center: P(450, 300) });
const project = {
  strands: [{
    type: 'Strand', index: 0, layer_name: '1_1', set_number: 1,
    start: strand.start, end: strand.end, control_points: strand.control_points,
    control_point_center: strand.control_point_center, control_point_center_locked: true,
    triangle_has_moved: true, control_point2_shown: true, control_point2_activated: true,
    width: 46, stroke_width: 4, color: strand.color, stroke_color: strand.stroke_color,
    has_circles: [false, false], is_hidden: false, shadow_only: false, hide_shadow: false,
    circle_stroke_color: null, knot_connections: {},
  }],
  groups: {}, selected_strand_name: null, locked_layers: [], lock_mode: false,
  shadow_enabled: true, show_control_points: true, shadow_overrides: {},
};

const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'),
  server: { port: 5214, open: false, host: '127.0.0.1' }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});

let r;
const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto('http://127.0.0.1:5214/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 30000 });

  r = await page.evaluate(async ({ project }) => {
    const store = window.__store;
    const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
    const settle = async (n = 6) => { for (let i = 0; i < n; i++) await nextFrame(); };
    const st = () => store.getState();
    const out = {};

    const reset = async (settings) => {
      st().loadDocument(window.__io.loadProject(JSON.parse(JSON.stringify(project))));
      st().setSettings({ show_grid: false, snap_to_grid_enabled: true, grid_size: 28,
        enable_third_control_point: true, enable_curvature_bias_control: true, ...settings });
      st().setSelection({ layerName: null, handle: null });
      st().setMode('move');
      // Frame the strand: pan so world (0,0) sits at a fixed screen offset, zoom 1.
      st().setView({ zoom: 1, panX: 40, panY: 40 });
      await settle(12);
    };
    const el = document.getElementById('c');
    const overlay = document.getElementById('overlay');
    const toClient = (w) => {
      const rect = el.getBoundingClientRect();
      const view = st().view;
      const sx = rect.width / Math.max(1, el.width), sy = rect.height / Math.max(1, el.height);
      return { x: rect.left + (w.x * view.zoom + view.panX) * sx, y: rect.top + (w.y * view.zoom + view.panY) * sy };
    };
    const pixel = (w) => {
      const rect = el.getBoundingClientRect();
      const view = st().view;
      const sx = overlay.width / Math.max(1, rect.width), sy = overlay.height / Math.max(1, rect.height);
      const x = Math.round((w.x * view.zoom + view.panX) * sx), y = Math.round((w.y * view.zoom + view.panY) * sy);
      const d = overlay.getContext('2d').getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    };
    const ev = (type, w, extra = {}) => {
      const c = toClient(w);
      return new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
        clientX: c.x, clientY: c.y,
        button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, ...extra,
      });
    };
    const gesture = async (from, path, to) => {
      el.dispatchEvent(ev('pointerdown', from)); await settle(3);
      for (const w of path) { el.dispatchEvent(ev('pointermove', w)); await settle(3); }
      el.dispatchEvent(ev('pointerup', to)); await settle(12);
    };
    const hover = async (w) => { el.dispatchEvent(ev('pointermove', w, { buttons: 0 })); await settle(4); return { ...st().hover }; };
    const s = () => st().doc.strands['1_1'];
    const biasOf = () => { const bc = (s().extra || {}).bias_control; return bc ? { t: bc.triangle_bias, c: bc.circle_bias } : null; };

    const center = { x: 450, y: 300 }, cp1 = { x: 300, y: 300 }, cp2 = { x: 600, y: 300 };
    const triSq = { x: 375, y: 300 }, circSq = { x: 525, y: 300 };   // neutral positions

    // A. hover + overlay pixels with the feature on.
    await reset({});
    out.hoverTri = await hover({ x: triSq.x + 10, y: triSq.y + 10 });
    out.hoverCirc = await hover(circSq);
    out.hoverNone = await hover({ x: 900, y: 800 });
    await settle(4);
    // Inside the 16px green square but outside the 9px icon: (+6, -6) from the centre.
    out.pxTriGreen = pixel({ x: triSq.x + 6, y: triSq.y - 6 });
    out.pxCircGreen = pixel({ x: circSq.x + 6, y: circSq.y - 6 });
    out.pxTriIcon = pixel(triSq);          // circle icon centre is strand colour; triangle centre too
    out.pxCircIcon = pixel(circSq);

    // B. drag the triangle square toward cp1 (no grid snap for a bias drag).
    const past0 = st().past.length;
    await gesture(triSq, [{ x: 340, y: 310 }, { x: 315, y: 331 }], { x: 315, y: 331 });
    out.dragTri = { bias: biasOf(), cp1: { ...s().control_points[0] }, center: { ...s().control_point_center },
      locked: s().control_point_center_locked, past: st().past.length - past0, selection: { ...st().selection } };
    await settle(4);
    out.pxAfterDragGreen = pixel({ x: center.x + (cp1.x - center.x) * 0.9 + 6, y: 300 - 6 });
    out.pxOldSpotClear = pixel({ x: triSq.x + 6, y: triSq.y - 6 });

    // C. undo restores neutral.
    st().undo(); await settle(8);
    out.afterUndo = biasOf();
    st().redo(); await settle(8);
    out.afterRedo = biasOf();

    // D. drag the circle square past cp2: clamps at 1.
    await gesture(circSq, [{ x: 580, y: 290 }, { x: 680, y: 280 }], { x: 680, y: 280 });
    out.dragCirc = { bias: biasOf(), cp2: { ...s().control_points[1] } };

    // E. feature off: nothing to hover, nothing drawn, the square spot is inert.
    await reset({ enable_curvature_bias_control: false });
    out.offHover = await hover(triSq);
    await settle(4);
    out.offPx = pixel({ x: triSq.x + 6, y: triSq.y - 6 });
    await gesture(triSq, [{ x: 340, y: 310 }], { x: 340, y: 310 });
    out.offDrag = { bias: biasOf(), cp1: { ...s().control_points[0] } };

    // F. third control point off force-hides bias controls too.
    await reset({ enable_third_control_point: false });
    out.noThirdHover = await hover(triSq);

    // G. a LONE strand with control points hidden: OSS's should_show_controls still
    // shows (and grabs) the bias squares, so they must be drawn and hoverable.
    await reset({});
    st().setDoc({ ...st().doc, show_control_points: false }); await settle(8);
    out.loneHiddenHover = await hover(triSq);
    await hover({ x: 900, y: 800 });         // move off so the hot-yellow tint doesn't colour the sample
    await settle(4);
    out.loneHiddenPx = pixel({ x: triSq.x + 6, y: triSq.y - 6 });
    out.loneHiddenCp1Px = pixel({ x: cp1.x + 8, y: cp1.y + 2 });   // inside cp1's glyph if it were drawn
    return out;
  }, { project });
} finally {
  await browser.close();
  await server.close();
}

console.log('--- browser: hover + overlay');
ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
ok('hovering the triangle square reports bias_triangle', r.hoverTri.handle === 'bias_triangle', JSON.stringify(r.hoverTri));
ok('hovering the circle square reports bias_circle', r.hoverCirc.handle === 'bias_circle', JSON.stringify(r.hoverCirc));
ok('empty space clears the hover', r.hoverNone.handle === null);
const isGreen = (px) => px[1] > 100 && px[0] < 60 && px[2] < 60 && px[3] > 200;
const isStrandColor = (px) => Math.abs(px[0] - 200) < 40 && Math.abs(px[1] - 170) < 40 && Math.abs(px[2] - 230) < 40;
ok('the triangle square is painted green', isGreen(r.pxTriGreen), JSON.stringify(r.pxTriGreen));
ok('the circle square is painted green', isGreen(r.pxCircGreen), JSON.stringify(r.pxCircGreen));
ok('the icons are the strand colour', isStrandColor(r.pxTriIcon) && isStrandColor(r.pxCircIcon), JSON.stringify([r.pxTriIcon, r.pxCircIcon]));

console.log('--- browser: drag');
ok('dragging the triangle square sets its bias from the projection (0.9)',
  r.dragTri.bias && near(r.dragTri.bias.t, 0.9, 1e-6) && near(r.dragTri.bias.c, 0.5, 1e-9), JSON.stringify(r.dragTri.bias));
ok('cp1 and the locked centre do not move', near(r.dragTri.cp1.x, 300) && near(r.dragTri.center.x, 450) && r.dragTri.locked === true);
ok('one drag = one undo step', r.dragTri.past === 1, String(r.dragTri.past));
ok('the selection reverts after the drag (transient highlight)', r.dragTri.selection.layerName === null);
ok('the square moved with the bias', isGreen(r.pxAfterDragGreen), JSON.stringify(r.pxAfterDragGreen));
ok('the old neutral spot is no longer green', !isGreen(r.pxOldSpotClear), JSON.stringify(r.pxOldSpotClear));
ok('undo restores neutral', !r.afterUndo || near(r.afterUndo.t, 0.5, 1e-9), JSON.stringify(r.afterUndo));
ok('redo re-applies it', r.afterRedo && near(r.afterRedo.t, 0.9, 1e-6), JSON.stringify(r.afterRedo));
ok('dragging past cp2 clamps the circle bias at 1', r.dragCirc.bias && near(r.dragCirc.bias.c, 1, 1e-9) && near(r.dragCirc.cp2.x, 600),
  JSON.stringify(r.dragCirc));

console.log('--- browser: settings gate');
ok('with the bias setting off nothing is hovered there', r.offHover.handle === null, JSON.stringify(r.offHover));
ok('...and nothing is drawn there', !isGreen(r.offPx), JSON.stringify(r.offPx));
ok('...and a drag there changes nothing', r.offDrag.bias === null && near(r.offDrag.cp1.x, 300), JSON.stringify(r.offDrag));
ok('with the third control point off the bias squares are gone too', r.noThirdHover.handle === null, JSON.stringify(r.noThirdHover));

console.log('--- browser: lone strand with control points hidden (OSS test-mode clause)');
ok('the bias square is still hoverable', r.loneHiddenHover.handle === 'bias_triangle', JSON.stringify(r.loneHiddenHover));
ok('...and still drawn', isGreen(r.loneHiddenPx), JSON.stringify(r.loneHiddenPx));
ok('...while the regular glyph layer stays hidden', !isGreen(r.loneHiddenCp1Px), JSON.stringify(r.loneHiddenCp1Px));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
