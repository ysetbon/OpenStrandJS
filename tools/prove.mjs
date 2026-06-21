// End-to-end harness for one fixture: reference render (Qt) -> JS render
// (Paper.js/Chromium) -> pixel diff. Prints the diff summary.
//
// Usage: node tools/prove.mjs <fixture.json> [artifactName]
//   artifactName defaults to the fixture's basename (without extension).
// Env: OSS_STEP (history step), OSS_PY (python with PyQt5; defaults to the
//      sibling OpenStrandStudio build_env interpreter).

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fixture = process.argv[2];
if (!fixture) {
  console.error('usage: node tools/prove.mjs <fixture.json> [artifactName]');
  process.exit(2);
}
const name = process.argv[3] || path.basename(fixture).replace(/\.[^.]+$/, '');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const artifactDir = path.join(root, 'artifacts', name);
mkdirSync(artifactDir, { recursive: true });

const PY =
  process.env.OSS_PY ||
  path.resolve(root, '..', 'OpenStrandStudio', 'src', 'build_env', 'Scripts', 'python.exe');

const refPng = path.join(artifactDir, 'reference.png');
const refMeta = path.join(artifactDir, 'reference.meta.json');

function run(cmd, args) {
  console.log(`\n$ ${path.basename(cmd)} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env });
}

run(PY, ['tools/reference_render.py', fixture, refPng, refMeta]);
run('node', ['tools/js_render.mjs', fixture, artifactDir]);
run('node', ['tools/diff.mjs', artifactDir]);
