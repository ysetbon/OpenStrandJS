// Faithful port of OpenStrand Studio's user_settings.txt flat format
// (settings_dialog.py save_settings_to_file:5130-5184 / load_settings_from_file).
//
// This is the SUPERSET interop file the desktop app reads/writes at
// %APPDATA%/OpenStrandStudio/user_settings.txt — the file users hand-carry between
// the Python app and this web app. It is a strict superset of the 36-key JSON
// (settingsJson.ts): it also carries TabEdgePosition + the 10 extra modeled keys
// (move/cp/shadow-selected-only, view-hide toggles, transparent-start-circle, skip
// warnings, arrow_head_stroke_width). JS-only keys (grid_size, show_grid) have NO
// .txt equivalent and are intentionally omitted — OSS would ignore them anyway.
//
// Format: one "Key: value" per line, '\n' endings, trailing newline. Booleans are
// lowercase true/false; colours are CSV "r,g,b,a"; floats use the desktop's exact
// per-key precision so a JS export of DEFAULT_SETTINGS is byte-identical to the
// desktop's default file. The reader uses parseFloat/Int and ignores unknown lines,
// so hand-edited / older files merge cleanly over `current`.
import type { RGBA, Settings } from '../model/types';

// ---- encoders (match the Python f-string formatting per key) ----
const b = (v: boolean) => (v ? 'true' : 'false');
const rgba = (c: RGBA) => `${c.r},${c.g},${c.b},${c.a}`;
const f1 = (v: number) => Number(v).toFixed(1);   // :.1f
const f2 = (v: number) => Number(v).toFixed(2);   // :.2f
// Python str(float): integer-valued floats render with a trailing ".0" (the desktop
// stores extension_length / arrow_head_length / arrow_head_width as floats, so the
// real file shows "100.0" / "20.0" / "10.0", not "100" / "20" / "10").
const pyf = (v: number) => (Number.isInteger(v) ? Number(v).toFixed(1) : String(v));
const i = (v: number) => String(Math.trunc(v));   // plain int

// JS tab-edge anchor ('bottom_center') <-> OSS TabEdgePosition ('bottom-center').
const anchorToOss = (a: string) => a.replace(/_/g, '-');
const anchorFromOss = (a: string) => a.trim().replace(/-/g, '_');

// Serialize the full Settings to the desktop user_settings.txt string. When
// `tabEdgeAnchor` is given (JS underscore form) it is emitted first, mirroring how
// OSS preserves the MainWindow-owned TabEdgePosition at the top of the file.
export function settingsToUserSettingsTxt(s: Settings, tabEdgeAnchor?: string): string {
  const L: string[] = [];
  if (tabEdgeAnchor) L.push(`TabEdgePosition: ${anchorToOss(tabEdgeAnchor)}`);
  L.push(`Theme: ${s.theme}`);
  L.push(`Language: ${s.language}`);
  L.push(`ShadowColor: ${rgba(s.shadow_color)}`);
  L.push(`DrawOnlyAffectedStrand: ${b(s.draw_only_affected_strand)}`);
  L.push(`EnableThirdControlPoint: ${b(s.enable_third_control_point)}`);
  L.push(`EnableCurvatureBiasControl: ${b(s.enable_curvature_bias_control)}`);
  L.push(`EnableSnapToGrid: ${b(s.snap_to_grid_enabled)}`);
  L.push(`EnableSnapToGridAttach: ${b(s.snap_to_grid_attach_enabled)}`);
  L.push(`ShowMoveHighlights: ${b(s.show_move_highlights)}`);
  L.push(`ShowHoverHighlights: ${b(s.show_hover_highlights)}`);
  L.push(`MoveSelectedOnly: ${b(s.move_selected_only)}`);
  L.push(`ShowCPSelectedOnly: ${b(s.show_cp_selected_only)}`);
  L.push(`ShadowSelectedOnly: ${b(s.shadow_selected_only)}`);
  L.push(`ViewHideHighlight: ${b(s.view_hide_highlight)}`);
  L.push(`ViewHideControlPoints: ${b(s.view_hide_control_points)}`);
  L.push(`DefaultTransparentStartCircle: ${b(s.default_transparent_start_circle)}`);
  L.push(`SkipCloseTabWarning: ${b(s.skip_close_tab_warning)}`);
  L.push(`SkipQuitWarning: ${b(s.skip_quit_warning)}`);
  L.push(`HighlightColor: ${rgba(s.highlight_color)}`);
  L.push(`NumSteps: ${i(s.num_steps)}`);
  L.push(`MaxBlurRadius: ${f1(s.max_blur_radius)}`);
  L.push(`ControlPointBaseFraction: ${f2(s.curve_params.base_fraction)}`);
  L.push(`DistanceMultiplier: ${f1(s.curve_params.dist_multiplier)}`);
  L.push(`CurveResponseExponent: ${f1(s.curve_params.exponent)}`);
  L.push(`ExtensionLength: ${pyf(s.extension_length)}`);
  L.push(`ExtensionDashCount: ${i(s.extension_dash_count)}`);
  L.push(`ExtensionDashWidth: ${f1(s.extension_dash_width)}`);
  L.push(`ExtensionDashGapLength: ${f1(s.extension_dash_gap_length)}`);
  // OSS writes ExtensionLineWidth == extension_dash_width (legacy duplicate).
  L.push(`ExtensionLineWidth: ${f1(s.extension_dash_width)}`);
  L.push(`ArrowHeadLength: ${pyf(s.arrow_head_length)}`);
  L.push(`ArrowHeadWidth: ${pyf(s.arrow_head_width)}`);
  L.push(`ArrowHeadStrokeWidth: ${i(s.arrow_head_stroke_width)}`);
  L.push(`ArrowGapLength: ${f1(s.arrow_gap_length)}`);
  L.push(`ArrowLineLength: ${f1(s.arrow_line_length)}`);
  L.push(`ArrowLineWidth: ${f1(s.arrow_line_width)}`);
  L.push(`UseDefaultArrowColor: ${b(s.use_default_arrow_color)}`);
  L.push(`DefaultArrowColor: ${rgba(s.default_arrow_fill_color)}`);
  L.push(`DefaultStrandColor: ${rgba(s.default_strand_color)}`);
  L.push(`DefaultStrokeColor: ${rgba(s.default_stroke_color)}`);
  L.push(`DefaultStrandWidth: ${i(s.default_strand_width)}`);
  L.push(`DefaultStrokeWidth: ${i(s.default_stroke_width)}`);
  L.push(`DefaultWidthGridUnits: ${i(s.default_width_grid_units)}`);
  return L.join('\n') + '\n';
}

// ---- decoders ----
function parseColor(val: string): RGBA | null {
  const p = val.split(',').map((x) => parseInt(x.trim(), 10));
  if (p.length < 3 || p.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  return { r: clamp(p[0]), g: clamp(p[1]), b: clamp(p[2]), a: p.length >= 4 && !Number.isNaN(p[3]) ? clamp(p[3]) : 255 };
}

// Parse a user_settings.txt string into a Settings patch. `current` supplies the
// nested curve_params baseline so a partial file only overrides keys it contains.
// Unknown keys (incl. TabEdgePosition — see parseTabEdgeAnchor) are ignored.
export function settingsFromUserSettingsTxt(text: string, current: Settings): Partial<Settings> {
  const out: Partial<Settings> = {};
  const set = (k: keyof Settings, v: unknown) => { (out as Record<string, unknown>)[k as string] = v; };
  const cp = { ...current.curve_params };
  let cpTouched = false;

  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    const bool = () => val.toLowerCase() === 'true';
    const num = () => parseFloat(val);
    const int = () => parseInt(val, 10);
    const col = () => parseColor(val);

    switch (key) {
      case 'Theme': set('theme', val); break;
      case 'Language': set('language', val); break;
      case 'ShadowColor': { const c = col(); if (c) set('shadow_color', c); break; }
      case 'DrawOnlyAffectedStrand': set('draw_only_affected_strand', bool()); break;
      case 'EnableThirdControlPoint': set('enable_third_control_point', bool()); break;
      case 'EnableCurvatureBiasControl': set('enable_curvature_bias_control', bool()); break;
      case 'EnableSnapToGrid': set('snap_to_grid_enabled', bool()); break;
      case 'EnableSnapToGridAttach': set('snap_to_grid_attach_enabled', bool()); break;
      case 'ShowMoveHighlights': set('show_move_highlights', bool()); break;
      case 'ShowHoverHighlights': set('show_hover_highlights', bool()); break;
      case 'MoveSelectedOnly': set('move_selected_only', bool()); break;
      case 'ShowCPSelectedOnly': set('show_cp_selected_only', bool()); break;
      case 'ShadowSelectedOnly': set('shadow_selected_only', bool()); break;
      case 'ViewHideHighlight': set('view_hide_highlight', bool()); break;
      case 'ViewHideControlPoints': set('view_hide_control_points', bool()); break;
      case 'DefaultTransparentStartCircle': set('default_transparent_start_circle', bool()); break;
      case 'SkipCloseTabWarning': set('skip_close_tab_warning', bool()); break;
      case 'SkipQuitWarning': set('skip_quit_warning', bool()); break;
      case 'HighlightColor': { const c = col(); if (c) set('highlight_color', c); break; }
      case 'NumSteps': if (Number.isFinite(int())) set('num_steps', int()); break;
      case 'MaxBlurRadius': if (Number.isFinite(num())) set('max_blur_radius', num()); break;
      case 'ControlPointBaseFraction': if (Number.isFinite(num())) { cp.base_fraction = num(); cpTouched = true; } break;
      case 'DistanceMultiplier': if (Number.isFinite(num())) { cp.dist_multiplier = num(); cpTouched = true; } break;
      case 'CurveResponseExponent': if (Number.isFinite(num())) { cp.exponent = num(); cpTouched = true; } break;
      case 'ExtensionLength': if (Number.isFinite(num())) set('extension_length', num()); break;
      case 'ExtensionDashCount': if (Number.isFinite(int())) set('extension_dash_count', int()); break;
      // ExtensionDashWidth and the legacy ExtensionLineWidth alias both map here (OSS
      // writes them equal; last line wins, which is fine since they're identical).
      case 'ExtensionDashWidth':
      case 'ExtensionLineWidth': if (Number.isFinite(num())) set('extension_dash_width', num()); break;
      case 'ExtensionDashGapLength': if (Number.isFinite(num())) set('extension_dash_gap_length', num()); break;
      case 'ArrowHeadLength': if (Number.isFinite(num())) set('arrow_head_length', num()); break;
      case 'ArrowHeadWidth': if (Number.isFinite(num())) set('arrow_head_width', num()); break;
      case 'ArrowHeadStrokeWidth': if (Number.isFinite(int())) set('arrow_head_stroke_width', int()); break;
      case 'ArrowGapLength': if (Number.isFinite(num())) set('arrow_gap_length', num()); break;
      case 'ArrowLineLength': if (Number.isFinite(num())) set('arrow_line_length', num()); break;
      case 'ArrowLineWidth': if (Number.isFinite(num())) set('arrow_line_width', num()); break;
      case 'UseDefaultArrowColor': set('use_default_arrow_color', bool()); break;
      case 'DefaultArrowColor': { const c = col(); if (c) set('default_arrow_fill_color', c); break; }
      case 'DefaultStrandColor': { const c = col(); if (c) set('default_strand_color', c); break; }
      case 'DefaultStrokeColor': { const c = col(); if (c) set('default_stroke_color', c); break; }
      case 'DefaultStrandWidth': if (Number.isFinite(int())) set('default_strand_width', int()); break;
      case 'DefaultStrokeWidth': if (Number.isFinite(int())) set('default_stroke_width', int()); break;
      case 'DefaultWidthGridUnits': if (Number.isFinite(int())) set('default_width_grid_units', int()); break;
      default: break; // unknown / TabEdgePosition / JS-only — ignore
    }
  }
  if (cpTouched) out.curve_params = cp;

  // Interlock (mirrors settingsJson.ts + OSS settings_dialog.py:1923-1931): curvature
  // bias can never be enabled while the third control point is off. Harden a
  // hand-edited / stale file so the effective gate stays consistent.
  const thirdEff = out.enable_third_control_point ?? current.enable_third_control_point;
  if (!thirdEff) out.enable_curvature_bias_control = false;

  return out;
}

// Pull the TabEdgePosition (if any) from a user_settings.txt string, in the JS
// underscore anchor form ('bottom-center' -> 'bottom_center'). null when absent.
export function parseTabEdgeAnchor(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() === 'TabEdgePosition') return anchorFromOss(line.slice(idx + 1));
  }
  return null;
}
