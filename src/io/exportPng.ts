// Export the VISIBLE CANVAS VIEWPORT as a PNG — exactly what's on screen, the way
// OpenStrand Studio's "Save as Image" does (main_window.save_canvas_as_image):
// take the whole canvas widget (view.width × view.height), keep the current
// zoom/pan, render it at SCALE× resolution onto a TRANSPARENT background, then
// download. OSS does NOT crop to content — the image bounds ARE the viewport, so
// every strand keeps the exact position/size it has on the canvas. Reuses the
// verified renderer (no renderer change), then restores the live view.

import { useEditorStore } from '../store/editorStore';
import { toRenderArray } from '../renderer/toRenderArray';
import { callRender } from '../renderer/rendererBridge';
import { requestRender } from '../renderer/renderScheduler';
import { downloadDataURL } from './fileDialog';
import type { RenderMeta } from '../model/types';

// OSS renders the export 4× larger than the canvas for crispness
// (main_window.py: scale_factor = 4.0). The image is view-size × this factor.
const EXPORT_SCALE = 4;

// Build the viewport export meta: the on-screen view (view.width/height, panX/panY,
// zoom) scaled up by `scale`. world -> export px is (world*zoom + pan)*scale, the
// SAME transform the live canvas uses (worldToScreen) just blown up `scale`×, so
// the export is pixel-for-pixel the visible canvas at higher resolution. Shared by
// export and tests.
export function exportMeta(scale = EXPORT_SCALE): { meta: RenderMeta; w: number; h: number } {
  const { doc, settings, view } = useEditorStore.getState();
  const w = Math.max(1, Math.round(view.width * scale));
  const h = Math.max(1, Math.round(view.height * scale));
  const meta: RenderMeta = {
    image_width: w,
    image_height: h,
    x_offset: view.panX * scale,
    y_offset: view.panY * scale,
    zoom: view.zoom * scale,
    // ss=1: render straight at `scale`× resolution (like OSS's 4× QImage) — no
    // box-average downscale. That keeps renderFixture on its alpha-correct
    // drawImage path so the transparent background survives to the PNG.
    supersample: 1,
    shadow_enabled: doc.shadow_enabled,
    shadow_overrides: doc.shadow_overrides,
    curve_params: settings.curve_params,
    // OSS draws the grid into the export when it's visible (paint_canvas draws
    // draw_grid first if self.canvas.show_grid).
    show_grid: settings.show_grid,
    grid_size: settings.grid_size,
    // OSS fills the QImage with Qt.transparent — keep the background transparent.
    transparent_bg: true,
  };
  return { meta, w, h };
}

export function exportPng(scale = EXPORT_SCALE): void {
  const { doc, settings, selection, mode } = useEditorStore.getState();
  const { meta } = exportMeta(scale);
  // Render the SAME payload the live canvas shows at rest: the selected strand is
  // highlighted (OSS paint_canvas calls draw_highlighted_strand for the selected
  // strand), unless View mode is hiding the highlight (view_hide_highlight). This
  // makes the export match what's on screen exactly.
  const viewHideHighlight = mode === 'view' && settings.view_hide_highlight;
  const arr = toRenderArray(doc, selection.layerName, undefined, viewHideHighlight);
  callRender(arr, meta);
  const c = document.getElementById('c') as HTMLCanvasElement | null;
  if (c) downloadDataURL('openstrand_export.png', c.toDataURL('image/png'));
  requestRender(); // restore the live viewport render
}

// Dev-only debug handle for testing export sizing without downloading.
if (import.meta.env?.DEV) (globalThis as Record<string, unknown>).__exportMeta = exportMeta;
