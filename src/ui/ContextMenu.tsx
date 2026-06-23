import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './contextMenu.css';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  checked?: boolean;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
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
    onClose();
  };

  // OSS only reserves a check gutter on menus that actually have checkable items
  // (the group menu has none — its items are plain text rows).
  const hasChecks = items.some((it) => it.checked != null);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.separator) return <div key={i} className="ctx-sep" role="separator" />;
        const cls =
          'ctx-item' +
          (item.danger ? ' ctx-danger' : '') +
          (item.disabled ? ' ctx-disabled' : '') +
          (item.checked ? ' ctx-checked' : '');
        return (
          <div
            key={i}
            className={cls}
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            onClick={() => clickItem(item)}
          >
            {hasChecks && <span className="ctx-check">{item.checked ? '✓' : ''}</span>}
            <span className="ctx-label">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
