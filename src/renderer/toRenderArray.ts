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

export function toRenderArray(doc: EditorDocument, selectedLayer?: string | null): RenderStrand[] {
  const out: RenderStrand[] = [];
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s) continue;
    if (s.is_hidden) continue;
    // Side-line / cap flags live in the model's `extra` passthrough bag (see
    // factory.ts); the renderer reads them as top-level strand props, so surface
    // them here. Without this the renderer never draws flat-end side lines and
    // can't honor closed/unfolded cap state in the editor.
    const ex = (s.extra ?? {}) as Record<string, unknown>;
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
      start_line_visible: ex.start_line_visible as boolean | undefined,
      end_line_visible: ex.end_line_visible as boolean | undefined,
      closed_connections: ex.closed_connections as [boolean, boolean] | undefined,
      manual_circle_visibility: ex.manual_circle_visibility as [boolean | null, boolean | null] | undefined,
      circle_stroke_color: s.circle_stroke_color,
      start_circle_stroke_color: (ex.start_circle_stroke_color as RenderStrand['start_circle_stroke_color']) ?? s.circle_stroke_color,
      end_circle_stroke_color: (ex.end_circle_stroke_color as RenderStrand['end_circle_stroke_color']) ?? s.circle_stroke_color,
      is_setting_staring_circle: ex.is_setting_staring_circle as boolean | undefined,
      // Selected strand draws its unified highlight in the renderer (under the
      // body), exactly like OSS — so the black stroke stays on top.
      is_selected: name === selectedLayer,
      // OSS shadow_only: keep the strand in the array (so it still casts/receives
      // shadow) but flag the renderer to suppress its body paint.
      shadow_only: s.shadow_only,
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
    shadow_overrides: doc.shadow_overrides,
    curve_params: settings.curve_params,
  };
}
