// Publish ONE fidelity dashboard "entry" into a gh-pages /fidelity gallery:
//
//   <fidelityDir>/<sub>/index.html          the self-contained dashboard (artifact.html)
//   <fidelityDir>/<sub>/meta.json           card metadata for the landing gallery
//   <fidelityDir>/<sub>/thumb.png           the CURRENT card snapshot (one example)
//   <fidelityDir>/<sub>/snaps/<fixture>.png a snapshot per example (for the toggle)
//
// <sub> is "main" for the canonical (merged) dashboard, or "pr-<N>" for a PR
// preview. tools/fidelity_index.mjs then scans every <sub>/meta.json and
// regenerates <fidelityDir>/index.html — the gallery/landing page, whose cards
// have a prev/next toggle to preview each example in the thumbnail widget
// (client-side only).
//
// Usage: node tools/fidelity_entry.mjs <fidelityDir> <sub>
// Env (all optional; sensible fallbacks):
//   FID_KIND    "main" | "pr"                (default: inferred from <sub>)
//   FID_PR      pull-request number          (for kind=pr)
//   FID_BRANCH  head branch / worktree name  (e.g. claude/effort-estimation-cepto6)
//   FID_TITLE   PR title / short description
//   FID_SHA     head commit SHA
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const [fidelityDir, sub] = process.argv.slice(2);
if (!fidelityDir || !sub) {
  console.error('usage: node tools/fidelity_entry.mjs <fidelityDir> <sub>');
  process.exit(2);
}

const OUT = path.join(process.cwd(), 'artifacts', 'fidelity');
const dest = path.join(fidelityDir, sub);

mkdirSync(dest, { recursive: true });
mkdirSync(path.join(dest, 'snaps'), { recursive: true });

// 1) The dashboard itself.
const artifact = path.join(OUT, 'artifact.html');
if (!existsSync(artifact)) {
  console.error(`no ${artifact}; nothing to publish`);
  process.exit(1);
}
copyFileSync(artifact, path.join(dest, 'index.html'));

// 2) Live results from this run (for the card's match summary + thumb choices).
let results = [];
const rp = path.join(OUT, 'report.json');
if (existsSync(rp)) {
  try {
    const rep = JSON.parse(readFileSync(rp, 'utf8'));
    results = (rep.results || [])
      .filter((r) => r && r.ok && r.match_pct != null)
      .map((r) => ({ fixture: r.fixture, match_pct: r.match_pct }));
  } catch { /* leave results empty */ }
}
const matches = results.map((r) => r.match_pct);
const perfect = matches.filter((m) => m === 100).length;
const lowest = matches.length ? Math.min(...matches) : null;

// Box-average downscale a PNG to fit within maxW x maxH, preserving aspect.
function downscale(srcPath, maxW, maxH) {
  const src = PNG.sync.read(readFileSync(srcPath));
  const scale = Math.min(1, maxW / src.width, maxH / src.height);
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  const out = new PNG({ width: dw, height: dh });
  const sxStep = src.width / dw;
  const syStep = src.height / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * syStep);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * syStep));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * sxStep);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * sxStep));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const i = (src.width * sy + sx) << 2;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
          n++;
        }
      }
      const o = (dw * y + x) << 2;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return { png: out, w: dw, h: dh };
}

// A clean single-panel snapshot source for a fixture: prefer the JS render,
// fall back to the OSS reference, then the (wide) montage.
function snapshotSource(fixture) {
  for (const name of ['js.png', 'reference.png', 'montage.png']) {
    const p = path.join(OUT, fixture, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// 3) One downscaled snapshot per example (the toggle cycles these). Preferred
//    order first so the default picks a meaningful example.
const PREF = ['fid_shadow_unfolded_attach', 'fid_unfold_angled', 'fid_unfold_chain', 'fid_shadow_folded_attach', 'fid_shadow_cross'];
const orderedFixtures = [
  ...PREF.filter((f) => results.some((r) => r.fixture === f)),
  ...results.map((r) => r.fixture).filter((f) => !PREF.includes(f)),
];

const thumbs = [];
for (const fixture of orderedFixtures) {
  const src = snapshotSource(fixture);
  if (!src) continue;
  try {
    const { png, w, h } = downscale(src, 480, 360);
    const rel = path.join('snaps', `${fixture}.png`);
    writeFileSync(path.join(dest, rel), PNG.sync.write(png));
    thumbs.push({ fixture, file: rel.split(path.sep).join('/'), w, h });
  } catch (e) {
    console.error(`snapshot for ${fixture} failed: ${e && e.message}`);
  }
}

// 4) Default snapshot: the first (preferred) example. The gallery toggle lets
//    a viewer flip through the rest client-side.
let selected = thumbs.length ? thumbs[0].fixture : null;

let thumb = null;
if (selected) {
  const t = thumbs.find((x) => x.fixture === selected);
  copyFileSync(path.join(dest, t.file), path.join(dest, 'thumb.png'));
  thumb = { file: 'thumb.png', from: t.fixture, w: t.w, h: t.h };
}

// 5) Card metadata for the gallery.
const kind = process.env.FID_KIND || (sub === 'main' ? 'main' : 'pr');
const pr = process.env.FID_PR ? Number(process.env.FID_PR) : null;
const meta = {
  sub,
  kind,
  pr: Number.isFinite(pr) ? pr : null,
  branch: process.env.FID_BRANCH || (kind === 'main' ? 'main' : ''),
  title: process.env.FID_TITLE || (kind === 'main' ? 'Canonical dashboard (latest main)' : `PR #${pr || '?'}`),
  sha: (process.env.FID_SHA || '').slice(0, 10),
  updated: new Date().toISOString(),
  summary: { fixtures: matches.length, perfect, lowest },
  results,
  selected,        // the example shown by default (toggle start position)
  thumb,           // { file, from, w, h }
  thumbs,          // all preview snapshots: [{ fixture, file, w, h }]
};
writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`entry -> ${dest} (${kind}${meta.pr ? ` #${meta.pr}` : ''}, ${matches.length} fixtures, ${thumbs.length} snapshots, default: ${selected || 'none'})`);
