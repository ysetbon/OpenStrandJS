// OSS-vs-JS fidelity harness driver. For each fixture:
//   1. render the REAL OpenStrandStudio Qt canvas (tools/reference_render.py)
//      -> reference.png + reference.meta.json   [the pixel oracle]
//   2. render the JS/Paper.js port (tools/js_render.mjs) into the same geometry
//      -> js.png
//   3. pixel-diff them (tools/diff.mjs) -> match%
//   4. compose an OSS | JS | diff montage (tools/montage.mjs)
// Then compare each match% against fidelity-baselines.json and emit report.json.
// Build the PR comment separately with tools/fidelity_comment.mjs. Exits non-zero
// if any fixture REGRESSED beyond tolerance (gate mode); `--update-baseline`
// rewrites the baselines instead.
//
// Usage:
//   node tools/fidelity_run.mjs [--fixtures a,b,c] [--tolerance 0.2] [--update-baseline]
// Env:
//   OSS_ROOT        path to the OpenStrandStudio checkout (default ../OpenStrandStudio)
//   OSS_CHROMIUM    chromium binary for Playwright (optional)
//   QT_QPA_PLATFORM defaults to "offscreen"
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'artifacts', 'fidelity');
const BASELINE_FILE = path.join(ROOT, 'fidelity-baselines.json');

// Default corpus - the fixtures worth gating on. Curated for signal + runtime.
const DEFAULT_CORPUS = [
  'single_strand',
  'closed_knot',
  'three_strand_braid',
  'overhand_knot',
  'box_stitch',
  'unfolded_shadow',
];

const args = process.argv.slice(2);
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const updateBaseline = args.includes('--update-baseline');
const tolerance = Number(getFlag('--tolerance') ?? 0.2); // allowed match% drop
const fixtures = (getFlag('--fixtures')?.split(',') ?? DEFAULT_CORPUS).map((s) => s.trim()).filter(Boolean);

const env = {
  ...process.env,
  QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM || 'offscreen',
  OSS_ROOT: process.env.OSS_ROOT || path.resolve(ROOT, '..', 'OpenStrandStudio'),
};
const PY = process.env.PYTHON || 'python3';

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

const baselines = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : {};
const results = [];

for (const name of fixtures) {
  const fixture = path.join('fixtures', `${name}.json`);
  if (!existsSync(fixture)) {
    // Record as an error so a missing/misnamed corpus can never yield a green
    // "matches the oracle" header from an empty result set.
    console.error(`MISSING ${name}: ${fixture} not found`);
    results.push({ fixture: name, ok: false, error: `${fixture} not found` });
    continue;
  }
  const dir = path.join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const ref = path.join(dir, 'reference.png');
  const meta = path.join(dir, 'reference.meta.json');
  const js = path.join(dir, 'js.png');
  const montage = path.join(dir, 'montage.png');

  const rec = { fixture: name };
  try {
    // 1. Qt oracle
    const oracleOut = run(PY, ['tools/reference_render.py', fixture, ref, meta]);
    const dim = /OK (\d+)x(\d+)/.exec(oracleOut);
    if (dim) { rec.width = +dim[1]; rec.height = +dim[2]; }
    // 2. JS render
    run('node', ['tools/js_render.mjs', fixture, dir]);
    // 3. diff
    const diffOut = run('node', ['tools/diff.mjs', dir]);
    const d = JSON.parse(diffOut.trim().split('\n').pop());
    rec.match_pct = d.match_pct;
    rec.mismatch_pixels = d.mismatch_pixels;
    rec.total_pixels = d.total_pixels;
    // 4. montage
    run('node', ['tools/montage.mjs', montage, ref, js, path.join(dir, 'diff.png')]);
    rec.ok = true;
  } catch (e) {
    rec.ok = false;
    rec.error = (e.stderr || e.stdout || e.message || '').toString().slice(-500);
    console.error(`FAIL ${name}: ${rec.error}`);
  }

  const base = baselines[name]?.match_pct;
  rec.baseline_pct = base ?? null;
  rec.delta = base != null && rec.match_pct != null ? Number((rec.match_pct - base).toFixed(3)) : null;
  rec.regressed = rec.ok && base != null && rec.delta < -tolerance;
  results.push(rec);
  console.log(`${name}: ${rec.ok ? rec.match_pct + '%' : 'ERROR'}${base != null ? ` (baseline ${base}%, delta ${rec.delta})` : ' (no baseline)'}`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ tolerance, results }, null, 2));

if (updateBaseline) {
  const next = {};
  for (const r of results) if (r.ok) next[r.fixture] = { match_pct: r.match_pct, width: r.width, height: r.height };
  writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`\nBaselines written to ${BASELINE_FILE} (${Object.keys(next).length} fixtures)`);
}

console.log(`\nreport -> ${path.join(OUT, 'report.json')} (build the PR comment with tools/fidelity_comment.mjs)`);
const regressed = results.filter((r) => r.regressed);
const errored = results.filter((r) => !r.ok);
// `--errors-only` hard-fails ONLY on render errors (environment-independent),
// leaving match% regressions to surface in the comment as advisory. This avoids
// spurious gate failures from cross-environment anti-aliasing jitter until the
// committed baselines are calibrated in the CI environment itself.
const errorsOnly = args.includes('--errors-only');
if (errored.length && !updateBaseline) {
  console.error(`\n${errored.length} render error(s): ${errored.map((r) => r.fixture).join(', ')}`);
  process.exit(1);
}
if (regressed.length && !errorsOnly && !updateBaseline) {
  console.error(`\n${regressed.length} regression(s): ${regressed.map((r) => r.fixture).join(', ')}`);
  process.exit(1);
}
