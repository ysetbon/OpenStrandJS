// Copy the OpenStrand Studio 2.0 mask / joint shadow test scenes into fixtures/
// so the fidelity harness can render them with the Qt oracle and the JS renderer.
//
// Sources (all read-only, from the OSS checkout):
//   docs/mask_shadow_observations/example_*/scene.json   -> fixtures/mso_<example>.json
//   tests/mask_piece/*.json                              -> fixtures/mp_<design>.json
//   src/samples/<name>.json                              -> fixtures/sample_<name>.json
// plus derived variants:
//   sample_<name>_w80.json  - every strand at width 80, stroke 2 (three grid squares,
//                             as tests/test_joint_shadow.py renders the samples)
//   mp_selected_over_crossing_sel(.pan).json - 4_1 selected, as
//                             tests/test_selection_outline_over_masks.py does; the
//                             .pan variant is panned by 1e-4 px (oss_pan) so OSS
//                             draws the masks through MaskedStrand._draw_direct.
//
// Usage: OSS_ROOT=../OpenStrandStudio node tools/make_mask_shadow_fixtures.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OSS = process.env.OSS_ROOT || path.resolve(ROOT, '..', 'OpenStrandStudio');
const OUT = path.join(ROOT, 'fixtures');
const written = [];

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (name, data) => {
  writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
  written.push(name);
};
// The flat {strands, ...} state a history file renders (its current step).
const stateOf = (data) => {
  if (data && data.type === 'OpenStrandStudioHistory') {
    const step = data.current_step;
    return data.states.find((s) => s.step === step).data;
  }
  return data;
};

// 1. docs/mask_shadow_observations examples
const obsDir = path.join(OSS, 'docs', 'mask_shadow_observations');
for (const ex of readdirSync(obsDir).filter((d) => d.startsWith('example_')).sort()) {
  const scene = path.join(obsDir, ex, 'scene.json');
  if (!existsSync(scene)) continue;
  const short = ex.replace(/^example_0?(\d+)_.*$/, 'ex$1');
  write(`mso_${short}`, read(scene));
}

// 2. tests/mask_piece designs
const mpDir = path.join(OSS, 'tests', 'mask_piece');
for (const f of readdirSync(mpDir).filter((f) => f.endsWith('.json')).sort()) {
  write(`mp_${f.replace(/\.json$/, '')}`, read(path.join(mpDir, f)));
}
{
  const data = read(path.join(mpDir, 'selected_over_crossing.json'));
  for (const s of stateOf(data).strands) if (s.layer_name === '4_1') s.is_selected = true;
  write('mp_selected_over_crossing_sel', data);
  write('mp_selected_over_crossing_sel_pan', { ...data, oss_pan: [0.0001, 0.0001] });
}

// 3. samples, at their saved widths and at three grid squares wide
const SAMPLES = ['chinese_double_coin', 'woven_heart', 'kagome_weave', 'tidal_waves', 'thick_and_thin', 'box_stitch'];
const WIDE = ['chinese_double_coin', 'woven_heart', 'tidal_waves', 'box_stitch'];
for (const name of SAMPLES) {
  const data = read(path.join(OSS, 'src', 'samples', `${name}.json`));
  write(`sample_${name}`, data);
  if (WIDE.includes(name)) {
    const wide = JSON.parse(JSON.stringify(data));
    for (const s of stateOf(wide).strands) {
      if (s.type === 'MaskedStrand') continue;
      s.width = 80;
      s.stroke_width = 2;
    }
    write(`sample_${name}_w80`, wide);
  }
}

console.log(`wrote ${written.length} fixtures:\n  ${written.join('\n  ')}`);
