// Pure adapter: live EditorDocument -> the flat (strands, meta) the renderer
// consumes. The renderer maps world->pixel as P(pt) = pt * (ss * zoom) + offset
// * ss, so the visible CSS-space transform is exactly `screen = world * zoom +
// offset` (ss cancels between the offscreen render and the in-page downscale).
// We therefore fold pan straight into offset and pass view.zoom as meta.zoom.

import type {
  EditorDocument, RenderMeta, RenderStrand, Settings, ViewState,
} from '../model/types';

// `highlightSet` (optional) marks extra strands as selected for highlight
// purposes — used during an endpoint drag so welded/attached peers that move
// rigidly with the grabbed endpoint get the same red halo + C-shapes as the
// grabbed strand (OSS reddens both sides of a moving junction).
export function toRenderArray(
  doc: EditorDocument,
  selectedLayer?: string | null,
  highlightSet?: Set<string>,
): RenderStrand[] {
  const out: RenderStrand[] = [];
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s) continue;
    // Side-line / cap flags live in the model's `extra` passthrough bag (see
    // factory.ts); the renderer reads them as top-level strand props, so surface
    // them here. Without this the renderer never draws flat-end side lines and
    // can't honor closed/unfolded cap state in the editor.
    const ex = (s.extra ?? {}) as Record<string, unknown>;
    const startStroke = (ex.start_circle_stroke_color as RenderStrand['start_circle_stroke_color']) ?? s.circle_stroke_color;
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
      // Hidden strands stay IN the array (the renderer skips their paint and
      // their shadow). Dropping them used to take their masks down with them:
      // buildMaskPath resolves a mask's components through byLayer, which is
      // built from this array, so hiding one component made the whole mask
      // vanish. OSS keeps them in canvas.strands (masked_strand.py:489 gates
      // only on the MASK's own is_hidden).
      is_hidden: s.is_hidden,
      start_line_visible: ex.start_line_visible as boolean | undefined,
      end_line_visible: ex.end_line_visible as boolean | undefined,
      closed_connections: ex.closed_connections as [boolean, boolean] | undefined,
      manual_circle_visibility: ex.manual_circle_visibility as [boolean | null, boolean | null] | undefined,
      circle_stroke_color: s.circle_stroke_color,
      start_circle_stroke_color: startStroke,
      end_circle_stroke_color: (ex.end_circle_stroke_color as RenderStrand['end_circle_stroke_color']) ?? s.circle_stroke_color,
      // OSS never serializes is_setting_staring_circle — the
      // start_circle_stroke_color setter derives it as (alpha == 0) on every
      // assignment, including load (strand.py:534-541). Derive identically here
      // so an unfolded start keeps its inner fill circle.
      is_setting_staring_circle: startStroke != null && (startStroke.a ?? 255) === 0,
      // Selected strand draws its unified highlight in the renderer (under the
      // body), exactly like OSS — so the black stroke stays on top. Welded peers
      // moving with a dragged endpoint are highlighted too (highlightSet).
      is_selected: name === selectedLayer || (!!highlightSet && highlightSet.has(name)),
      // OSS shadow_only: keep the strand in the array (so it still casts/receives
      // shadow) but flag the renderer to suppress its body paint.
      shadow_only: s.shadow_only,
      // OSS 1.109 per-layer Hide Shadow: cast nothing, still receive.
      hide_shadow: s.hide_shadow,
      // Arrow visibility + customization (1.109 §7) — all live in `extra`.
      start_arrow_visible: ex.start_arrow_visible as boolean | undefined,
      end_arrow_visible: ex.end_arrow_visible as boolean | undefined,
      full_arrow_visible: ex.full_arrow_visible as boolean | undefined,
      arrow_color: (ex.arrow_color as RenderStrand['arrow_color']) ?? null,
      arrow_transparency: ex.arrow_transparency as number | undefined,
      arrow_head_visible: ex.arrow_head_visible as boolean | undefined,
      // Curvature bias — serialized by OSS under `bias_control`, so it rides the
      // `extra` bag. The renderer only consults it when the setting is on.
      bias_control: (ex.bias_control as RenderStrand['bias_control']) ?? null,
      // Dashed extension rays (1.110 §extension). Per-strand booleans in `extra`,
      // default false on every OSS Strand.
      start_extension_visible: ex.start_extension_visible as boolean | undefined,
      end_extension_visible: ex.end_extension_visible as boolean | undefined,
      arrow_texture: ex.arrow_texture as RenderStrand['arrow_texture'],
      arrow_shaft_style: ex.arrow_shaft_style as RenderStrand['arrow_shaft_style'],
      arrow_casts_shadow: ex.arrow_casts_shadow as boolean | undefined,
    };
    if (s.type === 'MaskedStrand') r.deletion_rectangles = s.deletion_rectangles ?? [];
    out.push(r);
  }
  return out;
}

export function buildMeta(
  doc: EditorDocument,
  view: ViewState,
  settings: Settings,
  visibleShadowPaths: string[] = [],
): RenderMeta {
  return {
    image_width: Math.max(1, Math.round(view.width)),
    image_height: Math.max(1, Math.round(view.height)),
    x_offset: view.panX,
    y_offset: view.panY,
    supersample: view.supersample,
    zoom: view.zoom,
    shadow_enabled: doc.shadow_enabled,
    shadow_overrides: doc.shadow_overrides,
    // Shadow Path preview. Defaulted to [] and omitted entirely when empty, so
    // every non-editor caller — the fidelity oracle above all — passes a meta with
    // no such key and the renderer's overlay stays inert.
    ...(visibleShadowPaths.length
      ? { visible_shadow_paths: visibleShadowPaths.map((k) => k.split('|') as [string, string]) }
      : {}),
    curve_params: settings.curve_params,
    // OSS reads both of these off the canvas in _build_curve_profile. Passing them
    // per render is what makes the two General-page toggles actually change the
    // drawn curve; previously the third control point was inferred from the data
    // (so the toggle did nothing) and bias was hardcoded to 0.5.
    enable_third_control_point: settings.enable_third_control_point,
    enable_curvature_bias_control: settings.enable_curvature_bias_control,
    // Same story for the shadow trio and the highlight colour: OSS reads them off
    // the canvas at paint time. Passing them per render is what makes the General
    // page's Shadow Color / Blur Steps / Blur Radius and the Selected-Strand page's
    // highlight colour actually change what is drawn — they were previously stored,
    // round-tripped through settings JSON, and then ignored by the renderer.
    shadow_color: settings.shadow_color,
    num_steps: settings.num_steps,
    max_blur_radius: settings.max_blur_radius,
    highlight_color: settings.highlight_color,
    draw_only_affected_strand: settings.draw_only_affected_strand,
    // The six arrow-dimension settings. The renderer already merged
    // meta.arrow_params over its defaults; this is the missing half of that wire.
    arrow_params: {
      head_length: settings.arrow_head_length,
      head_width: settings.arrow_head_width,
      head_stroke_width: settings.arrow_head_stroke_width,
      gap_length: settings.arrow_gap_length,
      line_length: settings.arrow_line_length,
      line_width: settings.arrow_line_width,
    },
    // The four extension-line settings. These had no consumer at all before the
    // rays landed — Tier 3 wired every other Layer-Panel setting and left these,
    // because there was no geometry for them to drive.
    extension_params: {
      length: settings.extension_length,
      dash_count: settings.extension_dash_count,
      dash_width: settings.extension_dash_width,
      dash_gap_length: settings.extension_dash_gap_length,
    },
    use_default_arrow_color: settings.use_default_arrow_color,
    default_arrow_fill_color: settings.default_arrow_fill_color,
    // Grid is drawn IN the renderer (behind strands), not on the overlay, so it
    // composites under the bodies like OSS. The oracle builds its own meta and
    // never sets these, so fixtures stay byte-identical.
    show_grid: settings.show_grid,
    grid_size: settings.grid_size,
    // Theme-aware canvas painting (live editor only). OSS paints the canvas
    // interior #2C2C2C in the dark theme (UI_PORT_PLAN.md §2.6, canvas_bg dark);
    // light/default stay white. Left undefined off-dark so the renderer's default
    // 'white' path — shared with the fidelity oracle — is byte-for-byte unchanged.
    canvas_bg: settings.theme === 'dark' ? '#2C2C2C' : undefined,
    // OSS grid is theme-INDEPENDENT #C8C8C8 (zoom >= 0.5) / #B4B4B4 (< 0.5)
    // (UI_PORT_PLAN.md:196). The legacy faint rgba(0,0,0,0.08) vanished on the dark
    // canvas; this value reads correctly on every theme. Grid is live-editor-only
    // (the oracle never sets show_grid), so the fidelity harness is unaffected.
    grid_color: (view.zoom ?? 1) >= 0.5 ? '#C8C8C8' : '#B4B4B4',
  };
}
