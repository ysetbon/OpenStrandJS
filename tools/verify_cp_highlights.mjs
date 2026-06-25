// Visual verification of the move-mode highlight fixes (CP glyphs / center / bias /
// endpoint "yellow boxes"). Drives the running editor via window.__store (DEV global,
// same pattern as compare_hover.mjs) and screenshots the composited #c + #overlay for
// each scenario I changed, so the fixes can be eyeballed.
//
// Usage: node tools/verify_cp_highlights.mjs [editorURL]   (default http://localhost:5183/)

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const url = process.argv[2] || 'http://localhost:5183/';
const outDir = path.join(root, 'artifacts', 'cp_highlights');
mkdirSync(outDir, { recursive: true });

const black = { r: 0, g: 0, b: 0, a: 255 };
const rec = (o) => ({
  set_number: 1, control_point_center: null, control_point_center_locked: false,
  width: 46, stroke_width: 4, stroke_color: black, has_circles: [false, false],
  is_hidden: false, shadow_only: false, circle_stroke_color: null, knot_connections: {},
  bias_triangle: 0.5, bias_circle: 0.5, extra: {}, ...o,
});

// 1_1: curved with third CP + asymmetric bias (shows triangle+circle+center+bias squares
//      + red/blue influence lines). 2_1: straight, shares 1_1.end at (500,260) (joint
//      dedup test). 3_1: GHOST test — control_point2_shown TRUE but triangle_has_moved
//      FALSE and cps collapsed onto start => must show ONLY a triangle, no ghost circle.
const strands = {
  '1_1': rec({
    type: 'Strand', layer_name: '1_1', start: { x: 200, y: 260 }, end: { x: 500, y: 260 },
    control_points: [{ x: 270, y: 150 }, { x: 430, y: 150 }],
    control_point_center: { x: 350, y: 138 }, control_point_center_locked: true,
    triangle_has_moved: true, control_point2_shown: true,
    bias_triangle: 0.80, bias_circle: 0.22, color: { r: 200, g: 120, b: 90, a: 255 },
  }),
  '2_1': rec({
    type: 'Strand', layer_name: '2_1', start: { x: 500, y: 260 }, end: { x: 660, y: 410 },
    control_points: [{ x: 500, y: 260 }, { x: 660, y: 410 }],
    color: { r: 90, g: 150, b: 210, a: 255 },
  }),
  '3_1': rec({
    type: 'Strand', layer_name: '3_1', start: { x: 200, y: 440 }, end: { x: 470, y: 440 },
    control_points: [{ x: 200, y: 440 }, { x: 200, y: 440 }],
    control_point2_shown: true, triangle_has_moved: false,
    color: { r: 110, g: 180, b: 110, a: 255 },
  }),
};
const baseDoc = {
  order: ['1_1', '2_1', '3_1'], strands, groups: {}, selected_strand_name: null,
  locked_layers: [], lock_mode: false, shadow_enabled: false, show_control_points: true,
  shadow_overrides: {},
};
const view = { width: 780, height: 540, panX: 0, panY: 0, zoom: 1, supersample: 1 };

const browser = await chromium.launch();
let shots;
try {
  const page = await browser.newPage({ viewport: { width: 820, height: 600 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console.error]', m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__store, null, { timeout: 10000 });

  shots = await page.evaluate(async ({ baseDoc, view }) => {
    const S = window.__store;
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const composite = () => {
      const c = document.getElementById('c'), o = document.getElementById('overlay');
      const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
      const ctx = t.getContext('2d');
      ctx.fillStyle = '#ECECEC'; ctx.fillRect(0, 0, t.width, t.height);
      ctx.drawImage(c, 0, 0); ctx.drawImage(o, 0, 0);
      return t.toDataURL('image/png');
    };
    const paint = async () => { window.__requestRender(); window.__requestOverlay(); await raf(); await raf(); };

    S.getState().setSettings({ enable_third_control_point: true, enable_curvature_bias_control: true, show_grid: false, show_cp_selected_only: false, move_selected_only: false });
    S.getState().setView(view);
    S.getState().setMode('move');
    const out = {};

    // 1) Rest: all glyphs + bias + endpoint boxes; 3_1 must show ONLY a triangle (ghost fix).
    S.getState().loadDocument(clone(baseDoc));
    S.getState().setDragging(false);
    S.getState().setHover({ layerName: null, handle: null });
    await paint(); out.rest = composite();

    // 2) Hover the shared joint (1_1.end == 2_1.start): one clean yellow box, 2_1's red suppressed.
    S.getState().setHover({ layerName: '1_1', handle: 'end' });
    await paint(); out.hover_joint = composite();

    // 3) CP drag: only the grabbed cp1 shows (yellow) on the affected strand; other CPs hidden.
    S.getState().setHover({ layerName: null, handle: null });
    S.getState().setSelection({ layerName: '1_1', handle: 'control_point1' });
    S.getState().setDragging(true);
    await paint(); out.cp_drag = composite();
    S.getState().setDragging(false);

    // 4) Locked strand still shows its squares (lock only blocks the grab).
    const lockedDoc = clone(baseDoc); lockedDoc.locked_layers = ['2_1']; lockedDoc.lock_mode = true;
    S.getState().loadDocument(lockedDoc);
    S.getState().setSelection({ layerName: null, handle: null });
    await paint(); out.locked = composite();

    // 5) show_cp_selected_only: select 1_1 -> only 1_1's CPs/squares; 2_1 & 3_1 hidden.
    const selDoc = clone(baseDoc); selDoc.selected_strand_name = '1_1';
    S.getState().loadDocument(selDoc);
    S.getState().setSettings({ show_cp_selected_only: true });
    await paint(); out.selected_only = composite();
    S.getState().setSettings({ show_cp_selected_only: false });

    return out;
  }, { baseDoc, view });
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}

for (const [name, dataUrl] of Object.entries(shots)) {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  writeFileSync(path.join(outDir, `${name}.png`), PNG.sync.write(png));
  console.log(`wrote ${name}.png (${png.width}x${png.height})`);
}
console.log('OUT: ' + outDir);
process.exit(0);
