// Build a self-contained fidelity dashboard (montages embedded as data URIs)
// from fidelity-baselines.json + artifacts/fidelity/<fixture>/montage.png.
// Output: artifacts/fidelity/artifact.html (content only; no <html>/<head>/<body>
// wrappers, per the Artifact publisher).
//
// Usage: node tools/fidelity_artifact.mjs [oss_sha]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const OSS_SHA = (process.argv[2] || '0d751d90f79c97c7ea9994fd02234fe066935a47').slice(0, 10);
const OUT = path.join(process.cwd(), 'artifacts', 'fidelity');
const baselines = JSON.parse(readFileSync(path.join(process.cwd(), 'fidelity-baselines.json'), 'utf8'));

// Real content: what each fixture actually exercises.
const NOTES = {
  single_strand: 'One plain strand — baseline body geometry, stroke width, and end caps.',
  closed_knot: 'Four attached strands forming a closed loop; every attachment start is unfolded (transparent).',
  three_strand_braid: 'A 21-strand over/under braid with 15 unfolded attachment starts.',
  overhand_knot: 'A knot with masked crossings, folded attached starts, and shadows on.',
  box_stitch: 'The densest case — masked crossings plus cast shadows.',
  unfolded_shadow: 'The closed knot with shadows ON — the exact case this change fixes (shadow of unfolded strands).',
};
const ORDER = ['unfolded_shadow', 'single_strand', 'closed_knot', 'three_strand_braid', 'box_stitch', 'overhand_knot'];

const dataUri = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');

const rows = ORDER.filter((f) => baselines[f]).map((f) => {
  const b = baselines[f];
  const mp = path.join(OUT, f, 'montage.png');
  return {
    fixture: f,
    match: b.match_pct,
    w: b.width,
    h: b.height,
    note: NOTES[f] || '',
    img: existsSync(mp) ? dataUri(mp) : null,
    isTarget: f === 'unfolded_shadow',
  };
});

const perfect = rows.filter((r) => r.match === 100).length;
const lowest = Math.min(...rows.map((r) => r.match));
const statusClass = (m) => (m === 100 ? 'perfect' : m >= 99 ? 'high' : 'ok');
const statusWord = (m) => (m === 100 ? 'pixel-perfect' : m >= 99 ? 'near-perfect' : 'matched');

const cards = rows.map((r) => `
      <article class="card${r.isTarget ? ' card--target' : ''}">
        <header class="card__head">
          <div class="card__id">
            <span class="mono card__name">${r.fixture}</span>
            ${r.isTarget ? '<span class="tag">this fix</span>' : ''}
          </div>
          <div class="card__meta">
            <span class="pill pill--${statusClass(r.match)}"><span class="dot"></span><span class="mono">${r.match}%</span> ${statusWord(r.match)}</span>
            <span class="mono dims">${r.w}&times;${r.h}</span>
          </div>
        </header>
        <p class="card__note">${r.note}</p>
        <div class="triptych">
          <div class="triptych__labels" aria-hidden="true">
            <span>OpenStrandStudio (Qt oracle)</span><span>JS renderer</span><span>pixel diff</span>
          </div>
          <div class="frame">
            ${r.img ? `<img loading="lazy" alt="${r.fixture}: OpenStrandStudio, JS renderer, and pixel diff side by side" src="${r.img}" />` : '<div class="frame__missing">montage unavailable</div>'}
          </div>
        </div>
      </article>`).join('\n');

const html = `<title>OSS · JS renderer fidelity</title>
<style>
  :root {
    --ground: #f5f6f8; --surface: #ffffff; --surface-2: #fbfcfd;
    --ink: #171a20; --muted: #5c6472; --hairline: #e6e9ee;
    --accent: #3b6ea5; --accent-ink: #2c567f;
    --good: #128a5b; --good-bg: #e4f4ec;
    --high: #9a7b1f; --high-bg: #f6efd9;
    --diff: #c33d86;
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
      --good: #35c489; --good-bg: #10281e;
      --high: #d8b24e; --high-bg: #2a2411;
      --diff: #e468a8;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 12px 30px -16px rgba(0,0,0,.6);
    }
  }
  :root[data-theme="light"] {
    --ground: #f5f6f8; --surface: #ffffff; --surface-2: #fbfcfd;
    --ink: #171a20; --muted: #5c6472; --hairline: #e6e9ee;
    --accent: #3b6ea5; --accent-ink: #2c567f;
    --good: #128a5b; --good-bg: #e4f4ec; --high: #9a7b1f; --high-bg: #f6efd9; --diff: #c33d86;
    --shadow: 0 1px 2px rgba(20,28,40,.05), 0 8px 24px -12px rgba(20,28,40,.18);
  }
  :root[data-theme="dark"] {
    --ground: #0c0f13; --surface: #14181f; --surface-2: #11151b;
    --ink: #e9ebf0; --muted: #98a1b0; --hairline: #232a34;
    --accent: #6aa3dd; --accent-ink: #8fbdea;
    --good: #35c489; --good-bg: #10281e; --high: #d8b24e; --high-bg: #2a2411; --diff: #e468a8;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 12px 30px -16px rgba(0,0,0,.6);
  }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink); font-family: var(--sans);
    line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: clamp(20px, 4vw, 56px); }

  .eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--accent-ink); margin: 0 0 10px; }
  h1 { font-size: clamp(26px, 4vw, 40px); line-height: 1.1; margin: 0 0 12px; letter-spacing: -.02em;
    text-wrap: balance; font-weight: 680; }
  .lede { max-width: 62ch; color: var(--muted); font-size: 16px; margin: 0; }
  .lede code { font-family: var(--mono); font-size: .9em; background: var(--surface-2);
    border: 1px solid var(--hairline); border-radius: 5px; padding: 1px 6px; color: var(--ink); }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px;
    margin: 28px 0 8px; }
  .stat { background: var(--surface); border: 1px solid var(--hairline); border-radius: 12px;
    padding: 16px 18px; box-shadow: var(--shadow); }
  .stat__k { font-family: var(--mono); font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 6px; }
  .stat__v { font-size: 26px; font-weight: 680; letter-spacing: -.01em; }
  .stat__v small { font-size: 14px; color: var(--muted); font-weight: 500; }

  .legend { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 24px 0 4px; padding: 14px 18px;
    background: var(--surface-2); border: 1px solid var(--hairline); border-radius: 12px;
    font-size: 13.5px; color: var(--muted); }
  .legend b { color: var(--ink); font-weight: 620; }
  .legend .swatch { color: var(--diff); font-weight: 700; }

  .cards { display: flex; flex-direction: column; gap: 20px; margin-top: 24px; }
  .card { background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--radius);
    padding: 18px 18px 20px; box-shadow: var(--shadow); }
  .card--target { border-color: color-mix(in srgb, var(--accent) 55%, var(--hairline));
    box-shadow: var(--shadow), 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }
  .card__head { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center;
    justify-content: space-between; }
  .card__id { display: flex; align-items: center; gap: 10px; }
  .card__name { font-size: 16px; font-weight: 600; color: var(--ink); }
  .tag { font-family: var(--mono); font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
    color: var(--accent-ink); background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    padding: 2px 8px; border-radius: 20px; }
  .card__meta { display: flex; align-items: center; gap: 12px; }
  .dims { color: var(--muted); font-size: 13px; }
  .pill { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 550;
    padding: 4px 11px 4px 9px; border-radius: 20px; border: 1px solid transparent; }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; }
  .pill--perfect { color: var(--good); background: var(--good-bg);
    border-color: color-mix(in srgb, var(--good) 30%, transparent); }
  .pill--perfect .dot { background: var(--good); }
  .pill--high, .pill--ok { color: var(--high); background: var(--high-bg);
    border-color: color-mix(in srgb, var(--high) 30%, transparent); }
  .pill--high .dot, .pill--ok .dot { background: var(--high); }

  .card__note { margin: 12px 0 14px; color: var(--muted); font-size: 14px; max-width: 70ch; }

  .triptych__labels { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
    font-family: var(--mono); font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 7px; padding: 0 2px; }
  .triptych__labels span:nth-child(2) { text-align: center; }
  .triptych__labels span:nth-child(3) { text-align: right; }
  .frame { overflow-x: auto; border: 1px solid var(--hairline); border-radius: 10px;
    background: repeating-conic-gradient(#0000 0% 25%, color-mix(in srgb, var(--muted) 8%, transparent) 0% 50%) 50% / 18px 18px; }
  .frame img { display: block; width: 100%; height: auto; max-width: 100%; }
  .frame__missing { padding: 40px; text-align: center; color: var(--muted); font-family: var(--mono); }

  footer { margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--hairline);
    color: var(--muted); font-size: 13px; }
  footer a { color: var(--accent-ink); }
  @media (prefers-reduced-motion: no-preference) {
    .card { animation: rise .5s cubic-bezier(.2,.7,.3,1) both; }
    .card:nth-child(2){animation-delay:.04s}.card:nth-child(3){animation-delay:.08s}
    .card:nth-child(4){animation-delay:.12s}.card:nth-child(5){animation-delay:.16s}.card:nth-child(6){animation-delay:.2s}
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
  }
</style>

<div class="wrap">
  <p class="eyebrow">OpenStrandStudio &middot; OpenStrandJS &middot; render fidelity</p>
  <h1>The JS renderer, checked pixel-for-pixel against the real Qt app</h1>
  <p class="lede">Every fixture below is rendered twice from the <em>same</em> saved JSON &mdash; once by the real
    <strong>OpenStrandStudio</strong> Qt canvas (the pixel oracle, pinned at <code>${OSS_SHA}</code>) and once by the
    <strong>OpenStrandJS</strong> Paper.js renderer &mdash; then diffed. Higher match% means closer to the original.</p>

  <section class="stats" aria-label="Summary">
    <div class="stat"><p class="stat__k">Fixtures</p><div class="stat__v">${rows.length}</div></div>
    <div class="stat"><p class="stat__k">Pixel-perfect</p><div class="stat__v">${perfect}<small> / ${rows.length} at 100%</small></div></div>
    <div class="stat"><p class="stat__k">Lowest match</p><div class="stat__v mono">${lowest}<small>%</small></div></div>
    <div class="stat"><p class="stat__k">Oracle @</p><div class="stat__v mono" style="font-size:18px">${OSS_SHA}</div></div>
  </section>

  <div class="legend">
    <span>Each strip, left to right: <b>OpenStrandStudio</b> (ground truth) &middot; <b>JS renderer</b> &middot; <b>pixel diff</b>.</span>
    <span>A near-white diff panel means the two are near-identical; <span class="swatch">magenta</span> marks differing pixels.</span>
  </div>

  <div class="cards">
${cards}
  </div>

  <footer>
    Generated by <a href="https://claude.ai/code">Claude Code</a> &middot; OSS-vs-JS fidelity harness.
    The same comparison runs in CI on every pull request (<code>.github/workflows/fidelity.yml</code>) and posts these images inline.
  </footer>
</div>`;

writeFileSync(path.join(OUT, 'artifact.html'), html);
console.log(`artifact -> ${path.join(OUT, 'artifact.html')} (${(html.length / 1024).toFixed(0)} KB, ${rows.length} fixtures, ${perfect} perfect)`);
