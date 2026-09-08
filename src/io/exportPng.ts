// The toolbar's "Image" button: a port of OSS save_canvas_as_image
// (main_window.py:2080-2159). OSS asks for a file name first, then paints the
// CURRENT VIEW — the canvas widget's own size, under its live zoom and pan — onto
// a transparent QImage 4x that size, through the same strand.draw the screen
// uses: the grid when it is on, every strand in order with the selected one
// highlighted, and the strand names when Draw Names is on. No content fitting, no
// margin, no white backdrop, and no supersampling beyond the 4x scale itself.
//
// Reuses the verified renderer: the 4x is folded into meta.zoom / the offsets
// exactly the way OSS folds it into painter.scale(scale_factor) ahead of its
// zoom/pan transform, so the export is the on-screen frame at 4x.

import { useEditorStore } from '../store/editorStore';
import { buildMeta, toRenderArray } from '../renderer/toRenderArray';
import { callRender } from '../renderer/rendererBridge';
import { requestRender, restingHighlightLayer } from '../renderer/renderScheduler';
import { pickPngFile, writePngFile } from './fileDialog';
import { drawStrandLabels } from '../overlay/strandLabels';
import type { RenderMeta } from '../model/types';

// OSS: `scale_factor = 4.0  # Create image 4x larger for maximum quality/crispness`.
export const EXPORT_SCALE = 4;

// Browser canvas budget. A Qt QImage takes the 4x of any widget, but a browser
// canvas past its limit silently draws NOTHING and the PNG comes out blank. The
// tightest current limit is Safari's (8192 px a side, 64M px in area, since
// Safari 18; Chrome and Firefox allow more), so the scale is lowered only when 4x
// would cross it — which no ordinary desktop view does (1920x1080 -> 33M px).
export const MAX_EXPORT_SIDE = 8192;
export const MAX_EXPORT_PIXELS = 8192 * 8192;

// The largest scale <= `scale` whose image fits the budget.
export function effectiveExportScale(scale: number, view: { width: number; height: number }): number {
  const w = Math.max(1, view.width), h = Math.max(1, view.height);
  return Math.min(scale, MAX_EXPORT_SIDE / w, MAX_EXPORT_SIDE / h, Math.sqrt(MAX_EXPORT_PIXELS / (w * h)));
}

// The export meta + dimensions (shared by the export and tests), and the scale
// actually applied. Never null: an empty document still exports the
// (transparent) view, as OSS does.
export function exportMeta(
  scale = EXPORT_SCALE,
): { meta: RenderMeta; w: number; h: number; scale: number } {
  const { doc, settings, view } = useEditorStore.getState();
  scale = effectiveExportScale(scale, view);
  // QSize * scale_factor: the widget size rounded, not the content bounds.
  const w = Math.max(1, Math.round(view.width * scale));
  const h = Math.max(1, Math.round(view.height * scale));
  const meta: RenderMeta = {
    // The live frame's settings (curve toggles, shadow trio, arrow/extension
    // params, grid, highlight colour) — everything strand.draw reads off the
    // canvas — minus the Shadow Path preview, which OSS paints at canvas level in
    // paintEvent only (strand_drawing_canvas.py:2802), so paint_canvas omits it.
    ...buildMeta(doc, view, settings),
    image_width: w,
    image_height: h,
    // painter.scale(4) ahead of the zoom/pan transform: screen' = 4 * screen.
    x_offset: view.panX * scale,
    y_offset: view.panY * scale,
    zoom: view.zoom * scale,
    // No supersampling: OSS paints straight onto the 4x image (the 4x IS the
    // quality step), unlike the screen's supersampled buffer.
    supersample: 1,
    // image.fill(Qt.transparent): no backdrop, whatever the theme.
    canvas_bg: 'transparent',
    // draw_grid's QPen(color, 1) (1.5 below 50% zoom) is not cosmetic, so under
    // painter.scale(4) * zoom the lines come out that many px wide. grid_color is
    // already the zoom-dependent OSS value from buildMeta.
    grid_line_width: (view.zoom < 0.5 ? 1.5 : 1) * scale * view.zoom,
  };
  return { meta, w, h, scale };
}

// Paint the export frame and return it as its own canvas (W x H, transparent
// background). Draws through #c, the renderer's only target, then hands the live
// view back to the scheduler; the returned canvas is a copy, so the screen
// repaint cannot race the PNG encode.
export function renderExportCanvas(scale = EXPORT_SCALE): HTMLCanvasElement | null {
  const e = exportMeta(scale);
  const { doc, settings, view, drawNames, mode, selection } = useEditorStore.getState();
  // `if strand == self.canvas.selected_strand: draw_highlighted_strand(...)` —
  // the selection is highlighted in the file exactly as on screen (and, as on
  // screen, hidden by the view-mode setting).
  const highlight = restingHighlightLayer(mode, settings, selection);
  callRender(toRenderArray(doc, highlight), e.meta);
  const c = document.getElementById('c') as HTMLCanvasElement | null;
  if (!c) return null;
  const out = document.createElement('canvas');
  out.width = e.w;
  out.height = e.h;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(c, 0, 0);
  // `if self.canvas.should_draw_names: draw_strand_label(...)` for every strand,
  // last, under the same transform: the scaled world->px map of the meta (the
  // scale actually applied, should the budget above have lowered it).
  if (drawNames) {
    drawStrandLabels(ctx, doc, settings, {
      zoom: view.zoom * e.scale, panX: e.meta.x_offset, panY: e.meta.y_offset,
    });
  }
  requestRender(); // restore the live viewport render
  return out;
}

// Resolves true when a file was written, false when the user cancelled the
// dialog or the write failed (logged by writePngFile). A render or encode
// failure — no #c to paint into, a canvas the browser refused to encode —
// throws, so the caller can tell the user rather than silently saving nothing.
export async function exportPng(scale = EXPORT_SCALE): Promise<boolean> {
  // OSS: the Save dialog comes first; cancelling it paints nothing.
  const pick = await pickPngFile();
  if (pick.kind === 'cancelled') return false;
  const out = renderExportCanvas(scale);
  if (!out) throw new Error('PNG export: no canvas to render into');
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(`PNG export: the browser could not encode a ${out.width}x${out.height} canvas`);
  return writePngFile(pick, blob, 'openstrand_export.png');
}

// Dev-only debug handles for testing the export without a file dialog.
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__exportMeta = exportMeta;
  (globalThis as Record<string, unknown>).__renderExportCanvas = renderExportCanvas;
}
