// End-to-end guard for the Tier-3 UI wiring, driven through the BUILT editor in
// Chromium. The geometry itself is covered by tools/tier3_check.mjs; what this
// adds is that the React surfaces reach it at all — a correct rotate action is
// worth nothing if the toolbar never dispatches to RotateMode.
//
// The rotate drag is aimed deterministically rather than by sweeping the canvas:
// the fixture is loaded with the editor's own loadProject, a free endpoint is
// picked from it, and fitPan (the same function the Load button calls) converts
// that world point to a page coordinate.
//
// It has since become the general editor-side UI harness: booting the built app
// costs ~80 lines of server + tsc plumbing, so later tiers' React-surface checks
// (the colour well, the arrow dialog) live here rather than duplicating it.
//
// Usage: node tools/tier3_ui_check.mjs [distDir]
//        OSS_CHROMIUM=/path/to/chrome node tools/tier3_ui_check.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(root, process.argv[2] || 'dist-editor');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`no built editor at ${dist} — run \`npm run build:editor\` first`);
  process.exit(2);
}

let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };

// ---- work out where to press, using the editor's own load + fit maths --------
const out = mkdtempSync(path.join(tmpdir(), 'ossjs-t3ui-'));
try {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', 'src/io/saveLoad.ts', 'src/interaction/viewTransform.ts',
     '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch { /* tsc reports import.meta under --module commonjs; it still emits */ }
const strip = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { strip(p); continue; }
    if (!p.endsWith('.js')) continue;
    const s = readFileSync(p, 'utf8');
    if (!s.includes('import.meta')) continue;
    writeFileSync(p, s.replace(/if \(import\.meta\.env\?\.DEV\)\s*\{[\s\S]*?\n\}\n?/g, '')
                     .replace(/if \(import\.meta\.env\?\.DEV\)[^\n]*\n(?:\s{4}[^\n]*\n)*/g, ''));
  }
};
strip(out);
writeFileSync(path.join(out, 'package.json'), '{"type":"commonjs"}');
try { symlinkSync(path.join(root, 'node_modules'), path.join(out, 'node_modules'), 'dir'); } catch { /* exists */ }
const require = createRequire(path.join(out, 'x.js'));
const { loadProject } = require(path.join(out, 'io/saveLoad.js'));
const { fitPan } = require(path.join(out, 'interaction/viewTransform.js'));

const fixtureText = readFileSync(path.join(root, 'fixtures/box_stitch.json'), 'utf8');
const doc = loadProject(JSON.parse(fixtureText));
// A FREE endpoint (has_circles false) on a non-mask strand — the only thing
// RotateMode will grab (rotate_mode.py:172-175).
let grabWorld = null;
for (const name of doc.order) {
  const s = doc.strands[name];
  if (!s || s.type === 'MaskedStrand') continue;
  if (!s.has_circles[0]) { grabWorld = { ...s.start }; break; }
  if (!s.has_circles[1]) { grabWorld = { ...s.end }; break; }
}
ok('the fixture has a free endpoint to rotate', !!grabWorld);

// ---- serve the built editor -------------------------------------------------
const BASE = '/OpenStrandJS/';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.startsWith(BASE)) p = p.slice(BASE.length - 1);
  let f = path.join(dist, p);
  if (!existsSync(f) || statSync(f).isDirectory()) f = path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}${BASE}`;

const browser = await chromium.launch(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);
  // Load through the real hidden <input type=file> the Load button drives.
  await page.setInputFiles('input[type=file]',
    { name: 'box_stitch.json', mimeType: 'application/json', buffer: Buffer.from(fixtureText) });
  await page.waitForTimeout(1500);

  const layers = page.locator('.nlb');
  ok('the project loaded and produced layer buttons', await layers.count() > 0);
  // A REGULAR strand: OSS refuses the angle dialog and the width menu for masks
  // (main_window.py:1250-1253), and this port must too.
  const regular = layers.filter({ hasText: /^\d+_\d+$/ }).first();

  const snapshot = () => page.evaluate(() => {
    const c = document.getElementById('c');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) >>> 0;
    return h;
  });

  // ---- rotate -------------------------------------------------------------
  await page.locator('.tb-btn', { hasText: 'Rotate' }).first().click();
  await page.waitForTimeout(300);
  ok('rotate mode sets the OSS SizeAll cursor',
    await page.locator('#c').evaluate((el) => getComputedStyle(el).cursor) === 'move');

  const geom = await page.locator('#c').evaluate((c) => {
    const r = c.getBoundingClientRect();
    return { w: c.width, h: c.height, left: r.left, top: r.top };
  });
  // The editor calls fitPan on load, so screen = world * zoom + pan at zoom 1.
  const pan = fitPan(doc, { zoom: 1, panX: 0, panY: 0, width: geom.w, height: geom.h, supersample: 2 });
  const px = geom.left + grabWorld.x + pan.panX;
  const py = geom.top + grabWorld.y + pan.panY;

  const beforeRotate = await snapshot();
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 80, py + 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  ok('a rotate drag on a free endpoint changes the canvas',
    await snapshot() !== beforeRotate,
    'RotateMode never fired — the toolbar or the mode registry is not wired');

  // ---- the angle dialog ---------------------------------------------------
  await page.locator('.tb-btn', { hasText: 'Move' }).first().click();
  await regular.click();
  await page.waitForTimeout(300);
  await page.locator('.tb-btn', { hasText: 'Angle' }).first().click();
  await page.waitForTimeout(500);
  const dialog = page.locator('[role=dialog]');
  ok('the Adjust Angle and Length dialog opens', await dialog.count() > 0);
  if (await dialog.count() > 0) {
    const sliders = dialog.locator('input[type=range]');
    ok('it carries the angle + length sliders', await sliders.count() === 2, `${await sliders.count()} sliders`);
    const beforePreview = await snapshot();
    await sliders.first().fill('75');
    await page.waitForTimeout(500);
    ok('moving the angle slider previews on the canvas', await snapshot() !== beforePreview);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    ok('Escape closes it', await page.locator('[role=dialog]').count() === 0);
  }

  // ---- the width dialog ---------------------------------------------------
  await regular.click({ button: 'right' });
  await page.waitForTimeout(400);
  const widthItem = page.getByText('Change Width', { exact: true }).first();
  ok('the layer menu offers Change Width', await widthItem.count() > 0);
  if (await widthItem.count() > 0) {
    await widthItem.click();
    await page.waitForTimeout(400);
    const d = page.locator('[role=dialog]');
    ok('the Change Width dialog opens (it was a window.prompt)', await d.count() > 0);
    if (await d.count() > 0) {
      ok('it carries the thickness box and the stroke slider',
        await d.locator('input[type=number]').count() === 1 &&
        await d.locator('input[type=range]').count() === 1);
    }
  }

  // The width dialog from the previous section is still up, and its modal backdrop
  // covers the layer panel. Close it before driving the menu again.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ---- the colour picker opens on the channel being edited --------------
  // `defaultValue` seeds an UNCONTROLLED input only at mount, so an input that
  // survives from one pick to the next opens on the colour chosen last. Picking a
  // fill colour and then opening Change Stroke Color showed the FILL. The input is
  // a SIBLING of each layer button, so both locators must be scoped to the same
  // .lp-item or this reads a different layer's swatch and proves nothing.
  {
    const item = page.locator('.lp-item').filter({ has: page.locator('.nlb') })
      .filter({ hasText: /^\d+_\d+$/ }).first();
    const btn = item.locator('.nlb').first();
    const swatch = item.locator('.nlb-color-input').first();
    const openItem = async (label) => {
      await btn.click({ button: 'right' });
      await page.waitForTimeout(300);
      await page.getByText(label, { exact: true }).first().click();
      await page.waitForTimeout(300);
    };
    await openItem('Change Color');
    const fillSwatch = await swatch.inputValue();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await openItem('Change Stroke Color');
    const strokeSwatch = await swatch.inputValue();
    ok('the stroke picker opens on the stroke colour, not the last fill',
      strokeSwatch !== fillSwatch,
      `both opened on ${strokeSwatch} — the input kept its previous mount`);

    // The other half of the same trade-off. The key must NOT include the colour:
    // a native picker emits an input event per drag frame, each one recolouring
    // the strand, so a colour-bearing key destroys the element — and the open OS
    // picker with it — on the first frame. A plain `el.value = ...` does not trip
    // React's value tracker, so the setter is called through the prototype
    // descriptor; without that this check passes vacuously. Reopen the FILL picker
    // first — the button's background is the fill colour, so probing while the
    // stroke pick is open would show no change and prove nothing.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await openItem('Change Color');
    await swatch.evaluate((el) => { el.dataset.probe = 'alive'; });
    const bgBefore = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
    await swatch.evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '#123456');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    const bgAfter = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
    ok('the pick actually recolours the strand (guards the check below)', bgBefore !== bgAfter,
      `button stayed ${bgAfter}`);
    ok('...and the picker survives it, so a drag is not cut off after one colour',
      await swatch.evaluate((el) => el.dataset.probe === 'alive'),
      'the input remounted mid-pick — the key is keyed on the colour');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  // ---- an arrow-transparency drag is ONE undo step ------------------------
  // The slider fires an onChange per pixel of travel. Routed through commitEdit
  // each of those is its own gesture, so a single drag buries the pre-drag state
  // under dozens of undo entries and Ctrl+Z steps back one notch at a time.
  // Measured against the canvas rather than the store: one undo must restore the
  // image the arrow had BEFORE the drag.
  {
    await regular.click({ button: 'right' });
    await page.waitForTimeout(400);
    const showArrow = page.getByText('Show Full Arrow', { exact: true }).first();
    ok('the layer menu offers Show Full Arrow', await showArrow.count() > 0);
    if (await showArrow.count() > 0) {
      await showArrow.click();
      await page.waitForTimeout(500);
      await regular.click({ button: 'right' });
      await page.waitForTimeout(400);
      const custom = page.getByText('Arrow Customization', { exact: true }).first();
      ok('...and Arrow Customization once the arrow is on', await custom.count() > 0);
      if (await custom.count() > 0) {
        await custom.click();
        await page.waitForTimeout(500);
        const dlg = page.locator('[role=dialog]');
        const slider = dlg.locator('input[type=range]').first();
        ok('the arrow dialog opens with its transparency slider', await slider.count() > 0);
        if (await slider.count() > 0) {
          const beforeDrag = await snapshot();
          // A real pointer drag, so several input events fire — .fill() would emit
          // one and the per-frame bug would be invisible.
          const box = await slider.boundingBox();
          await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
          await page.mouse.down();
          for (let i = 1; i <= 8; i++) {
            await page.mouse.move(box.x + box.width - 2 - (box.width * 0.09 * i), box.y + box.height / 2);
            await page.waitForTimeout(60);
          }
          await page.mouse.up();
          await page.waitForTimeout(500);
          const afterDrag = await snapshot();
          ok('dragging arrow transparency repaints the arrow', afterDrag !== beforeDrag,
            'the slider never moved — the drag missed the track');
          // Close first: the modal owns the keyboard while it is up.
          await page.keyboard.press('Escape');
          await page.waitForTimeout(400);
          await page.keyboard.press('Control+z');
          await page.waitForTimeout(600);
          ok('one undo restores the whole drag, not one slider notch',
            await snapshot() === beforeDrag,
            'the drag left one undo entry per frame — use mutateDoc + a single commit');
        }
      }
    }
  }

  // ---- the shadow editor's bulk row and Shadow Path preview ---------------
  // Geometry is covered by tools/tier5_check.mjs; what this adds is that the
  // React surface reaches it — a correct overlay is worth nothing if no button
  // ever sets a pair, and OSS clears every pair when the editor closes
  // (group_shadow_editor_dialog.py:677), which is easy to forget and leaves a
  // blue overlay stranded on the canvas with no dialog left to switch it off.
  {
    // box_stitch's TOP layer casts onto everything under it, so its editor is
    // guaranteed to list at least one row. Picking any layer would risk the
    // bottom one, whose editor is legitimately empty.
    const items = page.locator('.lp-item').filter({ has: page.locator('.nlb') })
      .filter({ hasText: /^\d+_\d+$/ });
    const top = items.first();
    await top.locator('.nlb').first().click({ button: 'right' });
    await page.waitForTimeout(400);
    const editShadows = page.getByText('Edit Shadows', { exact: true }).first();
    ok('the layer menu offers Edit Shadows', await editShadows.count() > 0);
    if (await editShadows.count() > 0) {
      await editShadows.click();
      await page.waitForTimeout(500);
      const dlg = page.locator('[role=dialog]');
      const bulk = dlg.locator('.gd-shadow-global');
      ok('the shadow editor opens with the bulk-toggle row (OSS :800-849)',
        await bulk.count() > 0);
      ok('...carrying all four toggles, not the three it had',
        await bulk.locator('.gd-toggle-btn').count() === 4,
        `${await bulk.locator('.gd-toggle-btn').count()} toggles`);

      const pathBtns = dlg.locator('.gd-shadow-row-main .gd-toggle-btn');
      const n = await pathBtns.count();
      ok('every row carries a Shadow Path button', n > 0, `${n} rows`);
      if (n > 0) {
        const before = await snapshot();
        await pathBtns.first().click();
        await page.waitForTimeout(600);
        const shown = await snapshot();
        ok('toggling one row paints the preview on the canvas', shown !== before,
          'the overlay never reached the renderer');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
        ok('...and closing the editor clears it again (OSS :677)',
          await snapshot() === before,
          'the blue overlay outlived the dialog that could switch it off');
      }
    }
  }

  ok('no page errors along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  // browser.close() can hang on some platforms; race it so the process still exits.
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  server.close();
  rmSync(out, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exitCode = fails ? 1 : 0;
