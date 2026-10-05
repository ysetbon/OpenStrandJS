// Guard for the interaction overlay (#overlay) at display scales 1, 1.25, 1.5
// and 2 (OpenStrand Studio 2.0 selection_utils._paint_selection_border, commit
// d190260: the ring is painted in the device's PHYSICAL pixels, so it is exact
// at 125 %, 150 % and 200 %).
//
// What the port does at a devicePixelRatio d > 1:
//   * #c (strand-renderer.js compositeTo) keeps a CSS-pixel backing store; the
//     browser upscales it, so the strand body is as soft as at d = 1 scaled up.
//   * #overlay has a backing store of round(css * d) physical pixels and draws
//     through a matching setTransform (renderScheduler.syncOverlay), so the
//     hover outline and the mask-mode border are crisp, the way Qt draws them.
// Both canvases occupy the same CSS box and the overlay is computed from the
// same world->screen geometry as the body, so they stay aligned.
//
// Measured along a scanline across a straight horizontal strand (zoom 1 and
// zoom 1.5), for the select-mode hover outline (2px black, select_mode.py:128)
// and the mask-mode pick border (stroke_width * 2 at black@128,
// mask_mode.py:270):
//   * #overlay's backing store is the physical size and its CSS box is #c's;
//   * in the overlay's own pixels, each ring runs from the body's edge out to
//     exactly its CSS width, with one antialiased pixel per edge;
//   * on screen (a device-pixel screenshot, #c under #overlay), the body edge
//     is where the geometry puts it, each ring starts on it and is its CSS
//     width thick — the same numbers as at d = 1 — and the ring's outer edge
//     has at most one partial device pixel at d = 2 (two at 1.25 / 1.5, where
//     #c's box itself sits on fractional device pixels). Before the overlay
//     went physical it had two at d = 2, the browser-upscaled CSS-px raster.
// Every edge is a 50 % crossing between neighbouring pixels, in CSS px.
//
// Drives the vite dev server (window.__store is DEV-only) in Chromium.
// Usage: node tools/dpr_overlay_check.mjs [outDir]
//        OSS_CHROMIUM=/path/to/chrome node tools/dpr_overlay_check.mjs
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(root, process.argv[2] || 'artifacts/dpr_overlay');
mkdirSync(OUT, { recursive: true });
const PORT = 5197;
const win = process.platform === 'win32';
const dev = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe', detached: !win });
dev.on('error', (e) => { console.log('FAIL  dev server did not start  ' + e.message); process.exit(1); });
const stopDev = () => {
  if (win) { spawnSync('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { stdio: 'ignore' }); return; }
  try { process.kill(-dev.pid, 'SIGTERM'); } catch { dev.kill(); }
};
await new Promise((r) => { dev.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) r(); }); setTimeout(r, 8000); });

let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const f2 = (v) => (v == null ? 'null' : v.toFixed(2));

// One straight horizontal strand: body 36 wide, 4px black stroke, flat ends.
// Its footprint is 36/2 + 4 = 22 world px either side of the centre line.
const WIDTH = 36, SW = 4, CY = 300, X0 = 260, X1 = 760;
const HALF = WIDTH / 2 + SW;
const strand = {
  type: 'Strand', index: 0, start: { x: X0, y: CY }, end: { x: X1, y: CY }, width: WIDTH,
  color: { r: 200, g: 170, b: 230, a: 255 }, stroke_color: { r: 0, g: 0, b: 0, a: 255 }, stroke_width: SW,
  has_circles: [false, false], layer_name: '1_1', set_number: 1, is_first_strand: true, is_start_side: true,
  start_line_visible: true, end_line_visible: true, is_hidden: false,
  start_extension_visible: false, end_extension_visible: false, start_arrow_visible: false,
  end_arrow_visible: false, full_arrow_visible: false, shadow_only: false, closed_connections: [false, false],
  knot_connections: {}, circle_stroke_color: { r: 0, g: 0, b: 0, a: 255 },
  control_points: [{ x: 420, y: CY }, { x: 600, y: CY }], control_point_center: { x: 510, y: CY },
  control_point_center_locked: false, is_selected: false,
};
const FIXTURE = { strands: [strand], groups: {} };
const PAN = { x: 40, y: 20 };

// Subpixel position (in device px, pixel centres at i + 0.5) where `prof`
// first crosses `thr` going from index `from` in direction `dir`.
function crossing(prof, from, dir, thr) {
  for (let i = from; i >= 0 && i + dir >= 0 && i + dir < prof.length; i += dir) {
    const a = prof[i], b = prof[i + dir];
    if ((a - thr) * (b - thr) <= 0 && a !== b) {
      const t = (thr - a) / (b - a);
      return i + 0.5 + dir * t;
    }
  }
  return null;
}
// Device pixels strictly between 10 % and 90 % of the step from `lo` (the
// outside, at smaller indices when dir > 0) to `hi` across the edge found at
// `at`: 0 or 1 for a crisp antialiased edge, 2+ for one rasterised at CSS
// resolution and upscaled. Walks out from the edge to the first pixel that is
// fully `lo` and in to the first that is fully `hi` (a thin ring's far side is
// never reached).
function softness(prof, at, dir, lo, hi) {
  if (at == null) return 99;
  const tOf = (i) => (prof[i] - lo) / (hi - lo);
  const partial = (i) => i >= 0 && i < prof.length && tOf(i) > 0.1 && tOf(i) < 0.9;
  const c = Math.floor(at);
  let n = 0;
  for (let i = c, k = 0; k < 4 && i >= 0 && i < prof.length && tOf(i) > 0.1; i -= dir, k++) if (partial(i)) n++;
  for (let i = c + dir, k = 0; k < 4 && i >= 0 && i < prof.length && tOf(i) < 0.9; i += dir, k++) if (partial(i)) n++;
  return n;
}

const results = {};
let browser;
try {
  browser = await chromium.launch(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
  for (const zoom of [1, 1.5]) {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const tag = `z${zoom}_dpr${dpr}`;
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: dpr });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 15000 });
      await page.evaluate(() => { localStorage.clear(); });

      // Set the scene, then capture the page with the given overlay state.
      const capture = async (overlay) => {
        const geo = await page.evaluate(async ({ fixture, pan, zoom, overlay, midX }) => {
          const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const S = window.__store;
          const st = S.getState();
          // Light theme: the edge measurements assume a white canvas, and the
          // default theme's canvas is #ECECEC like OSS.
          st.setSettings({ show_grid: false, show_hover_highlights: true, theme: 'light', language: 'en' });
          if (!S.getState().doc.order.includes('1_1')) {
            const doc = window.__io.loadProject(fixture);
            doc.shadow_enabled = false;
            doc.show_control_points = false;
            st.loadDocument(doc);
          }
          st.setView({ panX: pan.x, panY: pan.y, zoom, supersample: 1 });
          st.setSelection({ layerName: null, handle: null });
          st.setMode(overlay === 'mask' ? 'mask' : 'select');
          st.setMaskPending(overlay === 'mask' ? ['1_1'] : []);
          st.setHover({ layerName: overlay === 'hover' ? '1_1' : null, handle: null });
          window.__requestRender(); window.__requestOverlay();
          await raf(); await raf(); await raf();
          const c = document.getElementById('c'), o = document.getElementById('overlay');
          const rc = c.getBoundingClientRect(), ro = o.getBoundingClientRect();
          // The overlay's own pixels down the scanline (its backing store).
          const sx = o.width / ro.width;
          const x = Math.floor((pan.x + midX * zoom) * sx);
          const d = o.getContext('2d').getImageData(x, 0, 1, o.height).data;
          const alpha = [], red = [];
          for (let i = 0; i < o.height; i++) { alpha.push(d[i * 4 + 3]); red.push(d[i * 4] * d[i * 4 + 3] / 255); }
          return {
            dpr: window.devicePixelRatio,
            c: { w: c.width, h: c.height, css: [rc.left, rc.top, rc.width, rc.height] },
            o: { w: o.width, h: o.height, css: [ro.left, ro.top, ro.width, ro.height] },
            col: { alpha, red, sy: o.height / ro.height },
          };
        }, { fixture: FIXTURE, pan: PAN, zoom, overlay, midX: (X0 + X1) / 2 });
        const buf = await page.screenshot({ path: `${OUT}/${tag}_${overlay}.png` });
        return { geo, png: PNG.sync.read(buf) };
      };

      const none = await capture('none');
      const hover = await capture('hover');
      const mask = await capture('mask');
      const { geo } = none;
      const [cl, ct, cw, chh] = geo.c.css;

      // Scanline: a device column through the middle of the strand.
      const colCss = cl + PAN.x + ((X0 + X1) / 2) * zoom;
      const col = Math.round(colCss * dpr);
      const prof = (png, ch) => {
        const out = [];
        for (let y = 0; y < png.height; y++) {
          const i = (y * png.width + col) * 4;
          out.push(ch === 'lum' ? 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2] : png.data[i + 1]);
        }
        return out;
      };
      // Expected edges in page CSS px (top side of the strand; the bottom side
      // is measured too, mirrored).
      const cyCss = ct + PAN.y + CY * zoom;
      const edgeCss = [cyCss - HALF * zoom, cyCss + HALF * zoom];
      const toCss = (d) => (d == null ? null : d / dpr);
      const r = { dpr: geo.dpr, c: geo.c, o: geo.o, sides: [] };

      // The overlay bitmap alone, in its backing pixels -> page CSS px.
      const bmp = (cap, ringAlpha, fillRed, side, sgn) => {
        const { alpha, red, sy } = cap.geo.col;
        const dir = -sgn;
        const start = Math.round((edgeCss[side === 'top' ? 0 : 1] - ct + sgn * 14 * zoom) * sy);
        const outer = crossing(alpha, start, dir, ringAlpha / 2);
        // Inward the ring (black) gives way to the footprint fill (yellow / red):
        // red channel, premultiplied so it is linear in coverage.
        const inner = outer == null ? null : crossing(red, Math.floor(outer) + dir, dir, fillRed / 2);
        const css = (v) => (v == null ? null : ct + v / sy);
        return { outer: css(outer), inner: css(inner), soft: softness(alpha, outer, dir, 0, ringAlpha) };
      };

      for (const [side, sgn] of [['top', -1], ['bottom', 1]]) {
        const startDev = Math.round((edgeCss[side === 'top' ? 0 : 1] + sgn * 14 * zoom) * dpr); // outside, on the background
        const dir = -sgn;   // walk inward
        // Body edge: background (white) -> black stroke, overlay off.
        const pn = prof(none.png, 'lum');
        const body = toCss(crossing(pn, startDev, dir, 127.5));
        // Hover outline (black, opaque) over the white background, then the
        // footprint fill (yellow @ 0.667) over the black stroke (~lum 150).
        const ph = prof(hover.png, 'lum');
        const hOuterDev = crossing(ph, startDev, dir, 127.5);
        const hInnerDev = hOuterDev == null ? null : crossing(ph, Math.floor(hOuterDev) + dir * 1, dir, 60);
        // Mask pick: border black@128 over white (G 128), then the red@128
        // fill over the black stroke (G 0). Green channel.
        const pm = prof(mask.png, 'g');
        const mOuterDev = crossing(pm, startDev, dir, 191.5);
        const mInnerDev = mOuterDev == null ? null : crossing(pm, Math.floor(mOuterDev) + dir * 1, dir, 64);
        r.sides.push({
          side, expectedBody: edgeCss[side === 'top' ? 0 : 1],
          body, hoverOuter: toCss(hOuterDev), hoverInner: toCss(hInnerDev),
          maskOuter: toCss(mOuterDev), maskInner: toCss(mInnerDev),
          hoverSoft: softness(ph, hOuterDev, dir, 255, 0), maskSoft: softness(pm, mOuterDev, dir, 255, 128),
          bodySoft: softness(pn, crossing(pn, startDev, dir, 127.5), dir, 255, 0),
          hoverBitmap: bmp(hover, 255, 170, side, sgn) /* yellow @ 170 */, maskBitmap: bmp(mask, 128, 128, side, sgn),
        });
      }
      results[tag] = r;

      // ---- assertions -------------------------------------------------------
      ok(`[${tag}] devicePixelRatio is ${dpr}`, Math.abs(geo.dpr - dpr) < 1e-6, String(geo.dpr));
      ok(`[${tag}] #overlay covers exactly #c's CSS box`,
        geo.o.css.every((v, i) => Math.abs(v - geo.c.css[i]) < 0.01), JSON.stringify([geo.o.css, geo.c.css]));
      ok(`[${tag}] #overlay backing store is the physical size (${Math.round(cw * dpr)}x${Math.round(chh * dpr)})`,
        geo.o.w === Math.round(cw * dpr) && geo.o.h === Math.round(chh * dpr), `${geo.o.w}x${geo.o.h}`);
      // Fractional scales put #c's CSS box on fractional device pixels, so the
      // browser resamples both canvases a little: one more partial pixel there.
      const softMax = Number.isInteger(dpr) ? 1 : 2;
      for (const s of r.sides) {
        const hw = s.hoverInner != null && s.hoverOuter != null ? Math.abs(s.hoverInner - s.hoverOuter) : null;
        const mw = s.maskInner != null && s.maskOuter != null ? Math.abs(s.maskInner - s.maskOuter) : null;
        const body = s.expectedBody, sg = s.side === 'top' ? -1 : 1;
        // (a) the overlay's own pixels: exact geometry, one partial pixel per edge.
        // The outer edge is the ring alone over nothing, so its coverage reads
        // straight off the alpha (0.15 px). The inner edge pixel holds the ring
        // over the fill, each with part coverage, and that mix (Qt paints it the
        // same way) is not linear in the edge position: up to ~0.35 backing px.
        for (const [what, b, w] of [['hover outline', s.hoverBitmap, 2 * zoom], ['mask border', s.maskBitmap, SW * 2 * zoom]]) {
          ok(`[${tag}] ${s.side}: ${what} bitmap runs from the body edge out ${w} CSS px`,
            b.inner != null && b.outer != null && Math.abs(b.inner - body) <= 0.3 && Math.abs(b.outer - (body + sg * w)) <= 0.15,
            `${f2(b.inner)}..${f2(b.outer)} vs ${f2(body)}..${f2(body + sg * w)}`);
          ok(`[${tag}] ${s.side}: ${what} bitmap edge is antialiased in physical pixels (<= 1 partial)`, b.soft <= 1, String(b.soft));
        }
        // (b) what is on screen (device-pixel screenshot, #c under #overlay).
        ok(`[${tag}] ${s.side}: on screen, body edge where the geometry puts it (${f2(body)})`,
          s.body != null && Math.abs(s.body - body) <= 0.35, f2(s.body));
        ok(`[${tag}] ${s.side}: on screen, hover outline starts on the body edge`,
          s.hoverInner != null && s.body != null && Math.abs(s.hoverInner - s.body) <= 0.5, `${f2(s.hoverInner)} vs ${f2(s.body)}`);
        ok(`[${tag}] ${s.side}: on screen, hover outline is ${2 * zoom} CSS px thick`, hw != null && Math.abs(hw - 2 * zoom) <= 0.4, f2(hw));
        ok(`[${tag}] ${s.side}: on screen, mask border starts on the body edge`,
          s.maskInner != null && s.body != null && Math.abs(s.maskInner - s.body) <= 0.5, `${f2(s.maskInner)} vs ${f2(s.body)}`);
        ok(`[${tag}] ${s.side}: on screen, mask border is ${SW * 2 * zoom} CSS px thick`, mw != null && Math.abs(mw - SW * 2 * zoom) <= 0.4, f2(mw));
        ok(`[${tag}] ${s.side}: on screen, hover outline edge is crisp (<= ${softMax} partial device px)`, s.hoverSoft <= softMax, String(s.hoverSoft));
        ok(`[${tag}] ${s.side}: on screen, mask border edge is crisp (<= ${softMax} partial device px)`, s.maskSoft <= softMax, String(s.maskSoft));
      }
      ok(`[${tag}] no page errors`, errors.length === 0, errors.join(' | '));
      await page.close();
    }
    // The same numbers as at d = 1: nothing moves or thickens with the scale.
    const base = results[`z${zoom}_dpr1`];
    for (const dpr of [1.25, 1.5, 2]) {
      const r = results[`z${zoom}_dpr${dpr}`];
      for (let k = 0; k < 2; k++) {
        const a = base.sides[k], b = r.sides[k];
        const keys = ['body', 'hoverOuter', 'hoverInner', 'maskOuter', 'maskInner'];
        const worst = Math.max(...keys.map((key) => (a[key] == null || b[key] == null ? 99 : Math.abs(a[key] - b[key]))));
        ok(`[z${zoom}] dpr ${dpr} vs 1, ${a.side}: every on-screen edge within 0.5 CSS px`, worst <= 0.5, f2(worst));
      }
    }
  }
} catch (e) {
  console.log('FAIL  exception  ' + (e && e.stack || e));
  fails++;
} finally {
  if (browser) await browser.close();
  stopDev();
}
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall DPR overlay checks passed');
process.exit(fails ? 1 : 0);
