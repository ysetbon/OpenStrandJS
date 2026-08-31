import { useEffect, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { t, tt } from '../i18n';
import { Button } from './controls';
import {
  listSessions, getSessionLatestDoc, getSessionActions, clearOtherSessions,
  type SessionInfo, type SessionAction,
} from './history';
import { historyLabel } from '../../store/historyMeta';
import type { PageProps } from './types';

// History page (settings_dialog.py index 7). Lists past sessions (newest first),
// loads a selected session's latest state, or clears all non-current sessions.
// Backed by IndexedDB snapshots (history.ts) — the web equivalent of OSS's
// temp_states/*.json crash-recovery files.
//
// Below the session list is the activity log: what was actually DONE, not just
// what the drawing looked like. With no session selected it shows this session's
// journal (store.historyLog — every edit, undo and redo in order); selecting a
// past session shows the provenance recorded with that session's snapshots.
const fmt = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// Journal kinds that are not plain edits get a prefix, so a log of ten steps
// still reads correctly when three of them were undos.
const KIND_PREFIX: Record<string, string> = { undo: 'Undo: ', redo: 'Redo: ', load: '', reset: '', edit: '' };

export function HistoryPage({ lang, onClose }: PageProps) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [pastActions, setPastActions] = useState<SessionAction[] | null>(null);
  // This session's journal, newest first.
  const log = useEditorStore((s) => s.historyLog);

  const refresh = () => { setSelected(null); setPastActions(null); listSessions().then(setSessions); };
  useEffect(() => { listSessions().then(setSessions); }, []);
  useEffect(() => {
    if (!selected) { setPastActions(null); return; }
    let live = true;
    getSessionActions(selected).then((a) => { if (live) setPastActions(a); });
    return () => { live = false; };
  }, [selected]);

  const rows = selected
    ? (pastActions ?? []).slice().reverse().map((a) => ({ key: `p${a.step}`, ts: a.ts, text: a.label }))
    : log.slice().reverse().map((e, i) => ({
      key: `c${log.length - i}`, ts: e.at, text: (KIND_PREFIX[e.kind] ?? '') + historyLabel(e.meta),
    }));

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

      <div>{t('history_actions', lang)}</div>
      <div className="set-history-list set-history-actions">
        {rows.length === 0 ? (
          <div className="set-history-empty">{t('no_actions_recorded', lang)}</div>
        ) : (
          rows.map((r) => (
            <div key={r.key} className="set-history-row is-static">
              <span className="set-history-time">{fmt(r.ts)}</span>
              {r.text}
            </div>
          ))
        )}
      </div>

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
