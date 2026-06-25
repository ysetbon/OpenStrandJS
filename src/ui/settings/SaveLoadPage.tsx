import { useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { t } from '../i18n';
import { settingsToJsonString, settingsFromJson } from '../../io/settingsJson';
import { settingsToUserSettingsTxt, settingsFromUserSettingsTxt, parseTabEdgeAnchor } from '../../io/userSettingsTxt';
import { saveText } from '../../io/fileDialog';
import { Button } from './controls';
import type { PageProps } from './types';

// Save/Load Settings page (settings_dialog.py index 4). Two export/import pairs:
//  - JSON  (the 36-key cross-app interchange shape, settingsJson.ts)
//  - .txt  (the desktop user_settings.txt flat format, a superset incl. TabEdgePosition
//           + the extra modeled keys — the file users hand-carry to/from the Python app)
// Both live-apply through setSettings. Faithful web equivalents of QFileDialog.
export function SaveLoadPage({ lang }: PageProps) {
  const set = useEditorStore((st) => st.setSettings);
  const jsonRef = useRef<HTMLInputElement | null>(null);
  const txtRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const saveJson = () => {
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

  const onJsonFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
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

  const saveTxt = async () => {
    try {
      const st = useEditorStore.getState();
      const text = settingsToUserSettingsTxt(st.settings, st.tabEdgePosition?.anchor);
      const ok = await saveText('user_settings.txt', text, 'text/plain', {
        description: 'OpenStrand user settings', accept: { 'text/plain': ['.txt'] },
      });
      // ok === false means the user cancelled the native picker — stay silent.
      setStatus(ok ? { ok: true, msg: t('save_settings_success', lang) } : null);
    } catch {
      setStatus({ ok: false, msg: t('load_settings_error', lang) });
    }
  };

  const onTxtFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const st = useEditorStore.getState();
      set(settingsFromUserSettingsTxt(text, st.settings));
      const anchor = parseTabEdgeAnchor(text);
      if (anchor) st.setTabEdgePosition({ anchor });
      setStatus({ ok: true, msg: t('load_settings_success', lang) });
    } catch {
      setStatus({ ok: false, msg: t('load_settings_error', lang) });
    }
  };

  return (
    <div className="set-page" style={{ alignItems: 'center', gap: 16, paddingTop: 24 }}>
      <div className="set-inline">
        <Button onClick={saveJson} wide>{t('save_settings_button', lang)}</Button>
        <Button onClick={() => jsonRef.current?.click()} wide>{t('load_settings_button', lang)}</Button>
      </div>
      <div className="set-inline">
        <Button onClick={saveTxt} wide>{t('save_settings_txt_button', lang)}</Button>
        <Button onClick={() => txtRef.current?.click()} wide>{t('load_settings_txt_button', lang)}</Button>
      </div>
      <input ref={jsonRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onJsonFile} />
      <input ref={txtRef} type="file" accept=".txt,text/plain" style={{ display: 'none' }} onChange={onTxtFile} />
      {status && (
        <div style={{ color: status.ok ? 'var(--set-check-on)' : 'var(--danger)' }}>{status.msg}</div>
      )}
    </div>
  );
}
