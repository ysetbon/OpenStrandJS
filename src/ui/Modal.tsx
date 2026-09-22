import React, { useEffect, useRef, useState } from 'react';
import type { Language } from '../model/types';
import { isRTL } from './i18n';
import './dialogs.css';

// Open dialogs, oldest first. Each Modal listens for Escape/Enter on the document
// (capture), so without this a nested dialog — the colour picker inside Arrow
// Customization or inside Settings — would have its Escape close the parent as
// well. A child mounts after its parent, so the last entry is the topmost one,
// and only that one acts on a key.
const modalStack: object[] = [];

/**
 * Shared dialog shell for every OSS QDialog port: a dimmed backdrop, a title bar
 * the user can drag the window around by, an optional close X, and Escape/Enter
 * handling owned by the topmost open dialog only.
 */
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
  /**
   * A press on the dimmed backdrop closes the dialog (default true). A Qt modal
   * QDialog never does this — a click outside it is simply swallowed — so dialogs
   * that must only leave through OK / Escape / the title-bar X pass false.
   */
  dismissOnBackdrop?: boolean;
  /** Show a title-bar "X" (the native window close of a QDialog); it calls onClose. */
  closeButton?: boolean;
}): JSX.Element {
  const {
    title, onClose, children, footer, lang, onEnter, modeless, width,
    dismissOnBackdrop = true, closeButton,
  } = props;

  // Identity for this dialog's slot in the stack above.
  const token = useRef<object>({}).current;
  useEffect(() => {
    modalStack.push(token);
    return () => {
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [token]);

  // Keyboard focus, as a QDialog handles it: focus moves into the dialog when
  // it opens (a control with autoFocus takes it during React's commit; else
  // the first control in the body, else the first focusable at all), a MODAL
  // dialog keeps Tab cycling within it (below), and the control that opened
  // the dialog gets focus back when it closes. A modeless dialog (shadow
  // editor, mask grid) leaves the rest of the window reachable, as OSS's do.
  const modalRef = useRef<HTMLDivElement>(null);
  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusables = (root: HTMLElement | null = modalRef.current): HTMLElement[] => Array.from(
    root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  // The element to hand focus back to, read during the FIRST RENDER: a child
  // marked autoFocus takes focus in React's commit, before any effect runs, so
  // an effect would record the dialog's own control as the opener.
  const [opener] = useState<HTMLElement | null>(
    () => (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null),
  );
  useEffect(() => {
    const box = modalRef.current;
    if (box && !box.contains(document.activeElement)) {
      const first = focusables(box.querySelector<HTMLElement>('.modal-body'))[0] ?? focusables()[0];
      first?.focus();
    }
    return () => {
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog owns the keyboard.
      if (modalStack[modalStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        // A key the dialog acts on must not also reach the editor's own
        // shortcuts (InteractionHost: Escape clears the selection) — a Qt modal
        // dialog swallows its key events, so the main window never sees them.
        e.stopPropagation();
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Enter' && onEnter) {
        const el = e.target as HTMLElement | null;
        // Don't hijack Enter inside multiline fields.
        if (el && el.tagName === 'TEXTAREA') return;
        e.stopPropagation();
        e.preventDefault();   // no synthetic click on a focused button on top of onEnter
        onEnter();
        return;
      }
      // Tab never leaves a modal dialog: past the last control it wraps to
      // the first, and Shift+Tab past the first wraps to the last.
      if (e.key === 'Tab' && !modeless) {
        const items = focusables();
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const inside = !!active && !!modalRef.current?.contains(active);
        if (!inside) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
        if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, onEnter, token, modeless]);

  // Title-bar drag. Every OSS dialog is a real window the user can pick up by its
  // title bar and park wherever it is not in the way of the canvas; the dialog is
  // moved with a transform so the centred flex layout of the backdrop is untouched.
  const offset = useRef({ x: 0, y: 0 });
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const onTitleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // The X button is part of the title bar but must stay a plain click.
    if ((e.target as HTMLElement).closest('.modal-close')) return;
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: offset.current.x, oy: offset.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();   // no text selection while dragging the title
  };
  const onTitleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    offset.current = { x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) };
    if (modalRef.current) {
      modalRef.current.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px)`;
    }
  };
  const onTitleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const dir = lang && isRTL(lang) ? 'rtl' : 'ltr';
  const style: React.CSSProperties | undefined = width != null ? { width } : undefined;

  return (
    <div
      className={'modal-backdrop' + (modeless ? ' modeless' : '')}
      onMouseDown={modeless || !dismissOnBackdrop ? undefined : onClose}
    >
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal={modeless ? undefined : 'true'}
        aria-label={title}
        dir={dir}
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="modal-titlebar"
          onPointerDown={onTitleDown}
          onPointerMove={onTitleMove}
          onPointerUp={onTitleUp}
          onPointerCancel={onTitleUp}
        >
          <h2>{title}</h2>
          {closeButton && (
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer != null && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
