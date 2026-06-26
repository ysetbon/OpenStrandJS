// Regression check for the mobile "mode switch doesn't update the canvas" bug:
// switching interaction mode must repaint the overlay even with NO pointer
// interaction (no hover/touch). Loads a fixture, flips mode via the DEV store,
// and asserts the #overlay pixels differ between attach (circles) and move
// (squares) — and that move is non-empty (not a stale attach overlay).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'box_stitch.json'), 'utf8'));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const overlaySig = (page) => page.evaluate(() => {
  const o = document.getElementById('overlay');
  const ctx = o.getContext('2d');
  const d = ctx.getImageData(0, 0, o.width, o.height).data;
  let nonEmpty = 0, sum = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { nonEmpty++; sum = (sum + i * d[i]) % 2147483647; }
  return { nonEmpty, sum };
});

const setMode = async (page, m) => {
  await page.evaluate((mode) => window.__store.getState().setMode(mode), m);
  await page.waitForTimeout(350); // let the requestOverlay rAF run
};

let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 787, height: 382 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://localhost:5173/?mobile=1', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('#overlay', { timeout: 10000 });
  await page.evaluate(async (fx) => {
    const mod = await import('/src/io/saveLoad.ts');
    window.__store.getState().loadDocument(mod.loadProject(fx));
  }, fixture);
  await page.waitForTimeout(400);

  await setMode(page, 'attach');
  const attach = await overlaySig(page);
  await setMode(page, 'move');     // NO touch/hover between switches
  const move = await overlaySig(page);
  await setMode(page, 'attach');
  const attach2 = await overlaySig(page);

  const changed = attach.sum !== move.sum && move.nonEmpty > 0 && attach.nonEmpty > 0;
  const reverts = Math.abs(attach2.sum - attach.sum) < 1e-9;
  console.log(JSON.stringify({
    attach, move, attach2,
    overlayChangesOnModeSwitch: changed,
    revertsBack: reverts,
    PASS: changed && reverts,
    errs,
  }, null, 2));
} catch (e) {
  log('ERROR:', String(e));
} finally {
  if (browser) await browser.close();
}
process.exit(0);
