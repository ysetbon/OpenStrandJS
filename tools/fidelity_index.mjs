// Regenerate the fidelity GALLERY / landing page at <fidelityDir>/index.html.
//
// It scans every <fidelityDir>/<sub>/meta.json (written by tools/fidelity_entry.mjs)
// and renders one card per dashboard: a snapshot thumbnail, the PR number and
// head branch/worktree name, a short description, the match summary, and a link
// into <sub>/. Cards are sorted with the canonical `main` dashboard first, then
// pull requests by number descending (newest PR first).
//
// Each card whose entry has more than one example lets you TOGGLE which example
// is shown as the snapshot (client-side preview). Persisting that choice is
// admin-only: a "Set as card thumbnail" button deep-links to the fidelity-thumb
// workflow_dispatch page, which GitHub only lets repo writers open and which
// additionally guards for admin permission. The persisted pick is stored in
// meta.selected and survives later fidelity re-runs.
//
// Usage: node tools/fidelity_index.mjs <fidelityDir>
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const fidelityDir = process.argv[2];
if (!fidelityDir) {
  console.error('usage: node tools/fidelity_index.mjs <fidelityDir>');
  process.exit(2);
}

const REPO = process.env.GITHUB_REPOSITORY || 'ysetbon/OpenStrandJS';
const THUMB_WORKFLOW = 'fidelity-thumb.yml';
const workflowUrl = `https://github.com/${REPO}/actions/workflows/${THUMB_WORKFLOW}`;

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
const escAttr = (s) => esc(s).replace(/'/g, '&#39;');

const pillClass = (m) => (m == null ? 'na' : m === 100 ? 'perfect' : m >= 99 ? 'high' : 'ok');
const summaryText = (s) => {
  if (!s || !s.fixtures) return 'no results';
  const low = s.lowest == null ? '—' : `${s.lowest}%`;
  return `${s.perfect}/${s.fixtures} pixel-perfect · lowest ${low}`;
};

const cards = entries.map((m) => {
  const subEnc = encodeURIComponent(m.sub);
  const href = `${subEnc}/`;
  const thumbs = Array.isArray(m.thumbs) ? m.thumbs : [];
  const selected = m.selected || (thumbs[0] && thumbs[0].fixture) || null;
  // Prefer live per-example snapshots; fall back to the flat thumb.png.
  const selThumb = thumbs.find((t) => t.fixture === selected);
  const thumbSrc = selThumb ? `${subEnc}/${selThumb.file}` : (m.thumb && m.thumb.file ? `${subEnc}/${m.thumb.file}` : null);
  const isMain = m.kind === 'main';
  const badge = isMain
    ? '<span class="chip chip--main">main</span>'
    : (m.pr ? `<span class="chip chip--pr">PR #${m.pr}</span>` : '<span class="chip">preview</span>');
  const low = m.summary && m.summary.lowest;
  const pill = pillClass(low);

  // Data for the client-side toggle: [{fixture, file}] relative to this sub.
  const toggleData = escAttr(JSON.stringify(thumbs.map((t) => ({ fixture: t.fixture, src: `${subEnc}/${t.file}` }))));
  const canToggle = thumbs.length > 1;

  const dots = canToggle
    ? `<div class="dots" role="tablist" aria-label="Choose example snapshot">${thumbs.map((t, i) =>
        `<button class="dot${t.fixture === selected ? ' on' : ''}" data-i="${i}" title="${escAttr(t.fixture)}" aria-label="${escAttr(t.fixture)}"></button>`).join('')}</div>`
    : '';
  const nav = canToggle
    ? `<button class="nav prev" aria-label="Previous example" title="Previous example">‹</button>
       <button class="nav next" aria-label="Next example" title="Next example">›</button>`
    : '';

  const adminBlock = canToggle
    ? `<div class="admin">
         <span class="hint mono">to persist: run <b>${THUMB_WORKFLOW}</b> with <span class="kv">sub=<span class="cur-sub">${esc(m.sub)}</span></span> <span class="kv">fixture=<span class="cur-fix">${esc(selected || '')}</span></span></span>
         <a class="admin-btn" href="${workflowUrl}" target="_blank" rel="noopener">Set as card thumbnail (admin) &#8599;</a>
       </div>`
    : '';

  return `
      <article class="card${isMain ? ' card--main' : ''}" data-sub="${escAttr(m.sub)}" data-selected="${escAttr(selected || '')}" data-thumbs='${toggleData}'>
        <div class="thumb">
          <a class="thumb__link" href="${href}" aria-label="Open ${esc(m.sub)} dashboard">
            ${thumbSrc
              ? `<img class="snap" loading="lazy" alt="Snapshot of ${esc(m.sub)}" src="${thumbSrc}" />`
              : '<div class="thumb__none">no snapshot</div>'}
          </a>
          <span class="pill pill--${pill}"><span class="dot-ind"></span>${low == null ? 'n/a' : `${low}%`}</span>
          ${nav}
          <div class="snapbar">
            ${canToggle ? `<span class="snaplabel mono">example: <span class="cur-fix">${esc(selected || '')}</span></span>` : ''}
            ${dots}
          </div>
        </div>
        <div class="body">
          <div class="row">
            ${badge}
            ${m.branch ? `<span class="branch mono" title="head branch / worktree">${esc(m.branch)}</span>` : ''}
          </div>
          <a class="title-link" href="${href}"><p class="title">${esc(m.title) || (isMain ? 'Canonical dashboard' : m.sub)}</p></a>
          <p class="sub">${esc(summaryText(m.summary))}${m.sha ? ` · <span class="mono">${esc(m.sha)}</span>` : ''}</p>
          ${adminBlock}
        </div>
      </article>`;
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
  a { color: inherit; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: clamp(20px, 4vw, 56px); }
  .eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--accent-ink); margin: 0 0 10px; }
  h1 { font-size: clamp(26px, 4vw, 40px); line-height: 1.1; margin: 0 0 12px; letter-spacing: -.02em;
    text-wrap: balance; font-weight: 680; }
  .lede { max-width: 64ch; color: var(--muted); font-size: 16px; margin: 0; }
  .lede code { font-family: var(--mono); font-size: .9em; background: var(--surface-2);
    border: 1px solid var(--hairline); border-radius: 5px; padding: 1px 6px; color: var(--ink); }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px;
    margin-top: 30px; }
  .card { display: flex; flex-direction: column;
    background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--radius);
    overflow: hidden; box-shadow: var(--shadow); transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
  .card:hover { transform: translateY(-3px);
    box-shadow: var(--shadow), 0 14px 30px -14px rgba(20,28,40,.28); border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline)); }
  .card--main { border-color: color-mix(in srgb, var(--accent) 55%, var(--hairline));
    box-shadow: var(--shadow), 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }
  .thumb { position: relative; aspect-ratio: 4 / 3; background:
    repeating-conic-gradient(#0000 0% 25%, color-mix(in srgb, var(--muted) 8%, transparent) 0% 50%) 50% / 18px 18px;
    border-bottom: 1px solid var(--hairline); }
  .thumb__link { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-decoration: none; }
  .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .thumb__none { color: var(--muted); font-family: var(--mono); font-size: 13px; }
  .pill { position: absolute; top: 10px; right: 10px; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600; font-family: var(--mono); padding: 3px 9px 3px 8px; border-radius: 20px;
    border: 1px solid transparent; backdrop-filter: blur(4px); z-index: 2; }
  .pill .dot-ind { width: 7px; height: 7px; border-radius: 50%; }
  .pill--perfect { color: var(--good); background: var(--good-bg); border-color: color-mix(in srgb, var(--good) 30%, transparent); }
  .pill--perfect .dot-ind { background: var(--good); }
  .pill--high, .pill--ok { color: var(--high); background: var(--high-bg); border-color: color-mix(in srgb, var(--high) 30%, transparent); }
  .pill--high .dot-ind, .pill--ok .dot-ind { background: var(--high); }
  .pill--na { color: var(--muted); background: var(--surface-2); border-color: var(--hairline); }
  .pill--na .dot-ind { background: var(--muted); }

  .nav { position: absolute; top: 50%; transform: translateY(-50%); z-index: 3;
    width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--hairline);
    background: color-mix(in srgb, var(--surface) 82%, transparent); color: var(--ink);
    font-size: 18px; line-height: 1; cursor: pointer; backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s ease; }
  .thumb:hover .nav, .nav:focus-visible { opacity: 1; }
  .nav.prev { left: 8px; } .nav.next { right: 8px; }
  .nav:hover { border-color: var(--accent); }

  .snapbar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 6px 10px; background: linear-gradient(transparent, color-mix(in srgb, var(--surface) 78%, transparent) 55%); }
  .snaplabel { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dots { display: flex; gap: 5px; }
  .dot { width: 8px; height: 8px; padding: 0; border-radius: 50%; cursor: pointer;
    border: 1px solid color-mix(in srgb, var(--muted) 55%, transparent); background: transparent; }
  .dot.on { background: var(--accent); border-color: var(--accent); }

  .body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 7px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .chip { font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .03em;
    padding: 2px 8px; border-radius: 20px; border: 1px solid var(--hairline); color: var(--muted); background: var(--surface-2); }
  .chip--main { color: var(--accent-ink); background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
  .chip--pr { color: var(--accent-ink); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
  .branch { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .title-link { text-decoration: none; }
  .title { margin: 2px 0 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
  .title-link:hover .title { color: var(--accent-ink); }
  .sub { margin: 0; font-size: 13px; color: var(--muted); }

  .admin { margin-top: 8px; padding-top: 10px; border-top: 1px dashed var(--hairline);
    display: flex; flex-direction: column; gap: 7px; }
  .hint { font-size: 11px; color: var(--muted); line-height: 1.5; }
  .hint .kv { display: inline-block; background: var(--surface-2); border: 1px solid var(--hairline);
    border-radius: 5px; padding: 0 5px; margin-right: 4px; color: var(--ink); }
  .admin-btn { align-self: flex-start; font-size: 12px; font-weight: 600; text-decoration: none;
    color: var(--accent-ink); background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent); border-radius: 8px; padding: 5px 11px; }
  .admin-btn:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }

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
    state; every open pull request gets its own preview. Hover a card to flip through its examples, then open it for the
    full OSS&nbsp;&middot;&nbsp;JS&nbsp;&middot;&nbsp;diff breakdown.</p>

  <div class="grid">
${entries.length ? cards : empty}
  </div>

  <footer>
    Generated by <a href="https://claude.ai/code">Claude Code</a> &middot; OSS-vs-JS fidelity harness
    (<code>.github/workflows/fidelity.yml</code>). This gallery rebuilds itself whenever a dashboard is published.
    Choosing a card's representative example is admin-only (runs <code>${THUMB_WORKFLOW}</code>).
  </footer>
</div>
<script>
  // Client-side snapshot toggle: cycle each card's <img> through its examples.
  // Preview only — persisting the choice runs the admin-gated fidelity-thumb
  // workflow (see each card's "Set as card thumbnail" button).
  for (const card of document.querySelectorAll('.card[data-thumbs]')) {
    let thumbs;
    try { thumbs = JSON.parse(card.getAttribute('data-thumbs') || '[]'); } catch { thumbs = []; }
    if (thumbs.length < 2) continue;
    const img = card.querySelector('img.snap');
    const dots = [...card.querySelectorAll('.dot')];
    const fixEls = [...card.querySelectorAll('.cur-fix')];
    let i = Math.max(0, thumbs.findIndex((t) => t.fixture === card.getAttribute('data-selected')));
    if (i < 0) i = 0;
    const show = (n) => {
      i = (n + thumbs.length) % thumbs.length;
      if (img) img.src = thumbs[i].src;
      dots.forEach((d, k) => d.classList.toggle('on', k === i));
      fixEls.forEach((el) => { el.textContent = thumbs[i].fixture; });
    };
    const prev = card.querySelector('.nav.prev');
    const next = card.querySelector('.nav.next');
    if (prev) prev.addEventListener('click', (e) => { e.preventDefault(); show(i - 1); });
    if (next) next.addEventListener('click', (e) => { e.preventDefault(); show(i + 1); });
    dots.forEach((d) => d.addEventListener('click', (e) => { e.preventDefault(); show(Number(d.dataset.i)); }));
    show(i);
  }
</script>
</body>
</html>`;

writeFileSync(path.join(fidelityDir, 'index.html'), html);
console.log(`index -> ${path.join(fidelityDir, 'index.html')} (${entries.length} dashboard${entries.length === 1 ? '' : 's'})`);
