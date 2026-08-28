import React, { useEffect, useRef } from 'react';
import type { Language } from '../model/types';
import { isRTL } from './i18n';
import './dialogs.css';

// Open dialogs, oldest first. Each Modal listens for Escape/Enter on the document
// (capture), so without this a nested dialog — the colour picker inside Arrow
// Customization or inside Settings — would have its Escape close the parent as
// well. A child mounts after its parent, so the last entry is the topmost one,
// and only that one acts on a key.
const modalStack: object[] = [];

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Drives RTL layout direction (OSS sets Qt.RightToLeft for Hebrew). */
  lang?: Language;
  /** Enter accepts the dialog (mirrors Qt's default-button behaviour). */
  onEnter?: () => void;
  /** OSS non-modal dialogs (shadow editor, mask grid): no dimming, canvas stays live. */
  modeless?: boolean;
  /** Explicit dialog width (OSS dialogs size to their content). */
  width?: number | string;
}): JSX.Element {
  const { title, onClose, children, footer, lang, onEnter, modeless, width } = props;

  // Identity for this dialog's slot in the stack above.
  const token = useRef<object>({}).current;
  useEffect(() => {
    modalStack.push(token);
    return () => {
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [token]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog owns the keyboard.
      if (modalStack[modalStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Enter' && onEnter) {
        const el = e.target as HTMLElement | null;
        // Don't hijack Enter inside multiline fields.
        if (el && el.tagName === 'TEXTAREA') return;
        onEnter();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, onEnter, token]);

  const dir = lang && isRTL(lang) ? 'rtl' : 'ltr';
  const style: React.CSSProperties | undefined = width != null ? { width } : undefined;

  return (
    <div
      className={'modal-backdrop' + (modeless ? ' modeless' : '')}
      onMouseDown={modeless ? undefined : onClose}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal={modeless ? undefined : 'true'}
        aria-label={title}
        dir={dir}
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        {footer != null && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
