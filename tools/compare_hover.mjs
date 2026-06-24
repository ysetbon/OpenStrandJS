// Pixel-diff the mask-mode HOVER highlight (the yellow body band drawn when you
// hover a strand in Mask mode) between the REAL OpenStrand Studio and OpenStrandJS.
//
// The hover is an interaction OVERLAY, not part of the offscreen body oracle, so
// the normal prove.mjs harness doesn't cover it. Method:
//   OSS:  reference_render.py at supersample 1, once WITHOUT a hover and once WITH
//         OSS_HOVER_LAYER set (it calls mask_mode.draw -> the exact Qt hover paint).
//   JS:   drive the running editor at the SAME geometry (view.width/pan = OSS
//         image/offset, zoom 1, editor supersample 1 -> #c and #overlay share the
//         world->screen transform and align with OSS), composite #c + #overlay over
//         white, once in select mode (no hover) and once in mask mode hovering the
//         same layer.
// Then diff OSS_hover vs JS_hover (the hover comparison) and OSS_nohover vs
// JS_nohover (the body baseline, i.e. the inherent ss1 anti-alias noise). If the
// hover-scene diff is ~ the body baseline, the hover matches OSS. Emits an HTML
// report with every panel.
//
// Usage: node tools/compare_hover.mjs [fixture] [hoverLayer] [mode] [editorURL]
//   mode = 'mask' (default) or 'select' — both draw the identical yellow hover.
//   defaults: fixtures/single_strand.json  1_1  mask  http://localhost:5183/

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixture = path.resolve(root, process.argv[2] || 'fixtures/single_strand.json');
const hoverLayer = process.argv[3] || '1_1';
const hoverModeArg = process.argv[4] || 'mask';   // 'mask' | 'select'
const url = process.argv[5] || 'http://localhost:5183/';
const outDir = path.join(root, 'artifacts', hoverModeArg === 'select' ? 'hover_diff_select' : 'hover_diff');
mkdirSync(outDir, { recursive: true });

const PY = process.env.OSS_PY ||
  path.resolve(root, '..', 'OpenStrandStudio', 'src', 'build_env', 'Scripts', 'python.exe');

// --- 1. OSS renders at supersample 1 (no-hover + hover) ---------------------
const refScript = path.join(here, 'reference_render.py');
const ossNoHover = path.join(outDir, 'oss_nohover.png');
const ossHover = path.join(outDir, 'oss_hover.png');
const metaPath = path.join(outDir, 'meta.json');
const metaPath2 = path.join(outDir, 'meta_hover.json');
const baseEnv = { ...process.env, OSS_SUPERSAMPLE: '1' };
console.log('OSS render (no hover)…');
execFileSync(PY, [refScript, fixture, ossNoHover, metaPath], { env: baseEnv, stdio: 'inherit' });
console.log(`OSS render (hover ${hoverLayer}, ${hoverModeArg})…`);
execFileSync(PY, [refScript, fixture, ossHover, metaPath2],
  { env: { ...baseEnv, OSS_HOVER_LAYER: hoverLayer, OSS_HOVER_MODE: hoverModeArg }, stdio: 'inherit' });

const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

// --- 2. Convert the OSS fixture to an editor EditorDocument -----------------
const fx = JSON.parse(readFileSync(fixture, 'utf8'));
const rawStrands = fx.type === 'OpenStrandStudioHistory'
  ? (fx.states.find((s) => s.step === (fx.current_step ?? 1))?.data.strands ?? [])
  : (fx.strands ?? []);
const cp = (p) => ({ x: p.x, y: p.y });
function toRecord(s) {
  const start = cp(s.start), end = cp(s.end);
  const ctrl = Array.isArray(s.control_points) && s.control_points.length === 2
    ? [cp(s.control_points[0]), cp(s.control_points[1])]
    : [cp(start), cp(start)];
  const rec = {
    type: s.type, layer_name: s.layer_name, set_number: s.set_number ?? 1,
    start, end, control_points: ctrl, control_point_center: null, control_point_center_locked: false,
    width: s.width, stroke_width: s.stroke_width ?? 4,
    color: s.color, stroke_color: s.stroke_color ?? { r: 0, g: 0, b: 0, a: 255 },
    has_circles: s.has_circles ?? [false, false], is_hidden: false, shadow_only: false,
    circle_stroke_color: null, knot_connections: {}, extra: {},
  };
  if (s.type === 'AttachedStrand') { rec.attached_to = s.parent_layer_name ?? null; rec.attachment_side = s.is_start_side ? 0 : 1; }
  if (s.type === 'MaskedStrand') { rec.deletion_rectangles = s.deletion_rectangles ?? []; rec.using_absolute_coords = false; }
  return rec;
}
const order = rawStrands.map((s) => s.layer_name);
const strands = {};
for (const s of rawStrands) strands[s.layer_name] = toRecord(s);
const doc = {
  order, strands, groups: {}, selected_strand_name: null, locked_layers: [], lock_mode: false,
  shadow_enabled: !!meta.shadow_enabled, show_control_points: false, shadow_overrides: {},
};
const view = { width: meta.image_width, height: meta.image_height, panX: meta.x_offset, panY: meta.y_offset, zoom: 1, supersample: 1 };

// --- 3. Drive the JS editor and grab composited #c + #overlay ---------------
const browser = await chromium.launch();
let caps;
try {
  const page = await browser.newPage({ viewport: { width: Math.min(1600, meta.image_width + 40), height: Math.min(1000, meta.image_height + 40) }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__store, null, { timeout: 10000 });

  caps = await page.evaluate(async ({ doc, view, curve, hoverLayer, hoverMode }) => {
    const S = window.__store;
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    S.getState().setSettings({ curve_params: curve, show_grid: false });
    S.getState().setView(view);
    S.getState().loadDocument(doc);
    const composite = () => {
      const c = document.getElementById('c'), o = document.getElementById('overlay');
      const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
      const ctx = t.getContext('2d');
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, t.width, t.height);
      ctx.drawImage(c, 0, 0); ctx.drawImage(o, 0, 0);
      return { url: t.toDataURL('image/png'), w: c.width, h: c.height };
    };
    // No-hover: select mode, nothing hovered.
    S.getState().setMode('select');
    S.getState().setHover({ layerName: null, handle: null });
    S.getState().setMaskPending([]);
    window.__requestRender(); await raf(); await raf();
    const nohover = composite();
    // Hover: enter the chosen mode and hover the chosen layer.
    S.getState().setMode(hoverMode);
    S.getState().setHover({ layerName: hoverLayer, handle: null });
    window.__requestOverlay(); window.__requestRender(); await raf(); await raf();
    const hover = composite();
    return { nohover, hover };
  }, { doc, view, curve: meta.curve_params, hoverLayer, hoverMode: hoverModeArg });
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}

// --- 4. Diff + HTML report --------------------------------------------------
const dec = (p) => PNG.sync.read(
  p.startsWith('data:') ? Buffer.from(p.split(',')[1], 'base64') : readFileSync(p),
);
const ossNo = dec(ossNoHover), ossH = dec(ossHover);
const jsNo = dec(caps.nohover.url), jsH = dec(caps.hover.url);
const W = ossH.width, H = ossH.height;

function diffPair(a, b, name) {
  if (a.width !== b.width || a.height !== b.height) {
    console.error(`SIZE MISMATCH ${name}: oss ${a.width}x${a.height} vs js ${b.width}x${b.height}`);
    return { n: -1, png: new PNG({ width: a.width, height: a.height }) };
  }
  const out = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0.1 });
  writeFileSync(path.join(outDir, name), PNG.sync.write(out));
  return { n, png: out };
}
writeFileSync(path.join(outDir, 'js_nohover.png'), PNG.sync.write(jsNo));
writeFileSync(path.join(outDir, 'js_hover.png'), PNG.sync.write(jsH));
const bodyDiff = diffPair(ossNo, jsNo, 'body_baseline_diff.png');
const hoverDiff = diffPair(ossH, jsH, 'hover_diff.png');

const total = W * H;
const summary = {
  canvas: `${W}x${H}`,
  body_baseline_diff_px: bodyDiff.n,
  body_baseline_diff_pct: bodyDiff.n < 0 ? 'SIZE-MISMATCH' : +(100 * bodyDiff.n / total).toFixed(3),
  hover_scene_diff_px: hoverDiff.n,
  hover_scene_diff_pct: hoverDiff.n < 0 ? 'SIZE-MISMATCH' : +(100 * hoverDiff.n / total).toFixed(3),
  note: 'hover_scene_diff ~ body_baseline_diff => hover matches OSS; excess over baseline = hover divergence',
};
console.log(JSON.stringify(summary, null, 2));

const html = `<!doctype html><meta charset=utf8><title>Mask hover pixel diff — OSS vs OpenStrandJS</title>
<style>body{font:13px system-ui;background:#111;color:#ddd;margin:20px}
h1{font-size:16px}table{border-collapse:collapse}td{padding:6px;text-align:center;vertical-align:top}
img{image-rendering:pixelated;max-width:340px;border:1px solid #333;background:#fff}
.k{color:#9cf}.bad{color:#f88}.ok{color:#8f8}code{color:#fc9}</style>
<h1>Mask-mode HOVER pixel diff &mdash; ${path.basename(fixture)} hovering <code>${hoverLayer}</code> (supersample 1)</h1>
<p>Body baseline diff (no-hover, OSS vs JS): <b class=k>${summary.body_baseline_diff_pct}%</b> &mdash; inherent ss1 anti-alias noise.<br>
Hover-scene diff (OSS hover vs JS hover): <b class="${summary.hover_scene_diff_px <= bodyDiff.n * 1.5 ? 'ok' : 'bad'}">${summary.hover_scene_diff_pct}%</b>.<br>
If the hover-scene diff is close to the body baseline, the hover highlight matches OSS.</p>
<table>
<tr><td class=k>OSS hover</td><td class=k>JS hover</td><td class=k>HOVER diff</td></tr>
<tr><td><img src=oss_hover.png></td><td><img src=js_hover.png></td><td><img src=hover_diff.png></td></tr>
<tr><td class=k>OSS no-hover</td><td class=k>JS no-hover</td><td class=k>baseline diff</td></tr>
<tr><td><img src=oss_nohover.png></td><td><img src=js_nohover.png></td><td><img src=body_baseline_diff.png></td></tr>
</table>`;
writeFileSync(path.join(outDir, 'report.html'), html);
console.log('REPORT: ' + path.join(outDir, 'report.html'));
process.exit(0);
