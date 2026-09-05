// Layer panel vs. move-mode drag: the highlighted layer button must not move.
//
// OSS move_mode writes canvas.selected_* directly and never calls
// canvas.select_strand() — the only path into layer_panel.select_layer() — so a
// drag never touches the layer panel: the button that was checked before the
// press is still the one checked mid-drag, after release, and after undo. The
// canvas highlight, by contrast, DOES follow the grabbed strand for the duration
// of the drag (canvas.selected_attached_strand = temp_selected_strand).
//
// This drives one real gesture in the editor and checks both halves of that
// contract via the DOM (aria-pressed on .nlb) and the store, at every phase:
//
//   p0  strand A selected (the real selection — same path as a button click)
//   p1  pointer-down on a handle of some OTHER strand B, in move mode
//   p2  after dragging it
//   p3  after release
//   p4  after undo
//   p5  after redo
//
// It asserts on node identity — the .nlb that is pressed at p0 must be the very
// same node at p1..p4 — so it needs no DOM<->layer-name mapping and cannot be
// fooled by a button being repainted with the same text.
//
// Usage:
//   node tools/layer_panel_drag_check.mjs [--fixture name] [--baseline <checkout-dir>]
//
// With --baseline the same gesture is also driven against that checkout and
// printed alongside, to show the behaviour being fixed; only the working tree
// decides the exit code.
//
// OSS_CHROMIUM: absolute path to a Chromium binary if the pre-installed browser
// revision does not match this Playwright version.

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const FIXTURE = arg('fixture', 'overhand_knot');
const BASELINE = arg('baseline', '');

function loadProjectJson(name) {
  const raw = JSON.parse(readFileSync(path.join(root, 'fixtures', `${name}.json`), 'utf8'));
  return raw && raw.type === 'OpenStrandStudioHistory'
    ? ((raw.states || []).find((s) => s.step === raw.current_step) || raw.states[0]).data
    : raw;
}
const project = loadProjectJson(FIXTURE);

async function boot(dir, port) {
  const server = await createServer({
    root: dir, configFile: path.join(dir, 'vite.config.ts'),
    server: { port, open: false, host: '127.0.0.1' }, logLevel: 'error',
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function openPage(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 30000 });
  return { page, errors };
}

// Drives the gesture and returns one snapshot per phase. Never throws on a
// behavioural failure — it reports, and the caller judges — so a baseline that
// misbehaves still yields a full table.
const RUN = async (page, project) => page.evaluate(async ({ project }) => {
  const store = window.__store;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) await nextFrame(); };

  store.getState().loadDocument(window.__io.loadProject(project));
  store.getState().setSettings({
    show_grid: false, snap_to_grid_enabled: true, theme: 'default',
    move_selected_only: false, show_cp_selected_only: false,
  });
  store.getState().setMode('select');
  await settle(20);

  const st0 = store.getState();
  const plain = st0.doc.order.filter((n) => st0.doc.strands[n]?.type !== 'MaskedStrand');
  if (plain.length < 2) return { error: `fixture has ${plain.length} plain strand(s); need >= 2` };
  const A = plain[0];

  // The real selection: what a layer-button click does.
  store.getState().setSelection({ layerName: A, handle: null });
  store.getState().setMode('move');
  await settle(10);

  // A handle that move mode will resolve to a strand other than A. moveGrab is
  // what pointer-down runs, so asking it directly avoids guessing joint roots.
  const st = store.getState();
  const hit = window.__hit;
  let target = null;
  const handles = (s) => [
    ['end', s.end], ['start', s.start],
    ['control_point1', s.control_points?.[0]], ['control_point2', s.control_points?.[1]],
  ];
  outer: for (const n of plain.slice(1)) {
    const s = st.doc.strands[n];
    for (const [, w] of handles(s)) {
      if (!w) continue;
      if (hit) {
        const g = hit.moveGrab(w, st.doc, st.settings, st.docRevision);
        if (g && g.layerName !== A) { target = { world: w, expect: g.layerName }; break outer; }
      } else {
        target = { world: w, expect: null }; break outer;
      }
    }
  }
  if (!target) return { error: `no handle on a strand other than ${A} is grabbable in move mode` };

  const el = document.getElementById('c');
  const rect = el.getBoundingClientRect();
  const view = store.getState().view;
  const sx = rect.width / Math.max(1, el.width);
  const sy = rect.height / Math.max(1, el.height);
  const toClient = (w) => ({
    x: rect.left + (w.x * view.zoom + view.panX) * sx,
    y: rect.top + (w.y * view.zoom + view.panY) * sy,
  });
  const ev = (type, x, y) => new PointerEvent(type, {
    pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
    clientX: x, clientY: y,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
  });

  const snap = (phase) => {
    const s = store.getState();
    const nodes = [...document.querySelectorAll('.nlb')];
    const pressed = nodes.filter((n) => n.getAttribute('aria-pressed') === 'true');
    return {
      phase,
      storeSel: s.selection.layerName,
      docSel: s.doc.selected_strand_name,
      pressedCount: pressed.length,
      pressedIdx: pressed.length ? nodes.indexOf(pressed[0]) : -1,
      pressedText: pressed.length ? pressed[0].textContent.trim().slice(0, 12) : '',
    };
  };

  const out = { A, expectGrab: target.expect, phases: [] };
  out.phases.push(snap('p0 selected A'));

  const p0 = toClient(target.world);
  el.dispatchEvent(ev('pointerdown', p0.x, p0.y));
  await settle(6);
  out.phases.push(snap('p1 pointer-down on B'));

  for (const [dx, dy] of [[30, 20], [60, 35]]) {
    el.dispatchEvent(ev('pointermove', p0.x + dx, p0.y + dy));
    await settle(4);
  }
  out.phases.push(snap('p2 dragged'));

  el.dispatchEvent(ev('pointerup', p0.x + 60, p0.y + 35));
  await settle(20);
  out.phases.push(snap('p3 released'));

  store.getState().undo();
  await settle(20);
  out.phases.push(snap('p4 undone'));
  store.getState().redo();
  await settle(20);
  out.phases.push(snap('p5 redone'));

  return out;
}, { project });

function judge(r) {
  const bad = [];
  if (r.error) return [r.error];
  const [p0, p1, , p3, p4, p5] = r.phases;
  for (const p of r.phases) {
    if (p.pressedCount !== 1) bad.push(`${p.phase}: ${p.pressedCount} layer buttons pressed (want exactly 1)`);
    if (p.pressedIdx !== p0.pressedIdx) bad.push(`${p.phase}: pressed layer button moved (node #${p0.pressedIdx} -> #${p.pressedIdx})`);
    if (p.docSel !== r.A) bad.push(`${p.phase}: doc.selected_strand_name is ${p.docSel}, want ${r.A}`);
  }
  if (p1.storeSel === r.A) bad.push(`p1: grab did not land on another strand (canvas selection still ${r.A}) — setup problem`);
  if (r.expectGrab && p1.storeSel !== r.expectGrab) bad.push(`p1: canvas selection is ${p1.storeSel}, moveGrab predicted ${r.expectGrab}`);
  if (p3.storeSel !== r.A) bad.push(`p3: canvas selection not restored to ${r.A} on release (is ${p3.storeSel})`);
  if (p4.storeSel !== r.A) bad.push(`p4: canvas selection after undo is ${p4.storeSel}, want ${r.A}`);
  if (p5.storeSel !== r.A) bad.push(`p5: canvas selection after redo is ${p5.storeSel}, want ${r.A}`);
  return bad;
}

function table(label, r) {
  console.log(`\n${label}`);
  if (r.error) { console.log(`  ERROR: ${r.error}`); return; }
  console.log(`  A=${r.A}  grab expected on=${r.expectGrab ?? '?'}`);
  console.log('  ' + 'phase'.padEnd(22) + 'canvas sel'.padEnd(12) + 'panel sel'.padEnd(12) + 'pressed#'.padEnd(10) + 'node'.padEnd(6) + 'text');
  for (const p of r.phases) {
    console.log('  ' + p.phase.padEnd(22) + String(p.storeSel).padEnd(12) + String(p.docSel).padEnd(12)
      + String(p.pressedCount).padEnd(10) + String(p.pressedIdx).padEnd(6) + p.pressedText);
  }
}

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});

let work, base, exit = 0;
try {
  work = await boot(root, 5303);
  const w = await openPage(browser, work.url);
  const rw = await RUN(w.page, project);
  table(`working tree — ${FIXTURE}`, rw);
  const bad = judge(rw);
  if (w.errors.length) bad.push(...w.errors.map((e) => `page error: ${e}`));
  console.log(bad.length ? `\n  FAIL\n    - ${bad.join('\n    - ')}` : '\n  ok  layer button stayed put; canvas highlight followed the drag and reverted');
  if (bad.length) exit = 1;

  if (BASELINE) {
    base = await boot(BASELINE, 5304);
    const b = await openPage(browser, base.url);
    const rb = await RUN(b.page, project);
    table(`baseline (${BASELINE}) — ${FIXTURE}`, rb);
    const bbad = judge(rb);
    console.log(bbad.length ? `\n  (baseline) differs:\n    - ${bbad.join('\n    - ')}` : '\n  (baseline) ok');
  }
} finally {
  await browser.close();
  await work?.server.close();
  await base?.server.close();
}
process.exit(exit);
