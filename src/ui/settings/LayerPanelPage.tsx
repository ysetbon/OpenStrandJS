import { useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { t, tt } from '../i18n';
import { Row, CheckRow, NumberInput, ColorSwatch, Button } from './controls';
import { DefaultWidthDialog } from './DefaultWidthDialog';
import type { PageProps } from './types';

// Layer Panel settings page (settings_dialog.py index 1): extension-line + arrow
// parameters, the default colours, the default-width sub-dialog launcher, and two
// view toggles. Ranges transcribed from setup_ui. Live-apply via setSettings.
export function LayerPanelPage({ lang }: PageProps) {
  const s = useEditorStore((st) => st.settings);
  const set = useEditorStore((st) => st.setSettings);
  const [widthOpen, setWidthOpen] = useState(false);

  const numRow = (
    key: string, field: 'extension_length' | 'extension_dash_count' | 'extension_dash_width' |
      'extension_dash_gap_length' | 'arrow_head_length' | 'arrow_head_width' | 'arrow_head_stroke_width' |
      'arrow_gap_length' | 'arrow_line_length' | 'arrow_line_width',
    min: number, max: number, opts?: { int?: boolean; decimals?: number },
  ) => (
    <Row label={t(key, lang)} title={tt(key, lang)}>
      <NumberInput
        value={s[field]}
        onChange={(v) => set({ [field]: opts?.int ? Math.round(v) : v } as Record<string, number>)}
        min={min}
        max={max}
        step={opts?.int ? 1 : undefined}
        decimals={opts?.int ? undefined : (opts?.decimals ?? 2)}
        title={tt(key, lang)}
      />
    </Row>
  );

  return (
    <div className="set-page">
      {/* Extension line settings */}
      {numRow('extension_length', 'extension_length', 0, 1000)}
      {numRow('extension_dash_count', 'extension_dash_count', 1, 100, { int: true })}
      {numRow('extension_dash_width', 'extension_dash_width', 0.1, 20)}
      {numRow('extension_dash_gap_length', 'extension_dash_gap_length', 0, 1000)}

      {/* Arrow head + shaft settings */}
      {numRow('arrow_head_length', 'arrow_head_length', 0, 500)}
      {numRow('arrow_head_width', 'arrow_head_width', 0, 500)}
      {numRow('arrow_head_stroke_width', 'arrow_head_stroke_width', 1, 30, { int: true })}
      {numRow('arrow_gap_length', 'arrow_gap_length', 0, 1000)}
      {numRow('arrow_line_length', 'arrow_line_length', 0, 1000)}
      {numRow('arrow_line_width', 'arrow_line_width', 0.1, 100)}

      {/* Use default arrow colour (live) + the arrow fill swatch */}
      <CheckRow label={t('use_default_arrow_color', lang)} checked={s.use_default_arrow_color}
        onChange={(v) => set({ use_default_arrow_color: v })} wrap />
      <Row label={t('button_color', lang)}>
        <ColorSwatch value={s.default_arrow_fill_color} onChange={(c) => set({ default_arrow_fill_color: c })} />
      </Row>

      {/* Default strand / stroke colours (used for new strands) */}
      <Row label={t('default_strand_color', lang)}>
        <ColorSwatch value={s.default_strand_color} onChange={(c) => set({ default_strand_color: c })} />
      </Row>
      <Row label={t('default_stroke_color', lang)}>
        <ColorSwatch value={s.default_stroke_color} onChange={(c) => set({ default_stroke_color: c })} />
      </Row>

      {/* Default strand width → sub-dialog (centered button) */}
      <div className="set-btn-col">
        <Button onClick={() => setWidthOpen(true)} title={tt('default_strand_width', lang)} wide>
          {t('default_strand_width', lang)}
        </Button>
      </div>

      {/* View toggles */}
      <CheckRow label={t('view_hide_control_points', lang)} checked={s.view_hide_control_points}
        onChange={(v) => set({ view_hide_control_points: v })} wrap />
      <CheckRow label={t('default_transparent_start_circle', lang)} checked={s.default_transparent_start_circle}
        onChange={(v) => set({ default_transparent_start_circle: v })} wrap />

      {widthOpen && <DefaultWidthDialog lang={lang} onClose={() => setWidthOpen(false)} />}
    </div>
  );
}
