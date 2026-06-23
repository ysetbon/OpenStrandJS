import React, { useEffect } from 'react';
import type { Language } from '../model/types';
import { isRTL } from './i18n';
import './dialogs.css';

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, [onClose, onEnter]);

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
