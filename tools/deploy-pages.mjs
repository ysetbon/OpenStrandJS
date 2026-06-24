// One-command deploy of the editor to GitHub Pages (gh-pages branch).
//
//   npm run deploy
//
// Builds the editor with Vite, then publishes ONLY the built output in
// dist-editor/ to the `gh-pages` branch of `origin` via a throwaway git repo.
// This needs no `workflow` OAuth scope (unlike the Actions-based deploy), so it
// works with a plain `repo`-scoped gh login.
//
// The live site is https://ysetbon.github.io/OpenStrandJS/.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(repoRoot, 'dist-editor');

// Only `npm` needs a shell on Windows (it resolves to npm.cmd). Running `git`
// under a shell re-parses the argv we pass, so a commit message with spaces gets
// split into separate pathspecs — hence the per-command shell decision here.
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd === 'npm',
  });

// Resolve the push URL from the repo's existing `origin` remote so this keeps
// working if the repo is renamed or moved.
const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot })
  .toString()
  .trim();

console.log('› building editor…');
run('npm', ['run', 'build:editor'], repoRoot);

if (!existsSync(distDir)) {
  console.error('build produced no dist-editor/ — aborting');
  process.exit(1);
}

// Stop GitHub Pages from running Jekyll over the Vite output.
writeFileSync(resolve(distDir, '.nojekyll'), '');

console.log('› publishing dist-editor/ to gh-pages…');
rmSync(resolve(distDir, '.git'), { recursive: true, force: true });
run('git', ['init', '-q'], distDir);
run('git', ['checkout', '-q', '-b', 'gh-pages'], distDir);
run('git', ['add', '-A'], distDir);
run('git', ['commit', '-q', '-m', 'Deploy editor build to GitHub Pages'], distDir);
run('git', ['push', '-f', '-q', remoteUrl, 'gh-pages'], distDir);
rmSync(resolve(distDir, '.git'), { recursive: true, force: true });

console.log('✓ deployed → https://ysetbon.github.io/OpenStrandJS/');
