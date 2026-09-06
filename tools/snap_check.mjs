// Regression guard for the snap-to-grid settings, which must behave exactly as
// OpenStrand Studio's two checkboxes do (settings_dialog.py General page):
//
//   "Enable snap to grid for move mode"          -> canvas.snap_to_grid_enabled
//   "Enable snap to grid for attach/create mode" -> canvas.snap_to_grid_attach_enabled
//
// The pure half compiles the geometry with the repo's own tsc and pins the
// desktop's decision tables (move_mode.py:4052-4093, attach_mode.py:939-987,
// strand_drawing_canvas.py:1141-1196). The browser half drives real pointer
// gestures through the editor and checks what actually lands in the document:
//
//   A. a new strand's START is snapped on press (attach_mode.py:609) and its END on
//      release — under the ATTACH setting only; the move setting has no say;
//   B. a bare click with attach-snap on creates a one-grid-step strand, never a
//      zero-length one (_get_snapped_attachment_position never collapses onto the
//      start; the desktop creates whenever start != end);
//   C. a child pulled from a free endpoint keeps the parent's exact endpoint as its
//      start and gets a grid-snapped END — again under the attach setting only;
//   D. a move-mode endpoint drag snaps under the MOVE setting only.
//
// Each assertion fails if its fix is reverted (a raw start, an unsnapped child end,
// a cancelled click, an offset-rounding group snap, or a setting read by the wrong
// mode).
//
// Usage: node tools/snap_check.mjs
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
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const onGrid = (p, g) => near(p.x, Math.round(p.x / g) * g, 1e-6) && near(p.y, Math.round(p.y / g) * g, 1e-6);
const fmt = (p) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;

// ================================================================ pure half
const out = mkdtempSync(path.join(tmpdir(), 'ossjs-snap-'));
try {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', 'src/store/actions.ts', 'src/model/group.ts',
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
const { snapPoint, snapGrid, snapMove, snapAttachTarget } = require(path.join(out, 'store/actions.js'));
const { snapGroupToGrid } = require(path.join(out, 'model/group.js'));

const G = 28;
const S = (over) => ({ grid_size: G, snap_to_grid_enabled: true, snap_to_grid_attach_enabled: true, ...over });
const P = (x, y) => ({ x, y });
const same = (p, q) => near(p.x, q.x, 1e-9) && near(p.y, q.y, 1e-9);

console.log('--- settings gates');
{
  const raw = P(101, 45);
  ok('attach snap rounds under the ATTACH setting', same(snapPoint(raw, S({})), P(112, 56)));
  ok('attach snap ignores the MOVE setting', same(snapPoint(raw, S({ snap_to_grid_enabled: false })), P(112, 56)));
  ok('attach snap off -> raw', same(snapPoint(raw, S({ snap_to_grid_attach_enabled: false })), raw));
  ok('move snap (canvas.snap_to_grid) rounds under the MOVE setting', same(snapGrid(raw, S({})), P(112, 56)));
  ok('move snap ignores the ATTACH setting', same(snapGrid(raw, S({ snap_to_grid_attach_enabled: false })), P(112, 56)));
  ok('move snap off -> raw', same(snapGrid(raw, S({ snap_to_grid_enabled: false })), raw));
}

console.log('--- move-mode zoom/Ctrl decision (move_mode.py:4052-4093)');
{
  const raw = P(101, 45);       // 11px / 11px off the (112, 56) intersection
  const close = P(111, 57);     // 1px / 1px off it
  ok('zoom >= 0.8: full snap', same(snapMove(raw, S({}), 1, false), P(112, 56)));
  ok('zoom < 0.35: no snap even with the setting on', same(snapMove(raw, S({}), 0.3, false), raw));
  ok('zoom < 0.35 + Ctrl: full snap', same(snapMove(raw, S({}), 0.3, true), P(112, 56)));
  ok('0.5 <= zoom < 0.8: gentle — far from the line stays put', same(snapMove(raw, S({}), 0.6, false), raw));
  ok('0.5 <= zoom < 0.8: gentle — within (grid/8)*zoom snaps', same(snapMove(close, S({}), 0.6, false), P(112, 56)));
  ok('0.35 <= zoom < 0.5: no snap', same(snapMove(close, S({}), 0.4, false), close));
  ok('setting off: no snap at zoom 1', same(snapMove(raw, S({ snap_to_grid_enabled: false }), 1, false), raw));
  ok('setting off: Ctrl is a no-op (canvas.snap_to_grid early-returns)',
    same(snapMove(raw, S({ snap_to_grid_enabled: false }), 1, true), raw));
  ok('bias handles never snap', same(snapMove(raw, S({}), 1, false, true), raw));
}

console.log('--- attach target (_get_snapped_attachment_position)');
{
  const start = P(112, 56);   // on-grid start, as a snapped press gives
  ok('a clear drag returns the snapped cursor', same(snapAttachTarget(P(200, 61), start, S({})), P(196, 56)));
  ok('cursor exactly on the start -> one grid step along +X',
    same(snapAttachTarget(start, start, S({})), P(140, 56)));
  ok('cursor that rounds back onto the start, mostly leftward -> one step along -X',
    same(snapAttachTarget(P(105, 58), start, S({})), P(84, 56)));
  ok('cursor that rounds back onto the start, mostly upward -> one step along -Y',
    same(snapAttachTarget(P(114, 47), start, S({})), P(112, 28)));
  ok('attach snap off: raw cursor, even on the start (no snap, no minimum length)',
    same(snapAttachTarget(P(113, 57), start, S({ snap_to_grid_attach_enabled: false })), P(113, 57)));
  const off = P(100, 100);    // an off-grid start (a parent endpoint) is never returned either
  ok('off-grid start: the rounded cursor is returned as-is when it differs from the start',
    same(snapAttachTarget(P(103, 101), off, S({})), P(112, 112)));
}

console.log('--- Move Group dialog: Snap to grid (snap_group_to_grid)');
{
  const mk = (over) => ({
    type: 'Strand', layer_name: '1_1', set_number: 1,
    start: P(101, 45), end: P(203, 149),
    control_points: [P(101, 45), P(190, 100)],
    control_point_center: P(145.5, 72.5), control_point_center_locked: false,
    width: 46, stroke_width: 4,
    color: { r: 0, g: 0, b: 0, a: 255 }, stroke_color: { r: 0, g: 0, b: 0, a: 255 },
    has_circles: [false, false], is_hidden: false, shadow_only: false, hide_shadow: false,
    circle_stroke_color: null, knot_connections: {}, extra: {}, control_point2_activated: true,
    ...over,
  });
  const strands = [
    mk({}),
    mk({ layer_name: '1_2', type: 'AttachedStrand', attached_to: '1_1', attachment_side: 1, start: P(203, 149), end: P(300, 160), control_points: [P(203, 149), P(203, 149)] }),
    mk({ layer_name: '2_1', set_number: 2, start: P(400, 400), end: P(500, 401) }),   // not in the group
    mk({ layer_name: '1_1_2_1', type: 'MaskedStrand', set_number: 1, deletion_rectangles: [{ top_left: [1, 1], top_right: [2, 1], bottom_left: [1, 2], bottom_right: [2, 2] }] }),
  ];
  const doc = {
    order: strands.map((s) => s.layer_name),
    strands: Object.fromEntries(strands.map((s) => [s.layer_name, s])),
    groups: { G: { main_strands: ['1_1'] } }, selected_strand_name: null, locked_layers: [], lock_mode: false,
    shadow_enabled: true, show_control_points: false, shadow_overrides: {}, extra: {},
  };
  snapGroupToGrid(doc, 'G', G);
  const a = doc.strands['1_1'], b = doc.strands['1_2'], c = doc.strands['2_1'];
  ok('member endpoints land ON the grid (absolute, not an offset rounding)',
    same(a.start, P(112, 56)) && same(a.end, P(196, 140)), `${fmt(a.start)} ${fmt(a.end)}`);
  ok('an attached member is snapped too', same(b.start, P(196, 140)) && same(b.end, P(308, 168)), `${fmt(b.start)} ${fmt(b.end)}`);
  ok('a strand outside the group is untouched', same(c.start, P(400, 400)) && same(c.end, P(500, 401)));
  ok('a control point that coincided with the old start rides with it (strand.py start setter)',
    same(a.control_points[0], P(112, 56)) && same(a.control_points[1], P(190, 100)));
  ok('the centre re-derives from the cp midpoint', same(a.control_point_center, P(151, 78)));
  ok('the mask member is left alone',
    JSON.stringify(doc.strands['1_1_2_1'].deletion_rectangles[0].top_left) === '[1,1]');
}
rmSync(out, { recursive: true, force: true });

// ============================================================= browser half
const rawFixture = JSON.parse(readFileSync(path.join(root, 'fixtures', 'single_strand.json'), 'utf8'));
const project0 = rawFixture && rawFixture.type === 'OpenStrandStudioHistory'
  ? ((rawFixture.states || []).find((s) => s.step === rawFixture.current_step) || rawFixture.states[0]).data
  : rawFixture;
// single_strand sits at x ~1290-1370, past the right edge of the canvas at this
// viewport; attach mode clamps the cursor ~50px inside the visible area (OSS
// constrain_coordinates_to_visible_viewport), so shift the whole drawing into view.
// A uniform translation keeps every point exactly as off-grid as it was.
const SHIFT = { x: -900, y: 300 };
const project = JSON.parse(JSON.stringify(project0));
for (const st of project.strands || []) {
  for (const k of ['start', 'end', 'control_point_center']) {
    if (st[k] && typeof st[k].x === 'number') { st[k].x += SHIFT.x; st[k].y += SHIFT.y; }
  }
  for (const cp of st.control_points || []) { cp.x += SHIFT.x; cp.y += SHIFT.y; }
}

const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'),
  server: { port: 5213, open: false, host: '127.0.0.1' }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});

let r;
const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto('http://127.0.0.1:5213/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 30000 });

  r = await page.evaluate(async ({ project }) => {
    const store = window.__store;
    const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
    const settle = async (n = 6) => { for (let i = 0; i < n; i++) await nextFrame(); };
    const st = () => store.getState();
    const out = {};

    // Every scenario starts from the same document, the same view and an explicit
    // pair of snap settings.
    const reset = async (settings) => {
      st().loadDocument(window.__io.loadProject(project));
      st().setSettings({ show_grid: false, grid_size: 28, ...settings });
      st().setSelection({ layerName: null, handle: null });
      await settle(12);
    };
    const el = document.getElementById('c');
    const toClient = (w) => {
      const rect = el.getBoundingClientRect();
      const view = st().view;
      const sx = rect.width / Math.max(1, el.width), sy = rect.height / Math.max(1, el.height);
      return { x: rect.left + (w.x * view.zoom + view.panX) * sx, y: rect.top + (w.y * view.zoom + view.panY) * sy };
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
    const newest = () => { const d = st().doc; return d.strands[d.order[d.order.length - 1]]; };
    const layers = () => st().doc.order.length;

    // A. new strand: armed press at an off-grid point, release at another.
    const pressA = { x: 301, y: 405 }, endA = { x: 425, y: 337 };
    await reset({ snap_to_grid_enabled: false, snap_to_grid_attach_enabled: true });
    { const n0 = layers(); st().armNewStrand(); await settle(2);
      await gesture(pressA, [{ x: 360, y: 380 }, endA], endA);
      const s = newest();
      out.newAttachOn = { created: layers() === n0 + 1, start: s.start, end: s.end, type: s.type }; }
    await reset({ snap_to_grid_enabled: true, snap_to_grid_attach_enabled: false });
    { const n0 = layers(); st().armNewStrand(); await settle(2);
      await gesture(pressA, [{ x: 360, y: 380 }, endA], endA);
      const s = newest();
      out.newAttachOff = { created: layers() === n0 + 1, start: s.start, end: s.end }; }

    // B. bare click (no move) with attach-snap on.
    await reset({ snap_to_grid_enabled: false, snap_to_grid_attach_enabled: true });
    { const n0 = layers(); st().armNewStrand(); await settle(2);
      await gesture(pressA, [], pressA);
      const s = newest();
      out.clickAttachOn = { created: layers() === n0 + 1, start: s.start, end: s.end }; }
    await reset({ snap_to_grid_enabled: true, snap_to_grid_attach_enabled: false });
    { const n0 = layers(); st().armNewStrand(); await settle(2);
      await gesture(pressA, [], pressA);
      out.clickAttachOff = { created: layers() === n0 + 1 }; }

    // C. child from the fixture's FREE endpoint (single_strand's end already carries a
    // circle, so that is its start: (472, 384) after the shift — off-grid, which is the point).
    const parent0 = st().doc.strands[st().doc.order[0]];
    const parentEnd = { ...(parent0.has_circles[0] ? parent0.end : parent0.start) };
    // Drag LEFT: the fixture's free endpoint sits near the canvas's right edge, and
    // attach mode clamps the cursor ~50px inside the viewport (OSS
    // constrain_coordinates_to_visible_viewport) — a rightward release would be clamped.
    const endC = { x: parentEnd.x - 101, y: parentEnd.y + 33 };
    await reset({ snap_to_grid_enabled: false, snap_to_grid_attach_enabled: true });
    { st().setMode('attach'); await settle(2);
      const n0 = layers();
      await gesture(parentEnd, [{ x: parentEnd.x - 50, y: parentEnd.y + 10 }, endC], endC);
      const s = newest();
      out.childAttachOn = { created: layers() === n0 + 1, type: s.type, start: s.start, end: s.end, parentEnd }; }
    await reset({ snap_to_grid_enabled: true, snap_to_grid_attach_enabled: false });
    { st().setMode('attach'); await settle(2);
      const n0 = layers();
      await gesture(parentEnd, [{ x: parentEnd.x - 50, y: parentEnd.y + 10 }, endC], endC);
      const s = newest();
      out.childAttachOff = { created: layers() === n0 + 1, start: s.start, end: s.end }; }

    // D. move-mode drag of that same free endpoint (zoom 1).
    const side = parent0.has_circles[0] ? 'end' : 'start';
    const dragTo = { x: parentEnd.x + 73, y: parentEnd.y + 41 };
    await reset({ snap_to_grid_enabled: true, snap_to_grid_attach_enabled: false });
    { st().setMode('move'); await settle(2);
      await gesture(parentEnd, [{ x: parentEnd.x + 30, y: parentEnd.y + 20 }, dragTo], dragTo);
      out.moveOn = { end: st().doc.strands[st().doc.order[0]][side] }; }
    await reset({ snap_to_grid_enabled: false, snap_to_grid_attach_enabled: true });
    { st().setMode('move'); await settle(2);
      await gesture(parentEnd, [{ x: parentEnd.x + 30, y: parentEnd.y + 20 }, dragTo], dragTo);
      out.moveOff = { end: st().doc.strands[st().doc.order[0]][side] }; }

    return out;
  }, { project });
} finally {
  await browser.close();
  await server.close();
}

console.log('--- editor gestures');
ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
{
  const a = r.newAttachOn;
  ok('A1. new strand created by an armed drag', a.created && a.type === 'Strand');
  ok('A2. attach-snap ON: the START is the snapped press (attach_mode.py:609)',
    onGrid(a.start, G) && same(a.start, P(308, 392)), fmt(a.start));
  ok('A3. attach-snap ON: the END is the snapped release', onGrid(a.end, G) && same(a.end, P(420, 336)), fmt(a.end));
  const b = r.newAttachOff;
  ok('A4. attach-snap OFF (move-snap ON): the START is the raw press — the move setting has no say',
    b.created && same(b.start, P(301, 405)), fmt(b.start));
  ok('A5. attach-snap OFF: the END is the raw release', same(b.end, P(425, 337)), fmt(b.end));
}
{
  const c = r.clickAttachOn;
  ok('B1. attach-snap ON: a bare click still creates a strand (start != end, attach_mode.py:520)', c.created);
  ok('B2. ...one grid step long, from the snapped press',
    c.created && same(c.start, P(308, 392)) && Math.hypot(c.end.x - c.start.x, c.end.y - c.start.y) === G,
    c.created ? `${fmt(c.start)} -> ${fmt(c.end)}` : 'not created');
  ok('B3. attach-snap OFF: a bare click creates nothing', !r.clickAttachOff.created);
}
{
  const c = r.childAttachOn;
  ok('C1. a child is attached to the free end', c.created && c.type === 'AttachedStrand');
  ok('C2. the child START is the parent\'s (off-grid) endpoint itself, never snapped (attach_mode.py:1144)',
    same(c.start, c.parentEnd), `${fmt(c.start)} vs parent ${fmt(c.parentEnd)}`);
  ok('C3. attach-snap ON: the child END is on the grid', onGrid(c.end, G), fmt(c.end));
  const d = r.childAttachOff;
  ok('C4. attach-snap OFF: the child END is the raw cursor (no snap, no 40px minimum)',
    d.created && same(d.end, P(c.parentEnd.x - 101, c.parentEnd.y + 33)), fmt(d.end));
}
{
  ok('D1. move-snap ON: a dragged endpoint lands on the grid', onGrid(r.moveOn.end, G), fmt(r.moveOn.end));
  ok('D2. move-snap OFF (attach-snap ON): a dragged endpoint stays raw — the attach setting has no say',
    !onGrid(r.moveOff.end, G), fmt(r.moveOff.end));
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
