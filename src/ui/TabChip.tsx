import React, { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { t } from './i18n';
import { Modal } from './Modal';
import { serializeProject } from '../io/saveLoad';
import { downloadJSON } from '../io/fileDialog';

// A single tab chip inside the floating TabEdge. Height 40, radius 9.
// Contents (LTR): [dirty dot if tab.dirty][title 9pt, bold when active][duplicate
// icon][close X]. The whole edge is flipped via dir="rtl" for Hebrew, which
// mirrors this row automatically (icons left, title+dot right) — matching OSS.
// Closing a dirty tab opens an unsaved-changes confirm (Save / Discard / Cancel),
// unless the "don't ask" setting is on, in which case it discards silently.
export function TabChip(props: {
  id: number;
  name: string;
  active: boolean;
  dirty?: boolean;
  untitledIndex?: number;
}): JSX.Element {
  const { id, name, active, dirty, untitledIndex } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const skipCloseWarning = useEditorStore((s) => s.settings.skip_close_tab_warning);
  const switchTab = useEditorStore((s) => s.switchTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const duplicateTab = useEditorStore((s) => s.duplicateTab);
  const markTabSaved = useEditorStore((s) => s.markTabSaved);

  const [confirmOpen, setConfirmOpen] = useState(false);

  // OSS title_for(): an untitled tab's title is derived from the active language
  // ("Untitled N") so it re-translates on language change; file/renamed/duplicated
  // tabs keep their stored title.
  const title = untitledIndex != null ? `${t('untitled', lang)} ${untitledIndex}` : name;

  const onCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // OSS tab_manager.py:333-335: prompt only when dirty AND the user hasn't opted
    // out; otherwise the dirty tab is discarded silently (NOT saved).
    if (dirty && !skipCloseWarning) {
      setConfirmOpen(true);
      return;
    }
    closeTab(id);
  };

  const onDuplicate = (e: React.MouseEvent) => {
    e.stopPropagation();
    duplicateTab(id);
  };

  // OSS "Save" makes the closing tab live and saves it to a file, then closes.
  // In the browser, save = download the project JSON (no cancel signal, so the
  // tab always closes after the download is triggered).
  const doSave = () => {
    const st = useEditorStore.getState();
    const tab = st.tabs.find((tb) => tb.id === id);
    const doc = id === st.activeTabId ? st.doc : (tab?.doc ?? st.doc);
    const fileName = `${title}.json`;
    downloadJSON(fileName, serializeProject(doc));
    markTabSaved(id, fileName);
    setConfirmOpen(false);
    closeTab(id);
  };
  const doDiscard = () => {
    setConfirmOpen(false);
    closeTab(id);
  };
  const doCancel = () => setConfirmOpen(false);

  return (
    <>
      <div
        className={'tab-chip' + (active ? ' tab-chip-active' : '')}
        role="tab"
        aria-selected={active}
        title={title}
        onClick={() => switchTab(id)}
      >
        {dirty ? <span className="tab-chip-dot" aria-hidden /> : null}
        <span className="tab-chip-title">{title}</span>
        <button
          type="button"
          className="tab-icon-btn tab-chip-dup"
          title={t('duplicate_tab', lang)}
          aria-label={t('duplicate_tab', lang)}
          onClick={onDuplicate}
        >
          <DuplicateGlyph />
        </button>
        <button
          type="button"
          className="tab-icon-btn tab-chip-close"
          title={t('close_tab', lang)}
          aria-label={t('close_tab', lang)}
          onClick={onCloseClick}
        >
          <CloseGlyph />
        </button>
      </div>

      {confirmOpen ? (
        <Modal
          title={t('unsaved_tab_title', lang)}
          lang={lang}
          onClose={doCancel}
          onEnter={doSave}
          footer={
            // OSS button order (left→right): Save (default), Discard, Cancel (Esc).
            <>
              <button type="button" className="tab-confirm-save" onClick={doSave}>{t('save', lang)}</button>
              <button type="button" onClick={doDiscard}>{t('discard', lang)}</button>
              <button type="button" onClick={doCancel}>{t('cancel', lang)}</button>
            </>
          }
        >
          {/* OSS body = "<title>\n\n<Unsaved changes>" */}
          <div className="tab-confirm-body">
            <div>{title}</div>
            <div style={{ marginTop: '1em' }}>{t('unsaved_tab_title', lang)}</div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// 18×18 overlapping-squares "duplicate" glyph.
function DuplicateGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 18 18" aria-hidden focusable="false">
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3" y="3" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// 18×18 X "close" glyph.
function CloseGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path d="M4.5 4.5 L13.5 13.5 M13.5 4.5 L4.5 13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
