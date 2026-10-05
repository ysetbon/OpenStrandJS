import { useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { loadProjectFile } from '../../io/saveLoad';
import { t } from '../i18n';
import { SAMPLES, sampleUrl } from './assets';
import type { PageProps } from './types';

// Samples page (settings_dialog.py index 9). A centered header + subtitle and a
// two-per-row grid of the 18 sample-project buttons (QGridLayout index//2, index%2,
// reading across rows; the page scrolls inside the dialog). Clicking one loads the bundled
// project JSON into the active canvas (existing loadProject → loadDocument
// pipeline) and closes the settings dialog (OSS closes then loads next tick).
export function SamplesPage({ lang, onClose }: PageProps) {
  const [error, setError] = useState<string | null>(null);

  const open = async (file: string) => {
    try {
      const res = await fetch(sampleUrl(file));
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      // OSS load_project on the bundled sample: a history file, so the whole
      // undo/redo stack comes along (import_history).
      const st = useEditorStore.getState();
      st.loadDocumentWithHistory(loadProjectFile(json, {
        enable_curvature_bias_control: st.settings.enable_curvature_bias_control,
        curve_params: st.settings.curve_params,
      }));
      onClose();
    } catch {
      setError(file);
    }
  };

  return (
    <div className="set-page" style={{ width: '100%' }}>
      <div className="set-page-header">{t('samples_header', lang)}</div>
      <div className="set-page-sub">{t('samples_sub', lang)}</div>
      <div className="set-samples-grid">
        {SAMPLES.map((s) => (
          <button key={s.file} type="button" className="set-btn" onClick={() => open(s.file)}>
            {t(s.key, lang)}
          </button>
        ))}
      </div>
      {error && <div style={{ color: 'var(--danger)' }}>{t('load_settings_error', lang)}: {error}</div>}
    </div>
  );
}
