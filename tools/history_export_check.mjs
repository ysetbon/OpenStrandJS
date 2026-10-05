#!/usr/bin/env node
// Save of a project whose history came from a file (OSS 2.0, keep_masks_on_top).
//
// OpenStrand Studio keeps every step of an opened history file as its own temp
// state file and File > Save (export_history_payload) copies those files back
// out verbatim. Since 2.0 the CANVAS has every mask above every strand
// (load_strands -> keep_masks_on_top, 45d6f1f), but the stored steps keep the
// file's order. Before copying them, Save records the live canvas as one more
// step ("captured before exporting the history") whenever the current state is
// one it imported, and drops the redo steps. This drives the real editor store
// through Open / Undo / Redo / an edit and checks what Save writes:
//
//   - the stored steps up to the current one are written exactly as stored;
//   - the live canvas follows as the captured step, in canvas order (masks on
//     top), carrying changes that made no undo step (selection, shadows);
//   - after an edit the new state is saved as usual and nothing is captured;
//   - an in-place edit never reaches a stored step;
//   - a mask loaded as an undo state keeps the centre MaskedStrand computed /
//     the file carried (no apply_loaded_strands pass on that path).
//
// With --oss it also runs the real OpenStrand Studio (tools/oss_history_export_oracle.py,
// PyQt5 + OSS_ROOT) and checks that OSS captures too, with the same step
// counts, that every step OSS keeps from the file is byte-identical to what the
// JS store writes, and that the captured canvas has the same layer order.
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
// A save-path fixture, kept out of the top-level render corpus (pan_fidelity,
// fidelity_run and friends sweep fixtures/*.json).
const FIXTURE = join(root, 'fixtures', 'history', 'history_mask_below.json');

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

// What Save writes for the live store (Toolbar.onSave): the file is built from
// historyForExport(), and the capture is applied once the file was written
// (`written` false = the user cancelled the dialog).
const save = (written = true) => {
  const h = store.getState().historyForExport();
  const out = io.serializeHistory(h.past, h.present, h.future, OPTS);
  if (written && h.capture) store.getState().captureForExport(h.capture);
  return out;
};
// Every Open parses its own copy, as the app does; the checks compare against
// the untouched `fileStates`.
const open = (json) => store.getState().loadDocumentWithHistory(io.loadProjectFile(JSON.parse(JSON.stringify(json)), OPTS));
const CAPTURED = 'captured before exporting the history';

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (err) { failures++; console.log(`FAIL  ${label}\n      ${err.message.split('\n').slice(0, 6).join('\n      ')}`); }
};

// Save of a state that came from the file: the stored steps up to it, verbatim,
// then the live canvas as one more step; the redo steps are gone.
const expectCaptured = (w, currentFromFile) => {
  assert.equal(w.max_step, currentFromFile + 1);
  assert.equal(w.current_step, w.max_step);
  for (let i = 0; i < currentFromFile; i++) assert.deepEqual(w.states[i].data, fileStates[i], `step ${i + 1}`);
  const last = w.states[w.max_step - 1].data;
  assert.equal(last.undo_metadata?.detail, CAPTURED);
  assert.equal(last.undo_metadata?.action, 'system.setting');
  const byName = Object.fromEntries(last.strands.map((st) => [st.layer_name, st]));
  assert.ok(masksOnTop(names(last), byName), `captured step in canvas order: ${names(last).join(' ')}`);
  return last;
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
check('Open -> Save: stored steps verbatim, the canvas captured, redo dropped', () => {
  expectCaptured(save(), file.current_step);
});
check('Save again: nothing more to capture, the same file', () => {
  const again = save();
  assert.equal(again.max_step, file.current_step + 1);
});

open(file);
store.getState().setDoc({ ...store.getState().doc, selected_strand_name: '3_1', shadow_enabled: false });
check('Open, change selection and shadows (no undo step) -> Save: the capture carries them', () => {
  const last = expectCaptured(save(), file.current_step);
  assert.equal(last.selected_strand_name, '3_1');
  assert.equal(last.shadow_enabled, false);
});

open(file);
store.getState().undo();
check('Undo -> Save: steps up to the undone-to one verbatim, then the capture', () => {
  expectCaptured(save(), file.current_step - 1);
});

open(file);
store.getState().redo();
check('Redo -> Save: every step verbatim, then the capture', () => {
  expectCaptured(save(), fileStates.length);
});

open(file);
store.getState().undo();
store.getState().commitEdit((d) => { d.strands['2_1'].stroke_width = 9; }, { action: 'strand.width', source: 'panel' });
check('Undo, edit -> Save: stored steps kept, redo dropped, new state in canvas order, no capture', () => {
  const w = save();
  assert.equal(w.max_step, file.current_step);
  assert.equal(w.current_step, w.max_step);
  for (let i = 0; i < w.max_step - 1; i++) assert.deepEqual(w.states[i].data, fileStates[i], `step ${i + 1}`);
  const last = w.states[w.max_step - 1].data;
  assert.notEqual(last.undo_metadata?.detail, CAPTURED);
  const strandsByName = Object.fromEntries(last.strands.map((s) => [s.layer_name, s]));
  assert.ok(masksOnTop(names(last), strandsByName), names(last).join(' '));
  assert.equal(strandsByName['2_1'].stroke_width, 9);
});

open(file);
check('Save cancelled: the history is untouched (redo kept, nothing captured)', () => {
  const before = store.getState();
  save(false);
  const after = store.getState();
  assert.equal(after.future.length, before.future.length);
  assert.ok(after.future.length > 0, 'the fixture has redo steps here');
  assert.equal(after.past, before.past);
  assert.equal(after.presentRaw, before.presentRaw);
});

open(file);
save();
check('after Save, a drag never changes the captured undo step', () => {
  const st = store.getState();
  const stored = JSON.stringify(st.past.at(-1).doc);
  st.beginGesture();
  store.getState().mutateDocLive((d) => { d.strands['1_1'].start.x += 25; });
  store.getState().commit();
  store.getState().undo();
  store.getState().undo();
  assert.equal(JSON.stringify(store.getState().doc.strands['1_1'].start),
    JSON.stringify(JSON.parse(stored).strands['1_1'].start));
});

open(file);
check('an edit never reaches a stored step (the stored data is a copy)', () => {
  const st = store.getState();
  const maskName = st.doc.order.find((n) => st.doc.strands[n].type === 'MaskedStrand');
  // A drag: beginGesture, then mutateDocLive edits the document in place
  // (trackMaskDeletionRects moves rectangles in place on every frame).
  st.beginGesture();
  store.getState().mutateDocLive((d) => {
    const m = d.strands[maskName];
    (m.deletion_rectangles ??= []).push({ top_left: [0, 0], top_right: [1, 0], bottom_left: [0, 1], bottom_right: [1, 1] });
  });
  assert.deepEqual(store.getState().presentRaw, fileStates[file.current_step - 1]);
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
    const ossCaptured = oss.states.at(-1)?.data?.undo_metadata?.detail === CAPTURED;
    check(`OSS [${ops || 'open'}]: OSS captures the canvas on Save, as the JS store does`, () => {
      assert.ok(ossCaptured, 'OSS wrote no capture step');
      assert.equal(js.max_step, oss.max_step);
      assert.equal(js.current_step, oss.current_step);
    });
    check(`OSS [${ops || 'open'}]: the ${oss.current_step - 1} step(s) OSS keeps from the file match the JS save byte for byte`, () => {
      for (let i = 0; i < oss.current_step - 1; i++) assert.deepEqual(js.states[i].data, oss.states[i].data, `step ${i + 1}`);
    });
    check(`OSS [${ops || 'open'}]: the captured canvas has the JS canvas's layer order`, () => {
      assert.deepEqual(names(oss.states.at(-1).data), names(js.states.at(-1).data));
    });
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall history-export checks passed');
process.exit(failures ? 1 : 0);
