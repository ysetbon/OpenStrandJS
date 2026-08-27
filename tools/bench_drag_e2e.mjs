// End-to-end drag/release benchmark for the LIVE editor.
//
// tools/bench_drag.mjs measures the RENDERER in isolation (renderFixture /
// renderDragFrame against web/render.html). That misses everything the editor
// itself does per pointer event: the store's document clone, the React wake-up,
// the render-array rebuild, the overlay redraw. Those dominate a real drag once
// a document has more than a handful of layers.
//
// This script boots the real Vite app in Chromium, loads a document, grabs a real
// endpoint in move mode, and drives synthetic PointerEvents at #c exactly the way
// a mouse does. It reports:
//
//   press        ms spent in the pointerdown handler (grab + bake trigger)
//   move sync    ms per pointermove INSIDE the event handler (store mutation)
//   frame        rAF-to-rAF interval while dragging  ->  the FPS a user feels
//   react        React commits observed during the drag (DOM mutations in the
//                layer panel + properties pane, via MutationObserver)
//   release      ms in the pointerup handler, and ms from pointerup until the
//                full-quality render that follows it has finished
//
// Usage:
//   node tools/bench_drag_e2e.mjs [--fixture three_strand_braid] [--moves 90]
//                                 [--synthetic 60] [--json out.json] [--label name]
//
// --synthetic N replaces the fixture with N procedurally generated strands, so
// the scaling behaviour (cost vs. layer count) is visible.
//
// OSS_CHROMIUM: absolute path to a Chromium binary if the pre-installed browser
// revision does not match this Playwright version.

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FIXTURE = arg('fixture', 'three_strand_braid');
const MOVES = Number(arg('moves', 90));
const SYNTHETIC = Number(arg('synthetic', 0));
const JSON_OUT = arg('json', '');
const LABEL = arg('label', SYNTHETIC ? `synthetic-${SYNTHETIC}` : FIXTURE);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};
const sum = (a) => a.reduce((x, y) => x + y, 0);

// The editor's own loader accepts the plain {strands, ...} project shape; a
// fixture saved as an OpenStrandStudioHistory needs its current step unwrapped
// first (same rule as js_render.mjs / ci_smoke.mjs).
function loadProjectJson(name) {
  const p = path.join(root, 'fixtures', `${name}.json`);
  if (!existsSync(p)) throw new Error(`no fixture ${p}`);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return raw && raw.type === 'OpenStrandStudioHistory'
    ? ((raw.states || []).find((s) => s.step === raw.current_step) || raw.states[0]).data
    : raw;
}

// A procedurally generated document of N main strands laid out on a grid. Shapes
// match what the editor's own loader expects (save_load field names), so it goes
// through exactly the same code path as a real file.
function syntheticProject(n) {
  const strands = [];
  const cols = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const cx = 140 + (i % cols) * 130;
    const cy = 140 + Math.floor(i / cols) * 130;
    const sx = cx, sy = cy, ex = cx + 96, ey = cy + 48;
    strands.push({
      type: 'Strand',
      index: i,
      layer_name: `${i + 1}_1`,
      set_number: i + 1,
      start: { x: sx, y: sy },
      end: { x: ex, y: ey },
      width: 46,
      stroke_width: 4,
      color: { r: 200, g: 170 - (i * 3) % 120, b: 230, a: 255 },
      stroke_color: { r: 0, g: 0, b: 0, a: 255 },
      has_circles: [false, false],
      control_points: [{ x: sx + 32, y: sy + 16 }, { x: ex - 32, y: ey - 16 }],
      control_point_center: { x: (sx + ex) / 2, y: (sy + ey) / 2 },
      control_point_center_locked: false,
      is_hidden: false,
    });
  }
  return {
    strands,
    groups: {},
    selected_strand_name: null,
    locked_layers: [],
    lock_mode: false,
    shadow_enabled: true,
    show_control_points: true,
    shadow_overrides: {},
  };
}

const project = SYNTHETIC > 0 ? syntheticProject(SYNTHETIC) : loadProjectJson(FIXTURE);

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { port: 5199, open: false, host: '127.0.0.1' },
  logLevel: 'error',
});
await server.listen();
const url = `http://127.0.0.1:5199/`;

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
let out;
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 30000 });

  out = await page.evaluate(async ({ project, moves }) => {
    const store = window.__store;
    const doc = window.__io.loadProject(project);
    store.getState().loadDocument(doc);
    // Grid off and shadows on: the default resting state of the app. Snap OFF so
    // every synthetic move produces a distinct target (snapMove's equal-target
    // early-out would otherwise skip most frames and flatter the numbers).
    store.getState().setSettings({ show_grid: false, snap_to_grid_enabled: false });
    store.getState().setMode('move');
    await new Promise((r) => setTimeout(r, 900));   // settle the first full render

    const el = document.getElementById('c');
    const rect = el.getBoundingClientRect();
    const view = store.getState().view;
    const st = store.getState();
    // Grab the END of the first non-masked strand — an endpoint drag is the
    // heaviest gesture (it carries welded peers and re-tracks every mask).
    const name = st.doc.order.find((n) => st.doc.strands[n]?.type !== 'MaskedStrand');
    const s = st.doc.strands[name];
    const toClient = (w) => ({
      x: rect.left + (w.x * view.zoom + view.panX) * (rect.width / Math.max(1, el.width)),
      y: rect.top + (w.y * view.zoom + view.panY) * (rect.height / Math.max(1, el.height)),
    });
    const grab = toClient(s.end);

    const ev = (type, x, y, extra = {}) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1, ...extra,
    });

    // React commits that actually reach the DOM. A drag that wakes the layer
    // panel shows up here; one that leaves React alone does not.
    let domMutations = 0;
    const mo = new MutationObserver((recs) => { domMutations += recs.length; });
    const panel = document.querySelector('.layer-panel') || document.body;
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });

    // Instrument the renderer so bake / per-frame / full-render costs separate out.
    const rec = { bake: [], frame: [], full: [] };
    const wrap = (key, fnName) => {
      const orig = window[fnName];
      if (typeof orig !== 'function') return;
      window[fnName] = function (...a) {
        const t0 = performance.now();
        try { return orig.apply(this, a); } finally { rec[key].push(performance.now() - t0); }
      };
    };
    wrap('bake', 'renderDragBackground');
    wrap('frame', 'renderDragFrame');
    wrap('full', 'renderFixture');

    const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

    // ---- press -------------------------------------------------------------
    let t0 = performance.now();
    el.dispatchEvent(ev('pointerdown', grab.x, grab.y));
    const pressMs = performance.now() - t0;
    await nextFrame(); await nextFrame();

    const grabbed = store.getState().dragging;

    // ---- drag: one move per animation frame, the way a mouse feeds a browser -
    const moveSync = [];
    const frameGaps = [];
    let last = performance.now();
    rec.frame.length = 0; rec.full.length = 0;   // drop press-time renders
    domMutations = 0;
    for (let i = 0; i < moves; i++) {
      const a = (i / moves) * Math.PI * 2;
      const x = grab.x + Math.cos(a) * 90;
      const y = grab.y + Math.sin(a) * 90;
      const t = performance.now();
      el.dispatchEvent(ev('pointermove', x, y));
      moveSync.push(performance.now() - t);
      await nextFrame();
      const now = performance.now();
      frameGaps.push(now - last);
      last = now;
    }
    const dragDomMutations = domMutations;

    // ---- release -----------------------------------------------------------
    const fullBefore = rec.full.length;
    t0 = performance.now();
    el.dispatchEvent(ev('pointerup', grab.x + 90, grab.y));
    const releaseSyncMs = performance.now() - t0;
    // Wait for the full-quality render that pointer-up schedules to land.
    const deadline = performance.now() + 4000;
    while (rec.full.length === fullBefore && performance.now() < deadline) await nextFrame();
    const releaseToPaintMs = performance.now() - t0;

    mo.disconnect();
    return {
      grabbed,
      strandCount: store.getState().doc.order.length,
      pressMs,
      moveSync,
      frameGaps,
      releaseSyncMs,
      releaseToPaintMs,
      releaseRenderMs: rec.full.length > fullBefore ? rec.full[fullBefore] : null,
      bake: rec.bake,
      dragFrames: rec.frame,
      dragDomMutations,
      historyDepth: store.getState().past.length,
    };
  }, { project, moves: MOVES });

  out.errors = errors;
} finally {
  // Both in the finally: the evaluate above throws whenever the page misbehaves,
  // and that path must not leak a Chromium process or leave the port bound.
  await browser.close().catch(() => {});
  await server.close();
}

if (!out || !out.grabbed) {
  console.error('BENCH FAILED: pointerdown did not start a drag (no endpoint grabbed)');
  process.exit(1);
}

const report = {
  label: LABEL,
  strands: out.strandCount,
  moves: MOVES,
  press_ms: +out.pressMs.toFixed(2),
  move_sync_median_ms: +median(out.moveSync).toFixed(3),
  move_sync_p95_ms: +pct(out.moveSync, 0.95).toFixed(3),
  move_sync_total_ms: +sum(out.moveSync).toFixed(1),
  frame_median_ms: +median(out.frameGaps).toFixed(2),
  frame_p95_ms: +pct(out.frameGaps, 0.95).toFixed(2),
  fps_median: +(1000 / Math.max(0.001, median(out.frameGaps))).toFixed(1),
  drag_frame_render_median_ms: +median(out.dragFrames).toFixed(2),
  drag_frames_rendered: out.dragFrames.length,
  bake_ms: +median(out.bake).toFixed(2),
  dom_mutations_during_drag: out.dragDomMutations,
  release_sync_ms: +out.releaseSyncMs.toFixed(2),
  release_to_paint_ms: +out.releaseToPaintMs.toFixed(2),
  release_render_ms: out.releaseRenderMs == null ? null : +out.releaseRenderMs.toFixed(2),
  history_depth: out.historyDepth,
  page_errors: out.errors,
};

console.log(`\ndrag/release — ${report.label} (${report.strands} strands, ${MOVES} moves)\n`);
for (const [k, v] of Object.entries(report)) {
  if (k === 'label' || k === 'page_errors') continue;
  console.log(`  ${k.padEnd(30)} ${v}`);
}
if (report.page_errors.length) console.log('\n  page errors:', report.page_errors.slice(0, 5));

if (JSON_OUT) {
  writeFileSync(path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(root, JSON_OUT),
    JSON.stringify(report, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
process.exit(0);
