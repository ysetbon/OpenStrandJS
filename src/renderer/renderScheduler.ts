// rAF-coalesced render pipeline. Any number of store changes in a frame collapse
// into one renderFixture call + one overlay redraw. The overlay canvas is always
// resized to match #c (the renderer owns #c's size), so the two layers stay
// pixel-aligned.

import { useEditorStore } from '../store/editorStore';
import {
  callRender, callRenderDragBackground, callRenderDragFrame, callEndDrag,
  callRenderPanBackground, callRenderPanFrame, callEndPan,
} from './rendererBridge';
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
// ---- pan gesture state --------------------------------------------------------
// True between pan pointer-down and pointer-up. Deliberately NOT in the zustand
// store: it is read only here, and putting it in the store would spend a React
// commit on each end of every pan for nothing.
let panGesture = false;
// What the live pan snapshot was taken for — every renderNow input EXCEPT the pan
// offset, which is the one thing the snapshot is allowed to differ in. `doc` is
// compared by identity AND revision because mutateDocLive edits the document in
// place, leaving the reference unchanged.
type PanSig = {
  doc: unknown; docRevision: number; settings: unknown; shadowPaths: unknown;
  highlight: string | null; zoom: number; w: number; h: number; ss: number;
};
let panSig: PanSig | null = null;

function samePanSig(a: PanSig | null, b: PanSig): boolean {
  return !!a && a.doc === b.doc && a.docRevision === b.docRevision
    && a.settings === b.settings && a.shadowPaths === b.shadowPaths
    && a.highlight === b.highlight && a.zoom === b.zoom
    && a.w === b.w && a.h === b.h && a.ss === b.ss;
}

// Unconditional: panSig can be null while the renderer still holds a snapshot (a
// renderPanBackground that succeeded followed by a refused blit), and callEndPan is
// idempotent, so gating this on panSig would be the one way to leak the bitmap.
function dropPanSnapshot(): void {
  panSig = null;
  callEndPan();
}

// Called by InteractionHost around a pan gesture. Ending one frees the snapshot
// (several megabytes) rather than holding it against a possible next pan, which
// could also mean serving that pan from a pre-edit scene.
export function setPanGesture(on: boolean): void {
  panGesture = on;
  if (!on) dropPanSnapshot();
}

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

// Work that must run at the TOP of the next frame, before it paints. The pointer
// handlers use this to apply a coalesced move: a 1000 Hz mouse fires ~16 moves
// per displayed frame, and running the document edit for every one of them threw
// away all but the last. Doing it here instead means one edit per painted frame,
// with no added latency — the edit lands in the same frame that renders it, not
// the next one. Tasks are deduplicated by identity, so a handler can register the
// same drain function on every event.
const frameTasks = new Set<() => void>();

// Registering a task does NOT by itself ask for a render or an overlay redraw —
// it only guarantees a frame will run. The task decides: a coalesced move that
// edits the document calls requestRender, one that only updates hover calls
// requestOverlay, and one that finds nothing changed leaves the frame empty.
// That is what keeps plain mouse-over-the-canvas from forcing a full repaint at
// display rate.
export function requestFrameTask(task: () => void): void {
  frameTasks.add(task);
  ensureFrame();
}

// Run a registered task NOW and drop it from the queue. Pointer-up calls this so
// the gesture finishes at the exact last position the pointer reported, rather
// than wherever the previous frame left it.
export function flushFrameTask(task: () => void): void {
  if (!frameTasks.delete(task)) return;
  runTask(task);
}

// Drop a queued task without running it — an aborted gesture must not have its
// last move applied on the way out.
export function cancelFrameTask(task: () => void): void {
  frameTasks.delete(task);
}

function runTask(task: () => void): void {
  try {
    task();
  } catch (err) {
    console.error('[OpenStrandJS] frame task failed:', err);
  }
}

let frameQueued = false;

function ensureFrame(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(runFrame);
}

function runFrame(): void {
  frameQueued = false;   // re-entrant requests queue a fresh frame
  // Frame tasks first: they mutate the document this frame is about to draw, and
  // they may raise the work level, so pendingWork is read only after they run.
  if (frameTasks.size) {
    const tasks = [...frameTasks];
    frameTasks.clear();
    for (const t of tasks) runTask(t);
  }
  const work = pendingWork;
  pendingWork = 0; // reset BEFORE the work so re-entrant requests queue a fresh frame
  if (work === 2) renderNow();
  if (work >= 1) syncOverlay();
}

function schedule(level: 1 | 2): void {
  if (level > pendingWork) pendingWork = level;
  ensureFrame();
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
  const {
    doc, docRevision, view, settings, dragging, dragMoving, selection, mode, visibleShadowPaths,
  } = useEditorStore.getState();
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
    if (panGesture && !dragging) {
      // PAN FAST-PATH. A pan moves no document coordinate — only x_offset/y_offset,
      // which renderFixture folds into every point — so before this path every pan
      // frame rebuilt the whole scene (measured ~1.2 s/frame on three_strand_braid).
      // renderPanBackground takes ONE oversized render and renderPanFrame blits the
      // matching sub-rectangle each frame; tools/pan_identity.mjs proves that
      // sub-rectangle is pixel-identical to the full render it replaces, so this is
      // a pure speedup with no change to what is drawn.
      const meta = {
        ...buildMeta(doc, view, settings, visibleShadowPaths),
        supersample: EDITOR_SUPERSAMPLE,
      };
      const sig: PanSig = {
        doc, docRevision, settings, shadowPaths: visibleShadowPaths,
        highlight: highlightLayer, zoom: meta.zoom ?? 1,
        w: meta.image_width, h: meta.image_height, ss: EDITOR_SUPERSAMPLE,
      };
      if (dragBaked) { callEndDrag(); dragBaked = false; bakedKey = null; }
      // Order matters: when the signature changed, the live snapshot is for a
      // different scene, so it must NOT be blitted first — && short-circuits past
      // callRenderPanFrame straight to the re-snapshot.
      if (!samePanSig(panSig, sig) || !callRenderPanFrame(meta)) {
        panSig = null;
        if (callRenderPanBackground(arr, meta) && callRenderPanFrame(meta)) {
          panSig = sig;
        } else {
          // Renderer without the pan entry points: the old full-render behaviour,
          // which is exactly what this path optimizes rather than replaces.
          callEndPan();
          callRender(arr, meta);
        }
      }
      return;
    }
    if (dragging && dragMoving.length) {
      // DRAG FAST-PATH (mirrors the original's draw-only-affected-strand path).
      // Render at native resolution with shadows off: bake every STATIC strand
      // once into a cached bitmap, then each frame draw ONLY the moving strands
      // over that cache. Per-frame work is O(moving strands), not O(all strands),
      // so dragging stays smooth regardless of scene size. The fidelity harness
      // calls renderFixture directly and never sets meta.drag, so the oracle's
      // default output is unchanged.
      const meta = {
        // No preview pairs on the drag path: the overlay lives in renderFixture,
        // and renderDragFrame deliberately skips shadows entirely (see below), so
        // passing them here would wire up something that cannot draw.
        ...buildMeta(doc, view, settings),
        supersample: 1,
        shadow_enabled: false,
        drag: { moving: dragMoving },
      };
      // Bake the static background when none is live OR when a prior gesture's
      // stale bake is still cached for a DIFFERENT moving set (re-grab after a
      // release). Same moving set => the static set is identical and unmoved, so
      // the cache is safely reused.
      //
      // The key carries the VIEW as well as the moving set. renderDragFrame
      // refuses a bake whose size/pan/zoom no longer match and silently falls
      // back to a full renderFixture — correct, but it never tells us, and this
      // key only tracked the moving set, so a resize or pan mid-gesture (a
      // splitter drag firing the ResizeObserver, say) dropped the rest of that
      // drag onto the slow path with no way back. Keying on the view means the
      // mismatch re-bakes once and every later frame is fast again.
      // draw_only_affected_strand rides along because it decides whether the
      // static bands are baked at all.
      const key = `${dragMoving.join('|')}|${settings.draw_only_affected_strand ? 1 : 0}`
        + `#${meta.image_width}x${meta.image_height}@${meta.x_offset},${meta.y_offset},${meta.zoom ?? 1}`;
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
      dropPanSnapshot();   // e.g. an undo landing while a pan snapshot is still live
      callRender(arr, {
        ...buildMeta(doc, view, settings, visibleShadowPaths),
        supersample: EDITOR_SUPERSAMPLE,
      });
    }
  } catch (err) {
    // Surface renderer errors without killing the rAF loop.
    console.error('[OpenStrandJS] render failed:', err);
  }
}
