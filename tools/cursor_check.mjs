// Guard for the canvas cursor + the layer panel's pan button, driven through the
// REAL app (dev server, so the assertions can read the store via window.__store).
//
// The rules are OSS strand_drawing_canvas.py's setCursor calls, one per mode on
// entry (set_mode + <Mode>.activate), the crosshair of an Edit Mask session, the
// open hand of the hand tool, and the CLOSED hand for the length of any pan
// drag — middle-drag, right-drag, or hand-tool left-drag — with the interrupted
// cursor restored on release. A right-drag pan also presses the layer panel's
// pan button (closed-hand icon) until the button goes up again
// (_update_pan_button_icon). OSS never changes the cursor on hover.
//
// Each assertion fails if its rule is reverted: before this guard, move mode
// showed a crosshair (OSS: open hand), hovering a handle swapped in a grab
// cursor no mode in OSS has, and a right/middle-drag pan left the cursor and
// the pan button exactly as they were.
//
// Usage: node tools/cursor_check.mjs
//        OSS_CHROMIUM=/path/to/chrome node tools/cursor_check.mjs
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };

const project = JSON.parse(readFileSync(path.join(root, 'fixtures/box_stitch.json'), 'utf8'));

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { port: 5211, strictPort: true, open: false, host: '127.0.0.1' },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://127.0.0.1:5211/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 30000 });
  await page.evaluate(({ project }) => {
    const st = window.__store.getState();
    st.loadDocument(window.__io.loadProject(project));
    st.setMode('select');
  }, { project });
  await page.waitForTimeout(1000);

  const cursor = () => page.evaluate(() => document.getElementById('c').style.cursor);
  const state = () => page.evaluate(() => {
    const s = window.__store.getState();
    return { mode: s.mode, panMode: s.panMode, panning: s.panning, view: { ...s.view } };
  });
  const setMode = async (m) => {
    await page.evaluate((m) => window.__store.getState().setMode(m), m);
    await page.waitForTimeout(150);
  };
  const panButton = page.locator('.control-column .cc-btn[title^="Pan"]');
  const panIcon = async () => path.basename(await panButton.locator('img').getAttribute('src'));
  const panChecked = async () => (await panButton.getAttribute('class')).includes('checked');
  const box = await page.locator('#c').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  /** Screen position of a world point. */
  const screenOf = (w) => page.evaluate((w) => {
    const v = window.__store.getState().view;
    return { x: v.panX + w.x * v.zoom, y: v.panY + w.y * v.zoom };
  }, w);
  const settle = () => page.waitForTimeout(120);

  // ---------------------------------------------------- 1. one cursor per mode
  // OSS set_mode: attach Cross, move OpenHand, select PointingHand, mask Cross,
  // angle_adjust SizeAll, rotate SizeAll; view Arrow then ViewMode.activate ->
  // OpenHand.
  const expected = {
    select: 'pointer', move: 'grab', attach: 'crosshair', mask: 'crosshair',
    rotate: 'move', angle: 'move', view: 'grab',
  };
  for (const [mode, want] of Object.entries(expected)) {
    await setMode(mode);
    const got = await cursor();
    ok(`${mode} mode shows the OSS cursor (${want})`, got === want, `got '${got}'`);
  }

  // ------------------------------------------ 2. hover never changes the cursor
  // Park the pointer on a strand endpoint in select mode (which tracks hover
  // handles) and in attach mode: OSS keeps the mode cursor, it does not swap in a
  // hand over a handle.
  const first = await page.evaluate(() => {
    const d = window.__store.getState().doc;
    return d.strands[d.order[0]].start;
  });
  for (const mode of ['select', 'attach', 'move']) {
    await setMode(mode);
    const sp = await screenOf(first);
    await page.mouse.move(box.x + sp.x + 40, box.y + sp.y + 40);
    await settle();
    await page.mouse.move(box.x + sp.x, box.y + sp.y);
    await settle();
    const hovering = await page.evaluate(() => window.__store.getState().hover.handle !== null
      || window.__store.getState().hover.layerName !== null);
    const got = await cursor();
    ok(`${mode}: the cursor stays '${expected[mode]}' over a handle` + (hovering ? '' : ' (nothing hovered)'),
      got === expected[mode], `got '${got}'`);
  }
  await page.mouse.move(cx + 200, cy + 200);
  await settle();

  // --------------------------------- 3. right-drag pan: closed hand, then restore
  // Any mode. OSS: press -> ClosedHandCursor + pan button pressed with the
  // closed-hand icon; release -> _pre_right_pan_cursor + button released.
  for (const mode of ['attach', 'select', 'move']) {
    await setMode(mode);
    const before = await state();
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await settle();
    ok(`${mode}: right-button press shows the closed hand`, (await cursor()) === 'grabbing', `got '${await cursor()}'`);
    ok(`${mode}: ...and presses the pan button with the closed-hand icon`,
      (await panIcon()) === 'pan_closed.png' && (await panChecked()), `icon=${await panIcon()} checked=${await panChecked()}`);
    ok(`${mode}: ...store.panning is set`, (await state()).panning === true);
    await page.mouse.move(cx + 60, cy + 30, { steps: 4 });
    await settle();
    ok(`${mode}: the drag still shows the closed hand`, (await cursor()) === 'grabbing', `got '${await cursor()}'`);
    const mid = await state();
    ok(`${mode}: ...and pans the view`, mid.view.panX === before.view.panX + 60 && mid.view.panY === before.view.panY + 30,
      `pan ${before.view.panX},${before.view.panY} -> ${mid.view.panX},${mid.view.panY}`);
    await page.mouse.up({ button: 'right' });
    await settle();
    ok(`${mode}: release restores the ${expected[mode]} cursor`, (await cursor()) === expected[mode], `got '${await cursor()}'`);
    ok(`${mode}: ...and lets the pan button go (open-hand icon, unchecked)`,
      (await panIcon()) === 'pan_open.png' && !(await panChecked()), `icon=${await panIcon()} checked=${await panChecked()}`);
    ok(`${mode}: ...store.panning is cleared`, (await state()).panning === false);
  }

  // ------------------------------------------------ 4. middle-drag pan, likewise
  await setMode('attach');
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await settle();
  ok('middle-button press shows the closed hand', (await cursor()) === 'grabbing', `got '${await cursor()}'`);
  await page.mouse.move(cx - 40, cy, { steps: 3 });
  await page.mouse.up({ button: 'middle' });
  await settle();
  ok('middle-button release restores the mode cursor', (await cursor()) === 'crosshair', `got '${await cursor()}'`);

  // ------------------------------------------------ 5. the hand tool (pan mode)
  // OSS toggle_pan_mode: OpenHandCursor + the pan button checked with the
  // closed-hand icon; a left press -> ClosedHand, release -> OpenHand (not the
  // mode cursor: the tool is still on); a right-click turns the tool off.
  await setMode('attach');
  await panButton.click();
  await settle();
  ok('hand tool on: open-hand cursor over the canvas', (await cursor()) === 'grab', `got '${await cursor()}'`);
  ok('hand tool on: the pan button is checked with the closed-hand icon',
    (await panIcon()) === 'pan_closed.png' && (await panChecked()), `icon=${await panIcon()} checked=${await panChecked()}`);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await settle();
  ok('hand tool: left press shows the closed hand', (await cursor()) === 'grabbing', `got '${await cursor()}'`);
  const preHand = await state();
  await page.mouse.move(cx + 25, cy + 10, { steps: 3 });
  await page.mouse.up();
  await settle();
  const postHand = await state();
  ok('hand tool: the left-drag pans', postHand.view.panX === preHand.view.panX + 25 && postHand.view.panY === preHand.view.panY + 10,
    `pan ${preHand.view.panX},${preHand.view.panY} -> ${postHand.view.panX},${postHand.view.panY}`);
  ok('hand tool: release goes back to the open hand, not the mode cursor', (await cursor()) === 'grab', `got '${await cursor()}'`);
  ok('hand tool: the pan button stays checked after the drag', await panChecked());
  await page.mouse.click(cx, cy, { button: 'right' });
  await settle();
  const afterRight = await state();
  ok('hand tool: a right-click turns it off (OSS exit_pan_mode)', afterRight.panMode === false && afterRight.panning === false,
    `panMode=${afterRight.panMode} panning=${afterRight.panning}`);
  ok('...and the canvas shows the mode cursor again', (await cursor()) === 'crosshair', `got '${await cursor()}'`);
  ok('...with the pan button released', (await panIcon()) === 'pan_open.png' && !(await panChecked()),
    `icon=${await panIcon()} checked=${await panChecked()}`);
  ok('...and the right-click did not pan', afterRight.view.panX === postHand.view.panX && afterRight.view.panY === postHand.view.panY);

  // ------------------------------------------- 6. Edit Mask forces the crosshair
  const maskName = await page.evaluate(() => {
    const d = window.__store.getState().doc;
    return d.order.find((n) => d.strands[n].type === 'MaskedStrand') ?? null;
  });
  if (maskName) {
    await setMode('move');
    await page.evaluate((n) => window.__store.getState().enterMaskEdit(n), maskName);
    await settle();
    ok('Edit Mask session: crosshair (OSS enter_mask_edit_mode)', (await cursor()) === 'crosshair', `got '${await cursor()}'`);
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await settle();
    ok('Edit Mask: a right-drag pan still shows the closed hand', (await cursor()) === 'grabbing', `got '${await cursor()}'`);
    await page.mouse.up({ button: 'right' });
    await settle();
    ok('Edit Mask: ...and the crosshair comes back on release', (await cursor()) === 'crosshair', `got '${await cursor()}'`);
    await page.evaluate(() => window.__store.getState().exitMaskEdit());
    await settle();
    ok('leaving Edit Mask restores the mode cursor (move: open hand)', (await cursor()) === 'grab', `got '${await cursor()}'`);
  } else {
    ok('fixture has a masked strand for the Edit Mask checks', false, 'none found');
  }

  ok('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall cursor checks passed');
process.exit(fails ? 1 : 0);
