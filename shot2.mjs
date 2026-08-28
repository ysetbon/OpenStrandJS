import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user/3012d3c9-dcd0-5e8e-abc2-77a4683b531f/scratchpad';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const setup = async (theme) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('http://localhost:5173/', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  if (theme === 'dark') {
    await page.evaluate(() => window.__store.setState((s) => ({ settings: { ...s.settings, theme: 'dark' } })));
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: 'New Strand', exact: true }).click();
  const box = await page.locator('#c').boundingBox();
  await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 300, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(500);
  return page;
};
for (const theme of ['light', 'dark']) {
  const page = await setup(theme);
  await page.locator('[class*="nlb"][role="button"]').first().click({ button: 'right' });
  await page.waitForTimeout(250);
  await page.locator('.ctx-menu > *').filter({ hasText: /^Change Color$/ }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.modal').screenshot({ path: `${OUT}/color_dialog_${theme}.png` });
  // and again at half alpha, to prove the checkerboard still shows through
  if (theme === 'light') {
    await page.locator('.cpd-num input').last().fill('110');
    await page.locator('.cpd-num input').last().dispatchEvent('change');
    await page.waitForTimeout(300);
    await page.locator('.cpd-preview-row').screenshot({ path: `${OUT}/preview_alpha110.png` });
  }
  await page.close();
}
console.log('done');
