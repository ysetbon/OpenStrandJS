import React, { useState, useRef, useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  toggleHidden, setShadowOnly, setColor, setWidth, resetMask, renameLayer,
} from '../store/actions';
import { maskComponents } from '../model/layerName';
import type { RGBA } from '../model/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { t } from './i18n';
import './layerButton.css';

// OSS NumberedLayerButton (UI_PORT_PLAN.md §2.4). 146×40px, border-radius 4,
// border 1px #888, fill = strand color (rgba). The layer name is rendered bold
// 12px WHITE with a BLACK outline (-webkit-text-stroke + a dual draw fallback).
// All OSS state colors here are theme-INDEPENDENT literals.
//
// Props are kept flexible so the integration list can drive selection, drag
// reorder (it draws the blue insertion line) and the per-button state flags.

function rgbaCss(c: RGBA | undefined | null): string {
  if (!c) return 'rgba(200,170,230,1)'; // default strand color fallback
  const a = c.a > 1 ? c.a / 255 : c.a; // tolerate 0..255 or 0..1 alpha
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

// RGBA(0..255) -> "#rrggbb" for the <input type=color> value.
function rgbaToHex(c: RGBA | undefined | null): string {
  if (!c) return '#c8aae6';
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

// "#rrggbb" -> RGBA(0..255), preserving the previous alpha.
function hexToRgba(hex: string, prev: RGBA | undefined | null): RGBA {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  const a = prev ? prev.a : 255;
  if (!m) return prev ? { ...prev } : { r: 200, g: 170, b: 230, a };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a };
}

export interface NumberedLayerButtonProps {
  name: string;
  orderIdx: number;
  onSelect: (name: string) => void;
  // Per-button state flags (integration computes these from mode/multi-select):
  attachable?: boolean;      // attach-mode candidate: right-edge green strip
  selectable?: boolean;      // selectable: 2px blue border
  multiSelected?: boolean;   // multi-select set membership: gold border
  // Drag-reorder hooks — the parent list draws the blue insertion line.
  draggable?: boolean;
  onDragStart?: (orderIdx: number, e: React.DragEvent) => void;
  onDragOver?: (orderIdx: number, e: React.DragEvent) => void;
  onDrop?: (orderIdx: number, e: React.DragEvent) => void;
  onDragEnd?: (orderIdx: number, e: React.DragEvent) => void;
}

export function NumberedLayerButton(props: NumberedLayerButtonProps): JSX.Element {
  const {
    name, orderIdx, onSelect,
    attachable, selectable, multiSelected,
    draggable, onDragStart, onDragOver, onDrop, onDragEnd,
  } = props;

  const lang = useEditorStore((s) => s.settings.language);
  const strand = useEditorStore((s) => s.doc.strands[name]);
  const selected = useEditorStore((s) => s.doc.selected_strand_name === name);
  const locked = useEditorStore((s) => s.doc.locked_layers.includes(name));
  const firstColor = useEditorStore((s) => {
    const mc = maskComponents(name);
    return mc ? s.doc.strands[mc.first]?.color : undefined;
  });
  const secondColor = useEditorStore((s) => {
    const mc = maskComponents(name);
    return mc ? s.doc.strands[mc.second]?.color : undefined;
  });
  const commitEdit = useEditorStore((s) => s.commitEdit);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(name);
  const [colorPick, setColorPick] = useState<'fill' | 'stroke' | null>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const isMasked = maskComponents(name) != null;
  const hidden = !!strand?.is_hidden;
  const shadowOnly = !!strand?.shadow_only;

  useEffect(() => {
    if (renaming) { renameInputRef.current?.focus(); renameInputRef.current?.select(); }
  }, [renaming]);

  // When the user picks fill/stroke via the menu, open the native color input.
  useEffect(() => {
    if (colorPick) colorInputRef.current?.click();
  }, [colorPick]);

  // ---- store-wired menu actions ----
  const doToggleHidden = () => commitEdit((d) => toggleHidden(d, name));
  const doToggleShadowOnly = () => commitEdit((d) => setShadowOnly(d, name, !shadowOnly));
  const doResetMask = () => commitEdit((d) => resetMask(d, name));
  const doEditShadows = () => {
    // No dedicated shadow editor for a single layer yet — toggle shadow_only as
    // the closest functional behavior (the group shadow editor is Phase 6).
    commitEdit((d) => setShadowOnly(d, name, !shadowOnly));
  };
  const applyColor = (kind: 'fill' | 'stroke', hex: string) => {
    const prev = kind === 'fill' ? strand?.color : strand?.stroke_color;
    const rgba = hexToRgba(hex, prev);
    commitEdit((d) => setColor(d, name, kind, rgba, false));
  };
  const doChangeWidth = (kind: 'width' | 'stroke_width') => {
    const cur = kind === 'width' ? strand?.width : strand?.stroke_width;
    const raw = window.prompt(t('change_width', lang), String(cur ?? 0));
    if (raw == null) return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    commitEdit((d) => setWidth(d, name, kind, v, false));
  };

  const commitRename = () => {
    const next = renameValue.trim();
    setRenaming(false);
    if (!next || next === name) return;
    commitEdit((d) => renameLayer(d, name, next));
  };

  const menuItems = (): MenuItem[] => {
    const items: MenuItem[] = [
      { label: hidden ? t('show_layer', lang) : t('hide_layer', lang), onClick: doToggleHidden },
      { label: t('shadow_only', lang), checked: shadowOnly, onClick: doToggleShadowOnly },
      { label: t('edit_shadows', lang), onClick: doEditShadows },
      { label: '', separator: true },
    ];
    if (isMasked) {
      items.push(
        { label: t('edit_mask', lang), disabled: true }, // mask editor is a later phase
        { label: t('reset_mask', lang), onClick: doResetMask },
      );
    } else {
      items.push(
        { label: t('change_color', lang), onClick: () => setColorPick('fill') },
        { label: t('change_stroke_color', lang), onClick: () => setColorPick('stroke') },
        { label: t('change_width', lang), onClick: () => doChangeWidth('width') },
      );
    }
    return items;
  };

  // ---- visual state -> class + inline style ----
  const classes = ['nlb'];
  if (selected) classes.push('nlb-checked');
  if (hidden) classes.push('nlb-hidden');
  if (shadowOnly) classes.push('nlb-shadow-only');
  if (locked) classes.push('nlb-locked');
  if (attachable) classes.push('nlb-attachable');
  if (selectable) classes.push('nlb-selectable');
  if (multiSelected) classes.push('nlb-multi');
  if (isMasked) classes.push('nlb-masked');

  // fill: masked uses first strand's color; otherwise the strand's own color.
  const fill = isMasked ? rgbaCss(firstColor) : rgbaCss(strand?.color);
  const style = { ['--nlb-fill']: fill } as React.CSSProperties;
  if (isMasked) (style as Record<string, string>)['--nlb-mask-border'] = rgbaCss(secondColor);

  return (
    <>
      <div
        className={classes.join(' ')}
        style={style}
        role="button"
        aria-pressed={selected}
        tabIndex={0}
        draggable={draggable}
        onClick={() => { if (!renaming) onSelect(name); }}
        onDoubleClick={() => { setRenameValue(name); setRenaming(true); }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        onDragStart={(e) => onDragStart?.(orderIdx, e)}
        onDragOver={(e) => { if (onDragOver) { e.preventDefault(); onDragOver(orderIdx, e); } }}
        onDrop={(e) => { if (onDrop) { e.preventDefault(); onDrop(orderIdx, e); } }}
        onDragEnd={(e) => onDragEnd?.(orderIdx, e)}
      >
        {renaming ? (
          <input
            ref={renameInputRef}
            className="nlb-rename"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
            }}
          />
        ) : (
          <span className="nlb-label" data-text={name}>{name}</span>
        )}

        {locked && <span className="nlb-lock" aria-hidden>🔒</span>}
      </div>

      {/* Hidden native color input driven by the menu "Change (Stroke) Color" items. */}
      <input
        ref={colorInputRef}
        type="color"
        className="nlb-color-input"
        defaultValue={rgbaToHex(colorPick === 'stroke' ? strand?.stroke_color : strand?.color)}
        onChange={(e) => { if (colorPick) applyColor(colorPick, e.target.value); }}
        onBlur={() => setColorPick(null)}
      />

      {menu && (
        <ContextMenu
          items={menuItems()}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
