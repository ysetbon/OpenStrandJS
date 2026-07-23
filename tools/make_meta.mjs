// Synthesize a reference.meta.json for the JS renderer WITHOUT the Qt oracle, so
// a fixture can be rendered for visual (not byte-exact) inspection. Geometry is
// approximated from strand control points; padding/supersample mirror
// reference_render.py. shadow_enabled can be forced on to exercise the
// shadow-of-unfolded-strands path (no committed fixture combines shadow+unfold).
//
// Usage: node tools/make_meta.mjs <fixture.json> <artifactDir> [shadow=on|off] [step=N]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const [fixturePath, artifactDir, shadowArg, stepArg] = process.argv.slice(2);
if (!fixturePath || !artifactDir) {
  console.error('usage: node tools/make_meta.mjs <fixture.json> <artifactDir> [on|off] [step]');
  process.exit(2);
}
mkdirSync(artifactDir, { recursive: true });

const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
let strands;
if (data && data.type === 'OpenStrandStudioHistory') {
  const step = stepArg ? Number(stepArg) : data.current_step;
  const st = data.states.find((s) => s.step === step) || data.states[data.states.length - 1];
  strands = st.data.strands;
} else {
  strands = data.strands;
}

// Approximate content bounds over every control point, expanded by the widest
// body half + a shadow/cap margin. Exactness doesn't matter for a before/after
// visual diff (both renders share this meta); padding 200 gives ample slack.
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxHalf = 0;
const pts = (s) => {
  const out = [s.start, s.end];
  const cp = s.control_points || [];
  for (const c of cp) if (c) out.push(c);
  if (s.control_point_center) out.push(s.control_point_center);
  return out.filter(Boolean);
};
for (const s of strands) {
  const w = (s.width || 0), sw = (s.stroke_width || 0);
  maxHalf = Math.max(maxHalf, w / 2 + sw);
  for (const p of pts(s)) {
    if (p.x == null) continue;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
}
const margin = maxHalf + 30 /*MAX_BLUR*/ + 20;
minX -= margin; minY -= margin; maxX += margin; maxY += margin;

const padding = 200;
const contentW = maxX - minX, contentH = maxY - minY;
const image_width = Math.max(Math.round(contentW + 2 * padding), 800);
const image_height = Math.max(Math.round(contentH + 2 * padding), 600);

const shadow_enabled = (shadowArg || 'off') === 'on';
const meta = {
  fixture: path.basename(fixturePath),
  curve_params: { base_fraction: 0.4, dist_multiplier: 1.2, exponent: 1.5 },
  image_width, image_height,
  min_x: minX, min_y: minY, max_x: maxX, max_y: maxY,
  padding, supersample: 2,
  x_offset: padding - minX, y_offset: padding - minY,
  shadow_enabled,
  show_control_points: false,
  num_strands: strands.length,
  shadow_overrides: {},
  layer_order: strands.map((s) => s.layer_name),
  num_steps: 2,
  shadow_color: { r: 0, g: 0, b: 0, a: 150 },
};
writeFileSync(path.join(artifactDir, 'reference.meta.json'), JSON.stringify(meta, null, 2));
console.log(`meta -> ${artifactDir} ${image_width}x${image_height} shadow=${shadow_enabled} strands=${strands.length}`);
