// Regression guard for the Tier-4 fixes: colour-action scopes, the closing-knot
// and extension menu actions, arrow customization data, the settings that reach
// the renderer, and translation-table completeness.
//
// Renderer GEOMETRY (the extension rays, arrow textures, arrow_casts_shadow) is
// covered by tools/tier4_ui_check.mjs, which needs a browser. What lives here is
// everything provable without one — plus the absent-safety of every new meta key,
// which is what keeps the Qt fidelity baselines intact.
//
// Usage: node tools/tier4_check.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(path.join(tmpdir(), 'ossjs-tier4-'));
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };

try {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', 'src/store/actions.ts', 'src/renderer/toRenderArray.ts',
     '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch { /* tsc reports import.meta under --module commonjs; it still emits */ }
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
const A = require(path.join(out, 'store/actions.js'));
const { buildMeta } = require(path.join(out, 'renderer/toRenderArray.js'));

const P = (x, y) => ({ x, y });
const mkStrand = (over) => ({
  type: 'Strand', layer_name: '1_1', set_number: 1,
  start: P(100, 100), end: P(200, 100),
  control_points: [P(120, 60), P(180, 60)],
  control_point_center: P(150, 60), control_point_center_locked: false,
  width: 46, stroke_width: 4,
  color: { r: 10, g: 20, b: 30, a: 255 }, stroke_color: { r: 0, g: 0, b: 0, a: 255 },
  has_circles: [false, false], is_hidden: false, shadow_only: false, hide_shadow: false,
  circle_stroke_color: null, knot_connections: {}, extra: {}, control_point2_activated: true,
  ...over,
});
const mkDoc = (strands) => ({
  order: strands.map((s) => s.layer_name),
  strands: Object.fromEntries(strands.map((s) => [s.layer_name, s])),
  groups: {}, selected_strand_name: null, locked_layers: [], lock_mode: false,
  shadow_enabled: true, show_control_points: false, shadow_overrides: {}, extra: {},
});

// ================================================ A. colour-action scopes
{
  // OSS change_stroke_color is documented "the stroke color of every strand in
  // the clicked strand's set" (numbered_layer_button.py:3290). The port applied
  // it to one strand — this is the behaviour that changed.
  const doc = mkDoc([
    mkStrand({}),
    mkStrand({ layer_name: '1_2', type: 'AttachedStrand', attached_to: '1_1', attachment_side: 1 }),
    mkStrand({ layer_name: '2_1', set_number: 2 }),
  ]);
  const RED = { r: 255, g: 0, b: 0, a: 255 };
  A.setColor(doc, '1_1', 'stroke', RED, true);
  ok('Change Stroke Color reaches the whole set',
    doc.strands['1_2'].stroke_color.r === 255);
  ok('...and stops at the set boundary', doc.strands['2_1'].stroke_color.r === 0);

  const doc2 = mkDoc([mkStrand({}), mkStrand({ layer_name: '1_2', type: 'AttachedStrand', attached_to: '1_1' })]);
  A.setColor(doc2, '1_1', 'stroke', RED, false);
  ok('the This Layer Only variant touches one strand',
    doc2.strands['1_1'].stroke_color.r === 255 && doc2.strands['1_2'].stroke_color.r === 0);

  const doc3 = mkDoc([mkStrand({}), mkStrand({ layer_name: '1_2', type: 'AttachedStrand', attached_to: '1_1' })]);
  A.setColor(doc3, '1_1', 'fill', RED, false);
  ok('and the fill has a This Layer Only variant too (1.110 change_layer_color)',
    doc3.strands['1_1'].color.r === 255 && doc3.strands['1_2'].color.r === 10);
}

// ============================================ B. closing-knot END edge
{
  const doc = mkDoc([mkStrand({ circle_stroke_color: { r: 0, g: 0, b: 0, a: 255 } })]);
  A.setEndCircleStrokeColor(doc, '1_1', { r: 0, g: 0, b: 0, a: 0 });
  const s = doc.strands['1_1'];
  ok('the closing-knot action makes the END edge transparent',
    s.extra.end_circle_stroke_color.a === 0);
  // The whole point of a separate setter: the START edge describes the other end
  // and must not follow, or unfolding one end would unfold both.
  ok('...and leaves the START edge opaque',
    s.extra.start_circle_stroke_color.a === 255 && s.circle_stroke_color.a === 255);
}

// ================================================ C. extension + arrow data
{
  const doc = mkDoc([mkStrand({})]);
  const s = doc.strands['1_1'];
  ok('extension flags start unset (OSS default False)',
    s.extra.start_extension_visible === undefined);
  A.toggleExtensionVisible(doc, '1_1', 'start');
  ok('toggling sets the start flag', s.extra.start_extension_visible === true);
  A.toggleExtensionVisible(doc, '1_1', 'start');
  ok('and toggling again clears it', s.extra.start_extension_visible === false);
  A.toggleExtensionVisible(doc, '1_1', 'end');
  ok('the two ends are independent',
    s.extra.end_extension_visible === true && s.extra.start_extension_visible === false);

  A.setArrowTransparency(doc, '1_1', 250);
  ok('arrow transparency clamps to 0..100', s.extra.arrow_transparency === 100);
  A.setArrowTransparency(doc, '1_1', -5);
  ok('...at both ends', s.extra.arrow_transparency === 0);
  A.setArrowTexture(doc, '1_1', 'crosshatch');
  A.setArrowShaftStyle(doc, '1_1', 'tiles');
  A.setArrowHeadVisible(doc, '1_1', false);
  A.setArrowCastsShadow(doc, '1_1', true);
  ok('the arrow properties land in the passthrough bag',
    s.extra.arrow_texture === 'crosshatch' && s.extra.arrow_shaft_style === 'tiles' &&
    s.extra.arrow_head_visible === false && s.extra.arrow_casts_shadow === true);

  A.setArrowColor(doc, '1_1', { r: 1, g: 2, b: 3, a: 4 });
  ok('an arrow colour is stored', s.extra.arrow_color.r === 1);
  // OSS's default is None, not a colour, and the renderer's fallback to
  // stroke_color depends on the key being ABSENT rather than set to a default.
  A.setArrowColor(doc, '1_1', null);
  ok('clearing it removes the key rather than writing a default',
    !('arrow_color' in s.extra));

  const mask = mkDoc([mkStrand({ layer_name: '1_1_2_1', type: 'MaskedStrand' })]);
  A.setArrowTexture(mask, '1_1_2_1', 'dots');
  ok('masks are refused (OSS offers no arrow menu for them)',
    mask.strands['1_1_2_1'].extra.arrow_texture === undefined);
}

// ================================================= D. settings reach meta
{
  const settings = {
    curve_params: { base_fraction: 1, dist_multiplier: 2, exponent: 2 },
    grid_size: 28, show_grid: false, theme: 'default',
    shadow_color: { r: 0, g: 0, b: 0, a: 150 }, num_steps: 2, max_blur_radius: 30,
    highlight_color: { r: 255, g: 0, b: 0, a: 255 }, draw_only_affected_strand: false,
    enable_third_control_point: false, enable_curvature_bias_control: false,
    arrow_head_length: 20, arrow_head_width: 10, arrow_head_stroke_width: 4,
    arrow_gap_length: 10, arrow_line_length: 20, arrow_line_width: 10,
    extension_length: 77, extension_dash_count: 3,
    extension_dash_width: 9, extension_dash_gap_length: 6,
    use_default_arrow_color: false, default_arrow_fill_color: { r: 7, g: 8, b: 9, a: 255 },
  };
  const view = { zoom: 1, panX: 0, panY: 0, width: 100, height: 100, supersample: 2 };
  const meta = buildMeta(mkDoc([mkStrand({})]), view, settings) || {};
  ok('buildMeta forwards all four extension dimensions',
    JSON.stringify(meta.extension_params) ===
    JSON.stringify({ length: 77, dash_count: 3, dash_width: 9, dash_gap_length: 6 }));
  ok('buildMeta forwards the arrow default-colour pair',
    meta.use_default_arrow_color === false && (meta.default_arrow_fill_color || {}).r === 7);
}

// ====================== E. the renderer's no-meta fallbacks (fidelity invariant)
{
  const src = readFileSync(path.join(root, 'web/strand-renderer.js'), 'utf8')
    + '\n;globalThis.__probe = () => ({ applyPaintSettings,'
    + ' get EXTENSION_PARAMS() { return EXTENSION_PARAMS; },'
    + ' get USE_DEFAULT_ARROW_COLOR() { return USE_DEFAULT_ARROW_COLOR; },'
    + ' get DEFAULT_ARROW_FILL() { return DEFAULT_ARROW_FILL; },'
    + ' defaultArrowFill });\n';
  const ctx = vm.createContext({ window: {}, document: { createElement: () => ({ getContext: () => ({}) }) }, paper: {}, console });
  vm.runInContext(src, ctx);
  const R = ctx.__probe();

  R.applyPaintSettings({});
  ok('an empty meta restores the OSS extension defaults (100 / 10)',
    R.EXTENSION_PARAMS.length === 100 && R.EXTENSION_PARAMS.dash_count === 10);
  ok('...with dash_width unset, meaning "use the strand stroke_width"',
    R.EXTENSION_PARAMS.dash_width === null && R.EXTENSION_PARAMS.dash_gap_length === null);
  // The inverted rule: absent must mean "use the strand's own colour", which is
  // what the Qt oracle renders. Getting this backwards would repaint every arrow
  // head in the corpus.
  ok('an empty meta leaves arrow heads on the strand colour',
    R.USE_DEFAULT_ARROW_COLOR === true &&
    R.defaultArrowFill({ color: { r: 5, g: 5, b: 5, a: 255 } }).r === 5);

  R.applyPaintSettings({
    extension_params: { length: 42, dash_count: 2, dash_width: 3, dash_gap_length: 1 },
    use_default_arrow_color: false, default_arrow_fill_color: { r: 9, g: 9, b: 9, a: 255 },
  });
  ok('meta extension dimensions are honoured', R.EXTENSION_PARAMS.length === 42);
  // OSS: `if NOT use_default_arrow_color: use default_arrow_fill_color`. The box
  // being UNticked is what makes the configured colour apply.
  ok('use_default_arrow_color FALSE selects the configured fill (OSS inversion)',
    R.defaultArrowFill({ color: { r: 5, g: 5, b: 5, a: 255 } }).r === 9);
}

// ============================================ F. translation-table completeness
{
  const ts = readFileSync(path.join(root, 'src/ui/translations.ts'), 'utf8');
  // [A-Za-z0-9_], not [a-z0-9_]: the table also holds camelCase (showGrid,
  // gridSize) and capitalised (X_angle) keys, and a lowercase-only pattern made
  // them invisible to both checks below — two real missing-language gaps rode
  // through this hole until a reviewer spotted them by eye.
  const jsKeys = new Set([...ts.matchAll(/^  ([A-Za-z0-9_]+): \{/gm)].map((m) => m[1]));

  // The desktop app is a SIBLING checkout (package.json: "../OpenStrandStudio"),
  // present on a dev machine and absent on a CI runner, which only checks out this
  // repo. Skip loudly rather than throw — and never silently: a skipped check that
  // reads as a pass is worse than no check.
  const pyPath = path.join(root, '..', 'OpenStrandStudio', 'src', 'translations.py');
  if (!existsSync(pyPath)) {
    console.log('SKIP  every key in the desktop app\'s table exists here'
      + '  (no ../OpenStrandStudio checkout — run this on a dev machine)');
  } else {
    const py = readFileSync(pyPath, 'utf8');
    const heads = [...py.matchAll(/^\s{0,4}'(\w{2})'\s*:\s*\{/gm)].map((m) => [m.index, m[1]]);
    const enSeg = py.slice(heads[0][0], heads[1][0]);
    const ossKeys = new Set([...enSeg.matchAll(/^\s+'([a-z0-9_]+)'\s*:/gm)].map((m) => m[1]));
    ossKeys.delete('en');   // the block header itself
    const missing = [...ossKeys].filter((k) => !jsKeys.has(k));
    ok('every key in the desktop app\'s table exists here',
      missing.length === 0, `${missing.length} missing: ${missing.slice(0, 8).join(', ')}`);
  }

  // Each entry must carry all seven languages, or `t()` silently falls back to
  // English for the missing ones and the gap never surfaces.
  const LANGS = ['en', 'fr', 'de', 'it', 'es', 'pt', 'he'];
  const short = [];
  for (const m of ts.matchAll(/^  ([A-Za-z0-9_]+): \{(.*)\},$/gm)) {
    const absent = LANGS.filter((l) => !new RegExp(`\\b${l}:\\s`).test(m[2]));
    if (absent.length) short.push(`${m[1]}(no ${absent.join('/')})`);
  }
  ok('and every entry carries all seven languages',
    short.length === 0, short.slice(0, 6).join(', '));
}

rmSync(out, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exitCode = fails ? 1 : 0;
