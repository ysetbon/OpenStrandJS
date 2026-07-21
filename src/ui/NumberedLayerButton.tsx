import React, { useState, useRef, useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  toggleHidden, setShadowOnly, setHideShadow, setColor, setWidth, setWidthGridUnits,
  resetMask, setCircleStrokeColor, toggleCircleVisible, toggleLineVisible, closeKnot,
  toggleLock,
} from '../store/actions';
import { maskComponents } from '../model/layerName';
import type { RGBA } from '../model/types';
import { ContextMenu, type MenuItem, type MenuRowButton } from './ContextMenu';
import { t } from './i18n';
import './layerButton.css';

// OSS NumberedLayerButton (numbered_layer_button.py). 146×40px, border: none, no
// border-radius. The layer name is rendered bold 16px (12pt) WHITE with a BLACK
// outline (-webkit-text-stroke + a dual draw fallback), centered, +1px paint
// nudge. All OSS state colors here are theme-INDEPENDENT literals.
//
// Props are kept flexible so the integration list can drive selection, drag
// reorder (it draws the blue insertion line) and the per-button state flags.

function rgbaCss(c: RGBA | undefined | null): string {
  if (!c) return 'rgba(200,170,230,1)'; // default strand color fallback
  const a = c.a > 1 ? c.a / 255 : c.a; // tolerate 0..255 or 0..1 alpha
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

// RGBA(0..255) -> "#rrggbb" for the <input type=color> value (alpha dropped,
// matching Qt QColor.name()).
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

// Qt QColor.lighter(factor)/darker(factor): operate on the HSV Value channel.
// lighter: V = min(255, V*factor/100); darker: V = floor(V*100/factor). Alpha
// preserved. Returns an rgba() string. (Qt defaults: lighter 150, darker 200.)
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max * 255];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const vn = v / 255;
  const c = vn * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = vn - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function qtLighter(c: RGBA | undefined | null, factor = 150): string {
  if (!c) return rgbaCss(c);
  const [h, s, v] = rgbToHsv(c.r, c.g, c.b);
  const nv = Math.min(255, (v * factor) / 100);
  const [r, g, b] = hsvToRgb(h, s, nv);
  const a = c.a > 1 ? c.a / 255 : c.a;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function qtDarker(c: RGBA | undefined | null, factor = 200): string {
  if (!c) return rgbaCss(c);
  const [h, s, v] = rgbToHsv(c.r, c.g, c.b);
  const nv = Math.floor((v * 100) / factor);
  const [r, g, b] = hsvToRgb(h, s, nv);
  const a = c.a > 1 ? c.a / 255 : c.a;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// WidthConfigDialog constants (numbered_layer_button.py:3098-3102).
const GRID_UNIT = 27;

export interface NumberedLayerButtonProps {
  name: string;
  orderIdx: number;
  onSelect: (name: string) => void;
  // Per-button state flags (integration computes these from mode/multi-select):
  attachable?: boolean;      // attach-mode candidate: right-edge green strip
  selectable?: boolean;      // selectable: 2px blue border
  multiSelected?: boolean;   // multi-select set membership: gold border
  maskedMode?: boolean;      // transient mask-create mode: flat gray button
  pickedForMask?: boolean;   // first picked layer during mask-create: darkened
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
    attachable, selectable, multiSelected, maskedMode, pickedForMask,
    draggable, onDragStart, onDragOver, onDrop, onDragEnd,
  } = props;

  const lang = useEditorStore((s) => s.settings.language);
  const strand = useEditorStore((s) => s.doc.strands[name]);
  const strands = useEditorStore((s) => s.doc.strands);
  const selected = useEditorStore((s) => s.doc.selected_strand_name === name);
  const locked = useEditorStore((s) => s.doc.locked_layers.includes(name));
  const multiSelectMode = useEditorStore((s) => s.multiSelectMode);
  const multiSelectedLayers = useEditorStore((s) => s.multiSelectedLayers);
  const firstColor = useEditorStore((s) => {
    const mc = maskComponents(name);
    return mc ? s.doc.strands[mc.first]?.color : undefined;
  });
  const secondColor = useEditorStore((s) => {
    const mc = maskComponents(name);
    return mc ? s.doc.strands[mc.second]?.color : undefined;
  });
  const commitEdit = useEditorStore((s) => s.commitEdit);
  // Per-mask Edit Mask session: which mask (if any) is being edited.
  const maskEditTarget = useEditorStore((s) => s.maskEditTarget);
  const enterMaskEdit = useEditorStore((s) => s.enterMaskEdit);
  const exitMaskEdit = useEditorStore((s) => s.exitMaskEdit);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [colorPick, setColorPick] = useState<'fill' | 'stroke' | null>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Scroll the selected button into view when selection moves to this layer
  // (e.g. selecting a strand on the canvas, or undo/redo) — OSS scrolls the
  // selected layer button into the panel viewport. `nearest` avoids gratuitous
  // scrolling when the button is already visible.
  useEffect(() => {
    if (selected) rootRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const isMasked = maskComponents(name) != null;
  const hidden = !!strand?.is_hidden;
  const shadowOnly = !!strand?.shadow_only;
  const hideShadow = !!strand?.hide_shadow;

  // When the user picks fill/stroke via the menu, open the native color input.
  useEffect(() => {
    if (colorPick) colorInputRef.current?.click();
  }, [colorPick]);

  // ---- store-wired menu actions ----
  const doToggleHidden = () => commitEdit((d) => toggleHidden(d, name));
  const doToggleShadowOnly = () => commitEdit((d) => setShadowOnly(d, name, !shadowOnly));
  const doToggleHideShadow = () => commitEdit((d) => setHideShadow(d, name, !hideShadow));
  // Reset Mask drops all deletion rectangles. OSS canvas.reset_mask first exits an
  // active edit session targeting this same mask (strand_drawing_canvas.py:7253-7255).
  const doResetMask = () => {
    if (maskEditTarget === name) exitMaskEdit();
    commitEdit((d) => resetMask(d, name));
  };
  // Edit Mask -> enter the per-mask deletion-rectangle erase session for this mask.
  const doEditMask = () => enterMaskEdit(name);
  const applyColor = (kind: 'fill' | 'stroke', hex: string) => {
    const prev = kind === 'fill' ? strand?.color : strand?.stroke_color;
    const rgba = hexToRgba(hex, prev);
    // Change Color (fill) propagates over the whole set; Change Stroke Color is
    // this-strand-only (numbered_layer_button.py change_color vs change_stroke_color).
    commitEdit((d) => setColor(d, name, kind, rgba, kind === 'fill'));
  };

  // OSS WidthConfigDialog: total thickness conserved; the slider redistributes
  // color vs stroke. total = squares*27, stroke clamped to [1, total/2], color =
  // total - 2*stroke. wholeSet -> Change Width (whole set); else Change Width
  // (This Layer Only). (numbered_layer_button.py:2698-2799, 3098-3396)
  // TODO(oss-fidelity): WidthConfigDialog slider redistribution — using prompt
  // for the grid-square count.
  const doChangeWidth = (wholeSet: boolean) => {
    if (!strand) return;
    const curUnits = typeof strand.extra.width_in_grid_units === 'number'
      ? (strand.extra.width_in_grid_units as number)
      : Math.max(0.5, Math.round(((strand.width + 2 * strand.stroke_width) / GRID_UNIT) * 10) / 10);
    const raw = window.prompt(t('change_width', lang), String(curUnits));
    if (raw == null) return;
    let squares = Number(raw);
    if (!Number.isFinite(squares)) return;
    if (squares < 0.5) squares = 0.5;
    const total = squares * GRID_UNIT;
    const maxStroke = Math.max(1, Math.floor(total / 2));
    const stroke = Math.max(1, Math.min(maxStroke, Math.round(strand.stroke_width)));
    const colorWidth = Math.max(0, total - 2 * stroke);
    commitEdit((d) => {
      setWidth(d, name, 'width', colorWidth, wholeSet);
      setWidth(d, name, 'stroke_width', stroke, wholeSet);
      setWidthGridUnits(d, name, squares, wholeSet);
    });
  };

  // ---- circle / line gating by scanning children attached to this strand ----
  const childSides = (): { start: boolean; end: boolean } => {
    let start = false, end = false;
    for (const k of Object.keys(strands)) {
      const c = strands[k];
      if (c.attached_to !== name) continue;
      if (c.attachment_side === 0) start = true;
      else if (c.attachment_side === 1) end = true;
    }
    return { start, end };
  };

  const menuItems = (): MenuItem[] => {
    const items: MenuItem[] = [];

    // ---- multi-select menu: exactly two items over the selected set ----
    if (multiSelectMode) {
      const S = multiSelectedLayers.includes(name)
        ? multiSelectedLayers
        : [name, ...multiSelectedLayers];
      const anyHidden = S.some((n) => strands[n]?.is_hidden);
      const anyShadow = S.some((n) => strands[n]?.shadow_only);
      items.push(
        {
          label: anyHidden ? t('show_selected_layers', lang) : t('hide_selected_layers', lang),
          onClick: () => commitEdit((d) => {
            const next = !anyHidden;
            for (const n of S) { const sd = d.strands[n]; if (sd) sd.is_hidden = next; }
          }),
        },
        { label: '', separator: true },
        {
          label: anyShadow ? t('disable_shadow_only_selected', lang) : t('enable_shadow_only_selected', lang),
          onClick: () => commitEdit((d) => {
            const next = !anyShadow;
            for (const n of S) { const sd = d.strands[n]; if (sd) sd.shadow_only = next; }
          }),
        },
      );
      return items;
    }

    // ---- common header (all layer types) ----
    items.push(
      { label: hidden ? t('show_layer', lang) : t('hide_layer', lang), onClick: doToggleHidden },
      // Shadow Only: inline ✓ prefix when active (OSS prepends "✓ "). No checked
      // gutter — the ctx-check gutter is not used here.
      { label: (shadowOnly ? '✓ ' : '') + t('shadow_only', lang), onClick: doToggleShadowOnly },
      // OSS 1.109 per-layer Hide Shadow (numbered_layer_button.py:776-789):
      // sits between Shadow Only and Edit Shadows, ✓-prefixed when active.
      { label: (hideShadow ? '✓ ' : '') + t('hide_shadow', lang), onClick: doToggleHideShadow },
      // TODO(oss-fidelity): open_shadow_editor per-strand dialog not ported.
      { label: t('edit_shadows', lang), disabled: true },
      { label: '', separator: true },
    );

    if (isMasked) {
      items.push(
        { label: t('edit_mask', lang), onClick: doEditMask },
        { label: t('reset_mask', lang), onClick: doResetMask },
      );
      return items;
    }

    // ---- regular / attached strand branch ----
    const isAttached = strand?.type === 'AttachedStrand';
    items.push(
      { label: t('change_color', lang), onClick: () => setColorPick('fill') },
      { label: t('change_stroke_color', lang), onClick: () => setColorPick('stroke') },
      { label: t('change_width', lang), onClick: () => doChangeWidth(true) },
      { label: t('change_layer_width', lang), onClick: () => doChangeWidth(false) },
      { label: '', separator: true },
    );

    // Circle stroke fold/unfold: one item toggling on circle_stroke_color.alpha.
    // OSS gates this on hasattr(strand,'circle_stroke_color'), which is true only
    // for AttachedStrand — so a plain Strand never shows it.
    if (isAttached) {
      const strokeAlpha = strand?.circle_stroke_color?.a ?? 255;
      if (strokeAlpha === 0) {
        items.push({
          label: t('restore_default_stroke', lang),
          onClick: () => commitEdit((d) => setCircleStrokeColor(d, name, { r: 0, g: 0, b: 0, a: 255 })),
        });
      } else {
        items.push({
          label: t('transparent_stroke', lang),
          onClick: () => commitEdit((d) => setCircleStrokeColor(d, name, { r: 0, g: 0, b: 0, a: 0 })),
        });
      }
    }

    // ---- Line group (start/end side-line visibility) ----
    // OSS renders this as one compound row: a "Line" label + inline Start/End
    // buttons (numbered_layer_button.py:820+). Rendered via ContextMenu's
    // compound-row item (rowLabel + buttons).
    // TODO(oss-fidelity): line flags only initialized on masked strands today;
    // renderer parity unverified.
    const startLine = strand?.extra?.start_line_visible;
    const endLine = strand?.extra?.end_line_visible;
    const hasStartLine = startLine !== undefined && !isAttached;
    const hasEndLine = endLine !== undefined;
    if (hasStartLine || hasEndLine) {
      const buttons: MenuRowButton[] = [];
      if (hasStartLine) buttons.push({
        label: startLine === false ? t('show_start_line', lang) : t('hide_start_line', lang),
        onClick: () => commitEdit((d) => toggleLineVisible(d, name, 'start')),
      });
      if (hasEndLine) buttons.push({
        label: endLine === false ? t('show_end_line', lang) : t('hide_end_line', lang),
        onClick: () => commitEdit((d) => toggleLineVisible(d, name, 'end')),
      });
      items.push({ label: '', separator: true });
      items.push({ label: '', rowLabel: t('line', lang), buttons });
    }

    // ---- Circle group (start/end circle visibility) ----
    // OSS compound row: "Circle" label (no padding) + inline Start/End buttons.
    // Gating: a child attached at side 0 -> start; side 1 -> end. AttachedStrand
    // always allows its start toggle.
    // TODO(oss-fidelity): child-scan gating approximated; renderer parity unverified.
    const sides = childSides();
    const showStart = isAttached || sides.start;
    const showEnd = sides.end;
    if (showStart || showEnd) {
      const hc = strand?.has_circles ?? [false, false];
      const buttons: MenuRowButton[] = [];
      if (showStart) buttons.push({
        label: hc[0] ? t('hide_start_circle', lang) : t('show_start_circle', lang),
        onClick: () => commitEdit((d) => toggleCircleVisible(d, name, 0)),
      });
      if (showEnd) buttons.push({
        label: hc[1] ? t('hide_end_circle', lang) : t('show_end_circle', lang),
        onClick: () => commitEdit((d) => toggleCircleVisible(d, name, 1)),
      });
      items.push({ label: '', separator: true });
      items.push({ label: '', rowLabel: t('circle', lang), buttons, noPad: true });
    }

    // ---- Close the Knot (exactly one free end) ----
    const hc = strand?.has_circles ?? [false, false];
    let freeCount = 0;
    let freeEndType: 'start' | 'end' = 'end';
    if (isAttached) {
      // start is always attached; the end is free iff it has no circle.
      if (!hc[1]) { freeCount = 1; freeEndType = 'end'; }
    } else {
      if (!hc[0]) { freeCount += 1; freeEndType = 'start'; }
      if (!hc[1]) { if (freeCount === 0) freeEndType = 'end'; freeCount += 1; }
    }
    if (freeCount === 1) {
      items.push(
        { label: '', separator: true },
        {
          label: t('close_the_knot', lang),
          onClick: () => commitEdit((d) => closeKnot(d, name, freeEndType)),
        },
      );
    }

    return items;
  };

  // ---- visual state -> class + inline style ----
  const isRtl = lang === 'he';
  const classes = ['nlb'];
  if (selected && !maskedMode) classes.push('nlb-checked');
  if (hidden) classes.push('nlb-hidden');
  if (shadowOnly) classes.push('nlb-shadow-only');
  if (attachable) classes.push('nlb-attachable');
  if (selectable) classes.push('nlb-selectable');
  if (isRtl) classes.push('nlb-rtl');
  if (multiSelected) classes.push('nlb-multi');
  if (isMasked) classes.push('nlb-masked');
  if (maskedMode) classes.push('nlb-mask-mode');
  if (pickedForMask) classes.push('nlb-mask-picked');
  // Edit Mask session: red-border the edited mask; dim + lock every other button.
  // Guard on the target still existing so a tab switch / undo that removed the mask
  // never leaves every button stuck-locked with no edited button to exit from.
  const editActive = maskEditTarget != null && strands[maskEditTarget]?.type === 'MaskedStrand';
  const editingThis = editActive && maskEditTarget === name;
  const editLocked = editActive && maskEditTarget !== name;
  if (editingThis) classes.push('nlb-mask-editing');
  if (editLocked) classes.push('nlb-edit-locked');

  // fill: masked uses first strand's color; otherwise the strand's own color.
  const base = isMasked ? firstColor : strand?.color;
  const style = { ['--nlb-fill']: rgbaCss(base) } as React.CSSProperties;
  const sty = style as Record<string, string>;
  sty['--nlb-hover'] = qtLighter(base, 150);
  sty['--nlb-checked'] = qtDarker(base, 200);
  // Mask border = SECOND strand's color, OPAQUE hex (Qt QColor.name() drops alpha).
  if (isMasked) sty['--nlb-mask-border'] = rgbaToHex(secondColor);

  return (
    <>
      <div
        ref={rootRef}
        className={classes.join(' ')}
        style={style}
        role="button"
        aria-pressed={selected}
        tabIndex={0}
        draggable={draggable}
        onClick={() => { if (!editActive) onSelect(name); }}
        onContextMenu={(e) => {
          e.preventDefault();
          // During an Edit Mask session every button's context menu is disabled
          // (OSS setContextMenuPolicy(Qt.NoContextMenu)); exit with ESC.
          if (editActive) return;
          // OSS suppresses the normal per-button menu in multi-select mode and
          // shows the 2-item multi menu instead (built in menuItems()).
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.(orderIdx, e); }}
        onDragOver={(e) => { if (onDragOver) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOver(orderIdx, e); } }}
        onDrop={(e) => { if (onDrop) { e.preventDefault(); onDrop(orderIdx, e); } }}
        onDragEnd={(e) => onDragEnd?.(orderIdx, e)}
      >
        <span className="nlb-label" data-text={name}>{name}</span>

        {/* attachable green inner box (9px black outline is .nlb-attachable::before) */}
        {attachable && <span className="nlb-attach" aria-hidden />}

        {/* OSS 1.109 lock rework: a small padlock toggle, vertically centered on
            the side opposite the green attachable strip (mirrored for RTL).
            Shown in lock mode (selectable) — and kept visible on a still-locked
            button outside it. Clicking it locks/unlocks WITHOUT selecting the
            layer; it only reacts in lock mode (OSS mousePress gates on
            selectable). Open = unlocked, closed = locked (amber fill). */}
        {(selectable || locked) && (
          <button
            type="button"
            className={`nlb-padlock${locked ? ' is-locked' : ''}`}
            aria-label={locked ? 'unlock layer' : 'lock layer'}
            aria-pressed={locked}
            onClick={(e) => {
              e.stopPropagation();
              if (!selectable || editActive) return;
              commitEdit((d) => toggleLock(d, name));
            }}
          >
            {locked ? '🔒' : '🔓'}
          </button>
        )}
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
