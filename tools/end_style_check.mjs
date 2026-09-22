// Guard for OSS 1.111 "Stylize End Side" (end_style.py / end_style_dialog.py).
//
// Three layers, each asserted so that it FAILS if its port is reverted:
//
//   1. RENDERER (web/render.html in Chromium): a styled end changes the pixels
//      exactly where its profile says — a pointed end fills the strand colour
//      past the flat cap, a trimmed end leaves the old cap region blank, a
//      concave end's coloured side line paints its own colour, an extended
//      straight end reaches further than the classic one — and a record that
//      draws the classic look (`shape: straight`, all zero) is pixel-identical
//      to no record at all (the fast path). Shadows and masks are exercised by
//      the fixture's crossing strand + mask so a crash there surfaces here.
//   2. MODEL (esbuild-bundled saveLoad.ts / endStyle.ts): `end_styles` round-trips
//      through the OSS JSON in serialize_strand's slot, a default record loads
//      as null, and the visual-equality dedupe sees an end-style-only change.
//   3. APP (the dev editor): the layer menu carries the Stylize End Side row
//      (Start / End for a strand's free ends, End only for an attached strand,
//      nothing for a mask); picking a shape previews live on the document; OK
//      commits ONE undo step and undo reverts it; Cancel restores the opening
//      state without an undo step.
//
// Usage: node tools/end_style_check.mjs
//        OSS_CHROMIUM=/path/to/chrome node tools/end_style_check.mjs
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const launch = () => chromium.launch(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});

const fixture = JSON.parse(readFileSync(path.join(root, 'fixtures/end_styles.json'), 'utf8'));

// ============================================================ 1. renderer
{
  const browser = await launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(pathToFileURL(path.join(root, 'web/render.html')).href + '?v=' + Date.now());
    await page.waitForFunction(() => typeof window.renderFixture === 'function');

    // One horizontal strand, start at (100, 100) -> end at (400, 100), width 46
    // + 2*4, so the classic flat cap ends at x = 400 and the side line spans
    // 400..404. The probe reads a 1x1 pixel of the composited canvas.
    const base = () => ({
      type: 'Strand', layer_name: '1_1', set_number: 1,
      start: { x: 100, y: 100 }, end: { x: 400, y: 100 },
      control_points: [{ x: 100, y: 100 }, { x: 400, y: 100 }], control_point_center: null, control_point_center_locked: false,
      width: 46, stroke_width: 4, color: { r: 200, g: 170, b: 230, a: 255 }, stroke_color: { r: 0, g: 0, b: 0, a: 255 },
      has_circles: [false, false], start_line_visible: true, end_line_visible: true, end_styles: [null, null],
    });
    const meta = { image_width: 600, image_height: 200, x_offset: 0, y_offset: 0, supersample: 2, shadow_enabled: true,
      curve_params: { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 } };
    const render = (strands, probes, m = meta) => page.evaluate(({ strands, meta, probes }) => {
      window.renderFixture(strands, meta);
      const c = document.getElementById('c');
      const ctx = c.getContext('2d');
      const px = probes.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
      let h = 0; const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) >>> 0;
      return { px, hash: h };
    }, { strands, meta: m, probes });
    const isWhite = (p) => p[0] > 250 && p[1] > 250 && p[2] > 250;
    const isFill = (p) => Math.abs(p[0] - 200) < 12 && Math.abs(p[1] - 170) < 12 && Math.abs(p[2] - 230) < 12;
    const isBlack = (p) => p[0] < 40 && p[1] < 40 && p[2] < 40;

    // Classic: fill inside, side line black at 402, white beyond 405.
    const classic = await render([base()], [[380, 100], [402, 100], [420, 100]]);
    ok('renderer: classic end — fill / black side line / blank beyond the cap',
      isFill(classic.px[0]) && isBlack(classic.px[1]) && isWhite(classic.px[2]), JSON.stringify(classic.px));

    // A record that draws the classic look is the fast path: identical pixels.
    const s0 = base(); s0.end_styles = [null, { shape: 'straight', tilt: 0, depth: 0.5, offset: 0, line_width: null, line_color: null }];
    const same = await render([s0], [[380, 100]]);
    ok('renderer: a default record is pixel-identical to no record', same.hash === classic.hash);

    // Pointed, depth 0.5 of the width (54*0.5 = 27 px beyond the side line at
    // x = 404): the tip sits at ~431, the fill reaches past the old cap, and at
    // 20 px off the centreline the profile is at 404 + 27*(1 - 20/27) = 411, so
    // (425, 80) lies in the cut-away corner.
    const s1 = base(); s1.end_styles = [null, { shape: 'pointed', tilt: 0, depth: 0.5, offset: 0, line_width: null, line_color: null }];
    const pointed = await render([s1], [[412, 100], [402, 100], [440, 100], [425, 80]]);
    ok('renderer: pointed end fills the strand colour past the flat cap',
      isFill(pointed.px[0]), JSON.stringify(pointed.px));
    ok('renderer: ...the old side line position is no longer the (black) cap', !isBlack(pointed.px[1]) || isFill(pointed.px[1]), JSON.stringify(pointed.px[1]));
    ok('renderer: ...and the corners beside the point are cut away', isWhite(pointed.px[3]), JSON.stringify(pointed.px[3]));
    ok('renderer: ...beyond the tip stays blank', isWhite(pointed.px[2]), JSON.stringify(pointed.px[2]));

    // Trim by 20 px: the region the classic cap covered is blank now.
    const s2 = base(); s2.end_styles = [null, { shape: 'straight', tilt: 0, depth: 0.5, offset: -20, line_width: null, line_color: null }];
    const trimmed = await render([s2], [[395, 100], [370, 100]]);
    ok('renderer: a trimmed straight end leaves the old cap region blank',
      isWhite(trimmed.px[0]) && isFill(trimmed.px[1]), JSON.stringify(trimmed.px));

    // Extend by 20 px: the fill reaches where the classic end was blank.
    const s3 = base(); s3.end_styles = [null, { shape: 'straight', tilt: 0, depth: 0.5, offset: 20, line_width: null, line_color: null }];
    const extended = await render([s3], [[415, 100], [422, 100]]);
    ok('renderer: an extended straight end fills past the classic cap, side line moved with it',
      isFill(extended.px[0]) && isBlack(extended.px[1]), JSON.stringify(extended.px));

    // Concave with a thick red side line: the band paints its own colour.
    const s4 = base(); s4.end_styles = [null, { shape: 'concave', tilt: 0, depth: 0.6, offset: 0, line_width: 10, line_color: { r: 220, g: 20, b: 20, a: 255 } }];
    const concave = await render([s4], [[397, 78], [402, 100]]);
    const isRed = (p) => p[0] > 180 && p[1] < 70 && p[2] < 70;
    ok('renderer: a concave end paints its side-line colour along the profile',
      isRed(concave.px[0]) && isWhite(concave.px[1]), JSON.stringify(concave.px));

    // Side line hidden: no band, so the fill runs all the way to the profile
    // (OSS: the fill is cut back to the side line's INNER edge, which is the
    // profile itself when the line is off) — a rounded cap of radius 27 ends at
    // x = 427 with no outline of its own.
    const s5 = base(); s5.end_line_visible = false;
    s5.end_styles = [null, { shape: 'rounded', tilt: 0, depth: 1, offset: 0, line_width: null, line_color: null }];
    const noLine = await render([s5], [[418, 100], [424, 100], [432, 100]]);
    ok('renderer: with the side line off the rounded end is fill right up to its profile',
      isFill(noLine.px[0]) && isFill(noLine.px[1]) && isWhite(noLine.px[2]), JSON.stringify(noLine.px));

    // A circle cap wins: the style lies dormant while the end has a circle.
    const s6 = base(); s6.has_circles = [false, true]; s6.manual_circle_visibility = [null, true];
    s6.end_styles = [null, { shape: 'pointed', tilt: 0, depth: 1, offset: 30, line_width: null, line_color: null }];
    const s6plain = base(); s6plain.has_circles = [false, true]; s6plain.manual_circle_visibility = [null, true];
    const dormant = await render([s6], []);
    const dormantPlain = await render([s6plain], []);
    ok('renderer: a style on an end that carries a circle draws nothing (dormant)', dormant.hash === dormantPlain.hash);

    // The fixture's own styled ends, probed where their profiles put them. The
    // horizontals sit at world (100..520, y = 100 + 110*i) and the meta offsets
    // by 20; the crossing strand and its mask are left out of this render
    // because they cover the ends.
    //   2_1 (orange) angled, tilt 30: the cut runs from ~17 px past the endpoint
    //       on one edge to ~9 px before it on the other, so at x = 525 one
    //       corner is fill and the other is cut away;
    //   5_1 (purple) notched, depth 0.6 of 54 = 32 px: the notch apex sits 28 px
    //       INSIDE the endpoint (world ~492), so on the centreline x = 500 is
    //       inside the blank wedge, while 18 px off the centreline the flank is
    //       at ~513 with its 4 px band inside it, so (500, 522) is still fill.
    const P = (x, y) => [x + 20, y + 20];
    const fixtureMeta = { ...meta, image_width: 860, image_height: 900, x_offset: 20, y_offset: 20 };
    const bare = fixture.strands.filter((s) => s.layer_name !== '7_1' && s.layer_name !== '7_1_3_1');
    const ends = await render(bare, [P(525, 188), P(525, 232), P(500, 540), P(500, 522)], fixtureMeta);
    const isOrange = (p) => Math.abs(p[0] - 255) < 12 && Math.abs(p[1] - 170) < 14 && Math.abs(p[2] - 127) < 14;
    ok('renderer: the fixture\'s angled end is cut on exactly one corner',
      isWhite(ends.px[0]) !== isWhite(ends.px[1]) && (isOrange(ends.px[0]) || isOrange(ends.px[1])), JSON.stringify([ends.px[0], ends.px[1]]));
    ok('renderer: the fixture\'s notched end is blank at its apex and filled beside it',
      isWhite(ends.px[2]) && isFill(ends.px[3]), JSON.stringify([ends.px[2], ends.px[3]]));
    // The whole fixture (shadows on): the crossing strand paints over the styled
    // ends and casts its shadow onto the strand beneath (1_1 at y = 100 turns
    // from the pure strand colour into the shadowed one just left of the green
    // body, whose edge is near x = 475).
    const all = await render(fixture.strands, [P(465, 100), P(485, 100), P(520, 430)], fixtureMeta);
    const isGreen = (p) => Math.abs(p[0] - 120) < 12 && Math.abs(p[1] - 200) < 12 && Math.abs(p[2] - 140) < 12;
    ok('renderer: the crossing strand paints over the styled ends (and its mask draws)', isGreen(all.px[1]) && isGreen(all.px[2]), JSON.stringify([all.px[1], all.px[2]]));
    ok('renderer: ...and casts its shadow onto the styled strand beneath',
      !isWhite(all.px[0]) && !isFill(all.px[0]) && all.px[0][0] < 170, JSON.stringify(all.px[0]));
    ok('renderer: no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
}

// ============================================================ 2. model
{
  const work = mkdtempSync(path.join(tmpdir(), 'ossjs-endstyle-'));
  const entry = path.join(work, 'entry.ts');
  const bundle = path.join(work, 'bundle.mjs');
  writeFileSync(entry, [
    `export * from ${JSON.stringify(path.join(root, 'src/io/saveLoad.ts'))};`,
    `export * from ${JSON.stringify(path.join(root, 'src/model/endStyle.ts'))};`,
    `export { strandVisualEqual } from ${JSON.stringify(path.join(root, 'src/store/visualEqual.ts'))};`,
    `export { strandFootprint, footprintContains } from ${JSON.stringify(path.join(root, 'src/interaction/selectionFootprint.ts'))};`,
  ].join('\n'));
  const esb = spawnSync(path.join(root, 'node_modules', '.bin', 'esbuild'),
    [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`], { stdio: 'inherit' });
  if (esb.status !== 0) process.exit(esb.status ?? 1);
  const M = await import(pathToFileURL(bundle).href);

  const doc = M.loadProject(fixture);
  const s41 = doc.strands['4_1'];
  ok('model: end_styles load into the typed record', s41.end_styles[1]?.shape === 'pointed' && s41.end_styles[1].line_width === 8);
  ok('model: a null slot stays null', doc.strands['7_1'].end_styles[0] === null);
  const out = M.serializeProject(doc);
  const raw = out.strands.find((s) => s.layer_name === '4_1');
  const keys = Object.keys(raw);
  ok('model: serialize writes end_styles right after end_line_visible (serialize_strand order)',
    keys[keys.indexOf('end_line_visible') + 1] === 'end_styles' && keys[keys.indexOf('end_styles') + 1] === 'is_hidden',
    keys.slice(keys.indexOf('start_line_visible'), keys.indexOf('is_hidden') + 1).join(','));
  ok('model: ...in OSS serialize_style form',
    JSON.stringify(Object.keys(raw.end_styles[1])) === JSON.stringify(['shape', 'tilt', 'depth', 'offset', 'line_width', 'line_color'])
      && raw.end_styles[1].line_color.r === 200);
  ok('model: an unstyled strand writes [null, null]', JSON.stringify(out.strands.find((s) => s.layer_name === '7_1_3_1').end_styles) === '[null,null]');
  ok('model: normalize turns the default record into null and clamps tilt',
    M.normalizeEndStyle({ shape: 'straight', tilt: 20, offset: 0 }) === null
      && M.normalizeEndStyle({ shape: 'angled', tilt: 200 }).tilt === 60);
  const a = JSON.parse(JSON.stringify(s41)), b = JSON.parse(JSON.stringify(s41));
  b.end_styles[1].depth = 0.9;
  ok('model: the undo dedupe sees an end-style-only change', M.strandVisualEqual(a, a) && !M.strandVisualEqual(a, b));
  const c = JSON.parse(JSON.stringify(s41)); c.extra.end_line_visible = false;
  ok('model: ...and a side-line visibility change', !M.strandVisualEqual(a, c));

  // Hit-test footprint: the pointed 4_1 (8 px band, then a tip 0.6 * 54 = 32 px
  // long, so the point reaches x = 560 and at 22 px off the centreline the
  // profile is at 528 + 32 * (1 - 22/27) = 534) contains its tip and not the
  // corner beside it; 1_1's straight start, trimmed 12 px (band 4 - 12 = -8),
  // gives up everything left of x = 108.
  const settings = { curve_params: { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 }, enable_curvature_bias_control: false };
  const fp = M.strandFootprint(s41, doc, settings);
  const y = s41.start.y;
  ok('footprint: the pointed tip is inside the selection footprint', M.footprintContains(fp, { x: 545, y }));
  ok('footprint: the corner beside the point is outside', !M.footprintContains(fp, { x: 545, y: y - 22 }));
  const s11 = doc.strands['1_1'];
  const fp11 = M.strandFootprint(s11, doc, settings);
  ok('footprint: the trimmed start gives up its old cap region',
    !M.footprintContains(fp11, { x: 100, y: s11.start.y }) && M.footprintContains(fp11, { x: 120, y: s11.start.y }));
  ok('footprint: an unstyled strand carries no cuts', M.strandFootprint(doc.strands['7_1'], doc, settings).removed.length === 0);
}

// ============================================================ 3. app
{
  const server = await createServer({
    root, configFile: path.join(root, 'vite.config.ts'),
    server: { port: 5214, strictPort: true, open: false, host: '127.0.0.1' }, logLevel: 'error',
  });
  await server.listen();
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('http://127.0.0.1:5214/', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 30000 });

    // box_stitch: a plain strand with two free ends? Use the styled fixture's
    // 1_1 (two free ends), plus an attached strand and a mask from box_stitch.
    const box = JSON.parse(readFileSync(path.join(root, 'fixtures/box_stitch.json'), 'utf8'));
    await page.evaluate(({ project }) => {
      const st = window.__store.getState();
      st.loadDocument(window.__io.loadProject(project));
      st.setMode('select');
    }, { project: fixture });
    await page.waitForTimeout(600);

    const menuFor = async (name) => {
      await page.locator('.nlb', { hasText: new RegExp(`^${name}$`) }).first().click({ button: 'right' });
      await page.waitForTimeout(250);
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll('[class*=ctx], [role=menu]'))
        .map((el) => el.innerText).join('\n'));
      return rows;
    };
    const closeMenu = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(150); };

    const m11 = await menuFor('1_1');
    ok('app: a strand with two free ends offers Stylize End Side with Start and End',
      /Stylize End Side/.test(m11) && /\bStart\b/.test(m11) && /\bEnd\b/.test(m11));
    ok('app: ...placed right after Close the Knot / the arrow section', m11.indexOf('Stylize End Side') > m11.indexOf('Show Full Arrow'));
    await closeMenu();

    const m711 = await menuFor('7_1_3_1');
    ok('app: a masked layer has no Stylize End Side row', !/Stylize End Side/.test(m711));
    await closeMenu();

    // Load box_stitch for an attached strand's menu (End only).
    await page.evaluate(({ project }) => {
      const st = window.__store.getState();
      st.loadDocument(window.__io.loadProject(project));
    }, { project: box });
    await page.waitForTimeout(500);
    const attached = await page.evaluate(() => {
      const d = window.__store.getState().doc;
      return d.order.find((n) => d.strands[n].type === 'AttachedStrand' && !d.strands[n].has_circles[1]) ?? null;
    });
    if (attached) {
      const ma = await menuFor(attached);
      const row = ma.split('\n');
      const i = row.indexOf('Stylize End Side');
      ok(`app: an attached strand (${attached}) offers End only`, i >= 0 && row[i + 1] === 'End' && row[i + 2] !== 'Start', row.slice(i, i + 3).join('|'));
      await closeMenu();
    } else {
      ok('app: box_stitch has an attached strand with a free end', false);
    }

    // Back to the styled fixture: open the End dialog of 1_1, pick Pointed, OK.
    await page.evaluate(({ project }) => {
      const st = window.__store.getState();
      st.loadDocument(window.__io.loadProject(project));
    }, { project: fixture });
    await page.waitForTimeout(500);
    const past0 = await page.evaluate(() => window.__store.getState().past.length);
    await menuFor('1_1');
    await page.getByRole('button', { name: /^End$/ }).first().click();
    await page.waitForTimeout(600);
    ok('app: the Stylize End Side dialog opens', await page.locator('.modal', { hasText: 'Stylize End Side' }).count() === 1);
    ok('app: ...headed by the layer and side', (await page.locator('.es-header').innerText()).includes('1_1'));
    ok('app: ...with six shape buttons carrying rendered icons',
      await page.locator('.es-shape-btn img').count() === 6);
    await page.locator('.es-shape-btn', { hasText: 'Pointed' }).click();
    await page.waitForTimeout(300);
    const live = await page.evaluate(() => window.__store.getState().doc.strands['1_1'].end_styles[1]);
    ok('app: picking a shape previews live on the document', live && live.shape === 'pointed', JSON.stringify(live));
    ok('app: ...without an undo step yet', (await page.evaluate(() => window.__store.getState().past.length)) === past0);
    await page.locator('.modal-footer button', { hasText: /^OK$/ }).click();
    await page.waitForTimeout(300);
    const afterOk = await page.evaluate(() => {
      const st = window.__store.getState();
      return { past: st.past.length, shape: st.doc.strands['1_1'].end_styles[1]?.shape, meta: st.presentMeta };
    });
    ok('app: OK keeps the shape and records ONE undo step', afterOk.past === past0 + 1 && afterOk.shape === 'pointed', JSON.stringify(afterOk));
    ok('app: ...tagged strand.end_style from the dialog', afterOk.meta && afterOk.meta.action === 'strand.end_style' && afterOk.meta.source === 'dialog', JSON.stringify(afterOk.meta));
    await page.evaluate(() => window.__store.getState().undo());
    await page.waitForTimeout(200);
    const undone = await page.evaluate(() => window.__store.getState().doc.strands['1_1'].end_styles[1]?.shape);
    ok('app: undo brings the previous end style back', undone === 'straight', String(undone));

    // Cancel restores the opening state, no undo step.
    const past1 = await page.evaluate(() => window.__store.getState().past.length);
    await menuFor('1_1');
    await page.getByRole('button', { name: /^Start$/ }).first().click();
    await page.waitForTimeout(500);
    await page.locator('.es-shape-btn', { hasText: 'Notched' }).click();
    await page.waitForTimeout(200);
    ok('app: the start-side dialog previews on the start slot',
      (await page.evaluate(() => window.__store.getState().doc.strands['1_1'].end_styles[0]?.shape)) === 'notched');
    await page.locator('.modal-footer button', { hasText: /^Cancel$/ }).click();
    await page.waitForTimeout(300);
    const cancelled = await page.evaluate(() => {
      const st = window.__store.getState();
      return { past: st.past.length, shape: st.doc.strands['1_1'].end_styles[0]?.shape, open: !!document.querySelector('.modal') };
    });
    ok('app: Cancel restores the end exactly and adds no undo step',
      cancelled.past === past1 && cancelled.shape === 'straight' && !cancelled.open, JSON.stringify(cancelled));

    ok('app: no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall end-style checks passed');
process.exit(fails ? 1 : 0);
