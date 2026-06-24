import { useEditorStore } from '../../store/editorStore';
import { t, tt } from '../i18n';
import type { Theme } from '../../model/types';
import { Row, CheckRow, NumberInput, Select, ColorSwatch, Button } from './controls';
import type { PageProps } from './types';

// General Settings page (settings_dialog.py index 0). Control order + ranges are
// transcribed verbatim from setup_ui. Every control applies live via setSettings
// (the web equivalent of OSS's apply-on-OK — the store persists + re-renders).
export function GeneralPage({ lang }: PageProps) {
  const s = useEditorStore((st) => st.settings);
  const set = useEditorStore((st) => st.setSettings);
  const cp = s.curve_params;
  const setCurve = (patch: Partial<typeof cp>) => set({ curve_params: { ...cp, ...patch } });

  return (
    <div className="set-page">
      {/* Theme */}
      <Row label={t('select_theme', lang)}>
        <Select value={s.theme} onChange={(v) => set({ theme: v as Theme })}>
          <option value="default">{t('default', lang)}</option>
          <option value="light">{t('light', lang)}</option>
          <option value="dark">{t('dark', lang)}</option>
        </Select>
      </Row>

      {/* Shadow colour */}
      <Row label={t('shadow_color', lang)}>
        <ColorSwatch value={s.shadow_color} onChange={(c) => set({ shadow_color: c })} />
      </Row>

      {/* Performance / drawing toggles */}
      <CheckRow label={t('draw_only_affected_strand', lang)} checked={s.draw_only_affected_strand}
        onChange={(v) => set({ draw_only_affected_strand: v })} />

      <CheckRow label={t('enable_third_control_point', lang)} checked={s.enable_third_control_point}
        onChange={(v) => set(v
          ? { enable_third_control_point: true }
          // Disabling the third CP force-unchecks the bias control (OSS on_third_control_changed).
          : { enable_third_control_point: false, enable_curvature_bias_control: false })} />

      <CheckRow label={t('enable_curvature_bias_control', lang)} checked={s.enable_curvature_bias_control}
        disabled={!s.enable_third_control_point}
        onChange={(v) => set({ enable_curvature_bias_control: v })} />

      <CheckRow label={t('enable_snap_to_grid', lang)} checked={s.snap_to_grid_enabled}
        onChange={(v) => set({ snap_to_grid_enabled: v })} />

      <CheckRow label={t('enable_snap_to_grid_attach', lang)} checked={s.snap_to_grid_attach_enabled}
        onChange={(v) => set({ snap_to_grid_attach_enabled: v })} />

      <CheckRow label={t('show_move_highlights', lang)} checked={s.show_move_highlights}
        onChange={(v) => set({ show_move_highlights: v })} />

      <CheckRow label={t('show_hover_highlights', lang)} checked={s.show_hover_highlights}
        onChange={(v) => set({ show_hover_highlights: v })} />

      <CheckRow label={t('skip_close_tab_warning', lang)} checked={s.skip_close_tab_warning}
        onChange={(v) => set({ skip_close_tab_warning: v })} wrap />

      <CheckRow label={t('skip_quit_warning', lang)} checked={s.skip_quit_warning}
        onChange={(v) => set({ skip_quit_warning: v })} wrap />

      {/* Shadow blur */}
      <Row label={t('shadow_blur_steps', lang)} title={tt('shadow_blur_steps', lang)}>
        <NumberInput value={s.num_steps} onChange={(v) => set({ num_steps: Math.round(v) })}
          min={1} max={100} step={1} title={tt('shadow_blur_steps', lang)} />
      </Row>
      <Row label={t('shadow_blur_radius', lang)} title={tt('shadow_blur_radius', lang)}>
        <NumberInput value={s.max_blur_radius} onChange={(v) => set({ max_blur_radius: v })}
          min={0} max={360} step={0.01} decimals={2} title={tt('shadow_blur_radius', lang)} />
      </Row>

      {/* Curvature (live in OSS too) */}
      <Row label={t('base_fraction', lang)} title={tt('base_fraction', lang)}>
        <NumberInput value={cp.base_fraction} onChange={(v) => setCurve({ base_fraction: v })}
          min={0.25} max={10} step={0.05} decimals={2} title={tt('base_fraction', lang)} />
      </Row>
      <Row label={t('distance_multiplier', lang)} title={t('distance_mult_tooltip', lang)}>
        <NumberInput value={cp.dist_multiplier} onChange={(v) => setCurve({ dist_multiplier: v })}
          min={1} max={10} step={0.1} decimals={1} title={t('distance_mult_tooltip', lang)} />
      </Row>
      <Row label={t('curve_response', lang)} title={tt('curve_response', lang)}>
        <NumberInput value={cp.exponent} onChange={(v) => setCurve({ exponent: v })}
          min={1} max={3} step={0.1} decimals={1} title={tt('curve_response', lang)} />
      </Row>

      {/* Reset curvature → OSS defaults 1.0 / 2.0 / 2.0 */}
      <Row label={t('reset_curvature_settings', lang)} title={t('reset_curvature_tooltip', lang)}>
        <Button onClick={() => set({ curve_params: { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 } })}
          title={t('reset_curvature_tooltip', lang)}>
          {t('reset', lang)}
        </Button>
      </Row>
    </div>
  );
}
