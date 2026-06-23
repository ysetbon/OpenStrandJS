// Compare the JS editor's "State" dialog data against the ORIGINAL OpenStrand
// Studio's get_layer_connections for several scenarios (incl. a mask). Builds each
// scenario in the live editor via __actions, reads the REAL State dialog DOM
// (connections + positions), serializes the doc to a fixture, runs
// tools/oss_layer_state.py on that fixture, and diffs the two.
//
// Usage: node tools/compare_layer_state.mjs [editorURL]   (default :5178)

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'artifacts', 'layer_state');
mkdirSync(outDir, { recursive: true });
const url = process.argv[2] || 'http://localhost:5178/';
const PY = path.join(root, '..', 'OpenStrandStudio', 'src', 'build_env', 'Scripts', 'python.exe');
const closedKnot = JSON.parse(readFileSync(path.join(root, 'fixtures', 'closed_knot.json'), 'utf8'));

const browser = await chromium.launch();
let results;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__store && !!window.__actions && !!window.__io, null, { timeout: 10000 });

  results = await page.evaluate(async (knot) => {
    const store = window.__store, A = window.__actions, io = window.__io;
    const st = () => store.getState();
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const reset = (d) => { d.strands = {}; d.order = []; d.groups = {}; d.locked_layers = []; d.selected_strand_name = null; };

    const scenarios = {
      single: (d) => { reset(d); A.addNewStrand(d, { x: 200, y: 300 }, { x: 500, y: 300 }); },
      attached: (d) => {
        reset(d);
        A.addNewStrand(d, { x: 200, y: 300 }, { x: 500, y: 300 });        // 1_1
        A.attachChild(d, '1_1', 1, { x: 500, y: 300 }, { x: 700, y: 150 }); // 1_2 @ 1_1.end
      },
      branch: (d) => {
        reset(d);
        A.addNewStrand(d, { x: 300, y: 320 }, { x: 600, y: 320 });        // 1_1
        A.attachChild(d, '1_1', 0, { x: 300, y: 320 }, { x: 160, y: 160 }); // 1_2 @ 1_1.start
        A.attachChild(d, '1_1', 1, { x: 600, y: 320 }, { x: 760, y: 160 }); // 1_3 @ 1_1.end
      },
      mask: (d) => {
        reset(d);
        A.addNewStrand(d, { x: 200, y: 300 }, { x: 500, y: 300 });   // 1_1 (set 1)
        A.addNewStrand(d, { x: 350, y: 150 }, { x: 350, y: 450 });   // 2_1 (set 2)
        A.createMask(d, '1_1', '2_1');                               // mask 1_1_2_1
      },
    };

    // Open the State dialog once; it re-renders reactively as the doc changes.
    st().mutateDoc(scenarios.single);
    await raf();
    document.querySelector('.tb-state').click();
    await raf();

    const readDialog = () => {
      const conns = {}, positions = {};
      document.querySelectorAll('.layer-state-log .layer-state-row').forEach((row) => {
        const name = row.querySelector('.ls-name')?.textContent;
        const c = row.querySelector('.ls-conn');
        const p = row.querySelector('.ls-pos');
        if (name && c) conns[name] = c.textContent;
        if (name && p) positions[name] = p.textContent;
      });
      return { conns, positions };
    };

    const out = {};
    const order = ['single', 'attached', 'branch', 'mask', 'knot'];
    for (const name of order) {
      if (name === 'knot') {
        const doc = io.loadProject(knot);
        st().setDoc(doc);
      } else {
        st().mutateDoc(scenarios[name]);
      }
      await raf();
      const { conns, positions } = readDialog();
      const serialized = io.serializeProject(st().doc);
      out[name] = { conns, positions, serialized, selected: st().doc.selected_strand_name };
    }
    return out;
  }, closedKnot);
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}

// --- parse helpers ---
const parseJsConn = (txt) => txt.replace(/[[\]]/g, '').split(', ').map((s) => s.trim()); // "[a, b]" -> [a,b]
const parseJsPos = (txt) => (txt.match(/-?\d+/g) || []).map(Number);                       // "(x, y) -> (x, y)"
const ossPosKey = (arr) => arr.join(',');

let pass = 0, fail = 0;
const lines = [];
for (const name of ['single', 'attached', 'branch', 'mask', 'knot']) {
  const r = results[name];
  const fixturePath = path.join(outDir, `state_${name}.json`);
  writeFileSync(fixturePath, JSON.stringify(r.serialized, null, 2));
  let oss;
  try {
    oss = JSON.parse(execFileSync(PY, [path.join(here, 'oss_layer_state.py'), fixturePath], { encoding: 'utf8' }).trim().split('\n').pop());
  } catch (e) {
    lines.push(`\n## ${name}: OSS harness FAILED — ${String(e.message).slice(0, 200)}`);
    fail++;
    continue;
  }

  // Compare connections (skip masked layers — OSS excludes them).
  const jsConn = {}; for (const k of Object.keys(r.conns)) jsConn[k] = parseJsConn(r.conns[k]);
  const ossConn = oss.connections;
  const layers = [...new Set([...Object.keys(jsConn), ...Object.keys(ossConn)])].sort();
  const connDiffs = [];
  for (const l of layers) {
    const a = (ossConn[l] || []).join(' | ');
    const b = (jsConn[l] || []).join(' | ');
    if (a !== b) connDiffs.push(`    ${l}: OSS[${a}]  JS[${b}]`);
  }

  // Compare positions.
  const posDiffs = [];
  for (const l of Object.keys(oss.positions)) {
    const a = ossPosKey(oss.positions[l]);
    const b = r.positions[l] ? ossPosKey(parseJsPos(r.positions[l])) : '(missing)';
    if (a !== b) posDiffs.push(`    ${l}: OSS(${a}) JS(${b})`);
  }

  const maskMatch = JSON.stringify(oss.masked_layers.sort()) ===
    JSON.stringify(r.serialized.strands.filter((s) => s.type === 'MaskedStrand').map((s) => s.layer_name).sort());

  const ok = connDiffs.length === 0 && posDiffs.length === 0 && maskMatch;
  ok ? pass++ : fail++;
  lines.push(`\n## ${name}: ${ok ? 'PASS ✓' : 'MISMATCH ✗'}`);
  lines.push(`   order  OSS ${JSON.stringify(oss.order)}`);
  lines.push(`   conns  OSS ${JSON.stringify(ossConn)}`);
  lines.push(`   conns  JS  ${JSON.stringify(jsConn)}`);
  lines.push(`   masks  OSS ${JSON.stringify(oss.masked_layers)}  (match=${maskMatch})`);
  if (connDiffs.length) lines.push('   CONNECTION DIFFS:\n' + connDiffs.join('\n'));
  if (posDiffs.length) lines.push('   POSITION DIFFS:\n' + posDiffs.join('\n'));
}

console.log(lines.join('\n'));
console.log(`\n=== ${pass} PASS / ${fail} FAIL (of ${pass + fail}) ===`);
process.exit(fail ? 1 : 0);
