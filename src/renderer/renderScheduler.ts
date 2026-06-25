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

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (!pendingFull) { syncOverlay(); return; }  // overlay-only frame
    pendingFull = false;
    const { doc, view, settings, dragging, dragMoving, selection, mode } = useEditorStore.getState();
    try {
      // During an endpoint drag, highlight every strand that moves with the
      // grabbed handle (weld group + attached/mask peers from movingStrandSet),
      // so a moving junction reddens on both sides like OSS — not just the
      // grabbed strand. At rest only the selected strand is highlighted.
      const highlightSet = dragging && dragMoving.length ? new Set(dragMoving) : undefined;
      // OSS View mode: when view_hide_highlight is on, suppress the red selection
      // highlight while in View mode (strand.py::_suppress_highlight_in_view) by
      // zeroing is_selected at the payload source. The renderer (#c) needs no change,
      // and the offline oracle / PNG export — which never set this — stay byte-identical.
      const viewHideHighlight = mode === 'view' && settings.view_hide_highlight;
      const arr = toRenderArray(doc, selection.layerName, highlightSet, viewHideHighlight);
      if (dragging && dragMoving.length) {
        // DRAG FAST-PATH (mirrors the original's draw-only-affected-strand path).
        // Render at native resolution: bake every STATIC strand once into a cached
        // bitmap (shadows off — the bake's concern is cheap resting geometry), then
        // each frame draw ONLY the moving strands over that cache. Per-frame work is
        // O(moving strands), not O(all strands), so dragging stays smooth regardless of
        // scene size. shadow_enabled flows through from settings (NOT forced off) so the
        // live moving band can redraw a moving MASK's own crossing shadow each frame like
        // OSS; the bake stays shadow-free and a moving strand's cast shadow onto lower
        // layers is the documented per-frame residual, restored by the pointer-up full
        // render. The fidelity harness calls renderFixture directly and never sets
        // meta.drag, so the oracle's default output is unchanged.
        const meta = {
          ...buildMeta(doc, view, settings),
          supersample: 1,
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
        callRender(arr, { ...buildMeta(doc, view, settings), supersample: EDITOR_SUPERSAMPLE });
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

if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__requestOverlay = () => requestOverlay();
  (globalThis as Record<string, unknown>).__requestRender = () => requestRender();
}
