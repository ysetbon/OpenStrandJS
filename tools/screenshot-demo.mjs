// Capture a demo screenshot of the live OpenStrandJS editor for the README.
// Drives the deployed site in real Chromium (Playwright): draws two crossing
// strands, switches to View mode for a clean render, and screenshots the UI.
//
//   node tools/screenshot-demo.mjs [outPath]

import { chromium } from 'playwright';

const out = process.argv[2] || 'docs/screenshot.png';
const URL = 'https://ysetbon.github.io/OpenStrandJS/';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  await page.goto(URL, { waitUntil: 'networkidle' });

  // Wait until the editor chrome is interactive.
  const newStrand = page.getByRole('button', { name: 'New Strand', exact: true });
  await newStrand.waitFor({ state: 'visible', timeout: 15000 });

  // Draw a strand by dragging on the canvas (page/CSS coordinates).
  const drawStrand = async (x1, y1, x2, y2) => {
    await newStrand.click();
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 12 });
    await page.mouse.up();
  };

  await drawStrand(245, 392, 555, 212); // ↗
  await drawStrand(555, 392, 245, 212); // ↖  (crosses the first)

  // Best-effort framing/cleanup — clear selection, then switch to View mode
  // which renders strands cleanly without edit handles. None of these are
  // essential to the capture, so a missing/hidden button must not abort it.
  const tryClick = async (name) => {
    try {
      await page.getByRole('button', { name, exact: true }).click({ timeout: 2500 });
    } catch {
      /* button not present in this mode — ignore */
    }
  };
  await tryClick('Deselect All');
  await tryClick('View');
  await tryClick('Deselect All');
  await page.waitForTimeout(500); // let the render settle

  await page.screenshot({ path: out });
  console.log('saved ->', out);
} finally {
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
}
process.exit(0);
