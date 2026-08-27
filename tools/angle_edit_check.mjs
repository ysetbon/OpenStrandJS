// Regression guard for setStrandAngleLength (OSS AngleAdjustMode parity).
//
// Two independent things have to hold, and the second one is subtle:
//
//  A. The edit is a RIGID transform. OSS rotates cp1/cp2/control_point_center
//     about the start by the angle difference and scales them by the length ratio
//     (angle_adjust_mode.py:340-392). Moving only the endpoint deforms a curved
//     strand instead of rotating it.
//  B. Dependent masks are re-measured against the FINAL curve. moveHandle ends by
//     recomputing each dependent mask's centroid and drifting its deletion
//     rectangles by the delta; if the handles are rotated AFTER that call, the
//     stored edited_center_point describes a curve that no longer exists — and it
//     is the baseline for the next edit, so the error compounds.
//
// Runs on plain node: the modules under test are pure geometry, compiled on the
// fly with the repo's own tsc.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(path.join(tmpdir(), 'ossjs-angle-'));
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };

try {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', 'src/store/actions.ts', 'src/io/saveLoad.ts', 'src/interaction/hitGeometry.ts',
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
writeFileSync(path.join(out, 'package.json'), '{"type":"commonjs"}');
try { symlinkSync(path.join(root, 'node_modules'), path.join(out, 'node_modules'), 'dir'); } catch { /* exists */ }

const require = createRequire(path.join(out, 'x.js'));
const { setStrandAngleLength } = require(path.join(out, 'store/actions.js'));
const { maskCentroid } = require(path.join(out, 'interaction/hitGeometry.js'));
const { loadProject } = require(path.join(out, 'io/saveLoad.js'));
const CURVE = { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 };

// ------------------------------------------------ A. rigid rotation + scaling
{
  const P = (x, y) => ({ x, y });
  const mk = () => ({
    order: ['1_1'],
    strands: { '1_1': {
      type: 'Strand', layer_name: '1_1', set_number: 1,
      start: P(100, 100), end: P(200, 100),
      control_points: [P(120, 60), P(180, 60)],      // a clear arc above the chord
      control_point_center: P(150, 60), control_point_center_locked: false,
      width: 46, stroke_width: 4,
      color: { r: 0, g: 0, b: 0, a: 255 }, stroke_color: { r: 0, g: 0, b: 0, a: 255 },
      has_circles: [false, false], is_hidden: false, shadow_only: false, hide_shadow: false,
      circle_stroke_color: null, knot_connections: {}, extra: {}, control_point2_activated: true,
    } },
    groups: {}, selected_strand_name: null, locked_layers: [], lock_mode: false,
    shadow_enabled: true, show_control_points: false, shadow_overrides: {}, extra: {},
  });
  const dist = (p) => Math.hypot(p.x - 100, p.y - 100);

  const d = mk(); const b = JSON.parse(JSON.stringify(d.strands['1_1']));
  setStrandAngleLength(d, '1_1', 90, 100);
  const a = d.strands['1_1'];
  for (const [n, x, y] of [['cp1', b.control_points[0], a.control_points[0]],
                           ['cp2', b.control_points[1], a.control_points[1]],
                           ['end', b.end, a.end]])
    ok(`${n} keeps its distance from the pivot (rigid rotation)`, Math.abs(dist(x) - dist(y)) < 1e-9);
  ok('cp1 actually rotated (it stayed put before this fix)',
    Math.hypot(a.control_points[0].x - b.control_points[0].x,
               a.control_points[0].y - b.control_points[0].y) > 1);

  const d2 = mk(); setStrandAngleLength(d2, '1_1', 0, 200);
  ok('doubling the length doubles the handle offsets',
    Math.abs(dist(d2.strands['1_1'].control_points[0]) - 2 * dist(b.control_points[0])) < 1e-9);
  ok('an unlocked centre re-derives to the handle midpoint',
    Math.abs(a.control_point_center.x - (a.control_points[0].x + a.control_points[1].x) / 2) < 1e-9);

  const d3 = mk();
  d3.strands['1_1'].control_points[1] = P(200, 100);
  d3.strands['1_1'].control_point2_activated = false;
  setStrandAngleLength(d3, '1_1', 90, 100);
  const a3 = d3.strands['1_1'];
  ok('a passive cp2 lands exactly on the new endpoint',
    a3.control_points[1].x === a3.end.x && a3.control_points[1].y === a3.end.y);
}

// --------------------------------- B. dependent masks measured on the FINAL curve
{
  const doc = loadProject(JSON.parse(readFileSync(path.join(root, 'fixtures/box_stitch.json'), 'utf8')));
  const maskName = Object.keys(doc.strands).find((n) => doc.strands[n].type === 'MaskedStrand');
  const [a, b, c, d] = maskName.split('_');
  const over = `${a}_${b}`, under = `${c}_${d}`;

  // An eraser window inside the crossing, so the tracking path engages at all.
  const mid = { x: (doc.strands[over].start.x + doc.strands[under].start.x) / 2,
                y: (doc.strands[over].start.y + doc.strands[under].start.y) / 2 };
  doc.strands[maskName].deletion_rectangles = [{
    top_left: [mid.x - 15, mid.y - 15], top_right: [mid.x + 15, mid.y - 15],
    bottom_left: [mid.x - 15, mid.y + 15], bottom_right: [mid.x + 15, mid.y + 15],
  }];

  const s = doc.strands[over];
  const ang = Math.atan2(s.end.y - s.start.y, s.end.x - s.start.x) * 180 / Math.PI;
  const len = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);
  setStrandAngleLength(doc, over, ang + 15, len, CURVE);

  const stored = doc.strands[maskName].edited_center_point;
  const truth = maskCentroid(doc.strands[over], doc.strands[under], CURVE,
                             doc.strands[maskName].deletion_rectangles);
  ok('the probe produced a centroid at all', !!stored && !!truth);
  if (stored && truth) {
    const gap = Math.hypot(stored.x - truth.x, stored.y - truth.y);
    ok("a dependent mask's stored centre matches the final curve",
      gap < 1e-6, `${gap.toFixed(2)}px off — measured before the handles were rotated`);
  }
}

rmSync(out, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
