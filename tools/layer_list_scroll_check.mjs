// Guard for the layer list's vertical scrolling (src/styles.css .lp-list)
// against OSS layer_panel.scroll_area: a QScrollArea whose QVBoxLayout is
// AlignHCenter|AlignBottom. With few layers the buttons sit at the bottom of
// the list; once there are more than fit, the list scrolls, every button is
// reachable (the topmost one included), and a vertical scrollbar shows —
// exactly like OSS. Also checks that the list stays scrollable when a layer
// is added, that the drop-line geometry still lands on row edges once the
// list is scrolled, and that the scrollbar goes away with the layers.
// Drives the vite dev server (window.__store is DEV-only) in Chromium and
// writes screenshots to $OUT.
//
// Usage: node tools/layer_list_scroll_check.mjs [outDir]
//        OSS_CHROMIUM=/path/to/chrome node tools/layer_list_scroll_check.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(root, process.argv[2] || 'artifacts/layer_list_scroll');
mkdirSync(OUT, { recursive: true });
const PORT = 5199;
// The dev server gets its own process group so stopDev can take the real vite
// process down along with the npx wrapper: signalling only the wrapper leaves
// vite bound to the strict port and the next local run failing to start.
const dev = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe', detached: true });
dev.on('error', (e) => { console.log('FAIL  dev server did not start  ' + e.message); process.exit(1); });
const stopDev = () => { try { process.kill(-dev.pid, 'SIGTERM'); } catch { dev.kill(); } };
await new Promise((r) => { dev.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) r(); }); setTimeout(r, 8000); });
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// Fabricate N free first strands (one set each) straight into the doc, the way
// the factory would; enough to overflow a 900px-tall list several times over.
const ADD_STRANDS = (n) => {
  const st = window.__store.getState();
  st.mutateDoc((d) => {
    for (let i = 0; i < n; i++) {
      const set = Object.keys(d.strands).length + 1;
      const name = `${set}_1`;
      const p = { x: 100 + i * 5, y: 100 + i * 5 };
      const q = { x: 300 + i * 5, y: 100 + i * 5 };
      d.strands[name] = {
        type: 'Strand', layer_name: name, set_number: set,
        start: p, end: q, control_points: [{ ...p }, { ...q }],
        control_point_center: { x: 200, y: 100 + i * 5 }, control_point_center_locked: false,
        width: 46, stroke_width: 4,
        color: { r: 200, g: 170, b: 230, a: 255 }, stroke_color: { r: 0, g: 0, b: 0, a: 255 },
        has_circles: [false, false], is_hidden: false, shadow_only: false, hide_shadow: false,
        circle_stroke_color: { r: 0, g: 0, b: 0, a: 255 }, knot_connections: {},
        triangle_has_moved: false, control_point2_shown: false, control_point2_activated: false,
        extra: { is_first_strand: false, is_start_side: true, start_line_visible: true, end_line_visible: true,
          start_extension_visible: false, end_extension_visible: false, start_arrow_visible: false,
          end_arrow_visible: false, full_arrow_visible: false, closed_connections: [false, false] },
      };
      d.order.push(name);
    }
  });
};

// Headless Chromium passes --hide-scrollbars by default, which would hide the
// very gutter this guards; launch without it so the scrollbar is really laid out.
let browser;
try {
  browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'], ...(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => !!window.__store, null, { timeout: 15000 });
  await page.evaluate(() => { localStorage.clear(); window.__store.getState().setSettings({ theme: 'default', language: 'en' }); });

  const list = page.locator('.lp-list');
  const metrics = () => page.evaluate(() => {
    const l = document.querySelector('.lp-list');
    const items = [...l.querySelectorAll('.lp-item')];
    const lr = l.getBoundingClientRect();
    const first = items[0]?.getBoundingClientRect();
    const last = items[items.length - 1]?.getBoundingClientRect();
    return {
      count: items.length,
      clientHeight: l.clientHeight, scrollHeight: l.scrollHeight, scrollTop: l.scrollTop,
      clientWidth: l.clientWidth, offsetWidth: l.offsetWidth,
      listTop: lr.top, listBottom: lr.bottom,
      firstTop: first?.top, lastBottom: last?.bottom,
      firstLeft: first?.left, firstRight: first?.right, listLeft: lr.left, listRight: lr.right,
    };
  });
  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

  // ---- few layers: bottom-aligned, no scrolling (OSS AlignBottom)
  await page.evaluate(ADD_STRANDS, 3);
  await page.waitForTimeout(100);
  let m = await metrics();
  ok('3 layers present', m.count === 3, String(m.count));
  ok('few layers: nothing to scroll', m.scrollHeight <= m.clientHeight + 1, JSON.stringify(m));
  ok('few layers: bottom-aligned (last button at the list bottom)', near(m.lastBottom, m.listBottom, 2), JSON.stringify(m));
  ok('few layers: no scrollbar (client width == offset width)', m.clientWidth === m.offsetWidth, JSON.stringify(m));
  await shot('01_few_layers');

  // ---- many layers: the list overflows, so it must scroll and show a scrollbar
  await page.evaluate(ADD_STRANDS, 40);
  await page.waitForTimeout(150);
  m = await metrics();
  ok('43 layers present', m.count === 43, String(m.count));
  ok('many layers: content taller than the list', m.scrollHeight > m.clientHeight + 40, JSON.stringify(m));
  ok('many layers: a vertical scrollbar is on screen', m.offsetWidth - m.clientWidth >= 4, `gutter=${m.offsetWidth - m.clientWidth}`);
  ok('many layers: button still fits beside the scrollbar (not squeezed, not clipped)',
    m.firstLeft >= m.listLeft - 0.5 && m.firstRight <= m.listLeft + m.clientWidth + 0.5 && near(m.firstRight - m.firstLeft, 132),
    JSON.stringify(m));
  await shot('02_many_layers_initial');

  // Scroll to the top: the topmost (newest) button must be fully reachable.
  await list.evaluate((l) => { l.scrollTop = 0; });
  await page.waitForTimeout(50);
  m = await metrics();
  ok('scrollTop 0 reaches the topmost button (top edge inside the list)',
    m.firstTop >= m.listTop - 0.5 && m.firstTop < m.listTop + 4, JSON.stringify(m));
  await shot('03_many_layers_scrolled_top');

  // Scroll to the bottom: the bottommost button sits on the list's bottom edge.
  await list.evaluate((l) => { l.scrollTop = l.scrollHeight; });
  await page.waitForTimeout(50);
  m = await metrics();
  ok('scrolled to the bottom: bottom button on the list bottom', near(m.lastBottom, m.listBottom, 2), JSON.stringify(m));
  ok('scrollTop reached the max', near(m.scrollTop, m.scrollHeight - m.clientHeight, 1), JSON.stringify(m));
  await shot('04_many_layers_scrolled_bottom');

  // Mouse wheel over the list scrolls it (the user's actual gesture).
  const box = await list.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(100);
  const afterWheel = await metrics();
  ok('mouse wheel scrolls the list up', afterWheel.scrollTop < m.scrollTop - 100, `${m.scrollTop} -> ${afterWheel.scrollTop}`);

  // Every button can be brought into view by scrolling — walk the whole list.
  const allReachable = await page.evaluate(() => {
    const l = document.querySelector('.lp-list');
    const lr = l.getBoundingClientRect();
    return [...l.querySelectorAll('.lp-item')].every((it) => {
      it.scrollIntoView({ block: 'nearest' });
      const r = it.getBoundingClientRect();
      return r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5;
    });
  });
  ok('every button can be scrolled fully into view', allReachable);

  // ---- adding a layer to an overflowing list keeps it scrollable (OSS
  // add_layer_button inserts the newest button at the top and just restores
  // the scrollbar value, which is the browser's default too).
  await list.evaluate((l) => { l.scrollTop = 0; });
  await page.evaluate(ADD_STRANDS, 1);
  await page.waitForTimeout(100);
  m = await metrics();
  ok('44 layers present', m.count === 44, String(m.count));
  ok('after adding a layer the list still scrolls', m.scrollHeight > m.clientHeight + 40, JSON.stringify(m));

  // ---- the drop-line geometry is right once the list is scrolled: a dragover
  // in the lower half of a row must put the line on that row's bottom edge, in
  // list-content coordinates (position:absolute inside the scrolling box).
  await list.evaluate((l) => { l.scrollTop = 200; });
  await page.waitForTimeout(50);
  const lineCheck = await page.evaluate(() => {
    const l = document.querySelector('.lp-list');
    const items = [...l.querySelectorAll('.lp-item')];
    const src = items[5].querySelector('button, [draggable]') || items[5];
    const dst = items[8].querySelector('button, [draggable]') || items[8];
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.bottom - 3 }));
    return new Promise((res) => requestAnimationFrame(() => {
      const line = l.querySelector('.lp-drop-line');
      const lr = line?.getBoundingClientRect();
      const out = { hasLine: !!line, lineTop: lr?.top, rowBottom: r.bottom, left: lr?.left, right: lr?.right, listLeft: l.getBoundingClientRect().left, clientWidth: l.clientWidth };
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      res(out);
    }));
  });
  ok('drop line appears while dragging over a lower row', lineCheck.hasLine, JSON.stringify(lineCheck));
  ok('drop line sits on the hovered row\'s bottom edge while scrolled', lineCheck.hasLine && near(lineCheck.lineTop, lineCheck.rowBottom, 2), JSON.stringify(lineCheck));
  ok('drop line spans the list content width', lineCheck.hasLine && near(lineCheck.left, lineCheck.listLeft, 1) && near(lineCheck.right - lineCheck.left, lineCheck.clientWidth, 1), JSON.stringify(lineCheck));

  // ---- removing layers again drops the scrollbar and returns to bottom-aligned
  await page.evaluate(() => window.__store.getState().mutateDoc((d) => {
    while (d.order.length > 2) { const n = d.order.pop(); delete d.strands[n]; }
  }));
  await page.waitForTimeout(100);
  m = await metrics();
  ok('back to 2 layers', m.count === 2, String(m.count));
  ok('few layers again: no scrollbar', m.clientWidth === m.offsetWidth, JSON.stringify(m));
  ok('few layers again: bottom-aligned', near(m.lastBottom, m.listBottom, 2), JSON.stringify(m));
  await shot('05_few_layers_again');
} finally {
  await browser?.close();
  stopDev();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
