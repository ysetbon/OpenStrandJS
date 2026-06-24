import type { ReactNode } from 'react';
import { t, isRTL } from '../i18n';
import { guideIconUrl, guideSvgUrl } from './assets';
import type { PageProps } from './types';

// Faithful port of the OpenStrand Studio settings "Button Guide" page
// (settings_dialog.py: build around lines 2965-3254, rebuilt in
// refresh_button_explanations_html around 3936-4207). The Qt version assembles a
// big QTextBrowser HTML document from many translation keys; here we render the
// same structure as JSX inside `.set-html` so the dialog CSS styles the
// h2/h3/ul/table/img exactly as the other guide pages.
//
// Two OSS notes reproduced here:
//   - Each "*_desc" value has the form "Name - Description"; OSS splits on the
//     first " - " into a bold name + the remainder (see splitNameDesc).
//   - The General-Settings list has a known OSS duplication bug
//     (snap_to_grid_attach_desc appears twice in the first build); we use the
//     canonical de-duplicated 15-item list from refresh_button_explanations_html.

// Split "Name - Description" on the first " - " → bold name + rest, matching
// OSS's `desc.split(' - ', 1)` / `desc.split(' - ')[0..1]`. If there is no
// separator, the whole string is treated as the name.
function splitNameDesc(value: string): { name: string; rest: string | null } {
  const idx = value.indexOf(' - ');
  if (idx === -1) return { name: value, rest: null };
  return { name: value.slice(0, idx), rest: value.slice(idx + 3) };
}

export function ButtonGuidePage({ lang }: PageProps) {
  const rtl = isRTL(lang);

  // OSS title color: dark → '#ffffff', light → '#000000', default → '#333'.
  // The active theme is reflected as a `theme-*` class on <html> (see App.tsx);
  // we read it directly (a pure DOM read, no store access) so the section
  // headings match OSS regardless of language.
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const titleColor = root?.classList.contains('theme-dark')
    ? '#ffffff'
    : root?.classList.contains('theme-light')
      ? '#000000'
      : '#333';
  const headStyle = { color: titleColor };

  // A description row rendered as a bold name + remainder, from a "*_desc" key.
  const descLi = (key: string): ReactNode => {
    const { name, rest } = splitNameDesc(t(key, lang));
    return (
      <li key={key}>
        <span className="button-name">{name}</span>
        {rest !== null ? ` - ${rest}` : null}
      </li>
    );
  };

  // A context-menu row: bold label (one or two name keys) + a separate desc key.
  const ctxLi = (labelKeys: string[], descKey: string): ReactNode => (
    <li key={`${labelKeys.join('/')}-${descKey}`}>
      <span className="button-name">{labelKeys.map((k) => t(k, lang)).join(' / ')}</span>
      {` - ${t(descKey, lang)}`}
    </li>
  );

  // The 14 shared context-menu entries (identical for main + attached strands).
  const sharedCtx: ReactNode[] = [
    ctxLi(['hide_layer', 'show_layer'], 'ctx_hide_show_desc'),
    ctxLi(['shadow_only'], 'ctx_shadow_only_desc'),
    ctxLi(['edit_shadows'], 'ctx_edit_shadows_desc'),
    ctxLi(['change_color'], 'ctx_change_color_desc'),
    ctxLi(['change_stroke_color'], 'ctx_change_stroke_color_desc'),
    ctxLi(['change_width'], 'ctx_change_width_desc'),
    ctxLi(['change_layer_width'], 'ctx_change_layer_width_desc'),
    ctxLi(['transparent_stroke'], 'ctx_stroke_transparency_desc'),
    ctxLi(['line'], 'ctx_line_desc'),
    ctxLi(['arrow'], 'ctx_arrow_desc'),
    ctxLi(['show_full_arrow'], 'ctx_full_arrow_desc'),
    ctxLi(['close_the_knot'], 'ctx_close_knot_desc'),
    ctxLi(['transparent_closing_knot_side'], 'ctx_closing_knot_desc'),
    ctxLi(['extension'], 'ctx_dash_desc'),
    ctxLi(['circle'], 'ctx_circle_desc'),
  ];

  // Layer-panel icon (PNG) at OSS's 34x34. Pass the OSS basename.
  const icon = (file: string): ReactNode => (
    <img src={guideIconUrl(file)} width={34} height={34} alt="" />
  );

  // Layer-panel button table rows: [icon cell, *_desc key].
  const layerRows: Array<{ key: string; icons: ReactNode }> = [
    { key: 'draw_names_desc', icons: null },
    { key: 'lock_layers_desc', icons: null },
    { key: 'add_new_strand_desc', icons: null },
    { key: 'delete_strand_desc', icons: null },
    { key: 'deselect_all_desc', icons: null },
    { key: 'pan_desc', icons: (<>{icon('pan_open.png')} {icon('pan_closed.png')}</>) },
    { key: 'zoom_in_desc', icons: icon('zoom_in.png') },
    { key: 'zoom_out_desc', icons: icon('zoom_out.png') },
    { key: 'center_strands_desc', icons: icon('center.png') },
    { key: 'multi_select_desc', icons: (<>{icon('multi_select_off.png')} {icon('multi_select_on.png')}</>) },
    { key: 'refresh_desc', icons: icon('refresh.png') },
    { key: 'reset_states_desc', icons: icon('home.png') },
  ];

  // Control-point SVG table rows: [svg file, name key, desc key].
  const controlPointRows: Array<{ svg: string; size: number; nameKey: string; descKey: string }> = [
    { svg: 'triangle.svg', size: 30, nameKey: 'triangle_control_name', descKey: 'triangle_control_desc' },
    { svg: 'circle.svg', size: 30, nameKey: 'circle_control_name', descKey: 'circle_control_desc' },
    { svg: 'square.svg', size: 30, nameKey: 'square_control_name', descKey: 'square_control_desc' },
    { svg: 'bias_triangle.svg', size: 24, nameKey: 'bias_triangle_name', descKey: 'bias_triangle_desc' },
    { svg: 'bias_circle.svg', size: 24, nameKey: 'bias_circle_name', descKey: 'bias_circle_desc' },
  ];

  // Selection indicators: [glyph, glyph color, name key, desc key].
  const selectionRows: Array<{ glyph: string; color: string; nameKey: string; descKey: string }> = [
    { glyph: '●', color: '#FF0000', nameKey: 'red_circle_name', descKey: 'red_circle_desc' },
    { glyph: '●', color: '#0000FF', nameKey: 'blue_circle_name', descKey: 'blue_circle_desc' },
    { glyph: '■', color: 'rgba(255, 0, 0, 1)', nameKey: 'red_square_name', descKey: 'red_square_desc' },
    { glyph: '■', color: 'rgba(34,139,34, 1)', nameKey: 'green_square_name', descKey: 'green_square_desc' },
    { glyph: '■', color: 'rgba(255, 222, 23, 1)', nameKey: 'yellow_square_name', descKey: 'yellow_square_desc' },
  ];

  const mainWindowKeys = [
    'attach_mode_desc', 'move_mode_desc', 'rotate_mode_desc', 'toggle_grid_desc',
    'angle_adjust_desc', 'save_desc', 'load_desc', 'save_image_desc', 'select_strand_desc',
    'mask_mode_desc', 'settings_desc', 'toggle_control_points_desc', 'toggle_shadow_desc',
  ];

  const groupKeys = [
    'create_group_desc', 'group_header_desc', 'select_group_desc', 'move_group_desc',
    'rotate_group_desc', 'edit_strand_angles_desc', 'duplicate_group_desc',
    'rename_group_desc', 'delete_group_desc',
  ];

  const shortcutKeys = [
    'shortcut_space_desc', 'shortcut_escape_desc', 'shortcut_undo_desc', 'shortcut_redo_desc',
    'shortcut_new_strand_desc', 'shortcut_draw_names_desc', 'shortcut_lock_layers_desc',
    'shortcut_delete_strand_desc', 'shortcut_deselect_all_desc', 'shortcut_clear_suppression_desc',
  ];

  // Canonical de-duplicated 15-item General-Settings list (the OSS first build
  // duplicates snap_to_grid_attach_desc; refresh_button_explanations_html omits
  // the duplicate, giving 15 distinct rows).
  const generalSettingsKeys = [
    'theme_select_desc', 'shadow_color_desc', 'draw_only_affected_desc', 'enable_third_cp_desc',
    'enable_curvature_bias_desc', 'enable_snap_desc', 'snap_to_grid_attach_desc',
    'show_move_highlights_desc', 'folded_start_edge_desc', 'shadow_blur_steps_desc',
    'shadow_blur_radius_desc', 'control_point_influence_desc', 'distance_boost_desc',
    'curvature_type_desc', 'reset_curvature_desc',
  ];

  return (
    <div className="set-page">
      <div className="set-page-header">{t('button_guide_info', lang)}</div>

      <div className="set-html" dir={rtl ? 'rtl' : 'ltr'}>
        {/* Layer Panel buttons */}
        <h2 style={headStyle}>{t('layer_panel_buttons', lang)}</h2>
        <table>
          <tbody>
            {layerRows.map(({ key, icons }) => {
              const { name, rest } = splitNameDesc(t(key, lang));
              return (
                <tr key={key}>
                  <td style={{ width: 90, textAlign: 'center', verticalAlign: 'middle' }}>{icons}</td>
                  <td>
                    <span className="button-name">{name}</span>
                    {rest !== null ? <> {'—'} {rest}</> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Layer context menu */}
        <h2 style={headStyle}>{t('layer_context_menu_title', lang)}</h2>
        <p>{t('layer_context_menu_info', lang)}</p>

        <h3 style={headStyle}>{t('main_strand_menu_title', lang)}</h3>
        <ul>{sharedCtx}</ul>

        <h3 style={headStyle}>{t('attached_strand_menu_title', lang)}</h3>
        <ul>{sharedCtx}</ul>

        <h3 style={headStyle}>{t('mask_strand_menu_title', lang)}</h3>
        <ul>
          {ctxLi(['hide_layer', 'show_layer'], 'ctx_hide_show_desc')}
          {ctxLi(['shadow_only'], 'ctx_shadow_only_desc')}
          {ctxLi(['edit_shadows'], 'ctx_edit_shadows_desc')}
          {ctxLi(['edit_mask'], 'ctx_edit_mask_desc')}
          {ctxLi(['reset_mask'], 'ctx_reset_mask_desc')}
        </ul>

        {/* Main window buttons */}
        <h2 style={headStyle}>{t('main_window_buttons', lang)}</h2>
        <ul>{mainWindowKeys.map(descLi)}</ul>

        {/* Group buttons */}
        <h2 style={headStyle}>{t('group_buttons', lang)}</h2>
        <ul>{groupKeys.map(descLi)}</ul>

        {/* Canvas indicators */}
        <h2 style={headStyle}>{t('canvas_indicators_title', lang)}</h2>

        <h3 style={headStyle}>{t('control_points_title', lang)}</h3>
        <table>
          <tbody>
            {controlPointRows.map(({ svg, size, nameKey, descKey }) => (
              <tr key={svg}>
                <td style={{ verticalAlign: 'middle', textAlign: 'center' }}>
                  <img src={guideSvgUrl(svg)} width={size} height={size} alt="" />
                </td>
                <td>
                  <span className="button-name">{t(nameKey, lang)}</span>
                  <br />
                  {t(descKey, lang)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={headStyle}>{t('selection_indicators_title', lang)}</h3>
        <ul>
          {selectionRows.map(({ glyph, color, nameKey, descKey }) => (
            <li key={nameKey} style={{ marginBottom: 12 }}>
              <span style={{ color, fontSize: 18, fontWeight: 'bold' }}>{glyph}</span>{' '}
              <span className="button-name">{t(nameKey, lang)}</span>
              {` - ${t(descKey, lang)}`}
            </li>
          ))}
        </ul>

        {/* Global shortcuts */}
        <h2 style={headStyle}>{t('global_shortcuts_title', lang)}</h2>
        <ul>{shortcutKeys.map(descLi)}</ul>

        {/* General settings buttons */}
        <h2 style={headStyle}>{t('general_settings_buttons', lang)}</h2>
        <ul>{generalSettingsKeys.map(descLi)}</ul>
      </div>
    </div>
  );
}
