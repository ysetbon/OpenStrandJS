// Screenshot the LAYER-PANEL mask button (.nlb.nlb-masked) of the running JS
// editor in three states — normal, hover, selected — plus the whole layer list,
// so we can prove the mask-button fidelity fixes (green-strip geometry, hover
// lighten, selected darken) against OSS.
//
// The layer panel is React/DOM (not the canvas oracle), so this drives the live
// editor via window.__store.loadDocument (same as compare_hover.mjs) and grabs a
// specific element. It forces html{zoom:1} so the button renders at its true
// 146x40 (the app ships zoom:0.65) and is directly comparable to OSS grab().
//
// Usage: node tools/compare_mask_button.mjs [fixture] [outDir] [url]
//   defaults: fixtures/mxn_lh_1x1.json  artifacts/mask_button/js  http://localhost:5173/

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixture = path.resolve(root, process.argv[2] || 'fixtures/mxn_lh_1x1.json');
const outDir = path.resolve(root, process.argv[3] || 'artifacts/mask_button/js');
const url = process.argv[4] || 'http://localhost:5173/';
mkdirSync(outDir, { recursive: true });

// --- build an EditorDocument from the OSS fixture (same shape as compare_hover) ---
const fx = JSON.parse(readFileSync(fixture, 'utf8'));
const rawStrands = fx.type === 'OpenStrandStudioHistory'
  ? (fx.states.find((s) => s.step === (fx.current_step ?? 1))?.data.strands ?? [])
  : (fx.strands ?? []);
const cp = (p) => (p ? { x: p.x, y: p.y } : { x: 0, y: 0 });   // masks may have null coords; buttons don't need geometry
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
  shadow_enabled: false, show_control_points: false, shadow_overrides: {},
};

const browser = await chromium.launch();
try {
  const dsf = +(process.env.DSF || 3);   // DSF=1 to match OSS grab() 146x40 for pixelmatch
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: dsf });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__store, null, { timeout: 10000 });

  // load the doc + neutralise the 0.65 app zoom so the button is true 146x40
  const maskName = await page.evaluate(async (doc) => {
    document.documentElement.style.zoom = '1';
    const S = window.__store;
    S.getState().setSettings({ show_grid: false });
    S.getState().loadDocument(doc);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // find the mask layer name (button gets .nlb-masked)
    const el = document.querySelector('.nlb.nlb-masked');
    return el ? el.querySelector('.nlb-label')?.getAttribute('data-text') ?? null : null;
  }, doc);

  if (!maskName) throw new Error('no mask button (.nlb.nlb-masked) found for fixture ' + fixture);
  console.log('mask layer:', maskName);

  // Geometry check: is the attach strip flush-right / full-height on a mask vs a
  // normal button? Reports the strip's edges relative to the button border box.
  const geom = await page.evaluate(() => {
    const probe = (btn) => {
      if (!btn) return null;
      const b = btn.getBoundingClientRect();
      const a = btn.querySelector('.nlb-attach')?.getBoundingClientRect() ?? null;
      const cs = getComputedStyle(btn);
      return {
        overflow: cs.overflow,
        borderRightPx: cs.borderRightWidth,
        button: { w: +b.width.toFixed(1), h: +b.height.toFixed(1) },
        attach: a ? {
          w: +a.width.toFixed(2), h: +a.height.toFixed(2),
          gapFromRight: +(b.right - a.right).toFixed(2),   // 0 == flush to border-box right edge
          topInset: +(a.top - b.top).toFixed(2),           // 0 == flush to top
          bottomInset: +(b.bottom - a.bottom).toFixed(2),  // 0 == flush to bottom
        } : null,
      };
    };
    const mask = document.querySelector('.nlb.nlb-masked');
    // a normal (non-mask) attachable button for comparison
    const normal = [...document.querySelectorAll('.nlb.nlb-attachable:not(.nlb-masked)')][0];
    return { mask: probe(mask), normal: probe(normal) };
  });
  console.log('geometry:', JSON.stringify(geom, null, 2));

  const sel = '.nlb.nlb-masked';
  const shot = async (name) => {
    const el = await page.$(sel);
    await el.screenshot({ path: path.join(outDir, name) });
  };

  // 1) normal — mouse parked away
  await page.mouse.move(5, 5);
  await page.waitForTimeout(80);
  await shot('normal.png');

  // 2) hover — real pointer over the button -> CSS :hover
  await page.hover(sel);
  await page.waitForTimeout(120);
  await shot('hover.png');

  // 3) selected — real left click (exercises onClick->select), then park mouse
  await page.click(sel);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(120);
  await shot('selected.png');

  // context: the whole layer list
  const list = await page.$('.lp-list');
  if (list) await list.screenshot({ path: path.join(outDir, 'list.png') });

  writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ fixture: path.basename(fixture), maskName, url, geom }, null, 2));
  console.log('saved ->', outDir);
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
process.exit(0);
