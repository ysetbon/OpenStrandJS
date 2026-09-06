import React from 'react';
import { useEditorStore } from '../store/editorStore';
import { t } from './i18n';
import { Modal } from './Modal';
import './tabEdge.css';

// The OSS "Unsaved changes" QMessageBox (tab_manager.close_tab,
// main_window.load_project): warning icon, text "<tab title>\n\nUnsaved changes",
// buttons Save (default: Enter) / Discard / Cancel (Esc), mirrored for Hebrew.
export function UnsavedChangesDialog(props: {
  tabTitle: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { tabTitle, onSave, onDiscard, onCancel } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const title = t('unsaved_tab_title', lang);
  return (
    <Modal
      title={title}
      lang={lang}
      onClose={onCancel}
      onEnter={onSave}
      footer={
        <>
          <button type="button" className="tab-confirm-save" onClick={onSave} autoFocus>{t('save', lang)}</button>
          <button type="button" onClick={onDiscard}>{t('discard', lang)}</button>
          <button type="button" onClick={onCancel}>{t('cancel', lang)}</button>
        </>
      }
    >
      <div className="tab-confirm-body">
        <WarningGlyph />
        <div className="tab-confirm-text">
          <div className="tab-confirm-title">{tabTitle}</div>
          <div>{title}</div>
        </div>
      </div>
    </Modal>
  );
}

// QMessageBox.Warning icon: a rounded yellow triangle with an exclamation mark.
function WarningGlyph(): JSX.Element {
  return (
    <svg className="tab-confirm-icon" width="40" height="40" viewBox="0 0 40 40" aria-hidden focusable="false">
      <path d="M20 4 L37.5 34.5 H2.5 Z" fill="#F4C20D" stroke="#B48A00" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="18.4" y="13" width="3.2" height="12" rx="1.4" fill="#222" />
      <circle cx="20" cy="29.5" r="1.9" fill="#222" />
    </svg>
  );
}
