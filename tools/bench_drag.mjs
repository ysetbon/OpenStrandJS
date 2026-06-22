// Per-frame render cost benchmark for the drag fast-path.
//
// During an endpoint drag every frame calls window.renderFixture. This script
// times renderFixture for representative fixtures under two metas:
//   FULL  = supersample:2, shadow_enabled:true   (the pre-fix per-move cost)
//   DRAFT = supersample:1, shadow_enabled:false   (the during-drag cost after
//                                                   the renderScheduler change)
// It reports median / p95 ms and the speedup, isolating exactly what the
// draft-mode-while-dragging change does to the per-frame render cost.
//
// Usage: node tools/bench_drag.mjs [iterations]   (default 40)

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ITERS = Number(process.argv[2] || 40);

// fixture file -> artifact dir (for reference.meta.json sizing). We also force a
// busy + shadowed worst case by toggling shadows on regardless of the fixture's
// stored flag, so the benchmark reflects a heavy drag, not a trivial one.
const CASES = [
  { fixture: 'fixtures/single_strand.json', art: 'single_strand', label: '1 strand' },
  { fixture: 'fixtures/overhand_knot.json', art: 'overhand_knot', label: '5 strands +shadow+mask' },
  { fixture: 'fixtures/three_strand_braid.json', art: 'three_strand_braid', label: '18 strands +3 masks' },
];

function loadStrands(fixturePath) {
  const data = JSON.parse(readFileSync(path.join(root, fixturePath), 'utf8'));
  if (data && data.type === 'OpenStrandStudioHistory') {
    const state = data.states.find((s) => s.step === data.current_step);
    return state ? state.data.strands : [];
  }
  return data.strands || [];
}

function loadMeta(art) {
  const p = path.join(root, 'artifacts', art, 'reference.meta.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  // Fallback sizing if no reference exists.
  return { image_width: 1000, image_height: 700, x_offset: 0, y_offset: 0, supersample: 2, curve_params: { base_fraction: 1, dist_multiplier: 2, exponent: 2 } };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const url = pathToFileURL(path.join(root, 'web', 'render.html')).href + '?v=' + process.pid;
  await page.goto(url);
  await page.waitForFunction(() => typeof window.renderFixture === 'function');

  console.log(`\nPer-frame render cost — ${ITERS} iters each (median / p95 ms)\n`);
  console.log(
    'fixture'.padEnd(26),
    'FULL ss2+shadow'.padEnd(18),
    'DRAFT all/ss1'.padEnd(16),
    'iter2 bake'.padEnd(12),
    'iter2 /move'.padEnd(14),
    'move speedup',
  );
  console.log('-'.repeat(98));

  for (const c of CASES) {
    const strands = loadStrands(c.fixture);
    const baseMeta = loadMeta(c.art);

    const timeFull = (overrides) => page.evaluate(({ strands, meta, iters }) => {
      window.renderFixture(JSON.parse(JSON.stringify(strands)), meta); // warmup
      const times = [];
      for (let i = 0; i < iters; i++) {
        const s = JSON.parse(JSON.stringify(strands)); // renderFixture mutates has_circles
        const t0 = performance.now();
        window.renderFixture(s, meta);
        times.push(performance.now() - t0);
      }
      return times;
    }, { strands, meta: { ...baseMeta, ...overrides }, iters: ITERS });

    // iteration-2 drag path: bake once (static = all but the moving strand), then
    // time renderDragFrame per move. Moving set = the first regular strand.
    const drag = await page.evaluate(({ strands, meta, iters }) => {
      const moving = [(strands.find((s) => s.type !== 'MaskedStrand') || strands[0]).layer_name];
      const m = { ...meta, supersample: 1, shadow_enabled: false, drag: { moving } };
      // bake (median of a few — it is one-time per gesture but measure it cleanly)
      const bakeTimes = [];
      for (let i = 0; i < 5; i++) {
        const s = JSON.parse(JSON.stringify(strands));
        const t0 = performance.now();
        window.renderDragBackground(s, m);
        bakeTimes.push(performance.now() - t0);
      }
      // per-move frames (bake stays cached from the last bake above)
      const frameTimes = [];
      for (let i = 0; i < iters; i++) {
        const s = JSON.parse(JSON.stringify(strands));
        const t0 = performance.now();
        window.renderDragFrame(s, m);
        frameTimes.push(performance.now() - t0);
      }
      window.endDrag();
      return { bakeTimes, frameTimes, movingCount: moving.length };
    }, { strands, meta: baseMeta, iters: ITERS });

    const full = await timeFull({ supersample: 2, shadow_enabled: true });
    const draft = await timeFull({ supersample: 1, shadow_enabled: false });
    const mf = median(full), md = median(draft);
    const bake = median(drag.bakeTimes), frame = median(drag.frameTimes);
    console.log(
      `${c.label}`.padEnd(26),
      `${mf.toFixed(0)} / ${p95(full).toFixed(0)}`.padEnd(18),
      `${md.toFixed(0)} / ${p95(draft).toFixed(0)}`.padEnd(16),
      `${bake.toFixed(0)}`.padEnd(12),
      `${frame.toFixed(1)} / ${p95(drag.frameTimes).toFixed(1)}`.padEnd(14),
      `${(mf / frame).toFixed(0)}x vs full`,
    );
  }
  console.log('\n(iter2 /move = renderDragFrame: blit cached background + draw only the moving strand)');
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
process.exit(0);
