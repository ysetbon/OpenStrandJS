// Pixel-diagnose the attach-mode DRAG PREVIEW vs the REAL strand it should look
// like. The original OpenStrand Studio draws the actual strand while you drag an
// attachment; our JS draws an overlay preview (overlayRenderer.drawPending). The
// JS renderer (#c) for a *committed* attached strand is already ~100% faithful to
// the original (the pixel oracle), so the committed render IS the ground truth.
//
// Method (everything captured from the running editor, one viewport, pixel-aligned
// because #overlay shares #c's world->screen transform):
//   bgC      = #c, parent strand only            (on white)
//   truthC   = #c, parent + committed child      (on white)   -> realChild = truthC - bgC
//   ovB      = #overlay, parent only, no pending  (static overlay: circles/squares)
//   ovA      = #overlay, parent only, pending set (static overlay + the preview band)
//   preview  = ovA - ovB  (isolates exactly the band + attachment half-circle)
// Then emit realChild | preview | diff (cropped to the child bbox) so the exact
// divergence (cap shape, half-circle, width, colour, end treatment) is visible.
//
// Usage: node tools/compare_attach_preview.mjs [editorURL]   (default :5178)

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'artifacts', 'attach_preview');
mkdirSync(outDir, { recursive: true });
const url = process.argv[2] || 'http://localhost:5178/';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__store && !!window.__actions, null, { timeout: 10000 });

  // --- drive the editor and grab both canvases as PNG data URLs ---
  const caps = await page.evaluate(async () => {
    const store = window.__store;
    const A = window.__actions;
    const st = () => store.getState();
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const grab = (id) => document.getElementById(id).toDataURL('image/png');

    // Use the real current view so coords land on-canvas regardless of size.
    const v = st().view;
    const z = v.zoom || 1;
    const toWorld = (sx, sy) => ({ x: (sx - v.panX) / z, y: (sy - v.panY) / z });
    const pStart = toWorld(170, 470);   // parent.start (screen)
    const pEnd = toWorld(380, 470);     // parent.end (screen)  <- attach here (side 1)
    const cEnd = toWorld(560, 250);     // child.end (screen, up-right; fully on-canvas)

    const W = 46, SW = 4, COL = { r: 200, g: 170, b: 230, a: 255 };

    // (1) PREVIEW: parent strand only, attach pending + dragging. Control points
    // off; attach circles are suppressed during drag, so #overlay is JUST the band.
    st().setMode('attach');
    st().mutateDoc((d) => {
      d.strands = {}; d.order = []; d.groups = {}; d.locked_layers = [];
      d.selected_strand_name = null; d.show_control_points = false; d.shadow_enabled = false;
      const name = A.addNewStrand(d, pStart, pEnd);
      const s = d.strands[name];
      s.width = W; s.stroke_width = SW; s.color = { ...COL }; s.stroke_color = { r: 0, g: 0, b: 0, a: 255 };
    });
    st().setSelection({ layerName: null, handle: null });
    st().setPending({ kind: 'attach', start: pEnd, end: cEnd, parent: st().doc.order[0], side: 1 });
    st().setDragging(true);
    window.__requestRender(); await raf();
    const band = grab('overlay');

    // (2) TRUTH: commit the child, then DROP the parent so #c renders the child
    // ALONE on white — no same-colour parent body to confound the cap region.
    st().setPending(null); st().setDragging(false);
    st().mutateDoc((d) => {
      A.attachChild(d, d.order[0], 1, pEnd, cEnd);
      const parent = d.order[0], child = d.order[1];
      delete d.strands[parent];
      d.order = [child];
      d.selected_strand_name = null;
    });
    window.__requestRender(); await raf();
    const truth = grab('c');

    return { band, truth, w: document.getElementById('c').width, h: document.getElementById('c').height };
  });

  const dec = (dataUrl) => PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const band = dec(caps.band), truth = dec(caps.truth);
  const { width, height } = truth;

  const px = (img, i) => [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  const WHITE = [255, 255, 255, 255];
  const isWhite = (p) => p[0] > 247 && p[1] > 247 && p[2] > 247;
  const over = (fg, bg) => { const a = fg[3] / 255; return [
    Math.round(fg[0] * a + bg[0] * (1 - a)), Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)), 255]; };

  // realChild = the child rendered alone on white (#c). preview = the overlay band
  // composited over white. No parent in either, so the cap region is unconfounded.
  const realChild = new PNG({ width, height });
  const preview = new PNG({ width, height });
  let bb = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
  const grow = (x, y) => { if (x < bb.x0) bb.x0 = x; if (y < bb.y0) bb.y0 = y; if (x > bb.x1) bb.x1 = x; if (y > bb.y1) bb.y1 = y; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (width * y + x) << 2;
    const tp = px(truth, i);
    const rc = isWhite(tp) ? WHITE : tp;
    const bp = px(band, i);
    const pv = bp[3] > 8 ? over(bp, WHITE) : WHITE;
    for (let k = 0; k < 4; k++) { realChild.data[i + k] = rc[k]; preview.data[i + k] = pv[k]; }
    if (!isWhite(rc) || !isWhite(pv)) grow(x, y);
  }
  if (bb.x1 < 0) bb = { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  const pad = 24;
  bb = { x0: Math.max(0, bb.x0 - pad), y0: Math.max(0, bb.y0 - pad), x1: Math.min(width - 1, bb.x1 + pad), y1: Math.min(height - 1, bb.y1 + pad) };
  const cw = bb.x1 - bb.x0 + 1, ch = bb.y1 - bb.y0 + 1;

  const crop = (src) => { const o = new PNG({ width: cw, height: ch });
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const s = (width * (y + bb.y0) + (x + bb.x0)) << 2, d = (cw * y + x) << 2;
      for (let k = 0; k < 4; k++) o.data[d + k] = src.data[s + k];
    } return o; };
  const realC = crop(realChild), prevC = crop(preview);

  const diff = new PNG({ width: cw, height: ch });
  const n = pixelmatch(realC.data, prevC.data, diff.data, cw, ch, { threshold: 0.12 });

  // Compose: [ realChild | preview | diff ] with labels-as-gap.
  const GAP = 14;
  const board = new PNG({ width: cw * 3 + GAP * 2, height: ch });
  board.data.fill(0x20);
  const blit = (src, ox) => { for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const s = (cw * y + x) << 2, d = (board.width * y + (x + ox)) << 2;
    board.data[d] = src.data[s]; board.data[d + 1] = src.data[s + 1]; board.data[d + 2] = src.data[s + 2]; board.data[d + 3] = 255;
  } };
  blit(realC, 0); blit(prevC, cw + GAP); blit(diff, (cw + GAP) * 2);

  writeFileSync(path.join(outDir, 'real_child.png'), PNG.sync.write(realC));
  writeFileSync(path.join(outDir, 'preview.png'), PNG.sync.write(prevC));
  writeFileSync(path.join(outDir, 'diff.png'), PNG.sync.write(diff));
  writeFileSync(path.join(outDir, 'board.png'), PNG.sync.write(board));
  const pct = (100 * n / (cw * ch)).toFixed(2);
  console.log(JSON.stringify({ canvas: `${width}x${height}`, child_bbox: `${cw}x${ch}`, diff_pixels: n, diff_pct: Number(pct), out: outDir }, null, 2));
  console.log('LAYOUT: board.png = [ REAL strand | PREVIEW band | pixel DIFF ]');
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
}
process.exit(0);
