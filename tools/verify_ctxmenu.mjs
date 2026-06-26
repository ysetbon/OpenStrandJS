// Verify the layer-button context menu opens AT the click/touch point in both
// presentations:
//   * desktop  — html{zoom:0.65}; a real right-click must place the menu's top-left
//                at the cursor (the reported bug placed it ~400px up-and-left).
//   * mobile   — html{zoom:1} + a CSS transform on `.app`; a long-press must open the
//                same menu near the touch point (the menu is portaled to <body> so it
//                escapes that transform).
// Run with the dev server up:  node tools/verify_ctxmenu.mjs [port]
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const PORT = process.argv[2] || '5175';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'box_stitch.json'), 'utf8'));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

async function loadDoc(page) {
  await page.evaluate(async (fx) => {
    const mod = await import('/src/io/saveLoad.ts');
    window.__store.getState().loadDocument(mod.loadProject(fx));
  }, fixture);
  await page.waitForTimeout(400);
}

// Pick a layer button whose CENTER is actually hittable (not occluded by the
// control column at small/scaled viewports), preferring higher buttons so a
// downward-opening menu is not vertically clamped. Returns its center in visual
// (clientX/Y) px — the space a real cursor/finger reports.
async function topLayerButtonPoint(page) {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.layer-panel [role="button"]'))
      .filter((b) => b.querySelector('.nlb-label'))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === b || b.contains(hit))) return { x, y };
    }
    return null;
  });
}

async function desktop(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('.app', { timeout: 10000 });
  await loadDoc(page);
  const pt = await topLayerButtonPoint(page);
  if (!pt) { await ctx.close(); return { mode: 'desktop', ok: false, why: 'no layer buttons', errs }; }
  // Dispatch a real contextmenu at the button center (clientX/Y = visual px).
  await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }, pt);
  await page.waitForSelector('.ctx-menu', { timeout: 3000 });
  const menu = await page.evaluate(() => {
    const r = document.querySelector('.ctx-menu').getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  await ctx.close();
  // top is the unclamped axis here; |menu.top - click.y| should be a few px, not ~100+.
  const dTop = Math.abs(menu.top - pt.y);
  return { mode: 'desktop', click: pt, menu, dTop, ok: dTop < 20 && errs.length === 0, errs };
}

async function mobile(browser) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?mobile=1`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('.app', { timeout: 10000 });
  await loadDoc(page);
  const pt = await topLayerButtonPoint(page);
  if (!pt) { await ctx.close(); return { mode: 'mobile', ok: false, why: 'no layer buttons', errs }; }
  // Long-press via a REAL touch (CDP) so React's onTouchStart + the compat
  // pointer/mouse sequence behave exactly like a finger: press, hold > 500ms with no
  // move (menu must OPEN), then release (menu must STAY open — the compat mousedown
  // burst must not dismiss it).
  const cdp = await ctx.newCDPSession(page);
  const readMenu = () => page.evaluate(() => {
    const el = document.querySelector('.ctx-menu');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
  await page.waitForTimeout(700);
  const heldMenu = await readMenu();           // open while finger is down
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);               // past the grace window + any legacy click delay
  const afterRelease = await readMenu();        // must survive the release compat burst
  const vp = await page.evaluate(() => ({ vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight }));
  await ctx.close();
  // On a forced-landscape phone (~390px tall) a long menu can be nearly as tall as
  // the viewport, so it legitimately clamps away from the touch (mobile.css caps its
  // height + scrolls). The real requirements: it OPENED, it's FULLY ON-SCREEN (no row
  // overflows off the bottom/right), and it SURVIVES the release compat burst. When
  // the menu DOES fit it also lands near the touch — checked only in that case.
  const m = 1; // 1px rounding slack
  const onScreen = !!heldMenu && heldMenu.left >= -m && heldMenu.top >= -m
    && heldMenu.left + heldMenu.w <= vp.vw + m && heldMenu.top + heldMenu.h <= vp.vh + m;
  const survives = !!afterRelease && heldMenu
    && afterRelease.left === heldMenu.left && afterRelease.top === heldMenu.top;
  // "Near the touch" only makes sense when the menu can actually extend DOWNWARD from
  // the touch point. In forced landscape a tall menu can't (touch.y + h > vh), so it
  // correctly clamps to the top — don't penalize that. Only require near-touch when
  // the menu genuinely fits below the finger.
  const fitsBelowTouch = heldMenu && pt.y + heldMenu.h <= vp.vh - 4;
  const nearTouch = !fitsBelowTouch || Math.abs(heldMenu.top - pt.y) < 40;
  const ok = onScreen && survives && nearTouch && errs.length === 0;
  return { mode: 'mobile', click: pt, vp, heldMenu, afterRelease, onScreen, survives, fitsBelowTouch, ok, errs };
}

let browser;
try {
  browser = await chromium.launch();
  const d = await desktop(browser);
  const m = await mobile(browser);
  console.log(JSON.stringify({ desktop: d, mobile: m }, null, 2));
  log(`\nDESKTOP ${d.ok ? 'PASS' : 'FAIL'}  |  MOBILE ${m.ok ? 'PASS' : 'FAIL'}`);
} catch (e) {
  log('ERROR:', String(e));
} finally {
  if (browser) await browser.close();
}
process.exit(0);
