// End-to-end pan benchmark, through the REAL app.
//
// The drag work in this branch was measured by tools/bench_drag_e2e.mjs, which
// drives exactly one gesture: a handle drag. Panning was never measured, which is
// why a pan costing a full scene rebuild per frame survived that whole round of
// benchmarking. This is the missing measurement.
//
// It drives a right-button pan across the canvas with real PointerEvents against
// the real store, renderer and InteractionHost, and reports the same gesture twice:
//
//   fast   the pan fast path as shipped (one oversized snapshot + a blit per frame)
//   off    the same gesture with window.renderPanBackground removed, which makes
//          renderScheduler fall through to callRender — i.e. bit-for-bit the
//          behaviour before this path existed. A true A/B in one binary, rather
//          than a number quoted from a different build.
//
// Usage:
//   node tools/bench_pan_e2e.mjs [--fixture three_strand_braid] [--moves 60]
//                                [--synthetic N] [--json out.json]
//
// OSS_CHROMIUM: absolute path to a Chromium binary if the pre-installed browser
// revision does not match this Playwright version.

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const FIXTURE = arg('fixture', 'three_strand_braid');
const MOVES = Number(arg('moves', 60));
const SYNTHETIC = Number(arg('synthetic', 0));
const JSON_OUT = arg('json', '');
const LABEL = arg('label', SYNTHETIC ? `synthetic-${SYNTHETIC}` : FIXTURE);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const sum = (a) => a.reduce((x, y) => x + y, 0);

function loadProjectJson(name) {
  return JSON.parse(readFileSync(path.join(root, 'fixtures', `${name}.json`), 'utf8'));
}

// A scene of N unrelated strands, to show how the two paths scale with scene size
// (the pan cost that matters is O(all strands) on the old path and O(1) on the new).
function syntheticProject(n) {
  const strands = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 10), col = i % 10;
    const x = 120 + col * 115, y = 120 + row * 95;
    strands.push({
      type: 'Strand',
      layer_name: `${i + 1}_1`,
      set_number: i + 1,
      start: { x, y },
      end: { x: x + 85, y: y + 55 },
      control_points: [{ x: x + 28, y: y + 8 }, { x: x + 58, y: y + 46 }],
      width: 46,
      color: { r: 200, g: 170, b: 230, a: 255 },
      stroke_color: { r: 0, g: 0, b: 0, a: 255 },
      stroke_width: 4,
      has_circles: [false, false],
      is_start_side: true,
      shadow_only: false,
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
  server: { port: 5201, open: false, host: '127.0.0.1' },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
let out;
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://127.0.0.1:5201/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 30000 });

  out = await page.evaluate(async ({ project, moves }) => {
    const store = window.__store;
    store.getState().loadDocument(window.__io.loadProject(project));
    // Grid ON: it is on by default in the editor, it is drawn by the renderer, and
    // it is one of the things a naive pan blit gets wrong — so the benchmark has no
    // business turning it off.
    store.getState().setSettings({ show_grid: true });
    store.getState().setMode('move');
    await new Promise((r) => setTimeout(r, 900));   // settle the first full render

    const el = document.getElementById('c');
    const rect = el.getBoundingClientRect();
    const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

    // Right-button drag: InteractionHost treats button 2 as a pan in every mode.
    const ev = (type, x, y) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      button: type === 'pointermove' ? -1 : 2,
      buttons: type === 'pointerup' ? 0 : 2,
    });

    // Time every renderer entry point the pan can reach.
    const rec = { full: [], snap: [], blit: [] };
    const saved = {};
    const wrap = (key, fnName) => {
      const orig = window[fnName];
      saved[fnName] = orig;
      if (typeof orig !== 'function') return;
      window[fnName] = function (...a) {
        const t0 = performance.now();
        try { return orig.apply(this, a); } finally { rec[key].push(performance.now() - t0); }
      };
    };
    wrap('full', 'renderFixture');
    wrap('snap', 'renderPanBackground');
    wrap('blit', 'renderPanFrame');

    // One pan gesture. A monotonic sweep, not a circle: a circle keeps coming back
    // near its own start and would hide the re-snapshot cost that a real pan across
    // the canvas pays every PAN_MARGIN pixels of travel.
    async function gesture() {
      rec.full.length = 0; rec.snap.length = 0; rec.blit.length = 0;
      const x0 = rect.left + rect.width * 0.25, y0 = rect.top + rect.height * 0.7;
      el.dispatchEvent(ev('pointerdown', x0, y0));
      await nextFrame();

      const moveSync = [], frameGaps = [];
      let last = performance.now();
      for (let i = 1; i <= moves; i++) {
        const f = i / moves;
        const t = performance.now();
        el.dispatchEvent(ev('pointermove', x0 + f * 620, y0 - f * 400));
        moveSync.push(performance.now() - t);
        await nextFrame();
        const now = performance.now();
        frameGaps.push(now - last);
        last = now;
      }
      el.dispatchEvent(ev('pointerup', x0 + 620, y0 - 400));
      await nextFrame();
      return {
        moveSync, frameGaps,
        full: [...rec.full], snap: [...rec.snap], blit: [...rec.blit],
        panX: store.getState().view.panX,
      };
    }

    const fast = await gesture();

    // Reset the view, then run the SAME gesture with the fast path unavailable.
    // renderScheduler's pan branch falls through to callRender when
    // renderPanBackground is missing, which is exactly the pre-existing behaviour.
    store.getState().setView({ panX: 0, panY: 0 });
    await new Promise((r) => setTimeout(r, 600));
    const realSnap = window.renderPanBackground;
    window.renderPanBackground = undefined;
    const off = await gesture();
    window.renderPanBackground = realSnap;

    return { fast, off, strandCount: store.getState().doc.order.length };
  }, { project, moves: MOVES });

  out.errors = errors;
} finally {
  await browser.close().catch(() => {});
  await server.close();
}

function summarize(g) {
  return {
    frame_median_ms: +median(g.frameGaps).toFixed(2),
    frame_p95_ms: +pct(g.frameGaps, 0.95).toFixed(2),
    fps_median: +(1000 / Math.max(0.001, median(g.frameGaps))).toFixed(1),
    move_sync_median_ms: +median(g.moveSync).toFixed(3),
    gesture_total_ms: +sum(g.frameGaps).toFixed(1),
    full_renders: g.full.length,
    full_render_total_ms: +sum(g.full).toFixed(1),
    snapshots: g.snap.length,
    snapshot_median_ms: +median(g.snap).toFixed(1),
    blits: g.blit.length,
    blit_median_ms: +median(g.blit).toFixed(3),
  };
}

const report = {
  label: LABEL,
  strands: out.strandCount,
  moves: MOVES,
  fast: summarize(out.fast),
  off: summarize(out.off),
  errors: out.errors,
};
report.speedup_fps = +(report.fast.fps_median / Math.max(0.001, report.off.fps_median)).toFixed(1);
report.speedup_gesture = +(report.off.gesture_total_ms / Math.max(0.001, report.fast.gesture_total_ms)).toFixed(1);

const pad = (s, n) => String(s).padEnd(n);
console.log(`\npan benchmark — ${report.label}, ${report.strands} strands, ${MOVES} moves\n`);
console.log(`${pad('', 26)}${pad('fast path', 14)}off (before)`);
for (const k of Object.keys(report.fast)) {
  console.log(`${pad(k, 26)}${pad(report.fast[k], 14)}${report.off[k]}`);
}
console.log(`\nmedian fps ${report.speedup_fps}x better; whole gesture ${report.speedup_gesture}x faster`);
if (out.errors.length) console.log('\npage errors:', out.errors.slice(0, 5));

if (JSON_OUT) {
  writeFileSync(path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(root, JSON_OUT), JSON.stringify(report, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
process.exit(out.errors.length ? 1 : 0);
