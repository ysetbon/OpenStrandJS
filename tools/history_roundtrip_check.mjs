#!/usr/bin/env node
// JS-side round trip of the OpenStrandStudioHistory wrapper:
//   loadProjectFile(file) -> serializeHistory(past, present, future) -> loadProjectFile
// must reproduce the same stack (documents, step numbers, current step, and the
// undo_metadata of every step), and the wrapper must have the shape
// undo_redo_manager.export_history writes.
//
//   node tools/history_roundtrip_check.mjs <file.json> [...more]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: history_roundtrip_check.mjs <file.json>...'); process.exit(2); }

const work = mkdtempSync(join(tmpdir(), 'ossjs-history-'));
const bundle = join(work, 'saveLoad.mjs');
const esb = spawnSync(join(root, 'node_modules', '.bin', 'esbuild'), [
  join(root, 'src', 'io', 'saveLoad.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`,
], { stdio: 'inherit' });
if (esb.status !== 0) process.exit(esb.status ?? 1);
const io = await import(pathToFileURL(bundle).href);

// This checks the WRAPPER mechanics (steps, current step, metadata, stack
// order), so the curvature-bias setting is held OFF: with it on, OSS's loader
// re-derives an unlocked centre (update_shape) after placing the bias squares
// from the centre as loaded, so a second load of the saved file legitimately
// re-places the squares — the same two-load drift the desktop shows.
const OPTS = { enable_curvature_bias_control: false };
// Compare documents by what they SAVE as: the first load of an older file
// leaves defaults implicit in `extra`, the second (of the freshly written
// wrapper) has them explicit — the same drawing either way.
const strip = (doc) => JSON.parse(JSON.stringify(io.serializeProject(doc, OPTS)));
let failures = 0;
for (const file of files) {
  try {
    const raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
    const a = io.loadProjectFile(raw, OPTS);
    const wrapper = io.serializeHistory(a.past, { doc: a.doc, meta: a.presentMeta }, a.future, OPTS);

    // export_history shape and key order.
    assert.deepEqual(Object.keys(wrapper), ['type', 'version', 'current_step', 'max_step', 'states']);
    assert.equal(wrapper.type, 'OpenStrandStudioHistory');
    assert.equal(wrapper.version, 1);
    assert.equal(wrapper.max_step, wrapper.states.length);
    wrapper.states.forEach((s, i) => {
      assert.deepEqual(Object.keys(s), ['step', 'data']);
      assert.equal(s.step, i + 1);
      const keys = Object.keys(s.data);
      const expectedKeys = ['strands', 'groups', 'strand_colors', 'selected_strand_name', 'locked_layers',
        'lock_mode', 'shadow_enabled', 'show_control_points', 'shadow_overrides'];
      if ('undo_metadata' in s.data) {
        expectedKeys.push('undo_metadata');
        assert.deepEqual(Object.keys(s.data.undo_metadata), ['action', 'source', 'mode', 'targets', 'detail', 'origin', 'at']);
        assert.match(s.data.undo_metadata.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
      }
      assert.deepEqual(keys, expectedKeys);
    });
    if (raw.type === 'OpenStrandStudioHistory') {
      const srcStates = raw.states
        .filter((s) => s && typeof s.step === 'number' && s.data != null)
        .sort((x, y) => x.step - y.step);
      const srcCurrent = Math.min(
        Number.isInteger(raw.current_step) ? raw.current_step : srcStates.length, srcStates.length);
      // serializeHistory drops LEADING empty states (no strands, no groups) that
      // precede the current one — OSS never records those — so compare against
      // the source trimmed the same way.
      const isEmpty = (d) => !(d.strands?.length) && !Object.keys(d.groups ?? {}).length;
      let leading = 0;
      while (leading < srcCurrent - 1 && isEmpty(srcStates[leading].data)) leading++;
      const kept = srcStates.length === 1 && isEmpty(srcStates[0].data) ? 0 : srcStates.length - leading;
      assert.equal(wrapper.states.length, kept, 'every non-leading-empty source step is kept');
      assert.equal(wrapper.current_step, kept === 0 ? 0 : srcCurrent - leading);
    }

    // Second pass through the loader reproduces the stack exactly.
    const b = io.loadProjectFile(JSON.parse(JSON.stringify(wrapper)), OPTS);
    assert.equal(b.past.length, a.past.length);
    assert.equal(b.future.length, a.future.length);
    assert.deepEqual(strip(b.doc), strip(a.doc));
    a.past.forEach((e, i) => assert.deepEqual(strip(b.past[i].doc), strip(e.doc), `past[${i}]`));
    a.future.forEach((e, i) => assert.deepEqual(strip(b.future[i].doc), strip(e.doc), `future[${i}]`));
    const sameMeta = (x, y) => assert.deepEqual(
      x && { ...x, at: Math.floor(x.at / 1000) }, y && { ...y, at: Math.floor(y.at / 1000) });
    sameMeta(b.presentMeta, a.presentMeta);
    a.past.forEach((e, i) => sameMeta(b.past[i].meta, e.meta));
    a.future.forEach((e, i) => sameMeta(b.future[i].meta, e.meta));

    // And a third serialization is byte-identical to the second.
    const again = io.serializeHistory(b.past, { doc: b.doc, meta: b.presentMeta }, b.future, OPTS);
    const norm = (w) => JSON.stringify(w, (k, v) => (k === 'at' ? undefined : v));
    assert.equal(norm(again), norm(wrapper));

    writeFileSync(join(work, 'roundtrip.json'), JSON.stringify(wrapper, null, 2));
    console.log(`OK   ${file}  (${wrapper.states.length} steps, current ${wrapper.current_step}, ` +
      `${a.doc.order.length} strands at current)`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${file}: ${err.message}`);
  }
}
process.exit(failures ? 1 : 0);
