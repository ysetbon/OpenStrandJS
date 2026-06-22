// The ONE world<->screen transform. The renderer adapter (toRenderArray),
// hit-testing, and the overlay all use this exact math, so handles never drift
// from the rendered bodies (the canvas-core spec's #1 risk).
//
// Phase 1: zoom is pinned to 1.0, so screen = world + pan (CSS px). Inverse:
// world = screen - pan. When full zoom lands (Phase 6) this becomes the
// center-anchored affine and the renderer gains meta.zoom/meta.pan.

import type { EditorDocument, Point, ViewState } from '../model/types';

export function worldToScreen(p: Point, view: ViewState): Point {
  return { x: p.x * view.zoom + view.panX, y: p.y * view.zoom + view.panY };
}

export function screenToWorld(s: Point, view: ViewState): Point {
  return { x: (s.x - view.panX) / view.zoom, y: (s.y - view.panY) / view.zoom };
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number; }

// Bounding box (world space) of everything the document touches: endpoints,
// control points, and mask deletion-rectangle corners.
export function contentBounds(doc: EditorDocument): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (p: Point | null | undefined) => {
    if (!p) return;
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  };
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s) continue;
    acc(s.start); acc(s.end);
    acc(s.control_points?.[0]); acc(s.control_points?.[1]);
    for (const rect of s.deletion_rectangles ?? []) {
      for (const c of [rect.top_left, rect.top_right, rect.bottom_left, rect.bottom_right]) {
        if (c) acc({ x: c[0], y: c[1] });
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

// Pan that centers the document in the viewport (zoom unchanged). Falls back to
// centering the origin when the document is empty.
export function fitPan(doc: EditorDocument, view: ViewState): { panX: number; panY: number } {
  const b = contentBounds(doc);
  if (!b) return { panX: view.width / 2, panY: view.height / 2 };
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { panX: view.width / 2 - cx * view.zoom, panY: view.height / 2 - cy * view.zoom };
}
