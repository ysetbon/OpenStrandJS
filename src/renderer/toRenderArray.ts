// Pure adapter: live EditorDocument -> the flat (strands, meta) the renderer
// consumes. The renderer maps world->pixel as P(pt) = (pt + offset) * ss, so
// the visible CSS-space transform is exactly `screen = world + offset` (ss
// cancels between the offscreen render and the in-page downscale). We therefore
// fold pan straight into offset; zoom is pinned to 1.0 in Phase 1, so no
// renderer change is needed (full zoom is the one additive renderer edit in
// Phase 6).

import type {
  EditorDocument, RenderMeta, RenderStrand, Settings, ViewState,
} from '../model/types';

export function toRenderArray(doc: EditorDocument): RenderStrand[] {
  const out: RenderStrand[] = [];
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s) continue;
    if (s.is_hidden) continue;
    const r: RenderStrand = {
      type: s.type,
      layer_name: s.layer_name,
      start: s.start,
      end: s.end,
      width: s.width,
      stroke_width: s.stroke_width,
      color: s.color,
      stroke_color: s.stroke_color,
      has_circles: s.has_circles,
      control_points: s.control_points,
      control_point_center: s.control_point_center,
      control_point_center_locked: s.control_point_center_locked,
    };
    if (s.type === 'MaskedStrand') r.deletion_rectangles = s.deletion_rectangles ?? [];
    out.push(r);
  }
  return out;
}

export function buildMeta(doc: EditorDocument, view: ViewState, settings: Settings): RenderMeta {
  return {
    image_width: Math.max(1, Math.round(view.width)),
    image_height: Math.max(1, Math.round(view.height)),
    x_offset: view.panX,
    y_offset: view.panY,
    supersample: view.supersample,
    zoom: view.zoom,
    shadow_enabled: doc.shadow_enabled,
    curve_params: settings.curve_params,
  };
}
