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

// strand-renderer.js is a side-effect module that assigns window.renderFixture /
// renderDragFrame / etc. Vite HMR can leave a STALE copy of it in memory when only
// its importers reload (e.g. after editing the renderer together with a .ts file):
// the rest of the app updates but window.renderFixture still points at the old
// build, so the next render reverts to old output (e.g. white canvas + no grid in
// a themed/gridded editor). Force a FULL page reload whenever the renderer module
// changes so the live window.* renderer is never out of sync. Dev-only:
// import.meta.hot is undefined in production builds and the block is stripped.
if (import.meta.hot) {
  import.meta.hot.accept('../../web/strand-renderer.js', () => window.location.reload());
}

declare global {
  interface Window {
    renderFixture: (strands: RenderStrand[], meta: RenderMeta) => unknown;
    extractStrands: (data: unknown, step?: number) => unknown[];
    renderDragBackground?: (strands: RenderStrand[], meta: RenderMeta) => unknown;
    renderDragFrame?: (strands: RenderStrand[], meta: RenderMeta) => unknown;
    endDrag?: () => void;
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

export function extractStrands(data: unknown, step?: number): unknown[] {
  return window.extractStrands(data, step);
}
