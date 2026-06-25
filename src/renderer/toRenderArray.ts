// Pure adapter: live EditorDocument -> the flat (strands, meta) the renderer
// consumes. The renderer maps world->pixel as P(pt) = (pt + offset) * ss, so
// the visible CSS-space transform is exactly `screen = world + offset` (ss
// cancels between the offscreen render and the in-page downscale). We therefore
// fold pan straight into offset; zoom is pinned to 1.0 in Phase 1, so no
// renderer change is needed (full zoom is the one additive renderer edit in
// Phase 6).

import type {
  EditorDocument, RenderMeta, RenderStrand, Settings, Theme, ViewState,
} from '../model/types';

// OSS canvas background per theme. The original's canvas widget shows the PARENT
// window background (default #ECECEC, light #FFFFFF, dark #2C2C2C) behind the grid
// + strands — verified by grabbing the real app per theme (the dark canvas reads
// #2C2C2C, which can only come from the window bg showing through, since the
// canvas's own stylesheet is white in every theme due to a casing bug). So the
// canvas backdrop == the theme's --window-bg, NOT a hardcoded white.
const THEME_CANVAS_BG: Record<Theme, string> = {
  default: '#ECECEC',
  light: '#FFFFFF',
  dark: '#2C2C2C',
};

// `highlightSet` (optional) marks extra strands as selected for highlight
// purposes — used during an endpoint drag so welded/attached peers that move
// rigidly with the grabbed endpoint get the same red halo + C-shapes as the
// grabbed strand (OSS reddens both sides of a moving junction).
//
// `viewHideHighlight` (optional, default false) ports OSS view-mode
// `view_hide_highlight` (strand.py::_suppress_highlight_in_view): when true it
// zeroes every strand's is_selected so the renderer (#c drawHighlight / drawMasked,
// both gated on is_selected) paints NO selection highlight — without touching the
// actual selection. The live scheduler computes it from (mode==='view' && setting);
// the offline oracle and PNG export never pass it (default false), so their output
// stays byte-identical.
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
      bias_triangle: s.bias_triangle,
      bias_circle: s.bias_circle,
      start_line_visible: ex.start_line_visible as boolean | undefined,
      end_line_visible: ex.end_line_visible as boolean | undefined,
      closed_connections: ex.closed_connections as [boolean, boolean] | undefined,
      manual_circle_visibility: ex.manual_circle_visibility as [boolean | null, boolean | null] | undefined,
      circle_stroke_color: s.circle_stroke_color,
      start_circle_stroke_color: (ex.start_circle_stroke_color as RenderStrand['start_circle_stroke_color']) ?? s.circle_stroke_color,
      end_circle_stroke_color: (ex.end_circle_stroke_color as RenderStrand['end_circle_stroke_color']) ?? s.circle_stroke_color,
      is_setting_staring_circle: ex.is_setting_staring_circle as boolean | undefined,
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
    // Theme canvas backdrop + OSS grid. Set on the LIVE path here AND carried into
    // the PNG export, which now reuses buildMeta (exportMeta spreads it): export
    // ignores canvas_bg (transparent_bg overrides the fill) but DOES draw the grid,
    // matching OSS save_canvas_as_image. Only the offline fidelity oracle
    // (reference_render.py meta) omits both, so renderFixture falls back to a white
    // opaque backdrop with no grid and stays byte-identical. Same absent-default
    // gating as drag / fast_downscale.
    canvas_bg: THEME_CANVAS_BG[settings.theme] ?? '#FFFFFF',
    grid: settings.show_grid && settings.grid_size > 0 ? { size: settings.grid_size } : undefined,
    // Effective bias gate (third CP must also be on). LIVE EDITOR ONLY — absent in the
    // oracle/export meta, so buildProfile falls back to 0.5 (unbiased) and fixtures stay
    // byte-identical. undefined (not false) to mirror the other absent-default keys.
    curvature_bias: (settings.enable_third_control_point && settings.enable_curvature_bias_control) || undefined,
  };
}
