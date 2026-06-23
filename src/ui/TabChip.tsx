import React, { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { t } from './i18n';
import { Modal } from './Modal';

// A single tab chip inside the floating TabEdge. Height 40, radius 9.
// Contents: [dirty dot if tab.dirty][title 9pt, bold when active][duplicate icon][close X].
// Closing a dirty tab opens an unsaved-changes confirm (Save / Discard / Cancel).
export function TabChip(props: {
  id: number;
  name: string;
  active: boolean;
  dirty?: boolean;
}): JSX.Element {
  const { id, name, active, dirty } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const switchTab = useEditorStore((s) => s.switchTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const duplicateTab = useEditorStore((s) => s.duplicateTab);
  const markTabSaved = useEditorStore((s) => s.markTabSaved);

  const [confirmOpen, setConfirmOpen] = useState(false);

  const onCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dirty) {
      setConfirmOpen(true);
      return;
    }
    closeTab(id);
  };

  const onDuplicate = (e: React.MouseEvent) => {
    e.stopPropagation();
    duplicateTab(id);
  };

  // Save = mark saved then close (file plumbing wired later; treat as in-memory save).
  const doSave = () => {
    markTabSaved(id, name);
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
        title={name}
        onClick={() => switchTab(id)}
      >
        {dirty ? <span className="tab-chip-dot" aria-hidden /> : null}
        <span className="tab-chip-title">{name}</span>
        <button
          type="button"
          className="tab-icon-btn tab-chip-dup"
          title="Duplicate"
          aria-label="Duplicate tab"
          onClick={onDuplicate}
        >
          <DuplicateGlyph />
        </button>
        <button
          type="button"
          className="tab-icon-btn tab-chip-close"
          title={t('close', lang)}
          aria-label={t('close', lang)}
          onClick={onCloseClick}
        >
          <CloseGlyph />
        </button>
      </div>

      {confirmOpen ? (
        <Modal
          title={t('unsaved_tab_title', lang)}
          onClose={doCancel}
          footer={
            <>
              <button type="button" onClick={doCancel}>{t('cancel', lang)}</button>
              <button type="button" onClick={doDiscard}>{t('discard', lang)}</button>
              <button type="button" className="tab-confirm-save" onClick={doSave}>{t('save', lang)}</button>
            </>
          }
        >
          <div className="tab-confirm-body">{name}</div>
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
