// rAF-coalesced render pipeline. Any number of store changes in a frame collapse
// into one renderFixture call + one overlay redraw. The overlay canvas is always
// resized to match #c (the renderer owns #c's size), so the two layers stay
// pixel-aligned.

import { useEditorStore } from '../store/editorStore';
import { callRender, callRenderDragBackground, callRenderDragFrame, callEndDrag } from './rendererBridge';
import { buildMeta, toRenderArray } from './toRenderArray';
import type { EditorDocument, Point, Selection } from '../model/types';

let scheduled = false;
// True when the queued frame must do a FULL render (#c via renderFixture), not just
// an overlay redraw. requestRender sets this; if an overlay frame is already queued
// it UPGRADES that frame to a full render instead of being dropped. This is the
// invariant that keeps a quick create/attach pointer-up from being swallowed by the
// prior pointer-move's overlay-only frame (the "new strand invisible until moved"
// bug): requestRender must ALWAYS win over a pending overlay frame.
let pendingFull = false;
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

// --- Adaptive drag quality (auto-fits the machine; no hardcoded resolution budget) ---
// The per-frame drag cost is dominated by Paper.js raster (∝ canvas pixels) + a path-
// boolean per moving mask (∝ outline segment count). Both scale with two knobs:
//   * res_scale  — drag render RESOLUTION (upscaled to #c). Applied at BAKE, so it is
//                  fixed for the life of a gesture (changing it needs a re-bake).
//   * sample_step — path SAMPLING density. Applied LIVE per frame (cheap, no re-bake).
// A feedback loop measures each drag frame's render time and converges both knobs to
// hold a frame budget: a fast machine (e.g. an M4) keeps full crispness, a slow one
// (e.g. a 2019 laptop) softens just enough to stay smooth. Persisted to localStorage so
// a known-slow machine starts already-tuned (no slow "first drag"). This only feeds
// meta.drag, which the offline oracle / full render never set — so they are untouched.
const DRAG_BUDGET_MS = 12;      // target render cost per drag frame (headroom in a 16ms frame)
const DRAG_MIN_SCALE = 0.34;    // floor on resolution scale (below this is too blurry)
const DRAG_MAX_STEP = 26;       // ceiling on sampling coarseness
const DRAG_PERF_KEY = 'openstrandjs.dragPerf';
let dragScale = 1;   // adaptive resolution scale (1 = full crisp), persisted
let dragStep = 0;    // adaptive sample_step (0 = full/default sampling), persisted
let bakedScale = 1;  // the scale the live bake was actually made at
let dragMsEma = 0;   // smoothed measured frame time (session-local)
// MOTION-ADAPTIVE resolution: while the pointer flings the grabbed handle fast, the moving
// strand + its masks are rendered at an even lower resolution than the baked bands (motion
// blur hides it), sharpening as the move slows. Tracks the grabbed handle's per-frame
// displacement (world px) between drag frames, lightly smoothed so steady motion doesn't
// flicker; both reset at each new grab.
let lastHandlePos: { x: number; y: number } | null = null;
let dispEma = 0;
// One-shot "settle" so a fling that stops dead (no further pointer-move) still sharpens to
// the baked scale; forceSettle makes the next frame ignore the motion downscale.
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let forceSettle = false;
try {
  const p = JSON.parse(localStorage.getItem(DRAG_PERF_KEY) || 'null');
  if (p && typeof p.scale === 'number') {
    dragScale = Math.max(DRAG_MIN_SCALE, Math.min(1, p.scale));
    dragStep = Math.max(0, Math.min(DRAG_MAX_STEP, p.step || 0));
  }
} catch { /* no stored perf profile yet */ }

// Nudge the two quality knobs toward DRAG_BUDGET_MS from one measured frame time.
// Multiplicative steps + EMA smoothing keep it from oscillating; res only moves toward
// the floor when slow and back toward crisp when there's headroom. dragScale takes
// effect on the NEXT bake (no mid-gesture re-bake/thrash); dragStep is live.
function adaptDragQuality(ms: number, hasMask: boolean): void {
  dragMsEma = dragMsEma === 0 ? ms : dragMsEma * 0.6 + ms * 0.4;
  const e = dragMsEma;
  let changed = false;
  if (e > DRAG_BUDGET_MS * 1.3) {
    const step0 = dragStep >= 3 ? dragStep : (hasMask ? 8 : 6);
    const ns = Math.min(DRAG_MAX_STEP, step0 * 1.2);
    if (ns !== dragStep) { dragStep = ns; changed = true; }
    const nsc = Math.max(DRAG_MIN_SCALE, dragScale * (e > DRAG_BUDGET_MS * 3 ? 0.82 : 0.93));
    if (nsc !== dragScale) { dragScale = nsc; changed = true; }
  } else if (e < DRAG_BUDGET_MS * 0.55) {
    if (dragStep > 0) { dragStep = dragStep > 3 ? dragStep * 0.9 : 0; changed = true; }
    if (dragScale < 1) { dragScale = Math.min(1, dragScale * 1.05); changed = true; }
  }
  if (changed) {
    try { localStorage.setItem(DRAG_PERF_KEY, JSON.stringify({ scale: dragScale, step: dragStep })); } catch { /* ignore */ }
  }
}

// World position of the currently-grabbed handle — the displacement proxy that drives
// motion-adaptive drag resolution. Mirrors MoveMode.handlePos.
function selHandlePos(doc: EditorDocument, selection: Selection): Point | null {
  const { layerName, handle } = selection;
  if (!layerName || !handle) return null;
  const s = doc.strands[layerName];
  if (!s) return null;
  switch (handle) {
    case 'start': return s.start;
    case 'end': return s.end;
    case 'control_point1': return s.control_points[0];
    case 'control_point2': return s.control_points[1];
    case 'control_point_center': return s.control_point_center ?? s.start;
  }
  return null;
}

// DEV-only drag perf readout: prints the per-grab bake time + a throttled per-frame time, with
// mask counts + the live quality knobs, so the slow-machine cost can be SEEN (open DevTools
// console, drag, read the [OSS drag] lines). No effect in production builds.
let lastPerfLog = 0;
function logDragPerf(bakeMs: number, frameMs: number, moving: string[], doc: EditorDocument, scale: number, mvScale: number): void {
  const now = performance.now();
  if (bakeMs <= 0 && now - lastPerfLog < 400) return; // always print a grab bake; throttle frame logs
  lastPerfLog = now;
  let movingMasks = 0;
  for (const n of moving) if (doc.strands[n]?.type === 'MaskedStrand') movingMasks++;
  let docMasks = 0;
  for (const n of doc.order) if (doc.strands[n]?.type === 'MaskedStrand') docMasks++;
  const bake = bakeMs > 0 ? `bake=${bakeMs.toFixed(0)}ms ` : '';
  // eslint-disable-next-line no-console
  console.log(`[OSS drag] ${bake}frame=${frameMs.toFixed(1)}ms movingMasks=${movingMasks} docMasks=${docMasks} scale=${scale.toFixed(2)} mv=${mvScale.toFixed(2)}`);
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
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(runFrame);
}

if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__requestOverlay = () => requestOverlay();
  (globalThis as Record<string, unknown>).__requestRender = () => requestRender();
}

export function requestRender(): void {
  // Always mark the queued frame as full. If an overlay-only frame is already
  // scheduled this UPGRADES it (instead of being dropped by the old `if (scheduled)
  // return`), so a quick create/attach pointer-up can never be swallowed.
  pendingFull = true;
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(runFrame);
}

// One coalesced rAF frame shared by both requestOverlay and requestRender. Does a
// full #c render when any caller this frame asked for one (pendingFull), then always
// resyncs the overlay so the two layers stay aligned.
function runFrame(): void {
  scheduled = false;
  const full = pendingFull;
  pendingFull = false;
  if (full) {
    const { doc, view, settings, dragging, dragMoving, selection, mode } = useEditorStore.getState();
    try {
      // During an endpoint/group drag, highlight every strand that moves with the
      // grabbed handle (weld group + attached/mask peers from movingStrandSet), so a
      // moving junction reddens on both sides like OSS — not just the grabbed strand.
      // EXCEPTION: single-strand rotate/angle adjust are one-strand operations (OSS
      // highlights only that strand), and they ride the SAME fast-path (dragMoving may
      // include attached-end children + masks purely so they redraw, not so they
      // redden). For those, leave highlightSet undefined so toRenderArray falls back to
      // selection.layerName — byte-identical to their pre-fast-path full-render look.
      // At rest only the selected strand is highlighted.
      const wholeSetHighlight = dragging && dragMoving.length > 0 && mode !== 'rotate' && mode !== 'angle';
      const highlightSet = wholeSetHighlight ? new Set(dragMoving) : undefined;
      // OSS View mode: when view_hide_highlight is on, suppress the red selection
      // highlight while in View mode (strand.py::_suppress_highlight_in_view) by
      // zeroing is_selected at the payload source. The renderer (#c) needs no change,
      // and the offline oracle / PNG export — which never set this — stay byte-identical.
      const viewHideHighlight = mode === 'view' && settings.view_hide_highlight;
      const arr = toRenderArray(doc, selection.layerName, highlightSet, viewHideHighlight);
      if (dragging && dragMoving.length) {
        // DRAG FAST-PATH (mirrors the original's draw-only-affected-strand path).
        // Render at native resolution with shadows off: bake every STATIC strand
        // once into a cached bitmap, then each frame draw ONLY the moving strands
        // over that cache. Per-frame work is O(moving strands), not O(all strands),
        // so dragging stays smooth regardless of scene size. The fidelity harness
        // calls renderFixture directly and never sets meta.drag, so the oracle's
        // default output is unchanged.
        const base = buildMeta(doc, view, settings);
        // The drag composite is rasterized by Paper.js every frame (cost ∝ canvas pixels)
        // plus a path-boolean per moving mask (cost ∝ outline segment count). The app's
        // 65% page zoom inflates the stage clientWidth, so a typical canvas is ~4.5 MP and a
        // knot strand with a few masks can take 100s of ms/frame on a slow machine — yet runs
        // fine on a fast one. So drag QUALITY is adaptive (see adaptDragQuality): render the
        // moving strand + baked static bands at dragScale resolution and dragStep sampling,
        // upscale-blit onto the unchanged full-size #c (overlay stays aligned). res_scale is
        // fixed for the life of a bake; sampling adapts live. Snaps fully crisp on release.
        const hasMovingMask = dragMoving.some((n) => doc.strands[n]?.type === 'MaskedStrand');
        // Bake the static background when none is live OR when a prior gesture's stale bake is
        // cached for a DIFFERENT moving set (re-grab after a release). The resolution scale is
        // captured at bake time only (changing it mid-gesture would need an expensive re-bake).
        // The bake key includes the VIEW signature (size + pan + zoom), not just the moving set:
        // if the view changes mid-drag (pan-while-dragging, wheel-zoom, window/panel resize), the
        // baked bands no longer match the live meta and renderDragFrame would fall back to a full
        // render EVERY frame forever. Folding the view in forces a re-bake at the new view so fast
        // frames resume.
        const key = dragMoving.join('|') + '|' + base.image_width + 'x' + base.image_height
          + '|' + base.x_offset + ',' + base.y_offset + '|' + (base.zoom || 1);
        const rebake = !dragBaked || bakedKey !== key;
        if (rebake) { bakedScale = dragScale; lastHandlePos = null; dispEma = 0; }
        const sample_step = dragStep >= 3 ? Math.round(dragStep) : undefined;
        // Motion-adaptive moving-strand resolution. The grabbed handle's per-frame world
        // displacement is a proxy for "how fast am I dragging": a big jump means fast motion
        // (low detail is invisible), a small one means precise placement (keep it crisp). We
        // only drop BELOW the bake scale once the perf controller has already softened (slow
        // machine) — a fast machine that stays at full scale never blurs the fling. mv_scale
        // takes effect immediately each frame (no re-bake — mv is re-stroked every frame).
        const MV_FAST_DISP = 34;   // world px/frame at/above which mv is fully downscaled
        const MV_MIN_FACTOR = 0.45; // floor: mv_scale never below this fraction of the bake scale
        const hp = selHandlePos(doc, selection);
        let mv_scale = bakedScale;
        // forceSettle (set by the settle timer) renders ONE crisp frame at the baked scale
        // even though the pointer is parked, so a fling that stops dead mid-air still sharpens
        // without a pointer-move or release.
        if (!forceSettle && bakedScale < 0.95 && hp && lastHandlePos) {
          const disp = Math.hypot(hp.x - lastHandlePos.x, hp.y - lastHandlePos.y);
          dispEma = dispEma === 0 ? disp : dispEma * 0.5 + disp * 0.5;
          const k = Math.min(1, dispEma / MV_FAST_DISP);       // 0 (still) .. 1 (fast fling)
          mv_scale = bakedScale * (1 - k * (1 - MV_MIN_FACTOR));
        }
        forceSettle = false;
        lastHandlePos = hp;
        const meta = {
          ...base,
          supersample: 1,
          shadow_enabled: false,
          // mask_simple (slow machines only): skip each crossing's stroke-border boolean — the
          // crossing stays visible (body fill, no dark border) at ~half the cost. Gated on the
          // perf controller having already softened, so a fast machine keeps full masks. Fixed
          // per gesture (bakedScale is), so the static bake + per-frame masks stay consistent.
          drag: { moving: dragMoving, res_scale: bakedScale, sample_step, mv_scale, mask_simple: bakedScale < 0.7 },
        };
        let bakeMs = 0;
        if (rebake) {
          if (dragBaked) callEndDrag(); // drop the stale bake from the prior gesture
          const tBake = performance.now();
          callRenderDragBackground(arr, meta);
          bakeMs = performance.now() - tBake;
          dragBaked = true;
          bakedKey = key;
        }
        const tFrame = performance.now();
        callRenderDragFrame(arr, meta);
        const frameMs = performance.now() - tFrame;
        // Feed the measured render time back into the quality knobs for subsequent frames.
        adaptDragQuality(frameMs, hasMovingMask);
        if (import.meta.env?.DEV) logDragPerf(bakeMs, frameMs, dragMoving, doc, bakedScale, mv_scale);
        // Settle: if this frame was downscaled by motion, schedule a one-shot crisp re-render
        // so a fling that STOPS dead (cursor parked, button still held — no further pointer-
        // move fires) still sharpens to the baked scale instead of staying blurry until release.
        // Each drag frame reschedules; the settle frame itself renders at bakedScale so it never
        // loops. Cleared on release. (Timers are foreground-tab only — exactly where dragging is.)
        if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
        if (mv_scale < bakedScale - 1e-3) {
          settleTimer = setTimeout(() => {
            settleTimer = null;
            if (useEditorStore.getState().dragging) { forceSettle = true; dispEma = 0; requestRender(); }
          }, 130);
        }
      } else {
        // NOT DRAGGING (release, selection click, undo, …): one full render at the
        // editor supersample (1×). At 1× shadows + correct z-order are restored in
        // ~30ms instead of the ~260ms a full ss2 render costs, so pointer-up no
        // longer hangs. Drop any drag background first so the next gesture re-bakes.
        if (dragBaked) { callEndDrag(); dragBaked = false; bakedKey = null; }
        if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
        forceSettle = false;
        callRender(arr, { ...buildMeta(doc, view, settings), supersample: EDITOR_SUPERSAMPLE });
      }
    } catch (err) {
      // Surface renderer errors without killing the rAF loop.
      console.error('[OpenStrandJS] render failed:', err);
    }
  }
  syncOverlay();
}
