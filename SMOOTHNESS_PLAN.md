# OSSJS Smoothness Plan — drag / zoom / release

Goal: make endpoint/CP **dragging**, **zoom in/out**, and mouse **release** feel smooth in
OpenStrandJS, mirroring how the OSS (PyQt5) original stays responsive — **without touching the
byte-identical `renderFixture` oracle path**. All work lives on the editor live-render path
(renderScheduler / CanvasStage / InteractionHost / store / drag-only renderer fns).

Produced by the `ossjs-smoothness` workflow (6 investigators → 3 designers → synthesis → 3 adversarial
verifiers → finalize). Two recommendations were rewritten after verification caught flaws (see notes on
R2/R3). Sequencing: **R1 → R3 → R2 → R4** (highest-leverage + lowest-risk first).

## Root causes (confirmed against source)

| Gesture | Root cause | Evidence |
|---|---|---|
| **drag** | Every `pointermove` deep-clones the **whole document** via `JSON.parse(JSON.stringify)` before any render — O(all strands) main-thread + GC churn per frame, re-introducing the cost the render fast-path already removed. OSS mutates only the grabbed strand in place. | `editorStore.ts:256-260` (cloneDoc), `:388-392` (mutateDoc); `MoveMode.ts:93,103`; OSS `move_mode.py:2796-2921` |
| **zoom** | Continuous wheel mints a new `view` each tick → CanvasStage effect (`view` in deps) fires `requestRender` → a **full Paper.js re-stroke of every strand + O(n²) shadow cast** per tick. rAF-coalesced but not debounced. OSS re-strokes too, but as a cheap native `QPainter.scale` over prebuilt paths into a 2× buffer. | `InteractionHost.ts:169-180`; `CanvasStage.tsx:70-72`; `renderScheduler.ts:117-123`; `strand-renderer.js:1150`; OSS `strand_drawing_canvas.py:4767-4779,1898-1904` |
| **release** | Pointer-up jumps in one frame from the cheap O(moving) drag frame to the most expensive render: drops the baked static bitmaps then re-strokes **every** strand at `SAMPLE_STEP=1` + full O(n²) shadow, synchronously inside the input rAF. OSS defers its 2nd full repaint via `QTimer.singleShot(0, update)`. | `MoveMode.ts:117-129`; `renderScheduler.ts:88,117-123`; `strand-renderer.js:1581,1248-1273,510-640`; OSS `move_mode.py:1681-1682` |

---

## R1 — Drag-scoped shallow mutation (drag · risk **low** · effort **S**) ⭐ start here

Add `mutateDocDuringDrag(fn)` beside `mutateDoc` in `editorStore.ts`. Instead of `cloneDoc(s.doc)`,
structurally share every unchanged strand and deep-clone **only** the `dragMoving` set:

```ts
mutateDocDuringDrag: (fn) => set((s) => {
  const moving = s.dragMoving;                 // published at grab (MoveMode.ts:75)
  const strands = { ...s.doc.strands };        // shallow copy of the map
  for (const n of moving) if (strands[n]) strands[n] = structuredClone(strands[n]);
  const draft = { ...s.doc, strands };         // order/extras shared by ref
  if (import.meta.env?.DEV) {
    const before = new Map(Object.keys(s.doc.strands)
      .filter(k => !moving.includes(k)).map(k => [k, s.doc.strands[k]]));
    fn(draft);
    for (const [k, ref] of before)
      if (draft.strands[k] !== ref)
        console.error('[OpenStrandJS] mutateDocDuringDrag wrote strand outside dragMoving:', k);
  } else { fn(draft); }
  return { doc: draft, docRevision: s.docRevision + 1 };
})
```

Wire **only** the two per-move calls — `MoveMode.ts:93` (setBias) and `:103` (moveHandle) — to
`mutateDocDuringDrag`. Leave `mutateDoc`/`cloneDoc` unchanged and keep the once-per-gesture calls
(`autoAdjustCp1OnGrab` :64, `seedMaskCenters` :68, `resetStraightCurveFlags` :126, `beginGesture`/`commit`)
on the full `mutateDoc` so undo/history stay byte-unchanged.

**Why safe:** the write-set is a proven subset of `dragMoving`. `moveHandle` writes
`strands[layer]` + `connectedMovers` peers and `trackMaskDeletionRects` writes only masks whose component
is in `moved` (`actions.ts:137-148,183-219`); `setBias` writes only `strands[layer]` (`actions.ts:162-173`);
`movingStrandSet` (= `dragMoving`) is a superset of all of them (`connections.ts:188-208`). The DEV
assertion guards against future drift. `cloneDoc`'s own comment confirms `StrandRecord` holds no
cross-references, so per-strand `structuredClone` is value-equivalent to the JSON round-trip.

**Expected:** drag state cost becomes O(moving), independent of scene size. Biggest win on dense scenes.
**Oracle:** store-only; never calls into `strand-renderer.js`.

## R3 — Defer the release full render by one rAF (release · risk **low** · effort **M**)

> **Rewrite note:** the original ("read store `dragging`/`dragMoving` in a deferred frame") was verified
> **dead code** — `onPointerUp` clears both *before* `requestRender`, and the scheduler gates the drag
> path on them. Drive the settle from an **explicit payload** instead.

- Add `requestReleaseSettle(movingNames: string[])` to `renderScheduler.ts` → captures names into a
  module-local `settle` and calls `schedule()` with `pendingFull`.
- In `schedule()`'s rAF, **before** the existing drag branch (`:75-88`): if `settle` is set AND
  `dragBaked` is still true AND `bakedKey === settle.names.join('|')`, do **phase 1** — one
  `callRenderDragFrame` over the still-live bake (instant, O(moving)), then `requestAnimationFrame` a
  one-shot **phase 2**: if a new drag started (`getState().dragging`) clear `settle` and return; else
  `callEndDrag()` + the existing full `callRender` at `EDITOR_SUPERSAMPLE=1` + `syncOverlay()`. Do **not**
  `callEndDrag` in phase 1 (keep the bake live). If preconditions fail, clear `settle` and fall through to
  today's full render (graceful degrade).
- `MoveMode.onPointerUp`: snapshot `const movingSnapshot = getState().dragMoving.slice()` **before** the
  `setDragMoving([])` clear; keep everything else; call `ctx.requestReleaseSettle(movingSnapshot)` instead
  of `ctx.requestRender()`. Add `requestReleaseSettle` to `ModeContext` (`Mode.ts`) + `InteractionHost.ctx()`.
- Supersede race handled by the existing `bakedKey` re-bake guard (`:109-115`) + the phase-2
  `if (dragging) return` skip.

**Expected:** the released strand settles in the **same** frame as pointer-up; the O(all)+O(n²)-shadow
full render lands one frame (~16ms) later. Interim frame lacks the moving strand's cast shadow onto lower
layers for one frame — the already-accepted per-drag residual. Final pixels identical to today.
**Oracle:** only reorders existing editor-only calls; `renderFixture` untouched.

## R2 — Transform-now / re-stroke-soon wheel zoom (zoom · risk **med** · effort **M**)

> **Rewrite note:** the original ("CSS-scale a 1× bitmap for the whole spin") was verified to introduce a
> **real blur regression** — OSS is *not* discrete; it re-strokes crisply into a 2× buffer every notch
> (`strand_drawing_canvas.py:4767-4779,1898-1904`). So the transient must stay short **and** crisp.

Decouple zoom feedback from the full re-render — entirely in InteractionHost / CanvasStage /
renderScheduler. `meta.zoom` keeps flowing from `view.zoom` via `buildMeta` (no new meta key).

- **Baseline:** when the full-render branch runs, record the rendered `{zoom,panX,panY}` in a
  renderScheduler field; expose `getRenderedView()`. Render the zoom **base** at **supersample 2** (only for
  the zoom settle/threshold render) so any transient scale-up stays crisp like OSS's 2× buffer. (Fallback if
  ss2's ~260ms base is too costly: keep ss1 but cap CSS scale to ≤1.0 — only scale down.)
- **Feedback:** `onWheel` keeps updating `view.zoom/panX/panY` (so hit-test/overlay math stay live), sets a
  transient `view.zooming=true`, and applies an instant CSS `transform` to **both** `#c` and `#overlay`
  (`transformOrigin='0 0'`, `translate(px,py) scale(liveZoom/baselineZoom)`) using the existing cursor-anchor
  formula (`InteractionHost.ts:179`).
- **Settle + large-delta:** (re)arm a **~50ms** idle timer per wheel event; **also** if accumulated
  `|liveZoom/baselineZoom − 1| > ~0.20` force the crisp re-stroke immediately. On trigger: `view.zooming=false`,
  clear both transforms, `requestRender()` once (ss2 base; resets baseline). Slow deliberate zoom is always
  crisp; only a fast multi-notch flick shows a ≤~2-frame soft window.
- **Effect split:** in CanvasStage keep a `useRef` of prev `{zoom,panX,panY,width,height}`; suppress the
  synchronous `requestRender` **only** when zoom changed AND `view.zooming` is set — pan/resize/docRevision/
  settings/mode keep the immediate path.
- **Overlay hardening:** while `view.zooming`, make `requestOverlay` a no-op (`renderScheduler.ts:135`) so the
  overlay can't redraw at live `view.zoom` then get CSS-scaled a second time; its CSS transform is applied in
  lockstep with `#c` and cleared on settle.
- **Stuck-transform guard:** explicitly clear `#c`/`#overlay` `transform=''` on settle, on `pointerdown`, and on
  mode change (`renderFixture` never sets `transform`).

**Expected:** the single biggest unaddressed cost — collapses a full re-stroke per wheel frame to
GPU-composited feedback + one crisp re-stroke per ~20% zoom / ~50ms idle, without blur or overlay drift.
**Oracle:** only manipulates element `style.transform`, the *when* of `requestRender`, a transient flag, and
a live-path ss override. The harness dispatches no wheel events and loads a fresh `render.html`.

## R4 — rAF-coalesce pointermove (drag · risk **low** · effort **S** · ship only if needed)

In `InteractionHost.onPointerMove`, stash the latest native `PointerEvent` and `requestAnimationFrame` a
flush that dispatches `mode().onPointerMove` with the most recent event (keep the pan/maskErase branches
synchronous). Native PointerEvents aren't pooled, so reading coords later is valid; optionally use
`getCoalescedEvents()`. **Guards:** (1) flush synchronously at the top of `onPointerUp`; (2) **discard**
pending move on `onPointerCancel` and ESC-abort; (3) cancel the pending rAF in `detach()`.

**Expected:** caps mutate+render at one per displayed frame regardless of event rate; compounds R1. Lower
marginal value — ship only if profiling shows multiple moves/frame still cost after R1.
**Oracle:** input layer only.

---

## Measurement (baseline before any change)

1. **Offline render cost:** `node tools/bench_drag.mjs 100` across `single_strand` / `overhand_knot` /
   `three_strand_braid`. Add one `timeFull({supersample:1, shadow_enabled:true})` column (1-line edit
   `bench_drag.mjs:73-83,110-111`) for a faithful release/zoom number (ss1 + shadows ON).
2. **Live pipeline cost:** add `tools/bench_gestures.mjs` (~50 lines, pattern from `compare_hover.mjs:96-121`):
   chromium → dev server → load fixture → `waitForFunction(()=>window.__store)` → wrap `performance.now()`
   around ZOOM (`setView({zoom})` + 2 rAFs), RELEASE (`setDragging(false)`+`__requestRender`+2 rAFs), DRAG
   (`setDragging(true)`+`setDragMoving([name])` then per-frame `mutateDocDuringDrag`+`__requestRender`+2 rAFs).
3. **End-to-end:** Playwright trace (`screenshots:true`) of a real wheel spin + drag-release; count >16ms frames.

**Oracle gate on every change:** `npm run diff` + the `compare_*` harnesses — every artifact PNG must be
byte-identical before and after.

## Rejected / deferred

- **Per-strand WeakMap stroked-outline cache** — high oracle-surface risk; R1 (state-not-render) is the
  higher-leverage drag win. Defer until profiling proves stroke-rebuild dominates.
- **Persistent paper.Project / reused scratch canvas** — invasive to a byte-identical fn; per-frame
  `paper.setup` is minor next to R1/R2/R3.
- **OSS per-frame background re-bake / dirty-rect / AA-toggle** — these are OSS's *slow*/vestigial paths;
  OSSJS already mirrors the fast path (bake once, redraw moving; ss2→1 + `DRAG_SAMPLE_STEP=3`).
- **DEFERRED — bake static cast-shadows into `DRAG_BG`** (`strand-renderer.js:1501` currently `shadows=false`):
  the only item that would edit renderer code (a drag-only fn the harness never calls). Needs static-vs-full
  shadow parity verification first. R3 removes the release hitch without it.
- **Already shipped (do not re-propose):** `EDITOR_SUPERSAMPLE=1`, drag bake/per-frame fast-path, zoom→meta.zoom,
  snapped-position early-out, per-gesture connection-table cache, pendingFull overlay-swallow guard.
