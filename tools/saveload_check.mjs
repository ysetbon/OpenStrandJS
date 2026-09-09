#!/usr/bin/env node
// Save/load parity check: the JS serializer against the Qt oracle.
//
// For each input, the OSS oracle (tools/oss_save_oracle.py) loads the project
// state and writes what OpenStrand Studio would save; the JS side loads the SAME
// state through loadProject and writes serializeProject. The two JSON trees are
// compared key by key, INCLUDING key order, and every difference is printed.
//
//   node tools/saveload_check.mjs [--bias on|off] [--all-steps] [--state] <file.json> [...more]
//
// --all-steps checks EVERY step of a history file (the JS side takes the step
// out of loadProjectFile's past/present/future, so the stack order is checked
// too). --state also compares the "State" dialog text (LayerStateManager) with
// what MainWindow.show_layer_state_log prints.
//
// Inputs may be bare project states or OpenStrandStudioHistory files (the
// current step is used). Requires python3 + PyQt5 (see oss_save_oracle.py).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
let bias = 'on';
const bi = args.indexOf('--bias');
if (bi >= 0) { bias = args[bi + 1]; args.splice(bi, 2); }
let allSteps = false;
const ai = args.indexOf('--all-steps');
if (ai >= 0) { allSteps = true; args.splice(ai, 1); }
let checkState = false;
const si = args.indexOf('--state');
if (si >= 0) { checkState = true; args.splice(si, 1); }
if (!args.length) { console.error('usage: saveload_check.mjs [--bias on|off] <file.json>...'); process.exit(2); }

// Bundle the TypeScript module once (esbuild ships with vite).
const work = mkdtempSync(join(tmpdir(), 'ossjs-saveload-'));
const bundle = join(work, 'saveLoad.mjs');
const entry = join(work, 'entry.ts');
writeFileSync(entry, [
  `export * from ${JSON.stringify(join(root, 'src', 'io', 'saveLoad.ts'))};`,
  `export { computeLayerState, formatLayerStateLog } from ${JSON.stringify(join(root, 'src', 'store', 'layerStateManager.ts'))};`,
].join('\n'));
const esb = spawnSync(join(root, 'node_modules', '.bin', 'esbuild'), [
  entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`,
], { stdio: 'inherit' });
if (esb.status !== 0) process.exit(esb.status ?? 1);
const io = await import(pathToFileURL(bundle).href);

const LABELS = {
  current_layer_state: 'Current Layer State', order: 'Order', connections: 'Connections',
  masked_layers: 'Masked Layers', colors: 'Colors', positions: 'Positions',
  selected_strand: 'Selected Strand', newest_strand: 'Newest Strand', newest_layer: 'Newest Layer',
};

const opts = { enable_curvature_bias_control: bias === 'on' };

// Deep comparison that also reports key-order differences on objects.
function diff(a, b, path, out) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { out.push(`${path}: array vs non-array`); return; }
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join(',') !== kb.join(',')) {
      const onlyA = ka.filter((k) => !kb.includes(k)), onlyB = kb.filter((k) => !ka.includes(k));
      if (onlyA.length || onlyB.length) out.push(`${path}: keys only in OSS [${onlyA}] only in JS [${onlyB}]`);
      else out.push(`${path}: key ORDER differs\n    OSS ${ka.join(' ')}\n    JS  ${kb.join(' ')}`);
    }
    for (const k of ka) if (k in b) diff(a[k], b[k], `${path}.${k}`, out);
    return;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) out.push(`${path}: ${a} vs ${b}`);
    return;
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

let failures = 0;
for (const file of args) {
  const input = resolve(file);
  const raw = JSON.parse(readFileSync(input, 'utf8'));
  const loaded = io.loadProjectFile(raw, opts);
  // Steps 1..max_step in stack order: past (oldest first), present, future reversed.
  const stack = [...loaded.past, { doc: loaded.doc, meta: loaded.presentMeta }, ...[...loaded.future].reverse()];
  const currentStep = loaded.past.length + 1;
  // The oracle is addressed by SOURCE step number while the JS stack is
  // positional, so --all-steps needs the file's steps to be exactly 1..n (what
  // export_history writes); anything else is reported rather than mis-paired.
  if (allSteps && raw.type === 'OpenStrandStudioHistory') {
    const srcSteps = (raw.states ?? []).filter((s) => s && typeof s.step === 'number' && s.data != null)
      .map((s) => s.step).sort((a, b) => a - b);
    const contiguous = srcSteps.length === stack.length && srcSteps.every((st, i) => st === i + 1);
    if (!contiguous) { failures++; console.log(`FAIL ${file}: steps are not 1..n (${srcSteps.join(',')}); --all-steps cannot pair them`); continue; }
  }
  const steps = allSteps && raw.type === 'OpenStrandStudioHistory'
    ? stack.map((_, i) => i + 1) : [null];
  for (const step of steps) {
    const oracleOut = join(work, 'oracle.json');
    const stateOut = join(work, 'state.txt');
    const pyArgs = [join(here, 'oss_save_oracle.py'), input, oracleOut, '--bias', bias];
    if (step != null) pyArgs.push('--step', String(step));
    if (checkState) pyArgs.push('--state-log', stateOut);
    const py = spawnSync('python3', pyArgs, { encoding: 'utf8' });
    if (py.status !== 0) { console.error(py.stdout, py.stderr); failures++; continue; }
    const oss = JSON.parse(readFileSync(oracleOut, 'utf8'));
    const entry = step == null ? stack[currentStep - 1] : stack[step - 1];
    const js = JSON.parse(JSON.stringify(io.serializeProject(entry.doc, opts)));
    const out = [];
    diff(oss, js, '$', out);
    if (checkState) {
      // OSS reads the selection off the canvas (the oracle selects the file's
      // selected_strand_name) and newest_strand is None after a load.
      const text = io.formatLayerStateLog(
        io.computeLayerState(entry.doc, { newestStrand: null, selectedStrand: entry.doc.selected_strand_name }), LABELS);
      // masked_layers is list(set(...)) in OSS: hash-randomized order per run,
      // so that one line is compared as a set.
      const canon = (t) => t.replace(/^(Masked Layers:\n)(\[.*\])$/m,
        (_, h, list) => h + JSON.stringify(JSON.parse(list.replace(/'/g, '"')).sort()));
      const expected = readFileSync(stateOut, 'utf8');
      if (canon(text) !== canon(expected)) {
        out.push('STATE dialog text differs');
        const a = expected.split('\n'), b = text.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(`  line ${i + 1}\n    OSS ${a[i]}\n    JS  ${b[i]}`);
      }
    }
    const label = step == null ? file : `${file} step ${step}/${stack.length}${step === currentStep ? ' (current)' : ''}`;
    const jsOut = join(work, 'js.json');
    writeFileSync(jsOut, JSON.stringify(js, null, 2));
    if (out.length) {
      failures++;
      console.log(`FAIL ${label} (${out.length} differences; oracle ${oracleOut}, js ${jsOut})`);
      for (const line of out.slice(0, 60)) console.log('  ' + line);
      if (out.length > 60) console.log(`  ... ${out.length - 60} more`);
    } else {
      console.log(`OK   ${label}  (${js.strands.length} strands, bias ${bias}${checkState ? ', state text' : ''})`);
    }
  }
}
process.exit(failures ? 1 : 0);
