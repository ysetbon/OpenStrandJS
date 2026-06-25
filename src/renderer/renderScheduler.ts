// rAF-coalesced render pipeline. Any number of store changes in a frame collapse
// into one renderFixture call + one overlay redraw. The overlay canvas is always
// resized to match #c (the renderer owns #c's size), so the two layers stay
// pixel-aligned.

import { useEditorStore } from '../store/editorStore';
import { callRender, callRenderDragBackground, callRenderDragFrame, callEndDrag } from './rendererBridge';
import { buildMeta, toRenderArray } from './toRenderArray';

let scheduled = false;
// True once the current drag gesture's static background has been baked.
let dragBaked = false;
// The moving-set signature (dragMoving.join('|')) the cached DRAG_BG was baked
// for. A new gesture whose moving set differs MUST force a re-bake, else it would
// blit the previous gesture's static background (the just-released strand missing,
// the newly-grabbed strand baked-static AND drawn-moving = ghosted). This happens
// because a deferred release can leave dragBaked=true when a new drag starts inside
// its ~1-frame window. Keyed re-bake closes that race. null when no bake is live.
let bakedKey: string | null = null;
// Supersample for LIVE EDITOR full renders. A full ss2 render is a ~260ms
// main-thread freeze even for one strand (Paper.js stroked-outline sampling at 2×)
// — that is the pointer-up "hang". At 1× a full render is ~30ms, so the editor
// stays responsive on every selection/undo/release. The offline fidelity oracle
// renders through renderFixture with its OWN meta (ss2 + exact box-average) and is
// untouched, and PNG export can request ss2 explicitly. Bump to 2 to trade
// responsiveness for crisper on-screen anti-aliasing.
const EDITOR_SUPERSAMPLE = 1;
let overlayCanvas: HTMLCanvasElement | null = null;
let overlayDraw: ((ctx: CanvasRenderingContext2D) => void) | null = null;

export function setOverlay(
  canvas: HTMLCanvasElement | null,
  draw: ((ctx: CanvasRenderingContext2D) => void) | null,
): void {
  overlayCanvas = canvas;
  overlayDraw = draw;
}

function syncOverlay(): void {
  if (!overlayCanvas) return;
  const c = document.getElementById('c') as HTMLCanvasElement | null;
  if (!c) return;
  // Match backing store + CSS box exactly to #c.
  if (overlayCanvas.width !== c.width) overlayCanvas.width = c.width;
  if (overlayCanvas.height !== c.height) overlayCanvas.height = c.height;
  overlayCanvas.style.width = c.style.width;
  overlayCanvas.style.height = c.style.height;
  const ctx = overlayCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (overlayDraw) overlayDraw(ctx);
}

// requestOverlay (cheap, overlay-only) and requestRender (full #c render) share
// ONE rAF-coalesced frame, deduped by `scheduled`. `pendingFull` records whether
// that frame must do a full render. requestRender always WINS: calling it while an
// overlay-only frame is already queued UPGRADES that frame to a full render.
//
// They previously shared only `scheduled` but queued two SEPARATE callbacks, so a
// pending overlay rAF (queued by the last pointer-move of a create/attach drag)
// SWALLOWED the requestRender fired on pointer-up — its early `if (scheduled)
// return` bailed, the overlay-only rAF ran, and the just-committed strand was never
// drawn to #c. It then stayed invisible until the next full render (e.g. when you
// moved it). The CanvasStage docRevision effect was only an intermittent backstop
// (it raced the same flag), which is why the strand vanished only "sometimes".
let pendingFull = false;
// R3 release-settle payload: the moving-set names captured at pointer-up. The scheduler
// reuses the still-live drag bake for one cheap settle frame and defers the full render
// one rAF. NOT read from the store, because MoveMode clears dragging/dragMoving on
// pointer-up BEFORE the deferred render runs. null when no release is pending.
let settle: { names: string[] } | null = null;

// R2 view gestures (wheel-zoom + hand-pan): while one is in flight we render DRAFT quality —
// shadows OFF at the editor supersample — on every event, then do ONE full shadowed render
// when the gesture settles. Shadows are the dominant render cost (~6-9x; see tools/bench_drag),
// so dropping them keeps zoom/pan smooth while the frame still fills the WHOLE viewport
// correctly (grid + strands edge-to-edge). (An earlier CSS-transform approach was faster still
// but left un-rendered margins on zoom-out/pan when a viewport-sized bitmap was scaled/shifted.)
let viewGesturing = false;
export function isViewGesturing(): boolean { return viewGesturing; }
export function setViewGesturing(b: boolean): void { viewGesturing = b; }

// Dev-only render timer: surfaces what each #c paint actually costs so smoothness work is
// driven by numbers, not guesses. Stripped from production builds.
function devTime<T>(label: string, fn: () => T): T {
  if (!import.meta.env?.DEV) return fn();
  const t0 = performance.now();
  const r = fn();
  // eslint-disable-next-line no-console
  console.log(`[OpenStrandJS perf] ${label}: ${(performance.now() - t0).toFixed(1)}ms`);
  return r;
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!pendingFull) { syncOverlay(); return; }  // overlay-only frame
    pendingFull = false;
    const { doc, view, settings, dragging, dragMoving, selection, mode } = useEditorStore.getState();
    // OSS View mode: when view_hide_highlight is on, suppress the red selection highlight
    // while in View mode (strand.py::_suppress_highlight_in_view) by zeroing is_selected at
    // the payload source. The renderer (#c) needs no change, and the offline oracle / PNG
    // export — which never set this — stay byte-identical. Hoisted out of the try so the
    // release-settle path below can reuse it.
    const viewHideHighlight = mode === 'view' && settings.view_hide_highlight;

    // RELEASE SETTLE FAST-PATH (R3): pointer-up asked for a deferred full render. If the
    // drag bake for this exact moving set is still live and no new gesture has started,
    // paint ONE more cheap moving frame over that bake THIS frame (the released strand
    // lands instantly), then defer the expensive from-scratch full render (true z-order +
    // O(n^2) shadow) to the NEXT frame — mirroring OSS deferring its second full repaint
    // via QTimer.singleShot(0, update) (move_mode.py:1681). The whole moving set is
    // highlighted for this one frame (like the drag frames); phase 2 collapses it to the
    // selected strand. If the bake is gone / keys mismatch / a drag is active, fall through
    // to the normal full render below (graceful degrade — no harm, just no deferral).
    if (settle) {
      const names = settle.names;
      settle = null;
      if (dragBaked && bakedKey === names.join('|') && !dragging) {
        try {
          const arr = toRenderArray(doc, selection.layerName, new Set(names), viewHideHighlight);
          // Shadow-free like the drag frames (phase 2 restores shadows next frame) so the
          // instant settle frame stays cheap even when zoomed in.
          callRenderDragFrame(arr, { ...buildMeta(doc, view, settings), supersample: 1, shadow_enabled: false, drag: { moving: names } });
        } catch (err) {
          console.error('[OpenStrandJS] release settle (phase 1) failed:', err);
        }
        syncOverlay();
        requestAnimationFrame(() => {
          // A new drag started inside the one-frame window — it now owns the bake (the
          // bakedKey re-bake guard keeps it correct), so leave the bake live and bail.
          if (useEditorStore.getState().dragging) return;
          if (dragBaked) { callEndDrag(); dragBaked = false; bakedKey = null; }
          const s = useEditorStore.getState();
          try {
            const arr2 = toRenderArray(s.doc, s.selection.layerName, undefined,
              s.mode === 'view' && s.settings.view_hide_highlight);
            devTime(`release full render (${arr2.length} strands @ zoom ${s.view.zoom.toFixed(2)})`,
              () => callRender(arr2, { ...buildMeta(s.doc, s.view, s.settings), supersample: EDITOR_SUPERSAMPLE }));
          } catch (err) {
            console.error('[OpenStrandJS] release settle (phase 2) failed:', err);
          }
          syncOverlay();
        });
        return;
      }
    }

    try {
      // During an endpoint drag, highlight every strand that moves with the
      // grabbed handle (weld group + attached/mask peers from movingStrandSet),
      // so a moving junction reddens on both sides like OSS — not just the
      // grabbed strand. At rest only the selected strand is highlighted.
      const highlightSet = dragging && dragMoving.length ? new Set(dragMoving) : undefined;
      const arr = toRenderArray(doc, selection.layerName, highlightSet, viewHideHighlight);
      if (dragging && dragMoving.length) {
        // DRAG FAST-PATH (mirrors the original's draw-only-affected-strand path).
        // Bake every STATIC strand once into a cached bitmap (shadows off), then each frame
        // draw ONLY the moving strands over that cache — per-frame work is O(moving), not
        // O(all). Shadows are ALSO off on the moving strand (shadow_enabled:false): they are
        // the dominant render cost and, zoomed in, the blur covers a large pixel area, so
        // recomputing the moving strand's shadow every frame was the residual drag jank
        // (worse the more you zoom in). The whole drag is therefore shadow-free, exactly like
        // zoom/pan; the pointer-up render (R3) restores correct shadows + z-order one frame
        // later. The fidelity harness calls renderFixture directly and never sets meta.drag /
        // this shadow_enabled, so the oracle's default output is unchanged.
        const meta = {
          ...buildMeta(doc, view, settings),
          supersample: 1,
          shadow_enabled: false,
          drag: { moving: dragMoving },
        };
        // Bake the static background when none is live OR when a prior gesture's
        // stale bake is still cached for a DIFFERENT moving set (re-grab after a
        // release). Same moving set => the static set is identical and unmoved, so
        // the cache is safely reused.
        const key = dragMoving.join('|');
        if (!dragBaked || bakedKey !== key) {
          if (dragBaked) callEndDrag(); // drop the stale bake from the prior gesture
          callRenderDragBackground(arr, meta);
          dragBaked = true;
          bakedKey = key;
        }
        callRenderDragFrame(arr, meta);
      } else {
        // NOT DRAGGING (release, selection click, undo, …): one full render at the
        // editor supersample (1×). At 1× shadows + correct z-order are restored in
        // ~30ms instead of the ~260ms a full ss2 render costs, so pointer-up no
        // longer hangs. Drop any drag background first so the next gesture re-bakes.
        if (dragBaked) { callEndDrag(); dragBaked = false; bakedKey = null; }
        // During a view gesture (zoom/pan) render DRAFT — shadows OFF — so it stays smooth even
        // on dense scenes; the settle render restores shadows. shadow_enabled is editor-path
        // meta only (the oracle passes its own meta), so byte-identical output is unaffected.
        const meta = { ...buildMeta(doc, view, settings), supersample: EDITOR_SUPERSAMPLE };
        if (viewGesturing) meta.shadow_enabled = false;
        devTime(`${viewGesturing ? 'view-gesture draft' : 'full render'} (${arr.length} strands @ zoom ${view.zoom.toFixed(2)})`,
          () => callRender(arr, meta));
      }
    } catch (err) {
      // Surface renderer errors without killing the rAF loop.
      console.error('[OpenStrandJS] render failed:', err);
    }
    syncOverlay();
  });
}

// Redraw just the overlay (cheap; no renderFixture). Used for hover/selection.
// Never downgrades a full render already requested for the current frame.
export function requestOverlay(): void {
  schedule();
}

// Full #c re-render (renderFixture). Coalesced into the shared frame and flagged so
// it can never be swallowed by a pending overlay-only frame.
export function requestRender(): void {
  pendingFull = true;
  schedule();
}

// R3: pointer-up's deferred render. Captures the just-ended gesture's moving set and
// schedules a full frame; the scheduler settles the released strand over the still-live
// bake this frame and runs the from-scratch full render on the next. Degrades to a plain
// full render if the bake is no longer valid (see schedule()).
export function requestReleaseSettle(movingNames: string[]): void {
  settle = { names: movingNames };
  pendingFull = true;
  schedule();
}

if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__requestOverlay = () => requestOverlay();
  (globalThis as Record<string, unknown>).__requestRender = () => requestRender();
}
