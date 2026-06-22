// Export the whole document as a PNG: render it content-fit (not viewport-fit)
// at an export scale into #c, grab toDataURL, download, then restore the live
// view. Reuses the verified renderer; no renderer change needed.

import { useEditorStore } from '../store/editorStore';
import { toRenderArray } from '../renderer/toRenderArray';
import { callRender } from '../renderer/rendererBridge';
import { requestRender } from '../renderer/renderScheduler';
import { contentBounds } from '../interaction/viewTransform';
import { downloadDataURL } from './fileDialog';
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
    curve_params: settings.curve_params,
  };
  return { meta, w, h };
}

export function exportPng(exportZoom = 2, margin = 40): void {
  const e = exportMeta(exportZoom, margin);
  if (!e) return;
  const { doc } = useEditorStore.getState();
  callRender(toRenderArray(doc), e.meta);
  const c = document.getElementById('c') as HTMLCanvasElement | null;
  if (c) downloadDataURL('openstrand_export.png', c.toDataURL('image/png'));
  requestRender(); // restore the live viewport render
}

// Dev-only debug handle for testing export sizing without downloading.
if (import.meta.env?.DEV) (globalThis as Record<string, unknown>).__exportMeta = exportMeta;
