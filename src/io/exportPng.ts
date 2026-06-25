// Export the canvas as a PNG, faithful to OSS save_canvas_as_image
// (main_window.py:1921). OSS is VIEWPORT-fit, not content-fit: it renders the
// on-screen canvas at its CURRENT zoom/pan into a transparent QImage 4x larger
// than the widget ("maximum quality/crispness"), then saves. So the export is
// exactly what's on screen — same framing, clipped at the canvas edges — just at
// 4x resolution with a transparent background.
//
// We reproduce that with the verified live renderer (no renderer behavior change):
// the renderer's final pixel = world*meta.zoom + meta.offset at image_width x
// image_height (supersample cancels). So we fold the 4x into zoom + offsets, render
// at supersample=1 (one antialiased pass, like OSS), and set transparent_bg so empty
// areas stay transparent. This is true WYSIWYG of the JS on-screen canvas at 4x.
//
// Note on zoom: this matches OSS pixel-for-pixel at view.zoom == 1 (the app's only
// zoom today — the zoom buttons are disabled placeholders). The JS view model is
// origin/pointer-anchored (screen = world*zoom + pan), whereas OSS zoom is
// center-anchored (it adds 4*center*(1-zoom)); at zoom != 1 the export still matches
// the JS on-screen view exactly, just not OSS's center-anchored framing — by design.
//
// Not drawn (matching the current live canvas, NOT OSS's export): the in-progress
// `pending` strand (it lives on the #overlay canvas, not #c, and users export at
// rest) and strand-name labels (should_draw_names is unimplemented in the renderer).
// Revisit if either becomes a supported export scenario.

import { useEditorStore } from '../store/editorStore';
import { toRenderArray, buildMeta } from '../renderer/toRenderArray';
import { callRender } from '../renderer/rendererBridge';
import { requestRender } from '../renderer/renderScheduler';
import { savePng } from './fileDialog';
import type { RenderMeta } from '../model/types';

// OSS scale_factor = 4.0 (hardcoded in save_canvas_as_image).
const EXPORT_SCALE = 4;

// Build the OSS-exact viewport-fit export meta + output dimensions (shared by
// export and tests). Output size == canvas widget size * scale, mirroring OSS
// high_res_size = canvas_size * 4.
export function exportMeta(scale = EXPORT_SCALE): { meta: RenderMeta; w: number; h: number } {
  const { doc, settings, view } = useEditorStore.getState();
  const base = buildMeta(doc, view, settings);
  const w = base.image_width * scale;
  const h = base.image_height * scale;
  const meta: RenderMeta = {
    ...base,
    image_width: w,
    image_height: h,
    x_offset: view.panX * scale,
    y_offset: view.panY * scale,
    zoom: view.zoom * scale,
    supersample: 1,        // the 4x resolution IS the supersample (one antialiased pass, like OSS)
    transparent_bg: true,  // OSS fills the QImage with Qt.transparent
    // `grid` is carried from base: OSS draws the grid in the export when show_grid
    // is on (main_window.py:1969). `canvas_bg` is carried but ignored under
    // transparent_bg, so the backdrop stays transparent.
  };
  return { meta, w, h };
}

export async function exportPng(scale = EXPORT_SCALE): Promise<void> {
  const { doc, selection, mode, settings } = useEditorStore.getState();
  const { meta } = exportMeta(scale);
  // WYSIWYG: the selected strand draws its highlight in the export too (OSS uses
  // draw_highlighted_strand for the selected strand at main_window.py:1974), with
  // the same View-mode hide-highlight gating as the live canvas.
  const viewHideHighlight = mode === 'view' && settings.view_hide_highlight;
  callRender(toRenderArray(doc, selection.layerName, undefined, viewHideHighlight), meta);
  const c = document.getElementById('c') as HTMLCanvasElement | null;
  const dataUrl = c?.toDataURL('image/png');
  requestRender(); // restore the live viewport render immediately (export size was transient)
  if (dataUrl) await savePng('openstrand_export.png', dataUrl);
}

// Dev-only debug handle for testing export sizing without downloading.
if (import.meta.env?.DEV) (globalThis as Record<string, unknown>).__exportMeta = exportMeta;
