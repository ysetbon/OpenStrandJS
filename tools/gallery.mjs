// Build artifacts/index.html — a single "menu" linking every pixel-diff artifact:
// the hover reports (report.html), the per-fixture body-render diffs
// (reference | js | diff), and the special comparisons (attach preview, UI). Scans
// artifacts/ so it always reflects whatever has been generated.
//
// Usage: node tools/gallery.mjs   ->   open /artifacts/index.html (via the dev server)

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const here = path.dirname(fileURLToPath(import.meta.url));
const artDir = path.resolve(here, '..', 'artifacts');

const has = (d, f) => existsSync(path.join(artDir, d, f));
const pct = (dir, a, b) => {
  try {
    const A = PNG.sync.read(readFileSync(path.join(artDir, dir, a)));
    const B = PNG.sync.read(readFileSync(path.join(artDir, dir, b)));
    if (A.width !== B.width || A.height !== B.height) return null;
    const n = pixelmatch(A.data, B.data, null, A.width, A.height, { threshold: 0.1 });
    return { pctVal: +(100 * n / (A.width * A.height)).toFixed(3), px: n, dim: `${A.width}x${B.height}` };
  } catch { return null; }
};

const dirs = readdirSync(artDir).filter((d) => {
  try { return statSync(path.join(artDir, d)).isDirectory(); } catch { return false; }
}).sort();

const cards = [];
for (const d of dirs) {
  // Hover reports — link the HTML + show the three hover panels.
  if (has(d, 'report.html')) {
    const p = pct(d, 'oss_hover.png', 'js_hover.png');
    cards.push({ group: 'Overlay (hover)', title: d, link: `${d}/report.html`,
      pct: p?.pctVal, imgs: [`${d}/oss_hover.png`, `${d}/js_hover.png`, `${d}/hover_diff.png`],
      labels: ['OSS', 'JS', 'diff'] });
    continue;
  }
  // Body-render diffs — reference | js | diff (the pixel oracle).
  if (has(d, 'reference.png') && has(d, 'js.png') && has(d, 'diff.png')) {
    const p = pct(d, 'reference.png', 'js.png');
    cards.push({ group: 'Body render (oracle)', title: d, pct: p?.pctVal, dim: p?.dim,
      imgs: [`${d}/reference.png`, `${d}/js.png`, `${d}/diff.png`], labels: ['OSS (ref)', 'JS', 'diff'] });
    continue;
  }
  // Special comparisons.
  if (has(d, 'board.png')) {
    cards.push({ group: 'Overlay (preview)', title: d, imgs: [`${d}/board.png`], labels: ['real | preview | diff'] });
    continue;
  }
  if (has(d, 'ui_sidebyside.png')) {
    cards.push({ group: 'UI chrome', title: d,
      imgs: [`${d}/ui_sidebyside.png`, `${d}/ui_diff.png`].filter((f) => existsSync(path.join(artDir, f))),
      labels: ['side-by-side', 'diff'] });
    continue;
  }
}

const order = ['Overlay (hover)', 'Overlay (preview)', 'Body render (oracle)', 'UI chrome'];
cards.sort((a, b) => (order.indexOf(a.group) - order.indexOf(b.group)) || a.title.localeCompare(b.title));

const badge = (c) => c.pct == null ? '' :
  `<span class="pct ${c.pct <= 0.4 ? 'ok' : c.pct <= 1 ? 'warn' : 'bad'}">${c.pct}%</span>`;
const card = (c) => `<div class=card>
  <div class=hd>${c.link ? `<a href="${c.link}">${c.title}</a>` : c.title} ${badge(c)}${c.dim ? `<span class=dim>${c.dim}</span>` : ''}</div>
  <div class=imgs>${c.imgs.map((src, i) => `<figure><img loading=lazy src="${src}"><figcaption>${c.labels[i] ?? ''}</figcaption></figure>`).join('')}</div>
</div>`;

let body = '';
for (const g of order) {
  const gc = cards.filter((c) => c.group === g);
  if (!gc.length) continue;
  body += `<h2>${g}</h2><div class=grid>${gc.map(card).join('')}</div>`;
}

const html = `<!doctype html><meta charset=utf8><title>OpenStrandJS — pixel-diff gallery</title>
<style>
:root{color-scheme:dark}
body{font:13px system-ui;background:#0f0f12;color:#ddd;margin:0;padding:20px 24px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;color:#9cf;margin:26px 0 10px;border-bottom:1px solid #2a2a30;padding-bottom:4px}
.sub{color:#888;margin:0 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
.card{background:#17171c;border:1px solid #26262e;border-radius:8px;padding:10px}
.hd{font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px}
.hd a{color:#cfe3ff;text-decoration:none}.hd a:hover{text-decoration:underline}
.dim{color:#777;font-weight:400;font-size:11px}
.pct{font-weight:700;border-radius:4px;padding:1px 6px;font-size:11px}
.pct.ok{background:#13361b;color:#7fe39a}.pct.warn{background:#3a3413;color:#e7d27a}.pct.bad{background:#3a1717;color:#f08a8a}
.imgs{display:flex;gap:6px}
figure{margin:0;flex:1;min-width:0}
figcaption{color:#888;text-align:center;font-size:10px;margin-top:2px}
img{width:100%;background:#fff;border:1px solid #2a2a30;border-radius:4px;image-rendering:auto}
</style>
<h1>OpenStrandJS &mdash; pixel-diff gallery</h1>
<p class=sub>Every comparison artifact under <code>artifacts/</code>. Green &le;0.4%, amber &le;1%, red &gt;1%. Click a hover title for its full report.</p>
${body}`;

writeFileSync(path.join(artDir, 'index.html'), html);
console.log(`wrote ${path.join(artDir, 'index.html')} (${cards.length} cards)`);
process.exit(0);
