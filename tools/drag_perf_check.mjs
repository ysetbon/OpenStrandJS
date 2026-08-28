// Regression guards for the drag/release fast path.
//
// Each assertion below fails if its optimisation is reverted, so the wins stay
// won. They are behavioural, not timing-based — nothing here depends on how fast
// the runner is.
//
//   1. A drag does not wake the layer panel.
//      The store edits the document in place during a gesture (mutateDocLive), so
//      the document, the strand map, and every unmoved strand record keep their
//      identities — which is exactly what makes zustand's Object.is bail-out skip
//      the panel. Restoring the cloning mutateDoc replaces all of them and
//      re-renders one layer button per layer on every frame.
//      This asserts those identities rather than counting DOM mutations (a wasted
//      re-render that produces identical markup writes no DOM) or React commits
//      (the strand angle/length read-out deliberately commits once a frame, and
//      React batches the panel into that same commit either way). The React
//      commit count is still reported below as context.
//
//   2. A fast flick lands on the LAST reported position.
//      Pointer moves are coalesced into one apply per animation frame. If the
//      flush at pointer-up is dropped, the gesture ends wherever the previous
//      frame left it and the strand visibly falls short.
//
//   3. In-place editing does not corrupt undo.
//      The gesture baseline is a deep clone taken at pointer-down. Undo must
//      restore the exact pre-drag geometry, ESC mid-drag must revert and add no
//      history step, and a press with no movement must add no history step.
//
//   4. mutateDocLive refuses to run without a baseline.
//      The structural guard that makes (3) safe.
//
//   5. The renderer's per-render geometry memo is closed after every render.
//      Its keys carry no coordinates, so it is correct only while scoped to one
//      paint. A memo left open across frames would freeze the dragged strand at
//      its pointer-down shape.
//
//   6. A drag frame allocates no new canvas and no new paper project.
//      The scratch bitmap and the paper project are created once per gesture.
//      Per-frame creation is megabytes of churn and a forced layout per frame.
//
// Usage: node tools/drag_perf_check.mjs
// OSS_CHROMIUM: absolute path to a Chromium binary if the pre-installed browser
// revision does not match this Playwright version.

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const raw = JSON.parse(readFileSync(path.join(root, 'fixtures', 'three_strand_braid.json'), 'utf8'));
const project = raw && raw.type === 'OpenStrandStudioHistory'
  ? ((raw.states || []).find((s) => s.step === raw.current_step) || raw.states[0]).data
  : raw;

const failures = [];
const ok = [];
const check = (name, pass, detail = '') => {
  (pass ? ok : failures).push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'),
  server: { port: 5207, open: false, host: '127.0.0.1' }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch(
  process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});

let result;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  // Count React commits by standing in for the DevTools hook. React looks this up
  // when it initialises and calls onCommitFiberRoot once per commit, so this is a
  // direct measure of "did the drag wake React", independent of whether the
  // re-render happened to produce identical DOM.
  await page.addInitScript(() => {
    window.__reactCommits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(),
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: () => { window.__reactCommits++; },
      onPostCommitFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      checkDCE: () => {},
    };
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto('http://127.0.0.1:5207/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!window.__store && !!window.__io, null, { timeout: 30000 });

  result = await page.evaluate(async ({ project }) => {
    const store = window.__store;
    const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
    const settle = async (n = 6) => { for (let i = 0; i < n; i++) await nextFrame(); };
    const out = {};

    const reset = async () => {
      store.getState().loadDocument(window.__io.loadProject(project));
      // Snap off so every synthetic move is a distinct target.
      store.getState().setSettings({ show_grid: false, snap_to_grid_enabled: false });
      store.getState().setMode('move');
      store.getState().setSelection({ layerName: null, handle: null });
      await settle(18);
    };

    const geom = () => {
      const el = document.getElementById('c');
      const rect = el.getBoundingClientRect();
      const view = store.getState().view;
      return {
        el,
        toClient: (w) => ({
          x: rect.left + (w.x * view.zoom + view.panX) * (rect.width / Math.max(1, el.width)),
          y: rect.top + (w.y * view.zoom + view.panY) * (rect.height / Math.max(1, el.height)),
        }),
        fromClient: (c) => ({
          x: ((c.x - rect.left) / (rect.width / Math.max(1, el.width)) - view.panX) / view.zoom,
          y: ((c.y - rect.top) / (rect.height / Math.max(1, el.height)) - view.panY) / view.zoom,
        }),
      };
    };
    const ev = (type, x, y) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1,
    });
    const firstPlain = () => {
      const st = store.getState();
      return st.doc.order.find((n) => st.doc.strands[n]?.type !== 'MaskedStrand');
    };

    // ---- 1 + 2 + 6: one flick drag, instrumented -------------------------
    await reset();
    {
      const name = firstPlain();
      const before = JSON.parse(JSON.stringify(store.getState().doc.strands[name].end));
      const { el, toClient, fromClient } = geom();
      const p0 = toClient(store.getState().doc.strands[name].end);

      const canvasesBefore = document.getElementsByTagName('canvas').length;
      const projectsBefore = window.paper ? window.paper.projects.length : -1;

      el.dispatchEvent(ev('pointerdown', p0.x, p0.y));
      await settle(4);
      const canvasesAtPress = document.getElementsByTagName('canvas').length;
      const commitsAtPress = window.__reactCommits;   // the press legitimately updates chrome
      out.docIdentityStable = true;
      out.staticStrandIdentityStable = true;
      let docRef = store.getState().doc;
      let strandsRef = store.getState().doc.strands;
      // A layer that is NOT in the moving set: its record must survive the whole
      // gesture untouched, which is what lets its layer button skip re-rendering.
      const movingSet = new Set(store.getState().dragMoving);
      const staticName = store.getState().doc.order.find((n) => !movingSet.has(n));
      let staticRef = staticName ? store.getState().doc.strands[staticName] : null;

      // A flick: several moves inside ONE frame, then a frame boundary. This is
      // what a high-Hz mouse produces and what coalescing collapses.
      let last = null;
      for (let i = 0; i < 10; i++) {
        for (let k = 0; k < 5; k++) {
          last = { x: p0.x + 12 * i + 2 * k, y: p0.y + 7 * i + k };
          el.dispatchEvent(ev('pointermove', last.x, last.y));
        }
        await nextFrame();
        // The invariant React's bail-out rests on: a drag frame must not replace
        // the document or the strand map.
        const st2 = store.getState();
        if (st2.doc !== docRef || st2.doc.strands !== strandsRef) out.docIdentityStable = false;
        if (staticRef && st2.doc.strands[staticName] !== staticRef) out.staticStrandIdentityStable = false;
        docRef = st2.doc; strandsRef = st2.doc.strands;
      }
      out.reactCommitsDuringDrag = window.__reactCommits - commitsAtPress;
      out.canvasGrowthDuringDrag = document.getElementsByTagName('canvas').length - canvasesAtPress;
      out.projectGrowthDuringDrag = window.paper ? window.paper.projects.length - projectsBefore : 0;

      // The final move is dispatched and released in the SAME frame — the flush
      // at pointer-up is the only thing that can land it.
      const finalPt = { x: p0.x + 260, y: p0.y + 130 };
      el.dispatchEvent(ev('pointermove', finalPt.x, finalPt.y));
      el.dispatchEvent(ev('pointerup', finalPt.x, finalPt.y));
      await settle(18);

      const want = fromClient(finalPt);
      const got = store.getState().doc.strands[name].end;
      out.finalDelta = Math.hypot(got.x - want.x, got.y - want.y);
      out.canvasGrowthTotal = document.getElementsByTagName('canvas').length - canvasesBefore;

      // ---- 3a: undo restores the exact pre-drag geometry ------------------
      out.historyAfterDrag = store.getState().past.length;
      store.getState().undo();
      await settle(10);
      const undone = store.getState().doc.strands[name].end;
      out.undoDelta = Math.hypot(undone.x - before.x, undone.y - before.y);
    }

    // ---- 3b: ESC mid-drag reverts and adds no history --------------------
    await reset();
    {
      const name = firstPlain();
      const before = JSON.parse(JSON.stringify(store.getState().doc.strands[name].end));
      const { el, toClient } = geom();
      const p0 = toClient(before);
      el.dispatchEvent(ev('pointerdown', p0.x, p0.y));
      await settle(3);
      el.dispatchEvent(ev('pointermove', p0.x + 70, p0.y + 45));
      await settle(3);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(10);
      const after = store.getState().doc.strands[name].end;
      out.escapeDelta = Math.hypot(after.x - before.x, after.y - before.y);
      out.escapeHistory = store.getState().past.length;
    }

    // ---- 3c: a press with no movement adds no history --------------------
    await reset();
    {
      const name = firstPlain();
      const { el, toClient } = geom();
      const p0 = toClient(store.getState().doc.strands[name].end);
      el.dispatchEvent(ev('pointerdown', p0.x, p0.y));
      await settle(3);
      el.dispatchEvent(ev('pointerup', p0.x, p0.y));
      await settle(12);
      out.clickOnlyHistory = store.getState().past.length;
    }

    // ---- 4: mutateDocLive is inert without a gesture baseline ------------
    await reset();
    {
      const name = firstPlain();
      const before = JSON.parse(JSON.stringify(store.getState().doc.strands[name].end));
      store.getState().mutateDocLive((d) => { d.strands[name].end = { x: 9999, y: 9999 }; });
      const after = store.getState().doc.strands[name].end;
      out.liveWithoutBaselineMoved = Math.hypot(after.x - before.x, after.y - before.y) > 0.001;
    }

    // ---- 5: the renderer's geometry memo is closed after every render ----
    // Both hooks are dev-build only, so check both: calling a missing
    // __requestRender would throw out of page.evaluate and leave `result`
    // undefined, and the failure would surface as a confusing TypeError against
    // the first guard rather than "the hook is gone".
    if (typeof window.__geomCacheOpen !== 'function') {
      out.geomCacheOpenAfterRender = 'no-geom-hook';
    } else if (typeof window.__requestRender !== 'function') {
      out.geomCacheOpenAfterRender = 'no-render-hook';
    } else {
      window.__requestRender();
      await settle(8);
      out.geomCacheOpenAfterRender = window.__geomCacheOpen();
    }

    // ---- 7: repeated pan gestures retain exactly ONE scene ----
    // renderFixture used to remove its paper project on the way out; it now keeps it
    // as the scene a pan reuses, and frees the previous one on the next render
    // instead. That swap is only safe if the count stays flat — a retained project
    // owns an offscreen canvas the size of the viewport, so leaking one per gesture
    // would be megabytes a gesture. Six gestures, with a settings edit between them
    // so each one is forced to build a fresh scene rather than reuse the last.
    {
      await reset();
      const el = document.getElementById('c');
      const rect = el.getBoundingClientRect();
      // Right-button drag: InteractionHost treats button 2 as a pan in every mode.
      const panEv = (type, x, y) => new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
        clientX: x, clientY: y,
        button: type === 'pointermove' ? -1 : 2,
        buttons: type === 'pointerup' ? 0 : 2,
      });
      const nProjects = () => (window.paper ? window.paper.projects.length : -1);
      const nCanvases = () => document.getElementsByTagName('canvas').length;
      const beforeP = nProjects(), beforeC = nCanvases();
      for (let g = 0; g < 6; g++) {
        const x0 = rect.left + rect.width * 0.4, y0 = rect.top + rect.height * 0.5;
        el.dispatchEvent(panEv('pointerdown', x0, y0));
        for (let i = 1; i <= 20; i++) {
          el.dispatchEvent(panEv('pointermove', x0 + i * 7, y0 + i * 4));
          await nextFrame();
        }
        el.dispatchEvent(panEv('pointerup', x0 + 140, y0 + 80));
        await nextFrame();
        store.getState().setSettings({ show_grid: g % 2 === 0 }); // forces a fresh scene
        await settle(6);
      }
      out.panProjectGrowth = nProjects() - beforeP;
      out.panCanvasGrowth = nCanvases() - beforeC;
    }

    return out;
  }, { project });

  result.pageErrors = pageErrors;
} finally {
  await browser.close();
  await server.close();
}

check('1a. a drag frame never replaces the document object', result.docIdentityStable === true,
  'doc or doc.strands changed identity mid-drag, which wakes every panel selector');
check('1b. a drag frame never rebuilds an unmoved strand', result.staticStrandIdentityStable === true,
  'a strand outside the moving set changed identity mid-drag, which re-renders its layer button');
check('2. flick lands on the last reported position', result.finalDelta < 0.5,
  `final endpoint is ${result.finalDelta.toFixed(3)} world px from the last pointer position`);
check('3a. undo restores the pre-drag geometry', result.undoDelta < 0.001,
  `undo left the endpoint ${result.undoDelta.toFixed(4)} px off`);
check('3a. a drag makes exactly one history step', result.historyAfterDrag === 1,
  `history depth ${result.historyAfterDrag} (expected 1)`);
check('3b. ESC mid-drag reverts', result.escapeDelta < 0.001,
  `ESC left the endpoint ${result.escapeDelta.toFixed(4)} px off`);
check('3b. ESC mid-drag adds no history step', result.escapeHistory === 0,
  `history depth ${result.escapeHistory} (expected 0)`);
check('3c. a click without movement adds no history step', result.clickOnlyHistory === 0,
  `history depth ${result.clickOnlyHistory} (expected 0)`);
check('4. mutateDocLive is inert without a gesture baseline', result.liveWithoutBaselineMoved === false,
  'it edited the document with no undo baseline in place');
check('5. geometry memo is closed after a render', result.geomCacheOpenAfterRender === false,
  `__geomCacheOpen() returned ${result.geomCacheOpenAfterRender}`);
check('6. a drag frame allocates no new canvas', result.canvasGrowthDuringDrag === 0,
  `${result.canvasGrowthDuringDrag} canvases added across 50 moves`);
check('6. a drag frame allocates no new paper project', result.projectGrowthDuringDrag <= 1,
  `${result.projectGrowthDuringDrag} projects added across 50 moves`);
check('7. repeated pan gestures retain exactly one scene', result.panProjectGrowth === 0,
  `${result.panProjectGrowth} paper projects added across 6 pan gestures`);
check('7. repeated pan gestures allocate no new canvas', result.panCanvasGrowth === 0,
  `${result.panCanvasGrowth} canvases added across 6 pan gestures`);

console.log('\ndrag/release performance guards\n');
for (const line of ok) console.log(`  ok    ${line.split(' — ')[0]}`);
for (const line of failures) console.log(`  FAIL  ${line}`);
if (result.pageErrors.length) console.log('\n  page errors:', result.pageErrors.slice(0, 4));
console.log(`\n  (context: ${result.reactCommitsDuringDrag} React commits over 10 drag frames`
  + ` — the strand angle/length read-out is expected to account for these)`);
console.log(`\n${ok.length}/${ok.length + failures.length} guards pass`);
if (failures.length || result.pageErrors.length) process.exit(1);
process.exit(0);
