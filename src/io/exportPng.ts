// Export the whole document as a PNG: render it content-fit (not viewport-fit)
// at an export scale into #c, grab toDataURL, download, then restore the live
// view. Reuses the verified renderer; no renderer change needed.

import { useEditorStore } from '../store/editorStore';
import { toRenderArray } from '../renderer/toRenderArray';
import { callRender } from '../renderer/rendererBridge';
import { requestRender } from '../renderer/renderScheduler';
import { contentBounds } from '../interaction/viewTransform';
import { downloadDataURL } from './fileDialog';
import { drawStrandLabels } from '../overlay/strandLabels';
import type { RenderMeta } from '../model/types';

// Build the content-fit export meta + dimensions (shared by export and tests).
export function exportMeta(exportZoom = 2, margin = 40): { meta: RenderMeta; w: number; h: number } | null {
  const { doc, settings, view } = useEditorStore.getState();
  const b = contentBounds(doc);
  if (!b) return null;
  const w = Math.max(1, Math.round((b.maxX - b.minX) * exportZoom + 2 * margin));
  const h = Math.max(1, Math.round((b.maxY - b.minY) * exportZoom + 2 * margin));
  const meta: RenderMeta = {
    image_width: w,
    image_height: h,
    x_offset: margin - b.minX * exportZoom,
    y_offset: margin - b.minY * exportZoom,
    supersample: view.supersample,
    zoom: exportZoom,
    shadow_enabled: doc.shadow_enabled,
    shadow_overrides: doc.shadow_overrides,
    curve_params: settings.curve_params,
    // The two curve-shaping settings, so the exported bodies (and the Draw Names
    // mask clip, which reads the same settings) use the live curve configuration
    // rather than the renderer's inferred-from-data fallback.
    enable_third_control_point: settings.enable_third_control_point,
    enable_curvature_bias_control: settings.enable_curvature_bias_control,
    // Honor the Grid toggle in the export: when on, the renderer paints the grid
    // behind the strands (same path as the on-screen render). Off => no grid.
    show_grid: settings.show_grid,
    grid_size: settings.grid_size,
  };
  return { meta, w, h };
}

export function exportPng(exportZoom = 2, margin = 40): void {
  const e = exportMeta(exportZoom, margin);
  if (!e) return;
  const { doc, settings, drawNames } = useEditorStore.getState();
  callRender(toRenderArray(doc), e.meta);
  const c = document.getElementById('c') as HTMLCanvasElement | null;
  if (!c) return;
  // OSS save_canvas_as_image paints the strand names into the image when Draw
  // Names is on (main_window.py paint_canvas). The composited canvas is 1:1 with
  // CSS px, so the world->px map is the meta's own zoom/offset pair.
  if (drawNames) {
    const ctx = c.getContext('2d');
    if (ctx) drawStrandLabels(ctx, doc, settings, { zoom: exportZoom, panX: e.meta.x_offset, panY: e.meta.y_offset });
  }
  downloadDataURL('openstrand_export.png', c.toDataURL('image/png'));
  requestRender(); // restore the live viewport render
}

// Dev-only debug handle for testing export sizing without downloading.
if (import.meta.env?.DEV) (globalThis as Record<string, unknown>).__exportMeta = exportMeta;
