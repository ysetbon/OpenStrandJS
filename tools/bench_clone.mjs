// R1 measurement: per-pointermove document-clone cost, OLD vs NEW.
//
// During a drag, MoveMode.onPointerMove clones the document once per frame before
// the render. This micro-bench times the two clone strategies on the REAL fixtures,
// so the before/after is deterministic and needs no browser / dev server:
//
//   OLD (mutateDoc):            JSON.parse(JSON.stringify(doc))   — O(all strands)
//   NEW (mutateDocDuringDrag):  {...doc, strands:{...}} + structuredClone(moving)  — O(moving)
//
// It reports median / p95 ms for each and the speedup, for a few realistic moving-set
// sizes (1 = a control-point / single-endpoint drag, 3 = a welded junction). The NEW
// time should stay roughly flat as the scene grows while OLD scales with strand count.
//
// Usage: node tools/bench_clone.mjs [iterations]   (default 2000)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ITERS = Number(process.argv[2] || 2000);

const CASES = [
  { fixture: 'fixtures/single_strand.json', label: '1 strand' },
  { fixture: 'fixtures/overhand_knot.json', label: '5 strands +shadow+mask' },
  { fixture: 'fixtures/three_strand_braid.json', label: '18 strands +3 masks' },
];

// Mirror bench_drag.mjs's fixture loader (handles the OpenStrandStudioHistory wrapper).
function loadStrands(fixturePath) {
  const data = JSON.parse(readFileSync(path.join(root, fixturePath), 'utf8'));
  if (data && data.type === 'OpenStrandStudioHistory') {
    const state = data.states.find((s) => s.step === data.current_step);
    return state ? state.data.strands : [];
  }
  return data.strands || [];
}

// Build an EditorDocument-shaped object: strands as a name-keyed map + order array,
// matching the live store's doc so the clone volume is faithful.
function toDoc(strands) {
  const map = {};
  const order = [];
  for (const s of strands) {
    const name = s.layer_name ?? s.name ?? String(order.length);
    map[name] = s;
    order.push(name);
  }
  return {
    order, strands: map, groups: {}, selected_strand_name: null, locked_layers: [],
    lock_mode: false, shadow_enabled: true, show_control_points: true, shadow_overrides: {},
  };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
const fmt = (n) => n.toFixed(4).padStart(8);

// OLD: whole-doc JSON round-trip (editorStore.cloneDoc / mutateDoc).
function cloneOld(doc) {
  return JSON.parse(JSON.stringify(doc));
}

// NEW: structural share + per-moving-strand structuredClone (mutateDocDuringDrag).
function cloneNew(doc, moving) {
  const strands = { ...doc.strands };
  for (const n of moving) if (strands[n]) strands[n] = structuredClone(strands[n]);
  return { ...doc, strands };
}

function timeIt(fn) {
  // Warm up so JIT/GC settle before timing.
  for (let i = 0; i < 50; i++) fn();
  const samples = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    const out = fn();
    const t1 = performance.now();
    // Touch the result so the clone can't be optimized away.
    if (out === undefined) throw new Error('clone returned undefined');
    samples.push(t1 - t0);
  }
  return { median: median(samples), p95: p95(samples) };
}

console.log(`R1 clone-cost micro-bench  (iterations=${ITERS}, node ${process.version})\n`);
console.log('fixture                          movingN     OLD med    OLD p95     NEW med    NEW p95   speedup(med)');
console.log('-'.repeat(104));

for (const c of CASES) {
  const doc = toDoc(loadStrands(c.fixture));
  const names = doc.order;
  const old = timeIt(() => cloneOld(doc));
  const movingSets = [1, 3].filter((n) => n <= names.length);
  if (!movingSets.includes(names.length) && names.length < 3) movingSets.push(names.length);
  for (const m of [...new Set(movingSets)]) {
    const moving = names.slice(0, m);
    const neu = timeIt(() => cloneNew(doc, moving));
    const speedup = old.median / neu.median;
    const label = `${c.label} (${names.length})`.padEnd(32);
    console.log(`${label} ${String(m).padStart(7)}   ${fmt(old.median)}ms ${fmt(old.p95)}ms  ${fmt(neu.median)}ms ${fmt(neu.p95)}ms   ${speedup.toFixed(1)}x`);
  }
}
console.log('\nNEW (O(moving)) should stay ~flat as the scene grows; OLD scales with total strand count.');
