// Faithful port of settings_dialog.py export_settings_to_json /
// import_settings_from_json. The export is the exact 36-key snake_case shape the
// desktop app writes (and reads), with nested {r,g,b,a} colour objects. The three
// curvature params use the desktop's JSON names, which differ from our nested
// `curve_params` field. Import treats every key as optional.
import type { RGBA, Settings } from '../model/types';

const rgba = (c: RGBA) => ({ r: c.r, g: c.g, b: c.b, a: c.a });

function toRgba(o: unknown): RGBA | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return { r: n(r.r, 0), g: n(r.g, 0), b: n(r.b, 0), a: n(r.a, 255) };
}

// Serialize the full Settings to the desktop's JSON shape (json.dump(indent=4)).
export function settingsToJson(s: Settings): Record<string, unknown> {
  return {
    theme: s.theme,
    language: s.language,
    shadow_color: rgba(s.shadow_color),
    draw_only_affected_strand: s.draw_only_affected_strand,
    enable_third_control_point: s.enable_third_control_point,
    enable_curvature_bias_control: s.enable_curvature_bias_control,
    snap_to_grid_enabled: s.snap_to_grid_enabled,
    snap_to_grid_attach_enabled: s.snap_to_grid_attach_enabled,
    show_move_highlights: s.show_move_highlights,
    show_hover_highlights: s.show_hover_highlights,
    num_steps: s.num_steps,
    max_blur_radius: s.max_blur_radius,
    control_point_base_fraction: s.curve_params.base_fraction,
    distance_multiplier: s.curve_params.dist_multiplier,
    curve_response_exponent: s.curve_params.exponent,
    extension_length: s.extension_length,
    extension_dash_count: s.extension_dash_count,
    extension_dash_width: s.extension_dash_width,
    extension_dash_gap_length: s.extension_dash_gap_length,
    arrow_head_length: s.arrow_head_length,
    arrow_head_width: s.arrow_head_width,
    arrow_head_stroke_width: s.arrow_head_stroke_width,
    arrow_gap_length: s.arrow_gap_length,
    arrow_line_length: s.arrow_line_length,
    arrow_line_width: s.arrow_line_width,
    use_default_arrow_color: s.use_default_arrow_color,
    default_arrow_fill_color: rgba(s.default_arrow_fill_color),
    default_strand_color: rgba(s.default_strand_color),
    default_stroke_color: rgba(s.default_stroke_color),
    default_strand_width: s.default_strand_width,
    default_stroke_width: s.default_stroke_width,
    default_width_grid_units: s.default_width_grid_units,
    highlight_color: rgba(s.highlight_color),
  };
}

export function settingsToJsonString(s: Settings): string {
  return JSON.stringify(settingsToJson(s), null, 4);
}

// Parse an imported settings blob into a Settings patch. `current` supplies the
// nested curve_params baseline so a partial JSON only overrides present keys.
export function settingsFromJson(raw: unknown, current: Settings): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;

  const str = <K extends keyof Settings>(k: K, jk: string) => {
    if (typeof o[jk] === 'string') (out as Record<string, unknown>)[k as string] = o[jk];
  };
  const num = <K extends keyof Settings>(k: K, jk: string) => {
    if (typeof o[jk] === 'number' && Number.isFinite(o[jk] as number)) {
      (out as Record<string, unknown>)[k as string] = o[jk];
    }
  };
  const bool = <K extends keyof Settings>(k: K, jk: string) => {
    if (typeof o[jk] === 'boolean') (out as Record<string, unknown>)[k as string] = o[jk];
  };
  const col = <K extends keyof Settings>(k: K, jk: string) => {
    const c = toRgba(o[jk]);
    if (c) (out as Record<string, unknown>)[k as string] = c;
  };

  str('theme', 'theme');
  str('language', 'language');
  col('shadow_color', 'shadow_color');
  bool('draw_only_affected_strand', 'draw_only_affected_strand');
  bool('enable_third_control_point', 'enable_third_control_point');
  bool('enable_curvature_bias_control', 'enable_curvature_bias_control');
  bool('snap_to_grid_enabled', 'snap_to_grid_enabled');
  bool('snap_to_grid_attach_enabled', 'snap_to_grid_attach_enabled');
  bool('show_move_highlights', 'show_move_highlights');
  bool('show_hover_highlights', 'show_hover_highlights');
  num('num_steps', 'num_steps');
  num('max_blur_radius', 'max_blur_radius');

  // Nested curvature params (desktop JSON names → curve_params).
  const cp = { ...current.curve_params };
  let cpTouched = false;
  if (typeof o.control_point_base_fraction === 'number') { cp.base_fraction = o.control_point_base_fraction; cpTouched = true; }
  if (typeof o.distance_multiplier === 'number') { cp.dist_multiplier = o.distance_multiplier; cpTouched = true; }
  if (typeof o.curve_response_exponent === 'number') { cp.exponent = o.curve_response_exponent; cpTouched = true; }
  if (cpTouched) out.curve_params = cp;

  num('extension_length', 'extension_length');
  num('extension_dash_count', 'extension_dash_count');
  num('extension_dash_width', 'extension_dash_width');
  num('extension_dash_gap_length', 'extension_dash_gap_length');
  num('arrow_head_length', 'arrow_head_length');
  num('arrow_head_width', 'arrow_head_width');
  num('arrow_head_stroke_width', 'arrow_head_stroke_width');
  num('arrow_gap_length', 'arrow_gap_length');
  num('arrow_line_length', 'arrow_line_length');
  num('arrow_line_width', 'arrow_line_width');
  bool('use_default_arrow_color', 'use_default_arrow_color');
  col('default_arrow_fill_color', 'default_arrow_fill_color');
  col('default_strand_color', 'default_strand_color');
  col('default_stroke_color', 'default_stroke_color');
  num('default_strand_width', 'default_strand_width');
  num('default_stroke_width', 'default_stroke_width');
  num('default_width_grid_units', 'default_width_grid_units');
  col('highlight_color', 'highlight_color');

  // Interlock (mirrors GeneralPage + OSS settings_dialog.py:1923-1931): curvature bias
  // can never be enabled while the third control point is off. Harden a hand-edited /
  // stale blob so the effective bias gate stays consistent regardless of file contents.
  const thirdEff = out.enable_third_control_point ?? current.enable_third_control_point;
  if (!thirdEff) out.enable_curvature_bias_control = false;

  return out;
}
