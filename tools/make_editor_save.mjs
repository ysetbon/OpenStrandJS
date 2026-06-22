// Produce the exact bytes the OpenStrandJS editor's Save writes for a fixture,
// WITHOUT running the browser. The in-browser round-trip test proved that
// serializeProject(loadProject(x)) is field-identical to: unwrap the history
// wrapper, sort strands by index, renumber index 0..n, and null MaskedStrand
// control_points. We reproduce that here so the authentic Qt loader
// (reference_render.py -> save_load_manager.load_strands) can verify it loads.
// Usage: node tools/make_editor_save.mjs <fixture.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
const raw = JSON.parse(readFileSync(inPath, 'utf8'));
const data = raw && raw.type === 'OpenStrandStudioHistory'
  ? ((raw.states || []).find((s) => s.step === raw.current_step) || (raw.states || [])[0]).data
  : raw;

const strands = (data.strands || []).slice()
  .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
strands.forEach((s, i) => {
  s.index = i;
  if (s.type === 'MaskedStrand') s.control_points = [null, null];
});

const out = {
  strands,
  groups: data.groups || {},
  selected_strand_name: data.selected_strand_name ?? null,
  locked_layers: data.locked_layers || [],
  lock_mode: !!data.lock_mode,
  shadow_enabled: data.shadow_enabled ?? true,
  show_control_points: !!data.show_control_points,
  shadow_overrides: data.shadow_overrides || {},
};

writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath} (${out.strands.length} strands)`);
