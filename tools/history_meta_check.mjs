// Regression guard for undo/redo state provenance (store/historyMeta.ts).
//
// The history stack stores documents; this feature makes each state also carry
// the record of WHAT produced it — the mode, or the panel/dialog/menu action —
// so the stack doubles as a log of what was done. Four things have to hold, and
// they are the ones that quietly rot:
//
//  A. The action rides on the state it CREATED. commit() attaches it to the new
//     present; the baseline it pushes onto `past` keeps the provenance of the
//     state that baseline actually is. Attach it to the wrong side and every
//     label in the log is off by one step.
//  B. Undo and redo carry it across intact, in both directions, so an undone
//     state can still say what it was and a redo restores that same record.
//  C. A gesture that changes nothing records nothing: commit() already discards
//     the no-op undo entry, and it must not journal a phantom action either.
//  D. Undo/redo still restore the same documents they always did — provenance is
//     an audit trail layered on top, not a change to what the stack does.
//
// Runs on plain node: the store is compiled on the fly with the repo's own tsc.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(path.join(tmpdir(), 'ossjs-history-'));
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };

try {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', 'src/store/editorStore.ts', 'src/store/historyMeta.ts', 'src/model/factory.ts',
     'src/store/actions.ts',
     '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck',
     '--esModuleInterop', '--moduleResolution', 'node'],
    { cwd: root, stdio: 'pipe' });
} catch { /* tsc reports import.meta under --module commonjs; it still emits */ }

// The emitted files keep Vite's dev-only debug handles, which CJS cannot parse.
const strip = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { strip(p); continue; }
    if (!p.endsWith('.js')) continue;
    const s = readFileSync(p, 'utf8');
    if (!s.includes('import.meta')) continue;
    writeFileSync(p, s.replace(/if \(import\.meta\.env\?\.DEV\)\s*\{[\s\S]*?\n\}\n?/g, '')
                     .replace(/if \(import\.meta\.env\?\.DEV\)[^\n]*\n(?:\s{4}[^\n]*\n)*/g, ''));
  }
};
strip(out);
writeFileSync(path.join(out, 'package.json'), '{"type":"commonjs"}');
try { symlinkSync(path.join(root, 'node_modules'), path.join(out, 'node_modules'), 'dir'); } catch { /* exists */ }

const require = createRequire(path.join(out, 'x.js'));
const { useEditorStore } = require(path.join(out, 'store/editorStore.js'));
const { historyLabel, historyShortLabel, ACTIONS } = require(path.join(out, 'store/historyMeta.js'));
const { makeStrand } = require(path.join(out, 'model/factory.js'));
const { setMemberNames } = require(path.join(out, 'store/actions.js'));

const st = () => useEditorStore.getState();
const addStrand = (name) => (d) => {
  d.order.push(name);
  d.strands[name] = makeStrand({ layer_name: name, set_number: 1, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } });
};

// ------------------------------------------------ A. the action rides on the state it created
useEditorStore.setState({ mode: 'attach' });
st().commitEdit(addStrand('1_1'), { action: 'attach.new', source: 'mode', targets: ['1_1'] });
ok('the new present carries the action that made it', st().presentMeta?.action === 'attach.new');
ok('the active mode is recorded with it', st().presentMeta?.mode === 'attach');
ok('the state it replaced carries its own (empty) provenance', st().past.at(-1).meta === null);

useEditorStore.setState({ mode: 'move' });
st().beginGesture({ action: 'move.handle', source: 'mode', targets: ['1_1'], detail: 'start' });
st().mutateDocLive((d) => { d.strands['1_1'].start = { x: 50, y: 50 }; });
st().commit();   // a bare commit uses what beginGesture staged
ok('a bare commit() uses the metadata staged by beginGesture', st().presentMeta?.action === 'move.handle');
ok('the pushed baseline keeps the provenance of the state it is',
  st().past.at(-1).meta?.action === 'attach.new');

useEditorStore.setState({ mode: 'select' });
st().commitEdit((d) => { d.strands['1_1'].is_hidden = true; },
  { action: 'strand.hidden', source: 'menu', targets: ['1_1'], detail: 'hide' });
ok('a non-mode action records its own source', st().presentMeta?.source === 'menu');

// ------------------------------------------------ B. undo/redo carry it both ways
const beforeUndo = JSON.stringify(st().doc);
st().undo();
ok('undo restores the previous state\'s provenance', st().presentMeta?.action === 'move.handle');
ok('the undone state keeps its own on the redo stack', st().future.at(-1).meta?.action === 'strand.hidden');
st().redo();
ok('redo restores the redone state\'s provenance', st().presentMeta?.action === 'strand.hidden');
ok('redo restores the document unchanged (D)', JSON.stringify(st().doc) === beforeUndo);

// ------------------------------------------------ C. a no-op gesture records nothing
const stepsBefore = st().past.length;
const logBefore = st().historyLog.length;
st().beginGesture({ action: 'move.handle', source: 'mode', targets: ['1_1'] });
st().commit();
ok('a gesture that changed nothing adds no undo step', st().past.length === stepsBefore);
ok('a gesture that changed nothing journals no action', st().historyLog.length === logBefore);
ok('a no-op gesture leaves the present provenance alone', st().presentMeta?.action === 'strand.hidden');

// ------------------------------------------------ the session journal
const kinds = st().historyLog.map((e) => e.kind).join(',');
ok('the journal records edits AND the undos/redos themselves',
  kinds === 'edit,edit,edit,undo,redo', kinds);
ok('journalled undo names the action it reversed',
  st().historyLog[3].meta?.action === 'strand.hidden');
ok('every journalled event is timestamped', st().historyLog.every((e) => typeof e.at === 'number' && e.at > 0));

// ------------------------------------------------ D. undo/redo behaviour is unchanged
st().undo(); st().undo(); st().undo();
ok('undoing every step returns to the empty document', st().doc.order.length === 0);
ok('the empty state has no provenance to report', st().presentMeta === null);
st().redo(); st().redo(); st().redo();
ok('redoing every step returns to the last state', JSON.stringify(st().doc) === beforeUndo);

// ------------------------------------------------ loading resets the stack but not the journal
const journalLen = st().historyLog.length;
st().loadDocument({
  order: [], strands: {}, groups: {}, selected_strand_name: null, locked_layers: [],
  lock_mode: false, shadow_enabled: true, show_control_points: true, shadow_overrides: {}, extra: {},
});
ok('a load clears the undo stack', st().past.length === 0 && st().future.length === 0);
ok('a load clears the present provenance', st().presentMeta === null);
ok('a load is itself journalled, and the journal survives it',
  st().historyLog.length === journalLen + 1 && st().historyLog.at(-1).kind === 'load');

// ------------------------------------------------ labels
ok('a catalogued action renders its description',
  historyLabel({ action: 'move.handle', source: 'mode', mode: 'move', targets: ['1_2'], at: 1 })
    === `${ACTIONS['move.handle']} — 1_2  ·  move mode`);
ok('an uncatalogued action still renders readably',
  historyLabel({ action: 'made.up_thing', source: 'panel', mode: null, targets: [], at: 1 })
    === 'Made up thing  ·  panel');
ok('an unlabelled state says so rather than rendering blank', historyLabel(null) === 'Unrecorded change');
ok('the short label drops the source suffix',
  historyShortLabel({ action: 'layer.delete', source: 'panel', mode: null, targets: ['2_1'], at: 1 })
    === `${ACTIONS['layer.delete']} (2_1)`);

// ------------------------------------------------ what a whole-set edit records
// A whole-set colour/width change touches every non-mask strand in the set, so
// the entry has to name them all — recording only the clicked layer understates
// what the step did.
{
  const doc = { order: [], strands: {} };
  const add = (name, set, type = 'Strand') => {
    doc.order.push(name);
    doc.strands[name] = { ...makeStrand({ layer_name: name, set_number: set, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }), type };
  };
  add('1_1', 1); add('1_2', 1); add('2_1', 2); add('1_3', 1, 'MaskedStrand');
  ok('a whole-set edit names every member of the set',
    setMemberNames(doc, '1_1').join(',') === '1_1,1_2');
  ok('...and never a mask, which those edits skip', !setMemberNames(doc, '1_1').includes('1_3'));
  ok('an unknown layer names nothing', setMemberNames(doc, 'nope').length === 0);
}

rmSync(out, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
