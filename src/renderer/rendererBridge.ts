// Typed bridge to the vanilla renderer in web/strand-renderer.js.
//
// strand-renderer.js references a global `paper` and assigns window.renderFixture
// / window.extractStrands. It is loaded UNCHANGED (it's the pixel-verified
// oracle). We expose paper as a global before any render call, then import the
// script for its side effects. paper is only dereferenced inside renderFixture
// at call time, so import order vs. the window.paper assignment is safe.

import paper from 'paper';
import '../../web/strand-renderer.js';
import type { RenderMeta, RenderStrand } from '../model/types';

(globalThis as unknown as { paper: typeof paper }).paper = paper;

declare global {
  interface Window {
    renderFixture: (strands: RenderStrand[], meta: RenderMeta) => unknown;
    extractStrands: (data: unknown, step?: number) => unknown[];
    renderDragBackground?: (strands: RenderStrand[], meta: RenderMeta) => unknown;
    renderDragFrame?: (strands: RenderStrand[], meta: RenderMeta) => unknown;
    endDrag?: () => void;
    renderPanBackground?: (strands: RenderStrand[], meta: RenderMeta) => unknown;
    renderPanFrame?: (meta: RenderMeta) => unknown;
    endPan?: () => void;
  }
}

export function callRender(strands: RenderStrand[], meta: RenderMeta): void {
  if (typeof window.renderFixture !== 'function') {
    throw new Error('strand-renderer.js did not define window.renderFixture');
  }
  window.renderFixture(strands, meta);
}

// Drag fast-path bridges. Each degrades gracefully to a full renderFixture if the
// renderer predates these functions, so the editor never breaks.
export function callRenderDragBackground(strands: RenderStrand[], meta: RenderMeta): void {
  if (typeof window.renderDragBackground === 'function') window.renderDragBackground(strands, meta);
  else callRender(strands, meta);
}

export function callRenderDragFrame(strands: RenderStrand[], meta: RenderMeta): void {
  if (typeof window.renderDragFrame === 'function') window.renderDragFrame(strands, meta);
  else callRender(strands, meta);
}

export function callEndDrag(): void {
  if (typeof window.endDrag === 'function') window.endDrag();
}

// Pan fast-path bridges. Same graceful degradation as the drag ones: an older
// renderer without them falls back to a full render, which is exactly the
// behaviour this path replaces.
export function callRenderPanBackground(strands: RenderStrand[], meta: RenderMeta): boolean {
  if (typeof window.renderPanBackground !== 'function') return false;
  window.renderPanBackground(strands, meta);
  return true;
}

// True when the snapshot served this frame; false means the caller must
// re-snapshot (delta past the margin, fractional delta, or size/zoom change).
export function callRenderPanFrame(meta: RenderMeta): boolean {
  if (typeof window.renderPanFrame !== 'function') return false;
  return window.renderPanFrame(meta) != null;
}

export function callEndPan(): void {
  if (typeof window.endPan === 'function') window.endPan();
}

export function extractStrands(data: unknown, step?: number): unknown[] {
  return window.extractStrands(data, step);
}
