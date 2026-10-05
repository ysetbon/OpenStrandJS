// Guard for the layer panel's Strands / Masks switch and "every mask above
// every strand" (OpenStrand Studio 2.0: layer_panel.py set_layer_tab /
// _apply_layer_tab_filter / toggle_new_mask / request_delete_all_masks,
// save_load_manager.keep_masks_on_top; commits 9fc7cbd, 21ae6b0, ba88e75,
// 45d6f1f, d763a50). Ports every case of OSS tests/test_layer_tab_switch.py that
// applies to the web (the Windows mouse-capture / Ctrl+C snapshot / QDrag cases
// have no web counterpart) and adds: masks-on-top after a new strand, an
// attached strand, a load and a drag; Delete All (masks) as ONE undo step; the
// tab following the selection through undo/redo and canvas clicks; the Hebrew
// swap; the switch's exact OSS colours.
//
// Drives the vite dev server (window.__store / __io / __actions / __hit are
// DEV-only) in Chromium, on the real samples (public/settings/samples).
//
// Usage: node tools/layer_tab_check.mjs [outDir]
//        OSS_CHROMIUM=/path/to/chrome node tools/layer_tab_check.mjs
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(root, process.argv[2] || 'artifacts/layer_tab');
mkdirSync(OUT, { recursive: true });
const PORT = 5199;
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SAMPLES = path.join(root, 'public/settings/samples');
const sample = (name) => readFileSync(path.join(SAMPLES, name));
// Labels come from the app's own translations module (served by vite), so the
// check follows translations.ts.
let DICT = {};
const T = (key, lang = 'en') => DICT[lang]?.[key] ?? null;
const KEYS = ['draw_names', 'lock_layers', 'add_new_strand', 'delete_strand', 'deselect_all', 'delete_all',
  'new_mask', 'delete_mask', 'new_mask_hint', 'delete_all_masks_confirm', 'layer_tab_strands', 'layer_tab_masks',
  'mask_mode', 'move_mode'];

let browser;
try {
  browser = await chromium.launch(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => !!window.__store && !!window.__io && !!window.__hit, null, { timeout: 15000 });
  await page.evaluate(() => { localStorage.clear(); window.__store.getState().setSettings({ theme: 'default', language: 'en' }); });
  DICT = await page.evaluate(async (keys) => {
    const m = await import('/src/ui/translations.ts');
    const out = {};
    for (const l of ['en', 'he']) { out[l] = {}; for (const k of keys) out[l][k] = m.t(k, l); }
    return out;
  }, KEYS);

  // ---- helpers -------------------------------------------------------------
  const S = (fn, arg) => page.evaluate(fn, arg);
  const state = () => S(() => {
    const s = window.__store.getState();
    return {
      tab: s.layerTab, mode: s.mode, order: [...s.doc.order], selected: s.doc.selected_strand_name,
      canvasSel: s.selection.layerName, multi: [...s.multiSelectedLayers], pending: [...s.maskPending],
      past: s.past.length, future: s.future.length,
      masks: s.doc.order.filter((n) => s.doc.strands[n].type === 'MaskedStrand'),
      plain: s.doc.order.filter((n) => s.doc.strands[n].type !== 'MaskedStrand'),
    };
  });
  const masksOnTop = (st) => {
    const kinds = st.order.map((n) => st.masks.includes(n));
    return eq(kinds, [...kinds].sort((a, b) => a - b));
  };
  const rows = () => page.$$eval('.lp-list .nlb', (els) => els.map((e) => e.textContent.trim()));
  const visibleButtons = () => page.$$eval('.layer-control-stack .lc-btn', (els) => els.map((e) => e.textContent.trim()));
  const half = (tab) => page.locator(`.lc-tab[data-tab="${tab}"]`);
  const newMask = () => page.locator('[data-testid="new-mask"]');
  const hint = () => page.locator('.lp-notification');
  const row = (name) => page.locator('.lp-list .nlb', { hasText: new RegExp(`^${name}$`) }).first();
  const settle = (ms = 120) => page.waitForTimeout(ms);

  // OSS load_project through the real file input (loadProjectFile -> loadDocumentWithHistory -> fitPan).
  async function load(name) {
    await S(() => { const s = window.__store.getState(); s.setMode('attach'); s.setLayerTab('strands'); });
    await page.setInputFiles('input[type=file]', { name, mimeType: 'application/json', buffer: sample(name) });
    await page.waitForFunction((n) => window.__store.getState().doc.order.length > 0 && n, name);
    await settle(400);
  }

  // A client point on the canvas where `name` is the topmost pick (mask mode's
  // maskStrandsAtPoint, or select mode's hitTest).
  async function pointOn(name, kind = 'mask') {
    return S(({ name, kind }) => {
      const s = window.__store.getState();
      const t = s.doc.strands[name];
      const c = document.getElementById('c');
      const r = c.getBoundingClientRect();
      const P = [t.start, t.control_points[0], t.control_points[1], t.end];
      for (let i = 5; i <= 95; i += 3) {
        const u = i / 100, v = 1 - u;
        const w = {
          x: v * v * v * P[0].x + 3 * v * v * u * P[1].x + 3 * v * u * u * P[2].x + u * u * u * P[3].x,
          y: v * v * v * P[0].y + 3 * v * v * u * P[1].y + 3 * v * u * u * P[2].y + u * u * u * P[3].y,
        };
        const top = kind === 'mask'
          ? window.__hit.maskStrandsAtPoint(w, s.doc, s.settings)[0]
          : window.__hit.hitTest(w, s.doc, s.settings)?.layerName;
        if (top !== name) continue;
        const sx = w.x * s.view.zoom + s.view.panX, sy = w.y * s.view.zoom + s.view.panY;
        if (sx < 5 || sy < 5 || sx > c.width - 5 || sy > c.height - 5) continue;
        return { x: r.left + sx * r.width / c.width, y: r.top + sy * r.height / c.height };
      }
      return null;
    }, { name, kind });
  }
  async function clickOn(name, kind) {
    const p = await pointOn(name, kind);
    if (!p) throw new Error(`no clickable point on ${name}`);
    await page.mouse.click(p.x, p.y);
    await settle(150);
  }
  // Empty canvas area (no strand under it) for drawing a new strand.
  async function emptyStroke(fx0, fy0, fx1, fy1) {
    const box = await page.locator('#c').boundingBox();
    const a = { x: box.x + box.width * fx0, y: box.y + box.height * fy0 };
    const b = { x: box.x + box.width * fx1, y: box.y + box.height * fy1 };
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await settle(200);
  }
  async function drawNewStrand(f = [0.04, 0.06, 0.2, 0.12]) {
    await page.locator('.lc-btn', { hasText: new RegExp(`^${T('add_new_strand')}$`) }).click();
    await settle(60);
    await emptyStroke(...f);
  }
  // HTML5 drag of a layer row onto another row at a y offset inside it.
  async function dragRow(src, dst, yFrac) {
    const box = await row(dst).boundingBox();
    await row(src).dragTo(row(dst), { targetPosition: { x: 20, y: Math.max(1, Math.min(box.height - 1, box.height * yFrac)) } });
    await settle(150);
  }

  // ======================================================================
  // keep_masks_on_top itself (test_keep_masks_on_top_moves_locks_with_their_layers)
  {
    const r = await S(() => {
      const mk = (type) => ({ type });
      const strands = { '1_1': mk('Strand'), '1_1_2_1': mk('MaskedStrand'), '2_1': mk('Strand'), '3_1': mk('Strand') };
      const a = ['1_1', '1_1_2_1', '2_1', '3_1'];
      const b = ['1_1', '2_1', '1_1_2_1'];
      return { moved: window.__actions.keepMasksOnTop(a, strands), same: window.__actions.keepMasksOnTop(b, strands) === b };
    });
    ok('keepMasksOnTop: strands keep their order, masks follow all of them', eq(r.moved, ['1_1', '2_1', '3_1', '1_1_2_1']), JSON.stringify(r));
    ok('keepMasksOnTop: an order already in shape comes back untouched', r.same);
  }

  // ======================================================================
  await load('bridge.json');
  let st = await state();
  const BRIDGE_ORDER = st.order;
  ok('bridge.json loaded (8 strands, 5 masks)', st.plain.length === 8 && st.masks.length === 5, JSON.stringify(st.order));

  // test_each_tab_shows_only_its_layers_and_buttons
  ok('starts on the Strands tab', st.tab === 'strands');
  ok('Strands half pressed, Masks half released',
    await half('strands').getAttribute('aria-pressed') === 'true' && await half('masks').getAttribute('aria-pressed') === 'false');
  ok('Strands tab lists exactly the strands', eq((await rows()).sort(), [...st.plain].sort()), JSON.stringify(await rows()));
  ok('Strands tab buttons: Draw Names, Lock Layers, New Strand, Delete Strand, Deselect All, Delete All',
    eq(await visibleButtons(), ['draw_names', 'lock_layers', 'add_new_strand', 'delete_strand', 'deselect_all', 'delete_all'].map((k) => T(k))),
    JSON.stringify(await visibleButtons()));
  // Exact OSS styling of the two halves (_layer_tab_half_style)
  const css = (loc) => loc.evaluate((e) => {
    const c = getComputedStyle(e);
    return { bg: c.backgroundColor, color: c.color, weight: c.fontWeight, size: c.fontSize, bt: c.borderTopWidth,
      bb: c.borderBottomWidth, bcol: c.borderTopColor, tl: c.borderTopLeftRadius, tr: c.borderTopRightRadius,
      bl: c.borderBottomLeftRadius, br: c.borderBottomRightRadius, h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width };
  });
  {
    const p = await css(half('strands')), u = await css(half('masks'));
    const dn = await page.getByRole('button', { name: T('draw_names'), exact: true }).boundingBox();
    ok('pressed half: #a47551, bold 14px black, 1px #888 border, left corners 4px',
      p.bg === 'rgb(164, 117, 81)' && p.color === 'rgb(0, 0, 0)' && p.weight === '700' && p.size === '14px'
      && p.bt === '1px' && p.bb === '1px' && p.bcol === 'rgb(136, 136, 136)' && p.tl === '4px' && p.bl === '4px' && p.tr === '0px' && p.br === '0px',
      JSON.stringify(p));
    ok('released half: #e8e8e8, bold 14px #555, 3px bottom border, right corners 4px',
      u.bg === 'rgb(232, 232, 232)' && u.color === 'rgb(85, 85, 85)' && u.weight === '700' && u.bb === '3px' && u.bt === '1px'
      && u.tr === '4px' && u.br === '4px' && u.tl === '0px', JSON.stringify(u));
    ok('the two halves are equal and as tall as the bottom buttons',
      Math.abs(p.w - u.w) <= 1 && Math.abs(p.h - dn.height) <= 0.5 && Math.abs(u.h - dn.height) <= 0.5, `${p.w}/${u.w} ${p.h}/${u.h}/${dn.height}`);
    await half('strands').hover();
    await settle(50);
    ok('pressed half hover is #b98f6f', (await css(half('strands'))).bg === 'rgb(185, 143, 111)');
    await half('masks').hover();
    await settle(50);
    ok('released half hover is #f2f2f2', (await css(half('masks'))).bg === 'rgb(242, 242, 242)');
    await page.mouse.move(5, 5);
  }
  await page.screenshot({ path: `${OUT}/01_strands_tab.png` });

  await half('masks').click();
  await settle();
  st = await state();
  ok('clicking Masks opens the Masks tab', st.tab === 'masks');
  ok('Masks half pressed, Strands half released',
    await half('masks').getAttribute('aria-pressed') === 'true' && await half('strands').getAttribute('aria-pressed') === 'false');
  ok('Masks tab lists exactly the masks', eq((await rows()).sort(), [...st.masks].sort()), JSON.stringify(await rows()));
  ok('Masks tab buttons: New Mask, Delete Mask, Deselect All, Delete All',
    eq(await visibleButtons(), ['new_mask', 'delete_mask', 'deselect_all', 'delete_all'].map((k) => T(k))),
    JSON.stringify(await visibleButtons()));
  {
    const nm = await css(newMask()), ns = { bg: 'rgb(144, 238, 144)' };
    ok('New Mask is the New Strand green', nm.bg === ns.bg, nm.bg);
    const dm = await css(page.locator('[data-testid="delete-mask"]'));
    ok('Delete Mask starts disabled (nothing selected)', await page.locator('[data-testid="delete-mask"]').isDisabled(), dm.bg);
  }
  await page.screenshot({ path: `${OUT}/02_masks_tab.png` });

  // test_switching_never_changes_order_or_indices
  for (const tab of ['strands', 'masks', 'strands', 'masks', 'strands']) {
    await half(tab).click();
  }
  st = await state();
  ok('switching tabs never changes the layer order', eq(st.order, BRIDGE_ORDER), JSON.stringify(st.order));

  // test_switching_drops_a_selection_it_would_hide
  await row('2_1').click();
  await settle();
  st = await state();
  ok('panel click selects 2_1', st.selected === '2_1' && st.canvasSel === '2_1');
  await S(() => { const s = window.__store.getState(); s.toggleMultiSelect(); s.toggleMultiSelectLayer('3_1'); s.toggleMultiSelectLayer('1_1_3_1'); });
  await half('masks').click();
  await settle();
  st = await state();
  ok('switch to Masks: the tab stays Masks', st.tab === 'masks');
  ok('switch to Masks: the hidden strand selection is dropped (panel + canvas)', st.selected === null && st.canvasSel === null, JSON.stringify(st));
  ok('switch to Masks: only the mask stays multi-selected', eq(st.multi, ['1_1_3_1']), JSON.stringify(st.multi));
  await S(() => window.__store.getState().toggleMultiSelect());

  // test_selecting_a_layer_of_the_other_tab_opens_that_tab (store-level select_layer)
  await half('strands').click();
  await S(() => window.__store.getState().setSelection({ layerName: '1_1_4_1', handle: null }));
  st = await state();
  ok('selecting a mask opens the Masks tab', st.tab === 'masks');
  ok('... and the list shows the masks', eq((await rows()).sort(), [...st.masks].sort()));
  await S(() => window.__store.getState().setSelection({ layerName: '5_1', handle: null }));
  ok('selecting a strand opens the Strands tab', (await state()).tab === 'strands');

  // Canvas click route: select mode, click a strand while the Masks tab is open.
  await S(() => { const s = window.__store.getState(); s.deselectAll(); s.setLayerTab('masks'); s.setMode('select'); });
  await clickOn('6_1', 'select');
  st = await state();
  ok('a canvas click on a strand (select mode) opens the Strands tab', st.tab === 'strands' && st.selected === '6_1', JSON.stringify(st));

  // test_new_mask_starts_and_cancels_mask_mode
  await S(() => { const s = window.__store.getState(); s.deselectAll(); s.setMode('attach'); });
  await half('masks').click();
  await newMask().click();
  await settle();
  st = await state();
  ok('New Mask starts mask mode', st.mode === 'mask');
  ok('New Mask is pressed', await newMask().getAttribute('aria-pressed') === 'true');
  ok('the hint under the buttons reads new_mask_hint', (await hint().textContent()) === T('new_mask_hint'), await hint().count());
  {
    const c = await css(newMask());
    ok('pressed New Mask keeps the green and gets a 2px #3c3c3c border',
      c.bg === 'rgb(144, 238, 144)' && c.bt === '2px' && c.bcol === 'rgb(60, 60, 60)', JSON.stringify(c));
  }
  await page.screenshot({ path: `${OUT}/03_new_mask_on.png` });
  await newMask().click();
  await settle();
  st = await state();
  ok('New Mask pressed again: back to attach', st.mode === 'attach');
  ok('... released, hint cleared', await newMask().getAttribute('aria-pressed') === 'false' && await hint().count() === 0);
  await newMask().click();
  await S(() => window.__store.getState().setMaskPending(['3_1']));
  await half('strands').click();
  await settle();
  st = await state();
  ok('leaving the Masks tab ends mask mode', st.mode === 'attach');
  ok('... and cancels the half-made pick', st.pending.length === 0);
  ok('... hint gone', await hint().count() === 0);

  // test_any_mode_change_releases_new_mask
  await half('masks').click();
  await newMask().click();
  await page.locator('.tb-btn', { hasText: T('move_mode') }).click();
  await settle();
  ok('a toolbar mode change releases New Mask', await newMask().getAttribute('aria-pressed') === 'false' && (await state()).mode === 'move');
  ok('... and clears the hint', await hint().count() === 0);

  // Entering mask mode while on the Strands tab opens Masks (set_new_mask_active)
  await S(() => { const s = window.__store.getState(); s.setMode('attach'); s.setLayerTab('strands'); s.setSelection({ layerName: '2_1', handle: null }); s.setMode('mask'); });
  st = await state();
  ok('mask mode on the Strands tab opens the Masks tab and drops the strand selection',
    st.tab === 'masks' && st.selected === null && st.mode === 'mask', JSON.stringify(st));
  await S(() => window.__store.getState().setMode('attach'));

  // test_toolbar_has_no_mask_button
  ok('the toolbar has no Mask button', await page.locator('.tb-btn', { hasText: new RegExp(`^${T('mask_mode')}$`) }).count() === 0);

  // test_creating_a_mask_lands_in_the_masks_tab + test_new_mask_with_real_canvas_clicks
  st = await state();
  const pastBefore = st.past;
  await half('masks').click();
  await newMask().click();
  await clickOn('3_1', 'mask');
  st = await state();
  ok('first canvas pick in mask mode', eq(st.pending, ['3_1']) && st.mode === 'mask', JSON.stringify(st.pending));
  await clickOn('1_1', 'mask');
  st = await state();
  ok('second pick makes 3_1_1_1, drawn on top like every mask', st.order[st.order.length - 1] === '3_1_1_1', JSON.stringify(st.order));
  ok('the new mask is selected (panel + canvas)', st.selected === '3_1_1_1' && st.canvasSel === '3_1_1_1');
  ok('mask creation returns to attach mode, New Mask released', st.mode === 'attach' && await newMask().getAttribute('aria-pressed') === 'false');
  ok('the Masks tab stays open and lists the new mask', st.tab === 'masks' && (await rows()).includes('3_1_1_1'));
  ok('one mask = one undo step', st.past === pastBefore + 1, `${pastBefore} -> ${st.past}`);
  // test_one_undo_removes_a_new_mask
  await page.keyboard.press('Control+z');
  await settle();
  st = await state();
  ok('one undo removes the new mask, layers exactly as before', eq(st.order, BRIDGE_ORDER), JSON.stringify(st.order));
  await page.keyboard.press('Control+y');
  await settle();
  st = await state();
  ok('redo brings it back', st.order.includes('3_1_1_1'));
  await page.keyboard.press('Control+z');
  await settle();

  // test_delete_mask_acts_only_on_a_selected_mask
  await S(() => window.__store.getState().deselectAll());
  await half('masks').click();
  ok('Delete Mask disabled with nothing selected', await page.locator('[data-testid="delete-mask"]').isDisabled());
  await row('1_1_5_1').click();
  await settle();
  ok('selecting a mask enables Delete Mask', await page.locator('[data-testid="delete-mask"]').isEnabled());
  st = await state();
  const strandsBefore = st.plain;
  await page.locator('[data-testid="delete-mask"]').click();
  await settle();
  st = await state();
  ok('Delete Mask removes the mask, keeps every strand', !st.order.includes('1_1_5_1') && eq(st.plain, strandsBefore));
  ok('... the Masks tab stays open', st.tab === 'masks' && eq((await rows()).sort(), [...st.masks].sort()));
  // lock mode: a locked mask can't be deleted
  await S(() => { const s = window.__store.getState(); s.enterExitLockMode(); s.mutateDoc((d) => { d.locked_layers = ['1_1_4_1']; }); s.setSelection({ layerName: '1_1_4_1', handle: null }); });
  await settle(60);
  ok('Delete Mask disabled for a locked mask in lock mode', await page.locator('[data-testid="delete-mask"]').isDisabled());
  await S(() => { const s = window.__store.getState(); s.enterExitLockMode(); s.deselectAll(); });
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await settle();
  // Undo all the way back to the loaded bridge
  await S(() => { const s = window.__store.getState(); while (s.past && window.__store.getState().past.length) window.__store.getState().undo(); });
  st = await state();
  ok('undo returns to the loaded file', eq(st.order, BRIDGE_ORDER), JSON.stringify(st.order));

  // test_delete_all_on_masks_tab_keeps_the_strands (+ one undo step)
  await S(() => { const s = window.__store.getState(); s.setLayerTab('masks'); s.enterExitLockMode(); s.mutateDoc((d) => { d.locked_layers = ['1_1_3_1', '2_1']; }); });
  await page.locator('[data-testid="delete-all-masks"]').click();
  await settle();
  const dlg = page.locator('.modal, [role="dialog"]').last();
  ok('Delete All (masks) asks first, with delete_all_masks_confirm', (await page.getByText(T('delete_all_masks_confirm')).count()) === 1);
  ok('... titled delete_all', (await page.getByText(T('delete_all'), { exact: true }).count()) >= 1);
  ok('... No is the default button', await page.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'delete-all-masks-no');
  await page.screenshot({ path: `${OUT}/04_delete_all_masks_confirm.png` });
  await page.locator('[data-testid="delete-all-masks-no"]').click();
  await settle();
  st = await state();
  ok('"No" changes nothing (5 masks)', st.masks.length === 5);
  const pastAll = st.past;
  await page.locator('[data-testid="delete-all-masks"]').click();
  await page.locator('[data-testid="delete-all-masks-yes"]').click();
  await settle();
  st = await state();
  const locks = await S(() => window.__store.getState().doc.locked_layers);
  ok('"Yes" removes every mask, keeps every strand in order', st.masks.length === 0 && eq(st.order, BRIDGE_ORDER.filter((n) => n.split('_').length === 2)), JSON.stringify(st.order));
  ok('... the Masks list is empty', (await rows()).length === 0);
  ok('... locks on removed masks go, strand locks stay', eq(locks, ['2_1']), JSON.stringify(locks));
  ok('... in ONE undo step', st.past === pastAll + 1, `${pastAll} -> ${st.past}`);
  await page.keyboard.press('Control+z');
  await settle();
  st = await state();
  ok('one undo brings every mask back in place', eq(st.order, BRIDGE_ORDER));
  await page.keyboard.press('Control+y');
  await settle();
  ok('redo removes them again', (await state()).masks.length === 0);
  await page.keyboard.press('Control+z');
  await S(() => { const s = window.__store.getState(); s.enterExitLockMode(); while (window.__store.getState().past.length) window.__store.getState().undo(); s.deselectAll(); });

  // test_mask_editing_locks_the_switch
  await S(() => window.__store.getState().enterMaskEdit('1_1_3_1'));
  await settle();
  const dis = async (loc) => loc.isDisabled();
  ok('Edit Mask session disables both halves', await dis(half('strands')) && await dis(half('masks')));
  ok('... New Mask, Delete Mask and Delete All (masks)',
    await dis(newMask()) && await dis(page.locator('[data-testid="delete-mask"]')) && await dis(page.locator('[data-testid="delete-all-masks"]')));
  await S(() => window.__store.getState().exitMaskEdit());
  await settle();
  ok('leaving it re-enables the switch and New Mask', !(await dis(half('strands'))) && !(await dis(newMask())));
  ok('... Delete Mask follows the selection again (mask selected)', !(await dis(page.locator('[data-testid="delete-mask"]'))));
  await S(() => window.__store.getState().deselectAll());

  // test_drop_ignores_hidden_buttons
  await S(() => window.__store.getState().mutateDoc((d) => {
    d.order = d.order.filter((n) => n !== '1_1_3_1');
    d.order.splice(d.order.indexOf('5_1'), 0, '1_1_3_1');
  }));
  await half('strands').click();
  await settle();
  await dragRow('1_1', '2_1', 0.1);   // top edge of 2_1
  st = await state();
  const shownRows = await rows();
  ok('drop next to the visible row under the cursor (hidden mask ignored)',
    shownRows.indexOf('1_1') === shownRows.indexOf('2_1') - 1, JSON.stringify(shownRows));
  ok('... the hidden mask stays above 4_1', st.order.indexOf('1_1_3_1') > st.order.indexOf('4_1'), JSON.stringify(st.order));
  ok('... and every mask is back above every strand', masksOnTop(st), JSON.stringify(st.order));
  await S(() => { while (window.__store.getState().past.length) window.__store.getState().undo(); });

  // test_drop_below_the_last_mask_keeps_it_above_the_strands
  await half('masks').click();
  await settle();
  await dragRow('5_1_8_1', '1_1_3_1', 0.9);   // just under the lowest mask
  st = await state();
  ok('a mask dropped under the lowest mask stays above every strand', masksOnTop(st), JSON.stringify(st.order));
  ok('... right below 1_1_3_1', st.order.indexOf('5_1_8_1') === st.order.indexOf('1_1_3_1') - 1, JSON.stringify(st.order));
  await S(() => { while (window.__store.getState().past.length) window.__store.getState().undo(); });

  // test_dragging_a_strand_to_the_top_keeps_it_under_the_masks
  await half('strands').click();
  await settle();
  await dragRow('1_1', '8_1', 0.1);
  st = await state();
  ok('a strand dragged to the top stays under every mask', masksOnTop(st) && st.plain[st.plain.length - 1] === '1_1', JSON.stringify(st.order));
  await S(() => { while (window.__store.getState().past.length) window.__store.getState().undo(); });

  // test_a_new_strand_is_drawn_under_the_masks
  await drawNewStrand();
  st = await state();
  ok('a new strand is created (9_1)', st.order.includes('9_1'), JSON.stringify(st.order));
  ok('... under the masks', masksOnTop(st), JSON.stringify(st.order));
  ok('... selected, on the Strands tab, in attach mode', st.selected === '9_1' && st.tab === 'strands' && st.mode === 'attach', JSON.stringify(st));
  // an attached strand too
  {
    const end = await S(() => {
      const s = window.__store.getState(); const t = s.doc.strands['9_1'];
      const c = document.getElementById('c'); const r = c.getBoundingClientRect();
      const sx = t.end.x * s.view.zoom + s.view.panX, sy = t.end.y * s.view.zoom + s.view.panY;
      return { x: r.left + sx * r.width / c.width, y: r.top + sy * r.height / c.height };
    });
    await page.mouse.move(end.x, end.y);
    await page.mouse.down();
    await page.mouse.move(end.x + 60, end.y + 50, { steps: 8 });
    await page.mouse.up();
    await settle(200);
    st = await state();
    ok('an attached strand (9_2) also lands under the masks', st.order.includes('9_2') && masksOnTop(st), JSON.stringify(st.order));
  }

  // test_a_new_strand_always_ends_in_attach_mode[mask]: New Strand while New Mask is on
  await half('masks').click();
  await newMask().click();
  await page.locator('.layer-control-stack').evaluate(() => {});
  await S(() => window.__store.getState().armNewStrand());   // what the N key / New Strand does
  st = await state();
  ok('New Strand while New Mask is on: attach mode, New Mask released', st.mode === 'attach' && await newMask().getAttribute('aria-pressed') === 'false');
  ok('... hint cleared', await hint().count() === 0);
  await emptyStroke(0.05, 0.85, 0.2, 0.9);
  st = await state();
  ok('... the strand is drawn and the Strands tab opens', st.order.includes('10_1') && st.tab === 'strands' && st.mode === 'attach', JSON.stringify(st));

  // test_undo_during_new_mask_ends_mask_mode (picks 0 and 1)
  for (const picks of [0, 1]) {
    await load('bridge.json');
    await S(() => window.__store.getState().setMode('select'));
    await clickOn('2_1', 'select');           // 2_1 selected (and attach mode)
    await drawNewStrand();                    // the undo baseline keeps 2_1 selected
    await half('masks').click();
    await newMask().click();
    if (picks) await clickOn('3_1', 'mask');
    st = await state();
    ok(`[picks=${picks}] mask mode on before undo`, st.mode === 'mask' && st.pending.length === picks, JSON.stringify(st));
    await page.keyboard.press('Control+z');
    await settle(200);
    st = await state();
    ok(`[picks=${picks}] undo restores the strand selection -> Strands tab`, st.tab === 'strands' && st.selected === '2_1', JSON.stringify(st));
    ok(`[picks=${picks}] ... mask mode ended (attach), pick cancelled`, st.mode === 'attach' && st.pending.length === 0, JSON.stringify(st));
    ok(`[picks=${picks}] ... hint cleared`, await hint().count() === 0);
    const count = st.order.length;
    await drawNewStrand([0.05, 0.85, 0.2, 0.9]);
    st = await state();
    ok(`[picks=${picks}] a new strand works after`, st.order.length === count + 1 && st.mode === 'attach' && st.tab === 'strands', JSON.stringify(st));
  }

  // Undo / redo restoring a MASK selection opens the Masks tab
  await load('bridge.json');
  await S(() => {
    const s = window.__store.getState();
    s.setSelection({ layerName: '2_1', handle: null });
    s.commitEdit((d) => { d.strands['7_1'].is_hidden = true; });   // baseline + present select 2_1
    s.setSelection({ layerName: '1_1_3_1', handle: null });           // present doc now selects a mask
  });
  ok('selecting the mask opened Masks', (await state()).tab === 'masks');
  await page.keyboard.press('Control+z');
  await settle();
  st = await state();
  ok('undo restoring a strand selection opens Strands', st.tab === 'strands' && st.selected === '2_1', JSON.stringify(st));
  await page.keyboard.press('Control+y');
  await settle();
  st = await state();
  ok('redo restoring a mask selection opens Masks', st.tab === 'masks' && st.selected === '1_1_3_1', JSON.stringify(st));

  // test_loading_a_file_puts_the_masks_above_every_strand
  await load('thick_and_thin.json');
  st = await state();
  const raw = JSON.parse(sample('thick_and_thin.json').toString());
  const saved = raw.states[raw.current_step - 1].data.strands.map((s) => s.layer_name);
  ok('thick_and_thin.json keeps 11_1/12_1 above its masks in the file', saved.indexOf('12_1') > saved.indexOf('1_1_6_1'));
  ok('loading puts every mask above every strand', masksOnTop(st), JSON.stringify(st.order));
  ok('... each group keeps its own order',
    eq(st.order, [...saved.filter((n) => n.split('_').length === 2), ...saved.filter((n) => n.split('_').length === 4)]), JSON.stringify(st.order));
  {
    const out = await S(() => window.__io.serializeProject(window.__store.getState().doc).strands.map((s) => [s.layer_name, s.index]));
    ok('save writes the normalised order (OSS saves canvas.strands)', eq(out.map((x) => x[0]), st.order) && out.every((x, i) => x[1] === i), JSON.stringify(out));
    const parsed = await S((txt) => window.__io.loadProjectFile(JSON.parse(txt)).doc.order, sample('thick_and_thin.json').toString());
    ok('the file parser itself (load_strands_from_data) still keeps the file order', eq(parsed, saved));
  }

  // test_hebrew_puts_strands_on_the_right + test_labels_fit_the_panel (on the
  // small bridge.json: every language switch re-renders the canvas)
  await load('bridge.json');
  const panelWidths = new Set();
  for (const lang of ['en', 'fr', 'de', 'it', 'es', 'pt', 'he', 'ru', 'fi', 'sv', 'ja', 'zh']) {
    await S((l) => window.__store.getState().setSettings({ language: l }), lang);
    await settle(60);
    for (const tab of ['strands', 'masks']) {
      // OSS's own rule, test_labels_fit_the_panel:
      //   need = QFontMetrics(half.font()).horizontalAdvance(half.text())
      //   assert need <= half.width() - 4
      // need = the label's advance (a Range over its text), half.width() = the
      // half's border box.
      const fit = await half(tab).evaluate((e) => {
        const r = document.createRange();
        r.selectNodeContents(e);
        return { need: r.getBoundingClientRect().width, width: e.getBoundingClientRect().width, sw: e.scrollWidth, cw: e.clientWidth };
      });
      ok(`[${lang}] '${await half(tab).textContent()}' needs <= its half - 4 (OSS test_labels_fit_the_panel)`,
        fit.need <= fit.width - 4 && fit.sw <= fit.cw, JSON.stringify(fit));
    }
    {
      const a = (await half('strands').boundingBox()).width, b = (await half('masks').boundingBox()).width;
      ok(`[${lang}] the halves are equal`, Math.abs(a - b) <= 1, `${a}/${b}`);
    }
    panelWidths.add((await page.locator('.layer-panel').boundingBox()).width);
    await half('masks').click();
    for (const id of ['new-mask', 'delete-mask', 'delete-all-masks']) {
      const loc = page.locator(`[data-testid="${id}"]`);
      ok(`[${lang}] '${await loc.textContent()}' fits its button`, await loc.evaluate((e) => e.scrollWidth <= e.clientWidth));
    }
    await half('strands').click();
    if (lang === 'ja') await page.locator('.layer-panel').screenshot({ path: `${OUT}/04b_japanese_panel.png` });
  }
  // OSS's column does not change with the language (list_column_min_width); the
  // port's floor is the 146px the layer buttons need or, if more, two halves
  // holding the widest label of any language with that 4px (layerTabFit.ts).
  {
    const floor = await S(async () => (await import('/src/ui/layerTabFit.ts')).tabRowMinWidth());
    const column = (await page.locator('.lp-left').boundingBox()).width;
    ok('the panel is as wide in every language', panelWidths.size === 1, JSON.stringify([...panelWidths]));
    ok(`list column is max(146, the switch's floor ${floor})`, Math.abs(column - Math.max(146, floor)) <= 0.5, String(column));
  }
  // Text-only zoom (Firefox) scales even px fonts while the page is open: the
  // switch's labels must still clear their halves. Simulated by doubling the
  // tabs' font, as 200% text zoom does; layerTabFit.watchTabFont re-measures.
  {
    await S((l) => window.__store.getState().setSettings({ language: l }), 'ja');
    await settle(60);
    const before = (await page.locator('.lp-left').boundingBox()).width;
    const tag = await page.addStyleTag({ content: '.lc-tab { font-size: 28px !important; }' });
    await settle(120);
    const fit = await half('strands').evaluate((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      return { need: r.getBoundingClientRect().width, width: e.getBoundingClientRect().width };
    });
    const zoomed = (await page.locator('.lp-left').boundingBox()).width;
    ok('200% text zoom: the column widens for the larger labels', zoomed > before, `${before} -> ${zoomed}`);
    ok("200% text zoom: [ja] the Strands label still clears its half by 4", fit.need <= fit.width - 4, JSON.stringify(fit));
    await tag.evaluate((e) => e.remove());
    await settle(120);
    const back = (await page.locator('.lp-left').boundingBox()).width;
    ok('text zoom back to 100%: the column returns to its floor', Math.abs(back - before) <= 0.5, `${before} -> ${back}`);
    await S((l) => window.__store.getState().setSettings({ language: l }), 'en');
    await settle(60);
  }
  await S(() => window.__store.getState().setSettings({ language: 'he' }));
  await settle();
  {
    const sx = (await half('strands').boundingBox()).x, mx = (await half('masks').boundingBox()).x;
    ok('Hebrew: Strands on the right, Masks on the left', sx > mx, `${sx} vs ${mx}`);
    ok('Hebrew: Strands label is layer_tab_strands (he)', (await half('strands').textContent()) === T('layer_tab_strands', 'he'));
    const s = await css(half('strands')), m = await css(half('masks'));
    ok('Hebrew: outer corners follow the swap', s.tr === '4px' && s.tl === '0px' && m.tl === '4px' && m.tr === '0px', JSON.stringify([s, m]));
    await page.screenshot({ path: `${OUT}/05_hebrew.png` });
  }
  await S(() => window.__store.getState().setSettings({ language: 'en', theme: 'dark' }));
  await settle();
  {
    const p = await css(half('strands')), u = await css(half('masks'));
    ok('dark theme: the switch keeps OSS\'s fixed colours', p.bg === 'rgb(164, 117, 81)' && u.bg === 'rgb(232, 232, 232)', JSON.stringify([p.bg, u.bg]));
    await half('masks').click();
    await newMask().click();
    await page.screenshot({ path: `${OUT}/06_dark_masks_new_mask.png` });
    await newMask().click();
  }
  await S(() => window.__store.getState().setSettings({ theme: 'default' }));

  ok('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  console.log('FAIL  exception  ' + (e && e.stack || e));
  fails++;
} finally {
  if (browser) await browser.close();
  stopDev();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall layer-tab checks passed');
process.exit(fails ? 1 : 0);
