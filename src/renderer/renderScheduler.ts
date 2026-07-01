// rAF-coalesced render pipeline. Any number of store changes in a frame collapse
// into one renderFixture call + one overlay redraw. The overlay canvas is always
// resized to match #c (the renderer owns #c's size), so the two layers stay
// pixel-aligned.

import { useEditorStore } from '../store/editorStore';
import { callRender, callRenderDragBackground, callRenderDragFrame, callEndDrag, callRenderPanImage } from './rendererBridge';
import { buildMeta, toRenderArray } from './toRenderArray';
import { contentBounds } from '../interaction/viewTransform';
import type { EditorDocument, Settings, ViewState } from '../model/types';

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

// --- PAN fast-path (canvas drag / hand tool) ---------------------------------------------
// A pan is a PURE rigid screen translation, so instead of re-rendering the scene every move
// (4.6 MP Paper raster + a boolean per mask, 100s of ms on a slow masked knot) we capture the
// scene ONCE at pan-start and BLIT it shifted by the pan delta each move — O(1), zero Paper work
// per move. #c keeps its full size so the existing syncOverlay re-aligns the handles from the
// live view (no overlay change). One crisp full render on RELEASE restores shadows/z-order.
//
// The capture is an OVER-RENDER: the whole scene — every strand, INCLUDING those off-screen —
// drawn into an offscreen that covers the content bounds + a margin (capped at PAN_MAX_DIM), at
// FULL (HD) resolution with full masks so the panned image is as crisp as the static view. Only
// a genuinely enormous region (zoomed far in) is downscaled, past PAN_PX_BUDGET, to stay within
// memory. Panning then reveals real off-screen strands instead of white. Falls back to a plain
// #c snapshot (viewport only, white beyond it) when the over-render renderer is unavailable.
// Oracle-safe: renderPanImage is editor-only; renderFixture is untouched. Pan takes precedence
// over the drag branch (see runFrame). Shadows are off during the pan and return on release.
const PAN_MARGIN_FRAC = 0.5;   // over-render margin as a fraction of the viewport, each side
const PAN_MAX_DIM = 8000;      // hard ceiling on the offscreen dimension (memory safety)
const PAN_PX_BUDGET = 40e6;    // HD: only regions larger than this (very zoomed-in) get downscaled
let panning = false;
let panSnap: HTMLCanvasElement | null = null;   // captured scene (over-render OR viewport snapshot)
let panSnapPan = { x: 0, y: 0 };                // view.panX/panY when captured
let panSnapView = { w: 0, h: 0, zoom: 1 };      // size+zoom the capture is valid for
let panSnapOrigin = { x: 0, y: 0 };             // backing-px offset of the capture's top-left (0,0 for a #c snapshot)
let panSnapScale = 1;                           // draft scale the capture was rendered at (1 for a #c snapshot)

// Plain fallback: copy the current crisp #c (viewport only) as the pan base.
function snapshotPanBase(view: ViewState): void {
  const c = document.getElementById('c') as HTMLCanvasElement | null;
  if (!c || c.width === 0 || c.height === 0) { panSnap = null; return; }
  if (!panSnap) panSnap = document.createElement('canvas');
  panSnap.width = c.width; panSnap.height = c.height;
  const ctx = panSnap.getContext('2d');
  if (!ctx) { panSnap = null; return; }
  ctx.drawImage(c, 0, 0);
  panSnapPan = { x: view.panX, y: view.panY };
  panSnapView = { w: Math.round(view.width), h: Math.round(view.height), zoom: view.zoom };
  panSnapOrigin = { x: 0, y: 0 };
  panSnapScale = 1;
}

// Over-render the whole scene (off-screen strands included) into a larger offscreen at draft
// quality. Region = union(viewport, contentBounds) + margin, capped at PAN_MAX_DIM, drawn at
// PAN_PX_BUDGET pixels. Returns true on success.
function renderPanOverImage(doc: EditorDocument, view: ViewState, settings: Settings, selLayer: string | null): boolean {
  const W = Math.round(view.width), H = Math.round(view.height), zoom = view.zoom;
  // Region in backing px = union(viewport [0..W,0..H], content bounds) + margin.
  let rx0 = 0, ry0 = 0, rx1 = W, ry1 = H;
  const b = contentBounds(doc);
  if (b) {
    rx0 = Math.min(rx0, b.minX * zoom + view.panX); ry0 = Math.min(ry0, b.minY * zoom + view.panY);
    rx1 = Math.max(rx1, b.maxX * zoom + view.panX); ry1 = Math.max(ry1, b.maxY * zoom + view.panY);
  }
  rx0 -= W * PAN_MARGIN_FRAC; ry0 -= H * PAN_MARGIN_FRAC; rx1 += W * PAN_MARGIN_FRAC; ry1 += H * PAN_MARGIN_FRAC;
  let regionW = rx1 - rx0, regionH = ry1 - ry0;
  if (regionW > PAN_MAX_DIM) { const c = (rx0 + rx1) / 2; rx0 = c - PAN_MAX_DIM / 2; regionW = PAN_MAX_DIM; }
  if (regionH > PAN_MAX_DIM) { const c = (ry0 + ry1) / 2; ry0 = c - PAN_MAX_DIM / 2; regionH = PAN_MAX_DIM; }
  const sc = Math.min(1, Math.sqrt(PAN_PX_BUDGET / Math.max(1, regionW * regionH)));
  const lw = Math.max(1, Math.round(regionW * sc)), lh = Math.max(1, Math.round(regionH * sc));
  const arr = toRenderArray(doc, selLayer, undefined, false);
  const meta = {
    ...buildMeta(doc, view, settings),
    image_width: lw, image_height: lh,
    x_offset: (view.panX - rx0) * sc, y_offset: (view.panY - ry0) * sc, zoom: zoom * sc,
    supersample: 1, shadow_enabled: false,
    // Full quality: no sample_step / mask_simple overrides -> default fine sampling + full masks
    // (the crossings keep their dark borders), so the capture matches the static view.
    drag: { moving: [] as string[] },
  };
  const canvas = callRenderPanImage(arr, meta);
  if (!canvas) return false;
  panSnap = canvas;
  panSnapPan = { x: view.panX, y: view.panY };
  panSnapView = { w: W, h: H, zoom };
  panSnapOrigin = { x: rx0, y: ry0 };
  panSnapScale = sc;
  return true;
}

// Blit the captured scene translated by the pan delta. Returns false (→ full render + re-capture)
// when the capture is missing or the view SIZE/ZOOM changed (wheel-zoom / resize mid-pan —
// translation is only valid at constant size+zoom).
function panBlit(view: ViewState): boolean {
  const c = document.getElementById('c') as HTMLCanvasElement | null;
  if (!panSnap || !c) return false;
  if (panSnapView.w !== Math.round(view.width) || panSnapView.h !== Math.round(view.height)
      || panSnapView.zoom !== view.zoom) return false;
  const ctx = c.getContext('2d');
  if (!ctx) return false;
  if (dragBaked) { callEndDrag(); dragBaked = false; bakedKey = null; } // drop a stale drag bake
  const dx = view.panX - panSnapPan.x, dy = view.panY - panSnapPan.y;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, c.width, c.height);
  // The capture covers backing region [origin, origin+region] rendered at panSnapScale; draw it
  // back to backing size at (origin + panDelta). At full scale (sc=1) this is a 1:1 blit with
  // smoothing OFF (crisp / HD); smoothing is only enabled when a very-zoomed-in capture was
  // downscaled and must be upscaled. Round the destination to whole pixels to avoid sub-pixel blur.
  ctx.imageSmoothingEnabled = panSnapScale < 1;
  ctx.drawImage(panSnap, 0, 0, panSnap.width, panSnap.height,
    Math.round(panSnapOrigin.x + dx), Math.round(panSnapOrigin.y + dy),
    Math.round(panSnap.width / panSnapScale), Math.round(panSnap.height / panSnapScale));
  return true;
}

// Called by InteractionHost on pan-start / pan-end.
export function beginPanGesture(): void {
  panning = true;
  const { doc, view, settings, selection } = useEditorStore.getState();
  // Over-render the whole scene (off-screen strands included) at pan-start; fall back to a plain
  // viewport snapshot of the crisp #c if the over-render renderer isn't available.
  if (!renderPanOverImage(doc, view, settings, selection.layerName)) snapshotPanBase(view);
}
export function endPanGesture(): void {
  panning = false;
  panSnap = null;
  requestRender(); // one crisp full render: shadows + z-order + fills the revealed edge
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
      // PAN FAST-PATH (takes precedence over the drag branch): a pan is a pure rigid screen
      // translation, so blit the pan-start snapshot of #c shifted by the pan delta — O(1), no
      // Paper raster / no mask booleans. panBlit returns false when the snapshot is stale (a
      // wheel-zoom or window/panel resize mid-pan changed size/zoom); then we fall through to a
      // full render below and re-snapshot it as the new base. The crisp shadowed render is
      // deferred to RELEASE (endPanGesture) — never mid-pan. syncOverlay (below) re-aligns the
      // handles from the live view either way.
      if (!(panning && panBlit(view))) {
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
      if (!panning && dragging && dragMoving.length) {
        // DRAG FAST-PATH: bake every STATIC strand once into a cached bitmap, then each frame
        // draw ONLY the moving strands over that cache — per-frame work is O(moving), not
        // O(all strands), so dragging stays smooth regardless of scene size, at full (crisp)
        // resolution with shadows off. Full quality + shadows return via a normal render on
        // pointer-up. The offline harness never sets meta.drag, so the oracle is unchanged.
        const base = buildMeta(doc, view, settings);
        // Bake once per moving-set; the key folds in the VIEW signature (size + pan + zoom) so a
        // mid-drag view change (pan-while-dragging, wheel-zoom, window/panel resize) re-bakes at
        // the new view instead of falling back to a full render every frame forever.
        const key = dragMoving.join('|') + '|' + base.image_width + 'x' + base.image_height
          + '|' + base.x_offset + ',' + base.y_offset + '|' + (base.zoom || 1);
        const rebake = !dragBaked || bakedKey !== key;
        const meta = { ...base, supersample: 1, shadow_enabled: false, drag: { moving: dragMoving } };
        if (rebake) {
          if (dragBaked) callEndDrag(); // drop the stale bake from the prior gesture
          callRenderDragBackground(arr, meta);
          dragBaked = true;
          bakedKey = key;
        }
        callRenderDragFrame(arr, meta);
      } else {
        // NOT the drag fast-path: a release / selection click / undo / … OR a STALE-pan
        // re-render (wheel-zoom / resize mid-pan). One full render at the editor supersample
        // (1×) restores shadows + z-order in ~30ms vs ~260ms at ss2, so pointer-up no longer
        // hangs. Drop any drag bake first; drop a stale pan base on a non-pan render; and when
        // panning (the stale case), re-snapshot the fresh #c as the new pan translation base.
        if (!panning && panSnap) panSnap = null;
        if (dragBaked) { callEndDrag(); dragBaked = false; bakedKey = null; }
        callRender(arr, { ...buildMeta(doc, view, settings), supersample: EDITOR_SUPERSAMPLE });
        if (panning) snapshotPanBase(view);
      }
      }
    } catch (err) {
      // Surface renderer errors without killing the rAF loop.
      console.error('[OpenStrandJS] render failed:', err);
    }
  }
  syncOverlay();
}
