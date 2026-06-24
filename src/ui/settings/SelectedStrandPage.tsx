import { useEditorStore } from '../../store/editorStore';
import { t } from '../i18n';
import { Row, CheckRow, ColorSwatch } from './controls';
import type { PageProps } from './types';

// Selected Strand settings page (settings_dialog.py index 2). OSS forces this page
// LTR; only label alignment flips in RTL. Four word-wrapped toggles + a highlight
// colour swatch. Live-apply via setSettings.
export function SelectedStrandPage({ lang }: PageProps) {
  const s = useEditorStore((st) => st.settings);
  const set = useEditorStore((st) => st.setSettings);

  return (
    <div className="set-page ltr-forced">
      <CheckRow label={t('move_selected_only', lang)} checked={s.move_selected_only}
        onChange={(v) => set({ move_selected_only: v })} wrap />
      <CheckRow label={t('show_cp_selected_only', lang)} checked={s.show_cp_selected_only}
        onChange={(v) => set({ show_cp_selected_only: v })} wrap />
      <CheckRow label={t('shadow_selected_only', lang)} checked={s.shadow_selected_only}
        onChange={(v) => set({ shadow_selected_only: v })} wrap />
      <CheckRow label={t('view_hide_highlight', lang)} checked={s.view_hide_highlight}
        onChange={(v) => set({ view_hide_highlight: v })} wrap />

      <Row label={t('highlight_color', lang)}>
        <ColorSwatch value={s.highlight_color} onChange={(c) => set({ highlight_color: c })} />
      </Row>
    </div>
  );
}
