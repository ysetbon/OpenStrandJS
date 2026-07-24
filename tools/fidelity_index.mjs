// Regenerate the fidelity GALLERY / landing page at <fidelityDir>/index.html.
//
// It scans every <fidelityDir>/<sub>/meta.json (written by tools/fidelity_entry.mjs)
// and renders one card per dashboard: a snapshot thumbnail, the PR number and
// head branch/worktree name, a short description, the match summary, and a link
// into <sub>/. Cards are sorted with the canonical `main` dashboard first, then
// pull requests by number descending (newest PR first).
//
// Usage: node tools/fidelity_index.mjs <fidelityDir>
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const fidelityDir = process.argv[2];
if (!fidelityDir) {
  console.error('usage: node tools/fidelity_index.mjs <fidelityDir>');
  process.exit(2);
}

// Collect entries from every subdir that has a meta.json.
const entries = [];
for (const name of readdirSync(fidelityDir)) {
  const dir = path.join(fidelityDir, name);
  let st;
  try { st = statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  const mp = path.join(dir, 'meta.json');
  if (!existsSync(mp)) continue;
  try {
    const meta = JSON.parse(readFileSync(mp, 'utf8'));
    meta.sub = meta.sub || name; // trust the directory name as the link target
    entries.push(meta);
  } catch (e) {
    console.error(`skip ${name}: bad meta.json (${e && e.message})`);
  }
}

// main first, then PRs by number descending; anything else alphabetical.
entries.sort((a, b) => {
  const rank = (m) => (m.kind === 'main' ? 0 : m.kind === 'pr' ? 1 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) return (b.pr || 0) - (a.pr || 0);
  return String(a.sub).localeCompare(String(b.sub));
});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const pillClass = (m) => (m == null ? 'na' : m === 100 ? 'perfect' : m >= 99 ? 'high' : 'ok');
const summaryText = (s) => {
  if (!s || !s.fixtures) return 'no results';
  const low = s.lowest == null ? '—' : `${s.lowest}%`;
  return `${s.perfect}/${s.fixtures} pixel-perfect · lowest ${low}`;
};

const cards = entries.map((m) => {
  const href = `${encodeURIComponent(m.sub)}/`;
  const thumbSrc = m.thumb && m.thumb.file ? `${encodeURIComponent(m.sub)}/${m.thumb.file}` : null;
  const isMain = m.kind === 'main';
  const badge = isMain
    ? '<span class="chip chip--main">main</span>'
    : (m.pr ? `<span class="chip chip--pr">PR #${m.pr}</span>` : '<span class="chip">preview</span>');
  const low = m.summary && m.summary.lowest;
  const pill = pillClass(low);
  return `
      <a class="card${isMain ? ' card--main' : ''}" href="${href}">
        <div class="thumb">
          ${thumbSrc
            ? `<img loading="lazy" alt="Snapshot of ${esc(m.sub)}" src="${thumbSrc}" />`
            : '<div class="thumb__none">no snapshot</div>'}
          <span class="pill pill--${pill}"><span class="dot"></span>${low == null ? 'n/a' : `${low}%`}</span>
        </div>
        <div class="body">
          <div class="row">
            ${badge}
            ${m.branch ? `<span class="branch mono" title="head branch / worktree">${esc(m.branch)}</span>` : ''}
          </div>
          <p class="title">${esc(m.title) || (isMain ? 'Canonical dashboard' : m.sub)}</p>
          <p class="sub">${esc(summaryText(m.summary))}${m.sha ? ` · <span class="mono">${esc(m.sha)}</span>` : ''}</p>
        </div>
      </a>`;
}).join('\n');

const empty = `
      <div class="empty">
        <p>No fidelity dashboards published yet.</p>
        <p class="sub">They appear here automatically once the fidelity workflow runs on a pull request or a merge to <span class="mono">main</span>.</p>
      </div>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OSS · JS renderer fidelity — dashboards</title>
<style>
  :root {
    --ground: #f5f6f8; --surface: #ffffff; --surface-2: #fbfcfd;
    --ink: #171a20; --muted: #5c6472; --hairline: #e6e9ee;
    --accent: #3b6ea5; --accent-ink: #2c567f;
    --good: #128a5b; --good-bg: #e4f4ec; --high: #9a7b1f; --high-bg: #f6efd9;
    --shadow: 0 1px 2px rgba(20,28,40,.05), 0 8px 24px -12px rgba(20,28,40,.18);
    --radius: 14px;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0c0f13; --surface: #14181f; --surface-2: #11151b;
      --ink: #e9ebf0; --muted: #98a1b0; --hairline: #232a34;
      --accent: #6aa3dd; --accent-ink: #8fbdea;
      --good: #35c489; --good-bg: #10281e; --high: #d8b24e; --high-bg: #2a2411;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 12px 30px -16px rgba(0,0,0,.6);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink); font-family: var(--sans);
    line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: clamp(20px, 4vw, 56px); }
  .eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--accent-ink); margin: 0 0 10px; }
  h1 { font-size: clamp(26px, 4vw, 40px); line-height: 1.1; margin: 0 0 12px; letter-spacing: -.02em;
    text-wrap: balance; font-weight: 680; }
  .lede { max-width: 64ch; color: var(--muted); font-size: 16px; margin: 0; }
  .lede code { font-family: var(--mono); font-size: .9em; background: var(--surface-2);
    border: 1px solid var(--hairline); border-radius: 5px; padding: 1px 6px; color: var(--ink); }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px;
    margin-top: 30px; }
  .card { display: flex; flex-direction: column; text-decoration: none; color: inherit;
    background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--radius);
    overflow: hidden; box-shadow: var(--shadow); transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
  .card:hover { transform: translateY(-3px);
    box-shadow: var(--shadow), 0 14px 30px -14px rgba(20,28,40,.28); border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline)); }
  .card--main { border-color: color-mix(in srgb, var(--accent) 55%, var(--hairline));
    box-shadow: var(--shadow), 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }
  .thumb { position: relative; aspect-ratio: 4 / 3; background:
    repeating-conic-gradient(#0000 0% 25%, color-mix(in srgb, var(--muted) 8%, transparent) 0% 50%) 50% / 18px 18px;
    border-bottom: 1px solid var(--hairline); display: flex; align-items: center; justify-content: center; }
  .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .thumb__none { color: var(--muted); font-family: var(--mono); font-size: 13px; }
  .pill { position: absolute; top: 10px; right: 10px; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600; font-family: var(--mono); padding: 3px 9px 3px 8px; border-radius: 20px;
    border: 1px solid transparent; backdrop-filter: blur(4px); }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; }
  .pill--perfect { color: var(--good); background: var(--good-bg); border-color: color-mix(in srgb, var(--good) 30%, transparent); }
  .pill--perfect .dot { background: var(--good); }
  .pill--high, .pill--ok { color: var(--high); background: var(--high-bg); border-color: color-mix(in srgb, var(--high) 30%, transparent); }
  .pill--high .dot, .pill--ok .dot { background: var(--high); }
  .pill--na { color: var(--muted); background: var(--surface-2); border-color: var(--hairline); }
  .pill--na .dot { background: var(--muted); }

  .body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 7px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .chip { font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .03em;
    padding: 2px 8px; border-radius: 20px; border: 1px solid var(--hairline); color: var(--muted); background: var(--surface-2); }
  .chip--main { color: var(--accent-ink); background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
  .chip--pr { color: var(--accent-ink); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
  .branch { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .title { margin: 2px 0 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
  .sub { margin: 0; font-size: 13px; color: var(--muted); }

  .empty { grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--muted); }
  .empty p { margin: 6px 0; }

  footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--hairline);
    color: var(--muted); font-size: 13px; }
  footer a { color: var(--accent-ink); }
</style>
</head>
<body>
<div class="wrap">
  <p class="eyebrow">OpenStrandStudio &middot; OpenStrandJS &middot; render fidelity</p>
  <h1>Fidelity dashboards</h1>
  <p class="lede">Each card is one run of the pixel-fidelity harness &mdash; the JS/Paper.js renderer checked
    against the real <strong>OpenStrandStudio</strong> Qt oracle. The <code>main</code> card tracks the latest merged
    state; every open pull request gets its own preview. Open a card for the full OSS&nbsp;&middot;&nbsp;JS&nbsp;&middot;&nbsp;diff breakdown.</p>

  <div class="grid">
${entries.length ? cards : empty}
  </div>

  <footer>
    Generated by <a href="https://claude.ai/code">Claude Code</a> &middot; OSS-vs-JS fidelity harness
    (<code>.github/workflows/fidelity.yml</code>). This gallery rebuilds itself whenever a dashboard is published.
  </footer>
</div>
</body>
</html>`;

writeFileSync(path.join(fidelityDir, 'index.html'), html);
console.log(`index -> ${path.join(fidelityDir, 'index.html')} (${entries.length} dashboard${entries.length === 1 ? '' : 's'})`);
