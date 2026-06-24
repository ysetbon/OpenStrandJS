import { useEffect, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { t, tt } from '../i18n';
import { Button } from './controls';
import { listSessions, getSessionLatestDoc, clearOtherSessions, type SessionInfo } from './history';
import type { PageProps } from './types';

// History page (settings_dialog.py index 7). Lists past sessions (newest first),
// loads a selected session's latest state, or clears all non-current sessions.
// Backed by IndexedDB snapshots (history.ts) — the web equivalent of OSS's
// temp_states/*.json crash-recovery files.
const fmt = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function HistoryPage({ lang, onClose }: PageProps) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const refresh = () => { setSelected(null); listSessions().then(setSessions); };
  useEffect(() => { listSessions().then(setSessions); }, []);

  const loadSelected = async () => {
    if (!selected) return;
    const doc = await getSessionLatestDoc(selected);
    if (!doc) { setError(true); return; }
    useEditorStore.getState().loadDocument(doc);
    onClose();
  };

  return (
    <div className="set-page" style={{ minWidth: 380 }}>
      <div style={{ whiteSpace: 'pre-line' }}>{t('history_explanation', lang)}</div>

      <div className="set-history-list" title={tt('history_list', lang)}>
        {sessions == null ? (
          <div className="set-history-empty">…</div>
        ) : sessions.length === 0 ? (
          <div className="set-history-empty">{t('no_history_found', lang)}</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.sessionId}
              className={'set-history-row' + (s.sessionId === selected ? ' active' : '')}
              onClick={() => { setSelected(s.sessionId); setError(false); }}
            >
              {`${fmt(s.ts)} (${t('history_state_label', lang)} ${s.steps})`}
            </div>
          ))
        )}
      </div>

      {error && <div style={{ color: 'var(--danger)' }}>{t('history_load_error_text', lang)}</div>}

      <div className="set-inline">
        <Button onClick={loadSelected} disabled={!selected}>
          {t('load_selected_history', lang)}
        </Button>
        <Button onClick={async () => { await clearOtherSessions(); refresh(); }}>
          {t('clear_all_history', lang)}
        </Button>
      </div>
    </div>
  );
}
