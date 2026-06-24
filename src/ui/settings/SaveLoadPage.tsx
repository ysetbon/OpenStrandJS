import { useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { t } from '../i18n';
import { settingsToJsonString, settingsFromJson } from '../../io/settingsJson';
import { Button } from './controls';
import type { PageProps } from './types';

// Save/Load Settings page (settings_dialog.py index 4). Save = export the 36-key
// JSON via a Blob download; Load = import a JSON file and hydrate every control
// (live-applies through setSettings). Faithful web equivalents of QFileDialog.
export function SaveLoadPage({ lang }: PageProps) {
  const set = useEditorStore((st) => st.setSettings);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const save = () => {
    try {
      const json = settingsToJsonString(useEditorStore.getState().settings);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'openstrand_settings.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus({ ok: true, msg: t('save_settings_success', lang) });
    } catch {
      setStatus({ ok: false, msg: t('load_settings_error', lang) });
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const patch = settingsFromJson(raw, useEditorStore.getState().settings);
      set(patch);
      setStatus({ ok: true, msg: t('load_settings_success', lang) });
    } catch {
      setStatus({ ok: false, msg: t('load_settings_error', lang) });
    }
  };

  return (
    <div className="set-page" style={{ alignItems: 'center', gap: 16, paddingTop: 24 }}>
      <div className="set-inline">
        <Button onClick={save} wide>{t('save_settings_button', lang)}</Button>
        <Button onClick={() => fileRef.current?.click()} wide>{t('load_settings_button', lang)}</Button>
      </div>
      <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onFile} />
      {status && (
        <div style={{ color: status.ok ? 'var(--set-check-on)' : 'var(--danger)' }}>{status.msg}</div>
      )}
    </div>
  );
}
