#!/usr/bin/env node
// Save of a project whose history came from a file (OSS 2.0, keep_masks_on_top).
//
// OpenStrand Studio keeps every step of an opened history file as its own temp
// state file and File > Save (export_history_payload) copies those files back
// out verbatim. Since 2.0 the CANVAS has every mask above every strand
// (load_strands -> keep_masks_on_top, 45d6f1f), but the stored steps keep the
// file's order. This drives the real editor store through Open / Undo / Redo /
// an edit and checks what Save writes:
//
//   - a step that came from the file is written exactly as it was stored;
//   - the canvas has the masks on top, and a new state is saved in that order;
//   - an edit after an undo drops the redo steps and keeps the stored ones;
//   - a mask loaded as an undo state keeps the centre MaskedStrand computed /
//     the file carried (no apply_loaded_strands pass on that path).
//
// With --oss it also runs the real OpenStrand Studio (tools/oss_history_export_oracle.py,
// PyQt5 + OSS_ROOT) and checks that every step OSS keeps from the file is
// byte-identical to what the JS store writes, and that the canvas OSS captures
// on export has the same layer order as the JS canvas.
//
//   node tools/history_export_check.mjs [--oss]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const withOss = process.argv.includes('--oss');
const FIXTURE = join(root, 'fixtures', 'history_mask_below.json');

const work = mkdtempSync(join(tmpdir(), 'ossjs-history-export-'));
const entry = join(work, 'entry.ts');
writeFileSync(entry, [
  `export { useEditorStore } from ${JSON.stringify(join(root, 'src', 'store', 'editorStore.ts'))};`,
  `export { loadProjectFile, serializeHistory, serializeProject } from ${JSON.stringify(join(root, 'src', 'io', 'saveLoad.ts'))};`,
].join('\n'));
const bundle = join(work, 'bundle.mjs');
const esb = spawnSync(join(root, 'node_modules', '.bin', 'esbuild'), [
  entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`,
  '--loader:.css=empty', '--define:import.meta.env.DEV=false', '--log-level=error',
], { stdio: 'inherit' });
if (esb.status !== 0) process.exit(esb.status ?? 1);
const io = await import(pathToFileURL(bundle).href);
const store = io.useEditorStore;

const OPTS = { enable_curvature_bias_control: false };
const file = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const fileStates = file.states.map((s) => s.data);
const isMask = (s) => s.type === 'MaskedStrand';
const names = (state) => state.strands.map((s) => s.layer_name);
const masksOnTop = (order, strands) => {
  const firstMask = order.findIndex((n) => strands[n]?.type === 'MaskedStrand');
  return firstMask < 0 || order.slice(firstMask).every((n) => strands[n]?.type === 'MaskedStrand');
};

// What Save writes for the live store (Toolbar.onSave).
const save = () => {
  const st = store.getState();
  return io.serializeHistory(st.past, { doc: st.doc, meta: st.presentMeta, raw: st.presentRaw }, st.future, OPTS);
};
const open = (json) => store.getState().loadDocumentWithHistory(io.loadProjectFile(json, OPTS));

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (err) { failures++; console.log(`FAIL  ${label}\n      ${err.message.split('\n').slice(0, 6).join('\n      ')}`); }
};

check('the fixture has a mask below a strand', () => {
  const st = fileStates[1];
  const firstMask = st.strands.findIndex(isMask);
  assert.ok(firstMask >= 0 && st.strands.slice(firstMask).some((s) => !isMask(s)));
});

open(file);
check('Open: the canvas has every mask above every strand', () => {
  const { doc } = store.getState();
  assert.ok(masksOnTop(doc.order, doc.strands), doc.order.join(' '));
});
check('Open -> Save: every step is written exactly as stored', () => {
  const w = save();
  assert.equal(w.current_step, file.current_step);
  assert.equal(w.max_step, fileStates.length);
  w.states.forEach((s, i) => assert.deepEqual(s.data, fileStates[i], `step ${i + 1}`));
});

store.getState().undo();
check('Undo -> Save: still every step as stored, current step one back', () => {
  const w = save();
  assert.equal(w.current_step, file.current_step - 1);
  w.states.forEach((s, i) => assert.deepEqual(s.data, fileStates[i], `step ${i + 1}`));
  const { doc } = store.getState();
  assert.ok(masksOnTop(doc.order, doc.strands), 'undo keeps the masks on top');
});
store.getState().redo();
store.getState().redo();
check('Redo, Redo -> Save: still every step as stored', () => {
  const w = save();
  assert.equal(w.current_step, fileStates.length);
  w.states.forEach((s, i) => assert.deepEqual(s.data, fileStates[i], `step ${i + 1}`));
});

open(file);
store.getState().undo();
store.getState().commitEdit((d) => { d.strands['2_1'].stroke_width = 9; }, { action: 'strand.width', source: 'panel' });
check('Undo, edit -> Save: stored steps kept, redo dropped, new state in canvas order', () => {
  const w = save();
  assert.equal(w.max_step, file.current_step);
  assert.equal(w.current_step, w.max_step);
  for (let i = 0; i < w.max_step - 1; i++) assert.deepEqual(w.states[i].data, fileStates[i], `step ${i + 1}`);
  const last = w.states[w.max_step - 1].data;
  const strandsByName = Object.fromEntries(last.strands.map((s) => [s.layer_name, s]));
  assert.ok(masksOnTop(names(last), strandsByName), names(last).join(' '));
  assert.equal(strandsByName['2_1'].stroke_width, 9);
});

check('a mask loaded as an undo state keeps its computed centre', () => {
  const loaded = io.loadProjectFile(file, OPTS);
  const out = io.serializeProject(loaded.doc, OPTS);
  const mask = out.strands.find(isMask);
  const start = mask.start;
  assert.ok(Math.hypot(mask.control_point_center.x - start.x, mask.control_point_center.y - start.y) > 1,
    `centre ${JSON.stringify(mask.control_point_center)} is not the start ${JSON.stringify(start)}`);
});

const snapshot = fileStates[1];
open(snapshot);
check('Open a bare project state -> Save: one step, masks on top, centre at the first start', () => {
  const w = save();
  assert.equal(w.max_step, 1);
  const st = w.states[0].data;
  const byName = Object.fromEntries(st.strands.map((s) => [s.layer_name, s]));
  assert.ok(masksOnTop(names(st), byName), names(st).join(' '));
  const mask = st.strands.find(isMask);
  assert.deepEqual(mask.control_point_center, byName['1_1'].start);
});

if (withOss) {
  const ossRoot = process.env.OSS_ROOT ?? resolve(root, '..', 'OpenStrandStudio');
  for (const ops of ['', 'undo', 'redo']) {
    const out = join(work, `oss_${ops || 'open'}.json`);
    const py = spawnSync('python3', [join(here, 'oss_history_export_oracle.py'), FIXTURE, out, '--bias', 'off',
      ...(ops ? ['--ops', ops] : [])], { encoding: 'utf8', env: { ...process.env, OSS_ROOT: ossRoot } });
    check(`OSS [${ops || 'open'}]: oracle runs`, () => assert.equal(py.status, 0, py.stderr));
    if (py.status !== 0) continue;
    const oss = JSON.parse(readFileSync(out, 'utf8'));
    open(file);
    if (ops === 'undo') store.getState().undo();
    if (ops === 'redo') store.getState().redo();
    const js = save();
    const captured = oss.states.at(-1)?.data?.undo_metadata?.detail === 'captured before exporting the history';
    const kept = captured ? oss.current_step - 1 : oss.current_step;
    check(`OSS [${ops || 'open'}]: the ${kept} step(s) OSS keeps from the file match the JS save byte for byte`, () => {
      for (let i = 0; i < kept; i++) assert.deepEqual(js.states[i].data, oss.states[i].data, `step ${i + 1}`);
    });
    if (captured) {
      check(`OSS [${ops || 'open'}]: the canvas OSS captures has the JS canvas's layer order`, () => {
        assert.deepEqual(names(oss.states.at(-1).data), store.getState().doc.order);
      });
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall history-export checks passed');
process.exit(failures ? 1 : 0);
