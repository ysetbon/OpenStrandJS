// Guard for the collapsible group column (src/ui/GroupRail.tsx, the collapse
// state in editorStore.ts, the chevron + Ctrl+G in LayerPanel.tsx, the widths
// in App.tsx) against OSS group_rail.py / layer_panel.set_group_panel_collapsed
// / main_window._save_group_panel_rail (OpenStrandStudio PRs #18 and #19):
// the column collapses to a 40px rail and the canvas gains exactly the width it
// gave up, the state is persisted and restored on reload without animation,
// the rail mirrors the groups (first letter of the name, position when the
// name has no letter or digit), the create tile runs the Create Group flow
// while staying collapsed and follows the language (G / ק), a group tile
// expands the column and flashes that group, the chevron mirrors in RTL,
// Ctrl+G toggles except while a modal dialog is up, mask editing disables the
// create tile, and a user-widened panel keeps its extra width across a toggle.
// Drives the vite dev server (window.__store is DEV-only) in Chromium and
// writes screenshots to $OUT.
//
// Usage: node tools/group_rail_check.mjs [outDir]
//        OSS_CHROMIUM=/path/to/chrome node tools/group_rail_check.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(root, process.argv[2] || 'artifacts/group_rail');
mkdirSync(OUT, { recursive: true });
const PORT = 5198;
const dev = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe' });
await new Promise((r) => { dev.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) r(); }); setTimeout(r, 8000); });
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// Widths from App.tsx: list column 146 + group column (113 expanded / 41 rail) + 1.
const PANEL_FULL = 260;
const PANEL_RAIL = 188;
const GROUP_FULL = 113;
const GROUP_RAIL = 41;
const FREED = PANEL_FULL - PANEL_RAIL;   // 72

const browser = await chromium.launch(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => !!window.__store, null, { timeout: 15000 });
  await page.evaluate(() => { localStorage.clear(); window.__store.getState().setSettings({ theme: 'default', language: 'en' }); });

  const w = async (sel) => (await page.locator(sel).first().boundingBox())?.width ?? -1;
  const collapsed = () => page.evaluate(() => window.__store.getState().groupPanelCollapsed);
  // The chevron is the theme's group_toggle_<theme>.png, flipped via data-dir.
  const chevron = () => page.locator('.lp-group-toggle').getAttribute('data-dir');
  const chevronIcon = async () => path.basename(new URL(await page.locator('.lp-group-toggle-icon').getAttribute('src'), 'http://x/').pathname);
  // The basename alone would pass with a broken asset or a wrong BASE_URL, so
  // the PNG must also have actually loaded.
  const chevronLoaded = () => page.evaluate(() => { const i = document.querySelector('.lp-group-toggle-icon'); return !!i && i.complete && i.naturalWidth > 0; });
  const chevronLabel = () => page.locator('.lp-group-toggle').getAttribute('aria-label');
  // Pressed color: force :active through CDP and read the computed background;
  // it must be the Create Group button's pressed color (--create-group-pressed).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const pressedBg = async (sel) => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
    const bg = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    return bg;
  };
  const token = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
  const chevronBox = async () => { const b = await page.locator('.lp-group-toggle-icon').boundingBox(); return [b.width, b.height]; };
  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

  // ---- default: expanded, full widths, chevron points to the outer edge
  ok('expanded by default', !(await collapsed()));
  ok('no rail while expanded', (await page.locator('.gp-rail').count()) === 0);
  ok(`group column ${GROUP_FULL}px`, near(await w('.lp-right'), GROUP_FULL), String(await w('.lp-right')));
  ok(`layer panel ${PANEL_FULL}px`, near(await w('.layer-panel'), PANEL_FULL), String(await w('.layer-panel')));
  ok('chevron points right in LTR while expanded', (await chevron()) === 'right', await chevron());
  ok('chevron is the default theme PNG', (await chevronIcon()) === 'group_toggle_default.png', await chevronIcon());
  ok('default theme PNG loaded', await chevronLoaded());
  ok('chevron has an accessible name (collapse)', (await chevronLabel()) === 'Collapse group panel', await chevronLabel());
  ok('chevron has no text glyph', ((await page.locator('.lp-group-toggle').textContent()) || '').trim() === '');
  ok('chevron icon is 13px (20% under 16)', JSON.stringify(await chevronBox()) === '[13,13]', JSON.stringify(await chevronBox()));
  ok('chevron presses in the Create Group pressed color (default)', (await pressedBg('.lp-group-toggle')) === hex2rgb(await token('--create-group-pressed')), await pressedBg('.lp-group-toggle'));
  ok('chevron has no tooltip', (await page.locator('.lp-group-toggle').getAttribute('title')) === null);
  const canvasBefore = await w('.canvas-wrap');
  await shot('01_expanded');

  // ---- collapse frees the width, expand restores it (OSS test_collapse_frees_width_and_expand_restores)
  await page.click('.lp-group-toggle');
  await page.waitForTimeout(350);
  ok('collapsed after the chevron', await collapsed());
  ok('rail shown, button + tree gone', (await page.locator('.gp-rail').count()) === 1 && (await page.locator('.gp-create-btn').count()) === 0 && (await page.locator('.gp-tree').count()) === 0);
  ok(`group column ${GROUP_RAIL}px`, near(await w('.lp-right'), GROUP_RAIL), String(await w('.lp-right')));
  ok(`layer panel ${PANEL_RAIL}px`, near(await w('.layer-panel'), PANEL_RAIL), String(await w('.layer-panel')));
  ok(`canvas gained ${FREED}px`, near(await w('.canvas-wrap'), canvasBefore + FREED), `${canvasBefore} -> ${await w('.canvas-wrap')}`);
  ok('rail 40px wide', near(await w('.gp-rail'), 40), String(await w('.gp-rail')));
  const createBox = await page.locator('.gp-rail-create').boundingBox();
  ok('create tile 30x30', near(createBox.width, 30) && near(createBox.height, 30), JSON.stringify(createBox));
  ok('create tile reads G in English', (await page.locator('.gp-rail-create').textContent()) === 'G');
  ok('create tile has no tooltip', (await page.locator('.gp-rail-create').getAttribute('title')) === null);
  ok('chevron points left while collapsed', (await chevron()) === 'left', await chevron());
  ok('chevron has an accessible name (expand)', (await chevronLabel()) === 'Expand group panel', await chevronLabel());
  ok('persisted GroupPanelRail true', (await page.evaluate(() => localStorage.getItem('openstrandjs.groupPanelRail'))) === 'true');
  await shot('02_collapsed_empty');

  await page.click('.lp-group-toggle');
  await page.waitForTimeout(350);
  ok('expanded again', !(await collapsed()));
  ok(`layer panel back to ${PANEL_FULL}px`, near(await w('.layer-panel'), PANEL_FULL), String(await w('.layer-panel')));
  ok('canvas width restored', near(await w('.canvas-wrap'), canvasBefore), `${canvasBefore} vs ${await w('.canvas-wrap')}`);
  ok('persisted GroupPanelRail false', (await page.evaluate(() => localStorage.getItem('openstrandjs.groupPanelRail'))) === 'false');

  // ---- the rail mirrors the groups (OSS test_rail_mirrors_the_group_tree + tile_label rules)
  await page.evaluate(() => {
    const s = window.__store.getState();
    s.mutateDoc((d) => {
      d.groups['Group 1'] = { main_strands: [] };
      d.groups['braid'] = { main_strands: [] };
      d.groups['  knot'] = { main_strands: [] };
      d.groups['42 strands'] = { main_strands: [] };
      d.groups['***'] = { main_strands: [] };
      d.groups['קבוצה'] = { main_strands: [] };
    });
    s.toggleGroupPanel();
  });
  await page.waitForTimeout(350);
  const tiles = () => page.locator('.gp-rail-tile').allTextContents();
  ok('one tile per group, first letter upper-cased, position when no letter/digit',
    (await tiles()).join(',') === 'G,B,K,4,5,ק', (await tiles()).join(','));
  const tileBox = await page.locator('.gp-rail-tile').first().boundingBox();
  ok('group tile 30x24', near(tileBox.width, 30) && near(tileBox.height, 24), JSON.stringify(tileBox));
  ok('tiles have no tooltip', (await page.locator('.gp-rail-tile').first().getAttribute('title')) === null);
  await shot('03_collapsed_groups');
  await page.evaluate(() => window.__store.getState().mutateDoc((d) => {
    delete d.groups['***'];
    const g = d.groups['braid']; delete d.groups['braid']; d.groups['zebra'] = g;
  }));
  await page.waitForTimeout(100);
  ok('tiles follow delete + rename', (await tiles()).join(',') === 'G,K,4,ק,Z', (await tiles()).join(','));

  // ---- the create tile runs the Create Group flow while staying collapsed
  await page.click('.gp-rail-create');
  await page.waitForTimeout(150);
  ok('create tile opens the Create Group dialog', (await page.locator('.modal').count()) === 1);
  ok('column stays collapsed with the dialog up', await collapsed());
  // Ctrl+G is silent while a modal dialog has taken over (OSS WindowShortcut).
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(100);
  ok('Ctrl+G ignored while a modal dialog is open', await collapsed());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok('dialog closed', (await page.locator('.modal').count()) === 0);

  // ---- Ctrl+G toggles (OSS test_ctrl_g_toggles)
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(350);
  ok('Ctrl+G expands', !(await collapsed()));
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(350);
  ok('Ctrl+G collapses', await collapsed());

  // ---- a group tile expands the column and flashes that group (OSS focus_group)
  await page.locator('.gp-rail-tile[data-group="zebra"]').click();
  await page.waitForTimeout(120);
  ok('tile expands the column', !(await collapsed()));
  const flashRow = page.locator('.gp-group-row.gp-flash');
  ok('the activated group flashes', (await flashRow.count()) === 1 && (await flashRow.textContent()).includes('zebra'));
  const flashBg = await page.evaluate(() => {
    const el = document.querySelector('.gp-group-row.gp-flash');
    const rs = getComputedStyle(document.documentElement);
    return el ? [getComputedStyle(el).backgroundColor, rs.getPropertyValue('--menu-selected-bg').trim()] : [];
  });
  ok('flash paints the tree selection colors', flashBg.length === 2 && flashBg[0] === hex2rgb(flashBg[1]), JSON.stringify(flashBg));
  await shot('04_flash');
  await page.waitForTimeout(1000);
  ok('flash ends after 900ms', (await page.locator('.gp-group-row.gp-flash').count()) === 0);

  // ---- Hebrew: the create tile reads ק and the chevron mirrors (OSS PR #19)
  await page.evaluate(() => window.__store.getState().setSettings({ language: 'he' }));
  await page.waitForTimeout(150);
  ok('chevron points left in RTL while expanded', (await chevron()) === 'left', await chevron());
  await page.evaluate(() => window.__store.getState().setGroupPanelCollapsed(true));
  await page.waitForTimeout(350);
  ok('create tile reads ק in Hebrew', (await page.locator('.gp-rail-create').textContent()) === 'ק', await page.locator('.gp-rail-create').textContent());
  ok('chevron points right in RTL while collapsed', (await chevron()) === 'right', await chevron());
  await page.evaluate(() => window.__store.getState().setSettings({ theme: 'dark' }));
  await page.waitForTimeout(150);
  ok('chevron swaps to the dark theme PNG', (await chevronIcon()) === 'group_toggle_dark.png', await chevronIcon());
  ok('dark theme PNG loaded', await chevronLoaded());
  ok('chevron presses in the Create Group pressed color (dark)', (await pressedBg('.lp-group-toggle')) === hex2rgb(await token('--create-group-pressed')), await pressedBg('.lp-group-toggle'));
  ok('rail tile presses in the Create Group pressed color (dark)', (await pressedBg('.gp-rail-tile')) === hex2rgb(await token('--create-group-pressed')), await pressedBg('.gp-rail-tile'));
  ok('accessible name follows the language', (await chevronLabel()) === 'הרחבת עמודת הקבוצות', await chevronLabel());
  await shot('05_rtl_dark_collapsed');
  await page.evaluate(() => window.__store.getState().setSettings({ theme: 'light' }));
  await page.waitForTimeout(150);
  ok('chevron swaps to the light theme PNG', (await chevronIcon()) === 'group_toggle_light.png', await chevronIcon());
  ok('light theme PNG loaded', await chevronLoaded());
  ok('chevron presses in the Create Group pressed color (light)', (await pressedBg('.lp-group-toggle')) === hex2rgb(await token('--create-group-pressed')), await pressedBg('.lp-group-toggle'));
  await page.evaluate(() => window.__store.getState().setSettings({ language: 'en', theme: 'default' }));
  await page.waitForTimeout(150);
  ok('create tile back to G in English', (await page.locator('.gp-rail-create').textContent()) === 'G');

  // ---- mask editing disables the create tile (OSS disable_controls)
  await page.evaluate(() => window.__store.setState({ maskEditTarget: 'x_y' }));
  await page.waitForTimeout(100);
  ok('create tile disabled while editing a mask', await page.locator('.gp-rail-create').isDisabled());
  await page.evaluate(() => window.__store.setState({ maskEditTarget: null }));
  await page.waitForTimeout(100);
  ok('create tile enabled again', !(await page.locator('.gp-rail-create').isDisabled()));

  // ---- reload restores the collapsed state without animation
  await page.reload();
  await page.waitForFunction(() => !!window.__store, null, { timeout: 15000 });
  ok('collapsed state restored on reload', await collapsed());
  ok(`layer panel ${PANEL_RAIL}px straight after load`, near(await w('.layer-panel'), PANEL_RAIL), String(await w('.layer-panel')));
  ok('no animation class on load', (await page.locator('.shell-group-anim').count()) === 0);

  // ---- a user-widened panel keeps its extra width across a toggle (keep_split)
  await page.evaluate(() => window.__store.getState().setGroupPanelCollapsed(false));
  await page.waitForTimeout(350);
  const handle = await page.locator('.splitter-handle').boundingBox();
  await page.mouse.move(handle.x + 0.5, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x - 100, handle.y + 200, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const widened = await w('.layer-panel');
  ok('panel widened by the splitter', near(widened, PANEL_FULL + 100, 2), String(widened));
  await page.evaluate(() => window.__store.getState().toggleGroupPanel());
  await page.waitForTimeout(350);
  ok(`collapse keeps the extra width (shifted by ${FREED})`, near(await w('.layer-panel'), widened - FREED, 2), String(await w('.layer-panel')));
  await page.evaluate(() => window.__store.getState().toggleGroupPanel());
  await page.waitForTimeout(350);
  ok('expand takes exactly that back', near(await w('.layer-panel'), widened, 2), String(await w('.layer-panel')));
  await shot('06_widened_expanded');
} finally {
  await browser.close();
  dev.kill();
}
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
