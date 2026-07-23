import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import './contextMenu.css';

/** A flat button inside a compound (Line / Circle / Arrow / Dash) row. */
export interface MenuRowButton {
  label: string;
  onClick: () => void;
}

export interface MenuItem {
  /** Plain text item (HoverLabel in OSS). */
  label: string;
  onClick?: () => void;
  /** Retained for API compatibility; no longer drives a gutter checkmark.
   *  (Shadow Only ✓ is now an inline label prefix from NumberedLayerButton.) */
  checked?: boolean;
  /** Retained for API compatibility; OSS menus have no per-item red. */
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /** Compound row (Line/Circle/Arrow/Dash): left label + N inline buttons. */
  rowLabel?: string;
  buttons?: MenuRowButton[];
  /** Circle row label carries no padding in OSS. */
  noPad?: boolean;
  /** Clicking the item does NOT close the menu (OSS expandable QWidgetAction
   *  rows — Paste/Copy Strand Data toggle their inline panels in place). */
  keepOpen?: boolean;
  /** Indented sub-row (OSS setIndent(20) on the paste anchor rows). */
  indent?: boolean;
  /** Raw content rendered inside the menu (OSS inline QWidgetAction panels). */
  custom?: React.ReactNode;
}

/* ---- Dynamic menu width (OSS calculate_menu_width: 8pt, min 150, +20, cap 350) ---- */
let measureCtx: CanvasRenderingContext2D | null = null;
function measureLabel(text: string): number {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    measureCtx = canvas.getContext('2d');
    if (measureCtx) measureCtx.font = '11px sans-serif'; // ~8pt
  }
  if (!measureCtx) return text.length * 7;
  return measureCtx.measureText(text).width;
}

function computeMenuWidth(items: MenuItem[]): number {
  let max = 150;
  for (const item of items) {
    if (item.separator) continue;
    const texts: string[] = [];
    if (item.buttons) {
      if (item.rowLabel) texts.push(item.rowLabel);
      for (const b of item.buttons) texts.push(b.label);
    } else {
      texts.push(item.label);
    }
    for (const t of texts) {
      const w = measureLabel(t) + 20;
      if (w > max) max = w;
    }
  }
  return Math.min(max, 350);
}

export function ContextMenu(props: {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}): JSX.Element {
  const { items, x, y, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  const lang = useEditorStore((s) => s.settings.language);
  const theme = useEditorStore((s) => s.settings.theme);
  const isRtl = lang === 'he';
  const isDark = theme === 'dark';

  const minWidth = useMemo(() => computeMenuWidth(items), [items]);

  // Clamp to viewport once the menu has been measured.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;
    let left = x;
    let top = y;
    if (left + rect.width > vw - margin) left = Math.max(margin, vw - rect.width - margin);
    if (top + rect.height > vh - margin) top = Math.max(margin, vh - rect.height - margin);
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    setPos({ left, top });
  }, [x, y, items]);

  // Close on outside-click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Use capture so we beat any stopPropagation on the page.
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('contextmenu', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('contextmenu', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const clickItem = (item: MenuItem) => {
    if (item.disabled || item.separator) return;
    item.onClick?.();
    if (!item.keepOpen) onClose();
  };

  return (
    <div
      ref={ref}
      className={'ctx-menu' + (isDark ? ' ctx-theme-dark' : '')}
      style={{ left: pos.left, top: pos.top, minWidth }}
      role="menu"
      dir={isRtl ? 'rtl' : 'ltr'}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.separator) return <div key={i} className="ctx-sep" role="separator" />;
        if (item.custom) return <div key={i} className="ctx-custom">{item.custom}</div>;
        if (item.buttons) {
          return (
            <div
              key={i}
              className={'ctx-compound' + (item.noPad ? ' ctx-compound-nopad' : '')}
              role="group"
            >
              <span className="ctx-compound-label">{item.rowLabel}</span>
              {item.buttons.map((b, j) => (
                <button
                  key={j}
                  type="button"
                  className="ctx-compound-btn"
                  onClick={() => {
                    b.onClick();
                    onClose();
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>
          );
        }
        const cls = 'ctx-item' + (item.disabled ? ' ctx-disabled' : '') + (item.indent ? ' ctx-indent' : '');
        return (
          <div
            key={i}
            className={cls}
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            onClick={() => clickItem(item)}
          >
            <span className="ctx-label">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
