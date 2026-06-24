import { useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { loadProject } from '../../io/saveLoad';
import { t } from '../i18n';
import { SAMPLES, sampleUrl } from './assets';
import type { PageProps } from './types';

// Samples page (settings_dialog.py index 9). A centered header + subtitle and a
// vertical column of 5 sample-project buttons. Clicking one loads the bundled
// project JSON into the active canvas (existing loadProject → loadDocument
// pipeline) and closes the settings dialog (OSS closes then loads next tick).
export function SamplesPage({ lang, onClose }: PageProps) {
  const [error, setError] = useState<string | null>(null);

  const open = async (file: string) => {
    try {
      const res = await fetch(sampleUrl(file));
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      const doc = loadProject(json);
      useEditorStore.getState().loadDocument(doc);
      onClose();
    } catch {
      setError(file);
    }
  };

  return (
    <div className="set-page" style={{ alignItems: 'center' }}>
      <div className="set-page-header">{t('samples_header', lang)}</div>
      <div className="set-page-sub">{t('samples_sub', lang)}</div>
      <div className="set-btn-col">
        {SAMPLES.map((s) => (
          <button key={s.file} type="button" className="set-btn" style={{ minHeight: 40 }} onClick={() => open(s.file)}>
            {t(s.key, lang)}
          </button>
        ))}
      </div>
      {error && <div style={{ color: 'var(--danger)' }}>{t('load_settings_error', lang)}: {error}</div>}
    </div>
  );
}
