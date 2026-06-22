// rAF-coalesced render pipeline. Any number of store changes in a frame collapse
// into one renderFixture call + one overlay redraw. The overlay canvas is always
// resized to match #c (the renderer owns #c's size), so the two layers stay
// pixel-aligned.

import { useEditorStore } from '../store/editorStore';
import { callRender } from './rendererBridge';
import { buildMeta, toRenderArray } from './toRenderArray';

let scheduled = false;
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
  requestAnimationFrame(() => { scheduled = false; syncOverlay(); });
}

if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__requestOverlay = () => requestOverlay();
  (globalThis as Record<string, unknown>).__requestRender = () => requestRender();
}

export function requestRender(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const { doc, view, settings } = useEditorStore.getState();
    try {
      callRender(toRenderArray(doc), buildMeta(doc, view, settings));
    } catch (err) {
      // Surface renderer errors without killing the rAF loop.
      console.error('[OpenStrandJS] render failed:', err);
    }
    syncOverlay();
  });
}
