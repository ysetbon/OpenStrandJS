// Pure adapter: live EditorDocument -> the flat (strands, meta) the renderer
// consumes. The renderer maps world->pixel as P(pt) = (pt + offset) * ss, so
// the visible CSS-space transform is exactly `screen = world + offset` (ss
// cancels between the offscreen render and the in-page downscale). We therefore
// fold pan straight into offset; zoom is pinned to 1.0 in Phase 1, so no
// renderer change is needed (full zoom is the one additive renderer edit in
// Phase 6).

import type {
  EditorDocument, RenderMeta, RenderStrand, RGBA, Settings, ViewState,
} from '../model/types';

// `highlightSet` (optional) marks extra strands as selected for highlight
// purposes — used during an endpoint drag so welded/attached peers that move
// rigidly with the grabbed endpoint get the same red halo + C-shapes as the
// grabbed strand (OSS reddens both sides of a moving junction).
//
// `viewHideHighlight` (optional, default false) ports OSS view-mode
// `view_hide_highlight` (strand.py::_suppress_highlight_in_view, :1970-1981):
// when true it zeroes every strand's is_selected so the renderer (#c
// drawHighlight / drawMasked, both gated on is_selected) paints NO selection
// highlight — without touching the actual selection. The live scheduler computes
// it from (mode==='view' && setting); the offline oracle and PNG export never
// pass it (default false), so their output stays byte-identical.
export function toRenderArray(
  doc: EditorDocument,
  selectedLayer?: string | null,
  highlightSet?: Set<string>,
  viewHideHighlight = false,
): RenderStrand[] {
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
    // Resolve the start-circle color the same way the renderer does (extra wins,
    // else the shared circle_stroke_color fallback) so we can derive the
    // is_setting_staring_circle flag from it below.
    const startCol = (ex.start_circle_stroke_color as RenderStrand['start_circle_stroke_color']) ?? s.circle_stroke_color;
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
      start_extension_visible: ex.start_extension_visible as boolean | undefined,
      end_extension_visible: ex.end_extension_visible as boolean | undefined,
      start_arrow_visible: ex.start_arrow_visible as boolean | undefined,
      end_arrow_visible: ex.end_arrow_visible as boolean | undefined,
      full_arrow_visible: ex.full_arrow_visible as boolean | undefined,
      arrow_color: ex.arrow_color as RGBA | null | undefined,
      arrow_transparency: ex.arrow_transparency as number | undefined,
      arrow_head_visible: ex.arrow_head_visible as boolean | undefined,
      closed_connections: ex.closed_connections as [boolean, boolean] | undefined,
      manual_circle_visibility: ex.manual_circle_visibility as [boolean | null, boolean | null] | undefined,
      circle_stroke_color: s.circle_stroke_color,
      start_circle_stroke_color: startCol,
      end_circle_stroke_color: (ex.end_circle_stroke_color as RenderStrand['end_circle_stroke_color']) ?? s.circle_stroke_color,
      // OSS never persists is_setting_staring_circle; its color setter re-derives it
      // as (start-circle alpha == 0) on every assignment and on load (strand.py:533-537).
      // Mirror that here so the renderer's unfolded-start branch fires uniformly for
      // attach-default / menu-unfold / loaded-OSS strands (a stored extra flag still wins).
      is_setting_staring_circle: (ex.is_setting_staring_circle as boolean | undefined)
        ?? ((startCol && startCol.a != null ? startCol.a : 255) === 0),
      // Junction resolution + elliptical end-cap flag (web/strand-renderer.js
      // partnerForEnd / ellipticalCapDims). attached_to & knot_connections let the
      // renderer find the connected partner; elliptical_end_caps lives in `extra`.
      attached_to: s.attached_to ?? null,
      attachment_side: s.attachment_side,
      knot_connections: s.knot_connections as RenderStrand['knot_connections'],
      elliptical_end_caps: ex.elliptical_end_caps as boolean | undefined,
      // Selected strand draws its unified highlight in the renderer (under the
      // body), exactly like OSS — so the black stroke stays on top. Welded peers
      // moving with a dragged endpoint are highlighted too (highlightSet). In View
      // mode with view_hide_highlight on, suppress the highlight entirely (selection
      // is preserved; only the painting is skipped — OSS _suppress_highlight_in_view).
      is_selected: !viewHideHighlight && (name === selectedLayer || (!!highlightSet && highlightSet.has(name))),
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
    // Live-only: draw the reference grid behind the strands (see RenderMeta). The
    // offline oracle / PNG export build their own meta and never set these, so
    // their output stays byte-identical.
    show_grid: settings.show_grid,
    grid_size: settings.grid_size,
    // Dashed-extension settings (consumed when a strand has start/end_extension_visible).
    extension_length: settings.extension_length,
    extension_dash_count: settings.extension_dash_count,
    extension_dash_width: settings.extension_dash_width,
    extension_dash_gap_length: settings.extension_dash_gap_length,
    // Arrow head/shaft settings (consumed when a strand has start/end_arrow_visible).
    arrow_head_length: settings.arrow_head_length,
    arrow_head_width: settings.arrow_head_width,
    arrow_head_stroke_width: settings.arrow_head_stroke_width,
    arrow_gap_length: settings.arrow_gap_length,
    arrow_line_length: settings.arrow_line_length,
    arrow_line_width: settings.arrow_line_width,
    use_default_arrow_color: settings.use_default_arrow_color,
    default_arrow_fill_color: settings.default_arrow_fill_color,
  };
}
