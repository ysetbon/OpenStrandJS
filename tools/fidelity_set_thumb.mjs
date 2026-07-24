// Persist an admin's choice of WHICH example is a gallery card's snapshot.
//
// Called by the fidelity-thumb workflow (workflow_dispatch, admin-gated). It
// points <fidelityDir>/<sub>/thumb.png at the chosen example's snapshot (already
// published under <sub>/snaps/<fixture>.png by tools/fidelity_entry.mjs) and
// records meta.selected so the choice sticks across later fidelity re-runs.
// tools/fidelity_index.mjs is then re-run to rebuild the landing gallery.
//
// Usage: node tools/fidelity_set_thumb.mjs <fidelityDir> <sub> <fixture>
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const [fidelityDir, sub, fixture] = process.argv.slice(2);
if (!fidelityDir || !sub || !fixture) {
  console.error('usage: node tools/fidelity_set_thumb.mjs <fidelityDir> <sub> <fixture>');
  process.exit(2);
}

// Guard against path traversal from the (admin-supplied but still-validated)
// inputs. The allowlist alone would accept "." / ".." (both match [._-]+), so
// reject those explicitly — sub/fixture must name an actual child entry.
const safe = (s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..';
if (!safe(sub) || !safe(fixture)) {
  console.error(`invalid sub/fixture (allowed: letters, digits, dot, dash, underscore)`);
  process.exit(2);
}

const dest = path.join(fidelityDir, sub);
const metaPath = path.join(dest, 'meta.json');
if (!existsSync(metaPath)) {
  console.error(`no entry at ${dest} (meta.json missing) — publish the dashboard first`);
  process.exit(1);
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const thumbs = Array.isArray(meta.thumbs) ? meta.thumbs : [];
const pick = thumbs.find((t) => t.fixture === fixture);
if (!pick) {
  const avail = thumbs.map((t) => t.fixture).join(', ') || '(none)';
  console.error(`fixture "${fixture}" is not a selectable snapshot for ${sub}. Available: ${avail}`);
  process.exit(1);
}

const snap = path.join(dest, pick.file);
if (!existsSync(snap)) {
  console.error(`snapshot file missing: ${snap}`);
  process.exit(1);
}

copyFileSync(snap, path.join(dest, 'thumb.png'));
meta.selected = fixture;
meta.thumb = { file: 'thumb.png', from: fixture, w: pick.w, h: pick.h };
writeFileSync(metaPath, JSON.stringify(meta, null, 2));

console.log(`set-thumb -> ${sub}: card snapshot is now "${fixture}"`);
