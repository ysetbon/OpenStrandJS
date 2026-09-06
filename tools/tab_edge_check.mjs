// Guard for the floating tab edge (src/ui/TabEdge.tsx, TabChip.tsx, the tab
// actions in editorStore.ts) against OSS tab_bar_widget.py / tab_manager.py:
// hidden at startup, docked bottom-center 24px off the canvas edges, chips then
// [+] (mirrored in RTL), 9pt titles, "Untitled N" from its own counter, duplicate
// inserted after its source and dirty, close falling back to the neighbour that
// took the slot, the six-pill magnet overlay while dragging, and the position
// persisted as an anchor or a free center ratio. Drives the vite dev server
// (window.__store is DEV-only) in Chromium and writes screenshots to $OUT.
//
// Usage: node tools/tab_edge_check.mjs [outDir]
//        OSS_CHROMIUM=/path/to/chrome node tools/tab_edge_check.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(root, process.argv[2] || 'artifacts/tab_edge');
mkdirSync(OUT, { recursive: true });
const dev = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { cwd: root, stdio: 'pipe' });
await new Promise((r) => { dev.stdout.on('data', (d) => { if (String(d).includes('5199')) r(); }); setTimeout(r, 8000); });
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const browser = await chromium.launch(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto('http://localhost:5199/');
  await page.waitForFunction(() => !!window.__store, null, { timeout: 15000 });
  const st = () => page.evaluate(() => { const s = window.__store.getState(); return { tabs: s.tabs.map(t => ({ id: t.id, name: t.name, ui: t.untitledIndex, dirty: !!t.dirty })), active: s.activeTabId, show: s.showTabs, pos: s.tabEdgePosition }; });
  let s0 = await st();
  ok('edge hidden by default (OSS)', s0.show === false, JSON.stringify(s0));
  ok('no .tab-edge in DOM while hidden', (await page.locator('.tab-edge').count()) === 0);
  await page.evaluate(() => { window.__store.getState().setSettings({ theme: 'default', language: 'en' }); window.__store.getState().toggleTabs(); });
  await page.waitForTimeout(300);
  ok('edge visible after Tabs toggle', (await page.locator('.tab-edge').count()) === 1);
  const box0 = await page.locator('.tab-edge').boundingBox();
  const wrap = await page.locator('.canvas-wrap').boundingBox();
  ok('docked bottom_center: bottom gap 24', Math.abs((wrap.y + wrap.height) - (box0.y + box0.height) - 24) <= 1, JSON.stringify({ box0, wrap }));
  ok('docked bottom_center: horizontally centered', Math.abs((box0.x + box0.width / 2) - (wrap.x + wrap.width / 2)) <= 1.5);
  ok('edge height 53', Math.abs(box0.height - 53) < 0.6, String(box0.height));
  // order: chips then plus in LTR
  const order = await page.evaluate(() => Array.from(document.querySelector('.tab-edge').children).map(e => e.className.split(' ')[0]));
  ok('LTR order grip, chip, plus', order.join(',') === 'tab-edge-grip,tab-chip,tab-edge-plus', order.join(','));
  const fs = await page.evaluate(() => getComputedStyle(document.querySelector('.tab-chip-title')).fontSize);
  ok('title font 12px (9pt)', fs === '12px', fs);
  await page.screenshot({ path: `${OUT}/01_default_one_tab.png`, clip: { x: box0.x - 30, y: box0.y - 30, width: box0.width + 60, height: box0.height + 60 } });

  // new tab twice, then duplicate the second: numbering + insertion + dirty
  await page.evaluate(() => { const s = window.__store.getState(); s.newTab(); s.newTab(); });
  let s1 = await st();
  ok('Untitled counter 1,2,3', s1.tabs.map(t => t.ui).join(',') === '1,2,3', JSON.stringify(s1.tabs));
  await page.evaluate(() => { const s = window.__store.getState(); s.duplicateTab(2); });
  s1 = await st();
  ok('duplicate inserted after source, named "Untitled 2 copy", dirty', s1.tabs[2].name === 'Untitled 2 copy' && s1.tabs[2].dirty && s1.active === s1.tabs[2].id, JSON.stringify(s1.tabs));
  await page.evaluate(() => { const s = window.__store.getState(); s.newTab(); });
  s1 = await st();
  ok('next untitled is 4 (duplicate did not consume a number)', s1.tabs[4].ui === 4, JSON.stringify(s1.tabs));
  // mark tab 1 dirty and show
  await page.evaluate(() => { const s = window.__store.getState(); s.switchTab(1); s.markActiveDirty(); s.switchTab(3); });
  await page.waitForTimeout(250);
  const chipTexts = await page.locator('.tab-chip-title').allTextContents();
  ok('chip titles', chipTexts.join('|') === 'Untitled 1|Untitled 2|Untitled 2 copy|Untitled 3|Untitled 4', chipTexts.join('|'));
  ok('dirty dots on tabs 1 and copy', (await page.locator('.tab-chip-dot').count()) === 2);
  let box = await page.locator('.tab-edge').boundingBox();
  await page.screenshot({ path: `${OUT}/02_default_five_tabs.png`, clip: { x: box.x - 30, y: box.y - 30, width: box.width + 60, height: box.height + 60 } });
  // Tabs are now [1, 2, 4=copy, 3, 5] with 3 live. Closing 3 (idx 3) falls back
  // to the tab that takes idx 3: id 5 (OSS: tabs[min(idx, len-1)]).
  await page.evaluate(() => window.__store.getState().closeTab(3));
  s1 = await st();
  ok('closing active falls back to the tab that took its slot', s1.active === 5, JSON.stringify(s1));
  // close a background tab keeps active
  await page.evaluate(() => window.__store.getState().closeTab(1));
  s1 = await st();
  ok('closing a background tab keeps the live tab', s1.active === 5, JSON.stringify(s1));
  // markTabSaved strips the extension
  await page.evaluate(() => window.__store.getState().markTabSaved(5, 'my_knot.json'));
  s1 = await st();
  ok('saved tab titled after file without extension', s1.tabs.find(t => t.id === 5).name === 'my_knot' && s1.tabs.find(t => t.id === 5).ui == null, JSON.stringify(s1.tabs));
  await page.waitForTimeout(200);

  // drag: grab the grip, move to near top-left, observe overlay + magnet
  box = await page.locator('.tab-edge').boundingBox();
  await page.mouse.move(box.x + 10, box.y + 26);
  const cur = await page.evaluate(() => getComputedStyle(document.querySelector('.tab-edge-grip')).cursor);
  ok('grip cursor grab', cur === 'grab', cur);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y - 200, { steps: 8 });
  await page.waitForTimeout(100);
  ok('snap overlay shown while dragging with 6 targets', (await page.locator('.tab-snap-overlay g').count()) === 6);
  await page.screenshot({ path: `${OUT}/03_drag_free.png` });
  // move to within 75px of the top_left anchor (24,24)
  await page.mouse.move(wrap.x + 24 + 10 + 40, wrap.y + 24 + 26 + 30, { steps: 8 });
  await page.waitForTimeout(100);
  let b2 = await page.locator('.tab-edge').boundingBox();
  ok('magnet grabbed top_left while dragging', Math.abs(b2.x - (wrap.x + 24)) <= 1 && Math.abs(b2.y - (wrap.y + 24)) <= 1, JSON.stringify(b2));
  await page.screenshot({ path: `${OUT}/04_drag_snapped.png` });
  await page.mouse.up();
  await page.waitForTimeout(100);
  s1 = await st();
  ok('released -> persisted anchor top_left', s1.pos.anchor === 'top_left' && s1.pos.ratio === null, JSON.stringify(s1.pos));
  ok('overlay gone after release', (await page.locator('.tab-snap-overlay').count()) === 0);
  // free drop: middle of canvas
  b2 = await page.locator('.tab-edge').boundingBox();
  await page.mouse.move(b2.x + 10, b2.y + 26);
  await page.mouse.down();
  await page.mouse.move(wrap.x + wrap.width * 0.4, wrap.y + wrap.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  s1 = await st();
  ok('free drop persisted as center ratio', s1.pos.anchor === null && Array.isArray(s1.pos.ratio), JSON.stringify(s1.pos));
  const ls = await page.evaluate(() => localStorage.getItem('openstrandjs.tabEdgePosition'));
  ok('localStorage holds the ratio', ls && ls.includes('ratio'), ls);

  // RTL Hebrew + dark theme
  await page.evaluate(() => window.__store.getState().setSettings({ language: 'he', theme: 'dark' }));
  await page.waitForTimeout(300);
  const orderR = await page.evaluate(() => Array.from(document.querySelector('.tab-edge').children).map(e => e.className.split(' ')[0]));
  ok('RTL order: grip, plus, chips', orderR[0] === 'tab-edge-grip' && orderR[1] === 'tab-edge-plus', orderR.join(','));
  const heTitles = await page.locator('.tab-chip-title').allTextContents();
  ok('untitled titles localized to Hebrew', heTitles.some(t => t.startsWith('ללא שם')), heTitles.join('|'));
  const chipOrder = await page.evaluate(() => Array.from(document.querySelector('.tab-chip').children).map(e => e.className.split(' ')[0]));
  ok('RTL chip: icons first, then title', chipOrder[0] === 'tab-icon-btn' && chipOrder[2] === 'tab-chip-title', chipOrder.join(','));
  box = await page.locator('.tab-edge').boundingBox();
  await page.screenshot({ path: `${OUT}/05_rtl_dark.png`, clip: { x: box.x - 30, y: box.y - 30, width: box.width + 60, height: box.height + 60 } });
  // light theme
  await page.evaluate(() => window.__store.getState().setSettings({ language: 'en', theme: 'light' }));
  await page.waitForTimeout(300);
  box = await page.locator('.tab-edge').boundingBox();
  await page.screenshot({ path: `${OUT}/06_light.png`, clip: { x: box.x - 30, y: box.y - 30, width: box.width + 60, height: box.height + 60 } });

  // unsaved-changes dialog on closing a dirty tab
  await page.evaluate(() => { const s = window.__store.getState(); s.markActiveDirty(); });
  await page.waitForTimeout(100);
  const activeChip = page.locator('.tab-chip-active');
  await activeChip.locator('.tab-icon-btn').nth(1).click();
  await page.waitForTimeout(200);
  ok('unsaved dialog opens', (await page.locator('.modal').count()) === 1);
  const btns = await page.locator('.modal-footer button').allTextContents();
  ok('dialog buttons Save / Discard / Cancel', btns.join(',') === 'Save,Discard,Cancel', btns.join(','));
  await page.screenshot({ path: `${OUT}/07_unsaved_dialog.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  ok('Escape cancels (tab kept)', (await page.locator('.modal').count()) === 0 && (await st()).tabs.length === 3);
  // full page shot
  await page.screenshot({ path: `${OUT}/08_full.png` });
} finally {
  await browser.close();
  dev.kill();
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
