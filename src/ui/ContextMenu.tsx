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
  // styles.css applies a global `html { zoom: 0.65 }`. Under that zoom, e.clientX/
  // clientY AND el.getBoundingClientRect() AND document.documentElement.clientWidth
  // are all in VISUAL (post-zoom screen) px — but a position:fixed element's inline
  // left/top are LAYOUT px, painted on screen at left*zoom. So we do ALL placement +
  // clamp math in visual px (the space clientX lives in), then divide the final
  // result by `zoom` ONCE to get the layout px the inline style needs. No-op at
  // zoom === 1. (`zoom` reads as a string like '0.65', or 'normal'/'' when unset;
  // coerce to 1.) NOTE: documentElement.clientWidth is the VISUAL viewport here
  // (the zoomed root reports the visual size, not layout) — do not treat it as
  // layout px, and do not mix layout-px offsetWidth into this visual-px clamp.
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x / zoom, top: y / zoom });

  const lang = useEditorStore((s) => s.settings.language);
  const theme = useEditorStore((s) => s.settings.theme);
  const isRtl = lang === 'he';
  const isDark = theme === 'dark';

  const minWidth = useMemo(() => computeMenuWidth(items), [items]);

  // Clamp to the viewport once the menu has been measured — ALL in VISUAL px
  // (the space clientX, getBoundingClientRect and documentElement.clientWidth
  // share under html{zoom}), then convert to layout px once via `/ zoom`.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();          // visual px (post-zoom)
    const vw = document.documentElement.clientWidth;  // visual viewport px
    const vh = document.documentElement.clientHeight;
    const margin = 4;
    let left = x;                                     // clientX, visual px
    let top = y;
    if (left + rect.width > vw - margin) left = Math.max(margin, vw - rect.width - margin);
    if (top + rect.height > vh - margin) top = Math.max(margin, vh - rect.height - margin);
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    // visual px -> layout px for the position:fixed inline style.
    setPos({ left: left / zoom, top: top / zoom });
  }, [x, y, items, zoom]);

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
    onClose();
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
        const cls = 'ctx-item' + (item.disabled ? ' ctx-disabled' : '');
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
