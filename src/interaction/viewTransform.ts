// The ONE world<->screen transform. The renderer adapter (toRenderArray),
// hit-testing, and the overlay all use this exact math, so handles never drift
// from the rendered bodies (the canvas-core spec's #1 risk).
//
// screen = world * zoom + pan (CSS px); world = (screen - pan) / zoom. The
// renderer takes the same pair as meta.zoom / meta.x_offset,y_offset, so the
// wheel, the zoom buttons, hit-testing and the overlay all move together.

import type { EditorDocument, Point, ViewState } from '../model/types';

// OSS zoom limits and step (strand_drawing_canvas.py:192-197): zoom_factor
// starts at 1.0, min_zoom 0.1, max_zoom 5.0, and zoom_in/zoom_out step by
// zoom_percentage = 10% OF THE CURRENT zoom, so the scale is geometric
// (1.1x in, 0.9x out) rather than a fixed 0.1 increment.
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
export const ZOOM_PERCENTAGE = 0.1;

/** Confine a zoom factor to OSS's [min_zoom, max_zoom]. */
export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/**
 * Set the zoom while pinning the world point currently under `anchor` (screen
 * px) — screen = world*zoom + pan, so pan = anchor - world*zoom.
 *
 * The zoom buttons anchor on the viewport centre. OSS instead keeps
 * pan_offset untouched and scales about the CANVAS centre (canvas point
 * width/2, height/2 — strand_drawing_canvas.py:1833), which is the same point
 * at OSS's default pan of 0; once panned, that point can sit off-screen, and
 * stepping the zoom there walks the drawing out of the viewport. Anchoring on
 * what the user is actually looking at keeps it in view.
 */
export function zoomAbout(
  view: ViewState, zoom: number, anchor: Point,
): { zoom: number; panX: number; panY: number } {
  const z = clampZoom(zoom);
  const w = screenToWorld(anchor, view);
  return { zoom: z, panX: anchor.x - w.x * z, panY: anchor.y - w.y * z };
}

/** Centre of the visible canvas, in screen px. */
export function viewCenter(view: ViewState): Point {
  return { x: view.width / 2, y: view.height / 2 };
}

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
