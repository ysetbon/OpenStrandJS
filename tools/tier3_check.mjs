// Regression guard for the Tier-3 fixes: the rotate gesture, the Adjust Angle and
// Length dialog's geometry, and the settings that the renderer never read.
//
// Every assertion below is written so that reverting its fix makes it FAIL, and
// the settings half additionally pins the FIDELITY invariant: with nothing on
// `meta`, the renderer must fall back to exactly the values the Qt oracle renders
// with, so a fixture render stays byte-identical.
//
// Pure node — the geometry under test is compiled on the fly with the repo's own
// tsc, and the renderer is evaluated in a vm with a probe appended, so no browser
// is needed.
//
// Usage: node tools/tier3_check.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(path.join(tmpdir(), 'ossjs-tier3-'));
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

// ---------------------------------------------------------------- compile TS
try {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', 'src/store/actions.ts', 'src/io/saveLoad.ts', 'src/interaction/hitGeometry.ts',
     'src/renderer/toRenderArray.ts',
     '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch { /* tsc reports import.meta under --module commonjs; it still emits */ }

// The emitted files keep Vite's dev-only debug handles, which CJS cannot parse.
const strip = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { strip(p); continue; }
    if (!p.endsWith('.js')) continue;
    const s = readFileSync(p, 'utf8');
    if (!s.includes('import.meta')) continue;
    writeFileSync(p, s.replace(/if \(import\.meta\.env\?\.DEV\)\s*\{[\s\S]*?\n\}\n?/g, '')
                     .replace(/if \(import\.meta\.env\?\.DEV\)[^\n]*\n(?:\s{4}[^\n]*\n)*/g, ''));
  }
};
strip(out);
// A leftover import.meta means the DEV-block shape changed and strip() missed it;
// require() would then throw a bare SyntaxError that names no cause.
const leftover = [];
(function scan(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { scan(p); continue; }
    if (p.endsWith('.js') && readFileSync(p, 'utf8').includes('import.meta')) leftover.push(path.relative(out, p));
  }
})(out);
ok('no import.meta survives the CJS strip', leftover.length === 0, leftover.join(', '));
writeFileSync(path.join(out, 'package.json'), '{"type":"commonjs"}');
try { symlinkSync(path.join(root, 'node_modules'), path.join(out, 'node_modules'), 'dir'); } catch { /* exists */ }

const require = createRequire(path.join(out, 'x.js'));
const {
  rotateGrab, snapshotRotate, applyRotateSnapshot,
  snapshotAngleAdjust, applyAngleAdjustSnapshot,
} = require(path.join(out, 'store/actions.js'));
const { maskCentroid } = require(path.join(out, 'interaction/hitGeometry.js'));
const { buildMeta } = require(path.join(out, 'renderer/toRenderArray.js'));
const { loadProject } = require(path.join(out, 'io/saveLoad.js'));
const CURVE = { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 };

const P = (x, y) => ({ x, y });
const mkStrand = (over) => ({
  type: 'Strand', layer_name: '1_1', set_number: 1,
  start: P(100, 100), end: P(200, 100),
  control_points: [P(120, 60), P(180, 60)],
  control_point_center: P(150, 60), control_point_center_locked: false,
  width: 46, stroke_width: 4,
  color: { r: 0, g: 0, b: 0, a: 255 }, stroke_color: { r: 0, g: 0, b: 0, a: 255 },
  has_circles: [false, false], is_hidden: false, shadow_only: false, hide_shadow: false,
  circle_stroke_color: null, knot_connections: {}, extra: {}, control_point2_activated: true,
  ...over,
});
const mkDoc = (strands) => ({
  order: strands.map((s) => s.layer_name),
  strands: Object.fromEntries(strands.map((s) => [s.layer_name, s])),
  groups: {}, selected_strand_name: null, locked_layers: [], lock_mode: false,
  shadow_enabled: true, show_control_points: false, shadow_overrides: {}, extra: {},
});

// ============================================================== A. rotateGrab
{
  const doc = mkDoc([mkStrand({})]);
  const s = doc.strands['1_1'];

  ok('a press on a free endpoint grabs it',
    JSON.stringify(rotateGrab(doc, P(100, 100))) === JSON.stringify({ name: '1_1', side: 0 }));
  // get_end_rectangle is width wide on EACH side of the endpoint (rotate_mode.py
  // :215-227), i.e. a square of side 2*width — not the 60px move-mode square.
  ok('the hit square reaches exactly `width` from the endpoint',
    !!rotateGrab(doc, P(100 + s.width - 0.01, 100)));
  ok('and no further', rotateGrab(doc, P(100 + s.width + 0.01, 100)) === null);

  const attached = mkDoc([mkStrand({ has_circles: [true, false] })]);
  // OSS only rotates an endpoint with has_circles false (:172-175) — a junction
  // is not free to swing.
  ok('an endpoint with a circle (something attached) is NOT grabbable',
    (rotateGrab(attached, P(100, 100)) || {}).side !== 0);

  const masked = mkDoc([mkStrand({ layer_name: '1_1_2_1', type: 'MaskedStrand' })]);
  ok('masks are skipped entirely (try_rotate_strand :166-167)',
    rotateGrab(masked, P(100, 100)) === null);

  // Both endpoints in range: OSS tests start first and returns on the first hit.
  const stubby = mkDoc([mkStrand({ end: P(110, 100) })]);
  ok('start is tested before end', (rotateGrab(stubby, P(105, 100)) || {}).side === 0);
}

// =================================================== B. the rotation is rigid
{
  const doc = mkDoc([mkStrand({})]);
  const before = JSON.parse(JSON.stringify(doc.strands['1_1']));
  const snap = snapshotRotate(doc, '1_1', 1);          // swing the END about the start
  const pivot = snap.pivot;
  ok('the pivot is the OTHER endpoint', pivot.x === before.start.x && pivot.y === before.start.y);

  applyRotateSnapshot(doc, snap, Math.PI / 2, CURVE);
  const a = doc.strands['1_1'];
  ok('the pivot endpoint does not move', a.start.x === before.start.x && a.start.y === before.start.y);
  ok('the chord length is preserved', near(dist(a.start, a.end), dist(before.start, before.end), 1e-9));
  for (const [n, b, x] of [['cp1', before.control_points[0], a.control_points[0]],
                           ['cp2', before.control_points[1], a.control_points[1]]]) {
    ok(`${n} keeps its distance from the pivot (rigid, not deformed)`,
      near(dist(b, pivot), dist(x, pivot), 1e-9));
  }
  ok('cp1 actually moved (a no-op rotation would pass the test above vacuously)',
    dist(before.control_points[0], a.control_points[0]) > 1);

  // Absolute-from-snapshot: re-applying the ORIGINAL angle must restore the exact
  // original geometry. An incremental implementation drifts here.
  applyRotateSnapshot(doc, snap, snap.origAngle, CURVE);
  const r = doc.strands['1_1'];
  ok('re-applying the opening angle restores the geometry exactly',
    near(dist(r.end, before.end), 0, 1e-9) &&
    near(dist(r.control_points[0], before.control_points[0]), 0, 1e-9) &&
    near(dist(r.control_points[1], before.control_points[1]), 0, 1e-9));
}

// ================================== C. rotate carries a glued child BODILY...
{
  const parent = mkStrand({ has_circles: [false, true] });
  const child = mkStrand({
    layer_name: '1_2', type: 'AttachedStrand', attached_to: '1_1', attachment_side: 1,
    start: P(200, 100), end: P(260, 160),
    control_points: [P(220, 120), P(240, 140)], control_point_center: P(230, 130),
    has_circles: [true, false],
  });
  const doc = mkDoc([parent, child]);
  const childBefore = JSON.parse(JSON.stringify(child));
  const snap = snapshotRotate(doc, '1_1', 1);
  ok('the child is picked up as glued to the swinging endpoint', snap.children.length === 1);

  applyRotateSnapshot(doc, snap, Math.PI / 2, CURVE);
  const p = doc.strands['1_1'], c = doc.strands['1_2'];
  const dx = p.end.x - childBefore.start.x, dy = p.end.y - childBefore.start.y;
  ok('the child start follows the endpoint',
    near(c.start.x, childBefore.start.x + dx) && near(c.start.y, childBefore.start.y + dy));
  // THE distinguishing property. moveHandle would leave the child's far end where
  // it was and pivot the child; OSS rotate translates the whole strand
  // (rotate_mode.py:398-412), so its own length is unchanged.
  ok('the child TRANSLATES rigidly — its far end moves by the same delta',
    near(c.end.x, childBefore.end.x + dx) && near(c.end.y, childBefore.end.y + dy));
  ok('so the child keeps its own length',
    near(dist(c.start, c.end), dist(childBefore.start, childBefore.end), 1e-9));
}

// ================== D. ...while the angle dialog RE-ANCHORS it (OSS :419-456)
{
  const parent = mkStrand({ has_circles: [false, true] });
  const child = mkStrand({
    layer_name: '1_2', type: 'AttachedStrand', attached_to: '1_1', attachment_side: 1,
    start: P(200, 100), end: P(260, 160),
    control_points: [P(220, 120), P(240, 140)], control_point_center: P(230, 130),
    has_circles: [true, false],
  });
  const doc = mkDoc([parent, child]);
  const before = JSON.parse(JSON.stringify(parent));
  const childBefore = JSON.parse(JSON.stringify(child));
  const snap = snapshotAngleAdjust(doc, '1_1');

  ok('max_length is max(10, trunc(initial * 2))',
    snap.maxLength === Math.max(10, Math.trunc(dist(before.start, before.end) * 2)));

  applyAngleAdjustSnapshot(doc, snap, snap.initialAngle + 30, snap.initialLength * 2, CURVE);
  const p = doc.strands['1_1'], c = doc.strands['1_2'];
  ok('doubling the length doubles the cp offsets from the pivot',
    near(dist(p.control_points[0], p.start), 2 * dist(before.control_points[0], before.start), 1e-9));
  ok('the child start snaps onto the new endpoint',
    near(c.start.x, p.end.x) && near(c.start.y, p.end.y));
  // The OTHER half of the same OSS block: the far end is explicitly held while the
  // handles translate — so unlike rotate, the child's own length CHANGES.
  ok('the child far end is held put (:434-437)',
    near(c.end.x, childBefore.end.x) && near(c.end.y, childBefore.end.y));
  const ddx = p.end.x - snap.end.x, ddy = p.end.y - snap.end.y;
  ok('the child handles translate by the endpoint delta',
    near(c.control_points[0].x, childBefore.control_points[0].x + ddx, 1e-9) &&
    near(c.control_points[0].y, childBefore.control_points[0].y + ddy, 1e-9));

  applyAngleAdjustSnapshot(doc, snap, snap.initialAngle, snap.initialLength, CURVE);
  const r = doc.strands['1_1'], rc = doc.strands['1_2'];
  ok('the dialog round-trips exactly at its opening values',
    near(dist(r.end, before.end), 0, 1e-6) &&
    near(dist(r.control_points[0], before.control_points[0]), 0, 1e-6) &&
    near(dist(r.control_points[1], before.control_points[1]), 0, 1e-6) &&
    near(dist(rc.control_points[0], childBefore.control_points[0]), 0, 1e-6));
}

// ================================ E. dependent masks follow both operations
//
// Two independent properties, because either alone can pass while the other is
// broken:
//   1. the stored centre is measured against the FINAL geometry. Measuring before
//      the handles are placed leaves edited_center_point describing a curve that
//      no longer exists — and it is the baseline for the NEXT edit, so the error
//      compounds. With no seeded baseline OSS's algorithm applies no shift, so
//      the stored value must equal a fresh measurement EXACTLY.
//   2. with a baseline seeded (what a real gesture does at pointer-down) the erase
//      windows actually MOVE. Neither OSS RotateMode nor OSS AngleAdjustMode drifts
//      them at all — this is the flagged deviation these two calls exist to add, so
//      dropping the trackMaskDeletionRects call leaves the rectangles at 0px.
const maskFixture = () => {
  const doc = loadProject(JSON.parse(readFileSync(path.join(root, 'fixtures/box_stitch.json'), 'utf8')));
  const maskName = Object.keys(doc.strands).find((n) => doc.strands[n].type === 'MaskedStrand');
  const [a, b, c, d] = maskName.split('_');
  const over = `${a}_${b}`, under = `${c}_${d}`;
  // Anchor the erase window ON the crossing. A window that misses the region makes
  // maskCentroid return the same value with and without deletions, and every check
  // below would pass without exercising anything — so the overlap is asserted too.
  const base = maskCentroid(doc.strands[over], doc.strands[under], CURVE);
  doc.strands[maskName].deletion_rectangles = [{
    top_left: [base.x - 15, base.y - 15], top_right: [base.x + 15, base.y - 15],
    bottom_left: [base.x - 15, base.y + 15], bottom_right: [base.x + 15, base.y + 15],
  }];
  return { doc, maskName, over, under, base };
};

for (const [label, run] of [
  ['rotate', (doc, name) => {
    const snap = snapshotRotate(doc, name, 1);
    applyRotateSnapshot(doc, snap, snap.origAngle + 0.25, CURVE);
  }],
  ['the angle dialog', (doc, name) => {
    const snap = snapshotAngleAdjust(doc, name);
    applyAngleAdjustSnapshot(doc, snap, snap.initialAngle + 15, snap.initialLength, CURVE);
  }],
]) {
  // --- 1. measured against the final curve (no seeded baseline -> no shift)
  {
    const { doc, maskName, over, under } = maskFixture();
    run(doc, over);
    const m = doc.strands[maskName];
    const stored = m.edited_center_point;
    const truth = maskCentroid(doc.strands[over], doc.strands[under], CURVE, m.deletion_rectangles);
    const bare = maskCentroid(doc.strands[over], doc.strands[under], CURVE);
    ok(`[${label}] the eraser window actually overlaps the intersection region`,
      !!bare && !!truth && dist(truth, bare) > 1e-9,
      'the window misses the crossing, so the tracking path is inert');
    ok(`[${label}] the stored centre is measured against the FINAL geometry`,
      !!stored && !!truth && dist(stored, truth) < 1e-6,
      stored && truth ? `${dist(stored, truth).toFixed(2)}px off` : 'no centroid');
  }

  // --- 2. with a baseline, the erase windows are actually carried
  {
    const { doc, maskName, over, under } = maskFixture();
    const m = doc.strands[maskName];
    // What a mode does at pointer-down (seedMaskCenters).
    m.base_center_point = maskCentroid(doc.strands[over], doc.strands[under], CURVE);
    m.edited_center_point =
      maskCentroid(doc.strands[over], doc.strands[under], CURVE, m.deletion_rectangles);
    const seeded = { ...m.edited_center_point };
    const origin = [...m.deletion_rectangles[0].top_left];

    run(doc, over);

    const movedX = m.deletion_rectangles[0].top_left[0] - origin[0];
    const movedY = m.deletion_rectangles[0].top_left[1] - origin[1];
    ok(`[${label}] the erase windows are carried with the region, not left behind`,
      Math.hypot(movedX, movedY) > 0.5,
      `moved ${Math.hypot(movedX, movedY).toFixed(3)}px — trackMaskDeletionRects did not run`);
    // OSS move_mode drifts each rectangle by exactly the centroid delta
    // (:2978-3031); the stored centre is the new measurement it drifted to.
    // Requires the movement too, so it cannot pass vacuously when nothing moved
    // at all (0 === 0 - 0 would otherwise satisfy the equality).
    ok(`[${label}] and by exactly the centroid delta`,
      Math.hypot(movedX, movedY) > 0.5 &&
      near(movedX, m.edited_center_point.x - seeded.x, 1e-9) &&
      near(movedY, m.edited_center_point.y - seeded.y, 1e-9));
  }
}

// ==================================================== F. the settings actually reach the renderer
{
  // The renderer is a plain <script>, not a module. Evaluate it in a vm with the
  // browser globals stubbed and a probe appended that closes over its top-level
  // `let`s, so the real applyPaintSettings can be called and its effect read back.
  const src = readFileSync(path.join(root, 'web/strand-renderer.js'), 'utf8')
    + '\n;globalThis.__probe = () => ({ applyPaintSettings, shadowBlurSteps,'
    + ' get SHADOW_COLOR() { return SHADOW_COLOR; }, get MAX_BLUR() { return MAX_BLUR; },'
    + ' get NUM_STEPS() { return NUM_STEPS; }, get HIGHLIGHT_COLOR() { return HIGHLIGHT_COLOR; },'
    + ' get ARROW_PARAMS() { return ARROW_PARAMS; } });\n';
  const ctx = vm.createContext({ window: {}, document: { createElement: () => ({ getContext: () => ({}) }) }, paper: {}, console });
  vm.runInContext(src, ctx);
  const R = ctx.__probe();

  // THE FIDELITY INVARIANT. reference_render.py builds its own meta and sets none
  // of these keys, so the no-meta path has to reproduce the values the reference
  // user_settings.txt loads — otherwise every committed baseline shifts.
  R.applyPaintSettings({});
  ok('an empty meta restores the Qt oracle shadow colour (0,0,0,150)',
    JSON.stringify(R.SHADOW_COLOR) === JSON.stringify({ r: 0, g: 0, b: 0, a: 150 }));
  ok('...its blur radius (30) and step count (2)', R.MAX_BLUR === 30 && R.NUM_STEPS === 2);
  ok('...its highlight colour (opaque red)',
    JSON.stringify(R.HIGHLIGHT_COLOR) === JSON.stringify({ r: 255, g: 0, b: 0, a: 255 }));
  ok('...and its arrow dimensions',
    JSON.stringify(R.ARROW_PARAMS) === JSON.stringify({
      head_length: 20, head_width: 10, gap_length: 10,
      line_length: 20, line_width: 10, head_stroke_width: 4,
    }));
  ok('the blur table is the documented 15px@150 / 30px@75',
    JSON.stringify(R.shadowBlurSteps()) ===
    JSON.stringify([{ width: 15, alpha: 150 }, { width: 30, alpha: 75 }]));

  // And the override path: each key must actually change what the renderer uses.
  R.applyPaintSettings({
    shadow_color: { r: 10, g: 20, b: 30, a: 200 },
    max_blur_radius: 12, num_steps: 4,
    highlight_color: { r: 0, g: 128, b: 255, a: 255 },
    arrow_params: { head_length: 33, head_width: 10, gap_length: 10, line_length: 20, line_width: 10, head_stroke_width: 4 },
  });
  ok('a meta shadow colour is honoured', R.SHADOW_COLOR.a === 200);
  ok('a meta blur radius / step count is honoured', R.MAX_BLUR === 12 && R.NUM_STEPS === 4);
  ok('the blur table tracks them', R.shadowBlurSteps().length === 4);
  ok('a meta highlight colour is honoured', R.HIGHLIGHT_COLOR.b === 255);
  ok('a meta arrow dimension is honoured', R.ARROW_PARAMS.head_length === 33);
  // NUM_STEPS is a divisor in shadowBlurSteps; 0 would make every width NaN.
  R.applyPaintSettings({ num_steps: 0 });
  ok('a nonsense step count falls back rather than producing NaN widths',
    R.NUM_STEPS === 2 && R.shadowBlurSteps().every((s) => Number.isFinite(s.width)));

  // The other half of the wire: buildMeta has to put the settings ON meta at all.
  const settings = {
    curve_params: CURVE, grid_size: 28, show_grid: false, theme: 'default',
    shadow_color: { r: 1, g: 2, b: 3, a: 4 }, num_steps: 7, max_blur_radius: 13,
    highlight_color: { r: 9, g: 8, b: 7, a: 6 }, draw_only_affected_strand: true,
    enable_third_control_point: false, enable_curvature_bias_control: false,
    arrow_head_length: 41, arrow_head_width: 42, arrow_head_stroke_width: 43,
    arrow_gap_length: 44, arrow_line_length: 45, arrow_line_width: 46,
  };
  const view = { zoom: 1, panX: 0, panY: 0, width: 100, height: 100, supersample: 2 };
  const meta = buildMeta(mkDoc([mkStrand({})]), view, settings) || {};
  ok('buildMeta forwards the shadow trio + highlight colour',
    (meta.shadow_color || {}).a === 4 && meta.num_steps === 7 && meta.max_blur_radius === 13 &&
    (meta.highlight_color || {}).r === 9);
  ok('buildMeta forwards draw_only_affected_strand', meta.draw_only_affected_strand === true);
  ok('buildMeta forwards all six arrow dimensions',
    JSON.stringify(meta.arrow_params) === JSON.stringify({
      head_length: 41, head_width: 42, head_stroke_width: 43,
      gap_length: 44, line_length: 45, line_width: 46,
    }));

  // STRUCTURAL, not behavioural: the checks above call applyPaintSettings directly,
  // so they stay green even if no render path ever calls it. Every render entry
  // point resolves the two curve toggles off meta; each one must resolve the paint
  // settings from the same meta, or a stale value from the previous frame leaks in.
  // Tying the two counts together also means a NEW entry point cannot be added with
  // only half the wire.
  const biasSites = (src.match(/BIAS_ENABLED = !!\(meta/g) || []).length;
  const paintSites = (src.match(/\n\s*applyPaintSettings\(meta\);/g) || []).length;
  ok('every render entry point applies the paint settings from its own meta',
    biasSites > 0 && paintSites === biasSites, `${paintSites} call sites vs ${biasSites} entry points`);
}

rmSync(out, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exitCode = fails ? 1 : 0;
