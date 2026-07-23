// rAF-coalesced render pipeline. Any number of store changes in a frame collapse
// into one renderFixture call + one overlay redraw. The overlay canvas is always
// resized to match #c (the renderer owns #c's size), so the two layers stay
// pixel-aligned.

import { useEditorStore } from '../store/editorStore';
import { callRender, callRenderDragBackground, callRenderDragFrame, callEndDrag } from './rendererBridge';
import { buildMeta, toRenderArray } from './toRenderArray';

// Pending work for the coalescing rAF: 0 = idle, 1 = overlay-only, 2 = full
// render (+ overlay). requestRender UPGRADES a frame already scheduled as
// overlay-only; with a single "scheduled" boolean, a pointer-move's overlay
// request arriving in the same frame window as pointer-up's render request
// silently swallowed the render — a just-created strand stayed invisible until
// the next unrelated full render.
let pendingWork: 0 | 1 | 2 = 0;
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

// Redraw just the overlay (cheap; no renderFixture). Used for hover/selection.
export function requestOverlay(): void {
  schedule(1);
}

function schedule(level: 1 | 2): void {
  const wasIdle = pendingWork === 0;
  if (level > pendingWork) pendingWork = level;
  if (!wasIdle) return; // a frame is queued; it will pick up the (upgraded) level
  requestAnimationFrame(() => {
    const work = pendingWork;
    pendingWork = 0; // reset BEFORE the work so re-entrant requests queue a fresh frame
    if (work === 2) renderNow();
    syncOverlay();
  });
}

if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__requestOverlay = () => requestOverlay();
  (globalThis as Record<string, unknown>).__requestRender = () => requestRender();
}

export function requestRender(): void {
  schedule(2);
}

// One full document render (renderFixture / drag fast-path). Overlay sync is the
// caller's job — schedule() always runs syncOverlay after this.
function renderNow(): void {
  const { doc, view, settings, dragging, dragMoving, selection, mode } = useEditorStore.getState();
  try {
    // During an endpoint drag, highlight every strand that moves with the
    // grabbed handle (weld group + attached/mask peers from movingStrandSet),
    // so a moving junction reddens on both sides like OSS — not just the
    // grabbed strand. At rest only the selected strand is highlighted.
    const highlightSet = dragging && dragMoving.length ? new Set(dragMoving) : undefined;
    // OSS _suppress_highlight_in_view (strand.py:1970-1980): in view mode the
    // "hide the selection highlight" setting skips PAINTING the highlight
    // without clearing the selection, so it reappears on leaving view mode.
    const highlightLayer = mode === 'view' && settings.view_hide_highlight ? null : selection.layerName;
    const arr = toRenderArray(doc, highlightLayer, highlightSet);
    if (dragging && dragMoving.length) {
      // DRAG FAST-PATH (mirrors the original's draw-only-affected-strand path).
      // Render at native resolution with shadows off: bake every STATIC strand
      // once into a cached bitmap, then each frame draw ONLY the moving strands
      // over that cache. Per-frame work is O(moving strands), not O(all strands),
      // so dragging stays smooth regardless of scene size. The fidelity harness
      // calls renderFixture directly and never sets meta.drag, so the oracle's
      // default output is unchanged.
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
      callRender(arr, { ...buildMeta(doc, view, settings), supersample: EDITOR_SUPERSAMPLE });
    }
  } catch (err) {
    // Surface renderer errors without killing the rAF loop.
    console.error('[OpenStrandJS] render failed:', err);
  }
}
