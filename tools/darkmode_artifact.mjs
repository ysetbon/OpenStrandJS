// Build a single self-contained artifacts/darkmode/index.html from the screenshots
// that tools/darkmode_shots.mjs produced. Every PNG is embedded as a base64 data
// URI so the file is portable (openable straight from a CI artifact download, no
// server, no loose files). Each window shows its themes side by side — dark first
// and largest, with light/default as reference — so a reviewer can confirm the
// dark theme matches OSS at a glance.
//
//   node tools/darkmode_artifact.mjs [artifactsDir]   (default: artifacts/darkmode)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = path.resolve(root, process.argv[2] || 'artifacts/darkmode');
const manifestPath = path.join(dir, 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error(`FAIL: ${manifestPath} not found — run tools/darkmode_shots.mjs first`);
  process.exit(1);
}

const { themes, shots } = JSON.parse(readFileSync(manifestPath, 'utf8'));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dataUri(rel) {
  const file = path.join(dir, rel);
  if (!existsSync(file)) return null;
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

// Group shots by window id, preserving first-seen order (registry order from the
// dark pass, which the harness emits first).
const byId = new Map();
for (const s of shots) {
  if (!byId.has(s.id)) byId.set(s.id, { id: s.id, title: s.title, category: s.category, note: s.note, byTheme: {} });
  byId.get(s.id).byTheme[s.theme] = s.file;
}
const windows = [...byId.values()];

// Order themes with dark first (the focus), then whatever else was captured.
const orderedThemes = ['dark', ...themes.filter((t) => t !== 'dark')].filter((t) => themes.includes(t));

const CATS = { main: 'Main window & canvas', panel: 'Panels', dialog: 'Dialogs', settings: 'Settings pages', menu: 'Context menus' };
const catOrder = ['main', 'panel', 'settings', 'dialog', 'menu'];
const grouped = catOrder.map((cat) => ({ cat, label: CATS[cat] || cat, items: windows.filter((w) => w.category === cat) })).filter((g) => g.items.length);

const cards = grouped.map((g) => {
  const items = g.items.map((w) => {
    const shotsHtml = orderedThemes.map((theme) => {
      const uri = w.byTheme[theme] ? dataUri(w.byTheme[theme]) : null;
      const cls = theme === 'dark' ? 'shot dark' : 'shot';
      return `<figure class="${cls}">
        <figcaption>${esc(theme)}</figcaption>
        ${uri ? `<img loading="lazy" src="${uri}" alt="${esc(w.title)} — ${esc(theme)}">` : '<div class="missing">— not captured —</div>'}
      </figure>`;
    }).join('');
    return `<article class="win" id="win-${esc(w.id)}">
      <h3>${esc(w.title)} ${w.note ? `<span class="note">(${esc(w.note)})</span>` : ''}<span class="wid">${esc(w.id)}</span></h3>
      <div class="shots">${shotsHtml}</div>
    </article>`;
  }).join('');
  return `<section><h2>${esc(g.label)} <span class="count">${g.items.length}</span></h2>${items}</section>`;
}).join('');

const total = windows.length;
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenStrandJS — dark-mode window gallery</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #1b1b1d; color: #eaeaea; font: 14px/1.5 system-ui, -apple-system, sans-serif; }
  header { padding: 20px 24px; border-bottom: 1px solid #34343a; position: sticky; top: 0; background: #1b1b1dee; backdrop-filter: blur(6px); z-index: 5; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header p { margin: 0; color: #9a9aa2; }
  main { padding: 8px 24px 64px; max-width: 1600px; margin: 0 auto; }
  section { margin: 28px 0; }
  section > h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .08em; color: #b7b7c0; border-bottom: 1px solid #34343a; padding-bottom: 6px; }
  section > h2 .count { color: #6f6f78; font-weight: 400; }
  .win { margin: 18px 0 26px; }
  .win h3 { font-size: 15px; margin: 0 0 8px; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .win h3 .wid { margin-left: auto; font: 11px monospace; color: #6f6f78; }
  .win h3 .note { font-weight: 400; font-size: 12px; color: #8a8a93; }
  .shots { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
  figure { margin: 0; background: #232327; border: 1px solid #34343a; border-radius: 8px; padding: 8px; }
  figure.dark { border-color: #4a6fa5; box-shadow: 0 0 0 1px #4a6fa544; }
  figcaption { font: 11px/1 monospace; text-transform: uppercase; letter-spacing: .06em; color: #9a9aa2; margin-bottom: 6px; }
  figure.dark figcaption { color: #7fa8e0; }
  img { display: block; max-width: 100%; height: auto; border-radius: 4px; background: #fff; }
  /* Dark shots get more room (they're the point); reference themes are smaller. */
  figure.dark img { width: min(720px, 90vw); }
  figure:not(.dark) img { width: min(360px, 70vw); }
  .missing { color: #b06; padding: 30px; font-style: italic; }
  a.jump { color: #7fa8e0; text-decoration: none; }
  nav.toc { columns: 3; column-gap: 24px; margin: 12px 0 0; padding: 0; list-style: none; font-size: 13px; }
  nav.toc li { break-inside: avoid; margin: 2px 0; }
  @media (max-width: 720px) { nav.toc { columns: 1; } figure.dark img { width: 100%; } }
</style>
</head>
<body>
<header>
  <h1>OpenStrandJS — dark-mode window gallery</h1>
  <p>${total} windows · themes: ${esc(orderedThemes.join(', '))} · dark is outlined in blue. Screenshots are the real components rendered by the app; compare dark against the light/default reference to confirm OSS-faithful theming.</p>
  <nav class="toc"><ul style="margin:8px 0 0;padding:0;list-style:none;columns:4">
    ${windows.map((w) => `<li><a class="jump" href="#win-${esc(w.id)}">${esc(w.title)}</a></li>`).join('')}
  </ul></nav>
</header>
<main>
${cards}
</main>
</body>
</html>`;

const out = path.join(dir, 'index.html');
writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)} (${total} windows, themes: ${orderedThemes.join(', ')}, ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB)`);
