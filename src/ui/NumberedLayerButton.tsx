import React, { useState, useRef, useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  toggleHidden, setShadowOnly, setHideShadow, setColor, setWidth, setWidthGridUnits,
  resetMask, setCircleStrokeColor, toggleCircleVisible, toggleLineVisible, closeKnot,
  toggleLock, toggleArrowVisible,
} from '../store/actions';
import { maskComponents } from '../model/layerName';
import type { RGBA } from '../model/types';
import { ContextMenu, type MenuItem, type MenuRowButton } from './ContextMenu';
import { StrandShadowEditorDialog } from './dialogs/StrandShadowEditorDialog';
import {
  COPY_PROPERTIES, clipboardPropertyCount, pasteStrandData, snapshotStrandData,
  type CopyProperty,
} from '../store/strandClipboard';
import { ossIcon } from './icons';
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
  const [shadowEditor, setShadowEditor] = useState(false);
  // Inline expandable panels inside the multi-select menu (OSS QWidgetAction
  // dropdowns — both collapsed each time the menu opens).
  const [pasteOpen, setPasteOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [badgeMenu, setBadgeMenu] = useState<{ x: number; y: number } | null>(null);
  // OSS right-click-on-indicator explanation tooltip (QToolTip.showText —
  // hover tooltips were deliberately removed as "too chatty").
  const [indicatorTip, setIndicatorTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const tipTimer = useRef<number | null>(null);
  const showIndicatorTip = (x: number, y: number, text: string) => {
    if (tipTimer.current != null) window.clearTimeout(tipTimer.current);
    setIndicatorTip({ x, y, text });
    tipTimer.current = window.setTimeout(() => setIndicatorTip(null), 2500);
  };
  const toggleMultiSelectLayer = useEditorStore((s) => s.toggleMultiSelectLayer);
  const strandClipboard = useEditorStore((s) => s.strandClipboard);
  const setStrandClipboard = useEditorStore((s) => s.setStrandClipboard);
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

  // ---- Copy/Paste Strand Data (1.109 strand_data_menu.py) ----
  // Menu paste targets the ticked layers only; chip paste targets the ticked
  // set when this layer is ticked, else this layer alone
  // (paste_strand_data_via_chip). One undo step per paste.
  const doPaste = (anchor: 'start' | 'end', targetsOverride: string[] | null) => {
    const snap = useEditorStore.getState().strandClipboard;
    if (!snap) return;
    const targets = targetsOverride ?? useEditorStore.getState().multiSelectedLayers;
    if (!targets.length) return;
    commitEdit((d) => { pasteStrandData(d, snap, targets, anchor); });
  };
  const doChipPaste = (anchor: 'start' | 'end') => {
    const ticked = useEditorStore.getState().multiSelectedLayers;
    doPaste(anchor, ticked.includes(name) ? ticked : [name]);
  };
  // OSS _strand_clipboard_state: copy/paste indicators live in MULTI-SELECT
  // mode only, and the SOURCE layer never shows paste chips — right after a
  // copy both anchors are exact no-ops on it, and the badge marks it instead
  // (the right-click menu can still paste onto the source when it is ticked).
  const isCopySource =
    multiSelectMode && !!strandClipboard && strandClipboard.source_layer_name === name;
  const isPasteTarget =
    multiSelectMode && !!strandClipboard && !isCopySource &&
    !!strand && strand.type !== 'MaskedStrand' && !locked;

  // OSS _build_strand_copy_panel (strand_data_menu.py:174-287): an UNTITLED
  // inline checklist inside the same menu — tristate Select All, one checkbox
  // per property, and a single flat "Copy (N)" button (live ticked count,
  // disabled at 0) that snapshots and closes the menu. Choices are remembered
  // for the session (strand_data_copy_options, default all ticked).
  const copyOptions = useEditorStore((s) => s.strandDataCopyOptions);
  const setCopyOption = useEditorStore((s) => s.setStrandDataCopyOption);
  const copyInlinePanel = (): React.ReactNode => {
    const labelOf: Record<CopyProperty, string> = {
      start_point: t('strand_data_start_point', lang),
      end_point: t('strand_data_end_point', lang),
      control_points: t('strand_data_control_points', lang),
      width: t('strand_data_width', lang),
      strand_color: t('strand_data_strand_color', lang),
      stroke_color: t('strand_data_stroke_color', lang),
    };
    const isOn = (k: CopyProperty) => copyOptions[k] !== false; // default true
    const allOn = COPY_PROPERTIES.every(isOn);
    const someOn = COPY_PROPERTIES.some(isOn);
    const selected = COPY_PROPERTIES.filter(isOn);
    const doCopy = () => {
      if (!strand) return;
      const snap = snapshotStrandData(strand, selected);
      if (snap) setStrandClipboard(snap);
      setMenu(null); // a successful Copy closes the menu (strand_data_menu.py:278-284)
    };
    return (
      <div className="ctx-inline-panel">
        <label className="ctx-check">
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => { if (el) el.indeterminate = someOn && !allOn; }}
            onChange={(e) => COPY_PROPERTIES.forEach((k) => setCopyOption(k, e.target.checked))}
          />
          <span>{t('select_all', lang)}</span>
        </label>
        {COPY_PROPERTIES.map((k) => (
          <label key={k} className="ctx-check">
            <input type="checkbox" checked={isOn(k)} onChange={(e) => setCopyOption(k, e.target.checked)} />
            <span>{labelOf[k]}</span>
          </label>
        ))}
        <button type="button" className="ctx-copy-btn" disabled={selected.length === 0} onClick={doCopy}>
          {`${t('copy', lang)} (${selected.length})`}
        </button>
      </div>
    );
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

    // ---- multi-select menu: batch items over the selected set + the 1.109
    //      Copy/Paste Strand Data entries (strand_data_menu.py) ----
    if (multiSelectMode) {
      // The right-clicked layer was added to the ticked set on contextmenu
      // (OSS layer_panel.py:1935-1938), so the set alone is the target list.
      const S = multiSelectedLayers;
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
        { label: '', separator: true },
      );
      // Paste sits above Copy (OSS strand_data_menu.py:93-133 — "so expanding
      // Copy never pushes Paste around"). Both are collapsed "label  ▾" rows
      // that expand INLINE in the menu; the ▾ flips to ▴ when expanded.
      const arrow = (open: boolean) => (open ? '  ▴' : '  ▾');
      if (strandClipboard) {
        items.push({
          label: t('paste_copied_data', lang) + arrow(pasteOpen),
          keepOpen: true,
          onClick: () => setPasteOpen((v) => !v),
        });
        if (pasteOpen) {
          // First row of the expanded panel: the gray clipboard summary hint
          // "{count} properties from {source}" (strand_data_menu.py:321-329).
          items.push({
            label: t('strand_data_clipboard_hint', lang)
              .replace('{count}', String(clipboardPropertyCount(strandClipboard)))
              .replace('{source}', strandClipboard.source_layer_name),
            disabled: true,
          });
          items.push(
            { label: t('angle_from_start_point', lang), indent: true, onClick: () => doPaste('start', null) },
            { label: t('angle_from_end_point', lang), indent: true, onClick: () => doPaste('end', null) },
          );
        }
      } else {
        // Disabled label keeps its ▾ in OSS.
        items.push({ label: t('paste_copied_data', lang) + arrow(false), disabled: true });
      }
      items.push({ label: '', separator: true });
      // Copy from the right-clicked layer; masked strands cannot be copied.
      const copyAllowed = !!strand && strand.type !== 'MaskedStrand';
      items.push({
        label: t('copy_strand_data', lang) + arrow(copyOpen),
        disabled: !copyAllowed,
        keepOpen: true,
        onClick: copyAllowed ? () => setCopyOpen((v) => !v) : undefined,
      });
      if (copyOpen && copyAllowed) {
        items.push({ label: '', custom: copyInlinePanel() });
      }
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
      { label: t('edit_shadows', lang), onClick: () => setShadowEditor(true) },
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

    // ---- Arrow group (1.109 §7): Start/End arrow toggles + Full Arrow ----
    // Compound row like Line/Circle; the renderer draws all three arrow kinds
    // (pixel-verified vs the Qt oracle). Color/transparency/texture/sizes
    // customization submenu is the remaining §7 tail.
    {
      const startArrow = strand?.extra?.start_arrow_visible === true;
      const endArrow = strand?.extra?.end_arrow_visible === true;
      const fullArrow = strand?.extra?.full_arrow_visible === true;
      items.push({ label: '', separator: true });
      items.push({
        label: '',
        rowLabel: t('arrow', lang),
        buttons: [
          {
            label: startArrow ? t('hide_start_arrow', lang) : t('show_start_arrow', lang),
            onClick: () => commitEdit((d) => toggleArrowVisible(d, name, 'start')),
          },
          {
            label: endArrow ? t('hide_end_arrow', lang) : t('show_end_arrow', lang),
            onClick: () => commitEdit((d) => toggleArrowVisible(d, name, 'end')),
          },
        ],
      });
      items.push({
        label: fullArrow ? t('hide_full_arrow', lang) : t('show_full_arrow', lang),
        onClick: () => commitEdit((d) => toggleArrowVisible(d, name, 'full')),
      });
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
          // shows the batch menu instead; right-clicking a non-ticked layer
          // first ADDS it to the selection (gold border + paste target,
          // layer_panel.py:1935-1938).
          if (multiSelectMode && !multiSelectedLayers.includes(name)) {
            toggleMultiSelectLayer(name);
          }
          setPasteOpen(false);
          setCopyOpen(false);
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
            <img
              className="nlb-padlock-img"
              src={ossIcon(locked ? 'lock_closed' : 'lock_open')}
              alt=""
              draggable={false}
            />
          </button>
        )}

        {/* Copy/Paste Strand Data indicators (1.109, redesigned in 75f8e8e5),
            drawn from the SAME OSS PNGs on the OSS geometry: a 26px indicator
            column on the trailing side (right for LTR, mirrored for RTL) —
            the copy badge is a 26×26 square centered on it (click = hint +
            Clear popup); eligible paste targets show the segmented ▲/● paste
            stack on hover (▲ top = anchor from start, ● bottom = from end). */}
        {isCopySource && (
          <button
            type="button"
            className="nlb-copybadge"
            aria-label={t('copy_strand_data', lang)}
            onClick={(e) => { e.stopPropagation(); setBadgeMenu({ x: e.clientX, y: e.clientY }); }}
            onContextMenu={(e) => {
              // OSS: right-click on the badge shows the clipboard hint as a
              // tooltip INSTEAD of the batch menu (numbered_layer_button.py:1772-1789;
              // hover tooltips were deliberately removed).
              e.preventDefault();
              e.stopPropagation();
              if (!strandClipboard) return;
              showIndicatorTip(e.clientX, e.clientY, t('strand_data_clipboard_hint', lang)
                .replace('{count}', String(clipboardPropertyCount(strandClipboard)))
                .replace('{source}', strandClipboard.source_layer_name));
            }}
          >
            <img src={ossIcon('copy_badge')} alt="" draggable={false} />
          </button>
        )}
        {isPasteTarget && (
          <span className="nlb-chips">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); doChipPaste('start'); }}
              onContextMenu={(e) => {
                e.preventDefault(); e.stopPropagation();
                showIndicatorTip(e.clientX, e.clientY, t('angle_from_start_point', lang));
              }}
            >
              <img src={ossIcon('chip_start')} alt="" draggable={false} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); doChipPaste('end'); }}
              onContextMenu={(e) => {
                e.preventDefault(); e.stopPropagation();
                showIndicatorTip(e.clientX, e.clientY, t('angle_from_end_point', lang));
              }}
            >
              <img src={ossIcon('chip_end')} alt="" draggable={false} />
            </button>
          </span>
        )}
        {indicatorTip && (
          <span
            className="nlb-indicator-tip"
            style={{ left: indicatorTip.x + 8, top: indicatorTip.y + 12 }}
            aria-hidden
          >
            {indicatorTip.text}
          </span>
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
          onClose={() => { setMenu(null); setPasteOpen(false); setCopyOpen(false); }}
        />
      )}

      {shadowEditor && (
        <StrandShadowEditorDialog layerName={name} onClose={() => setShadowEditor(false)} />
      )}

      {/* Copy-badge popup: clipboard hint + Clear (show_strand_data_badge_popup). */}
      {badgeMenu && strandClipboard && (
        <ContextMenu
          items={[
            {
              label: t('strand_data_clipboard_hint', lang)
                .replace('{count}', String(clipboardPropertyCount(strandClipboard)))
                .replace('{source}', strandClipboard.source_layer_name),
              disabled: true,
            },
            { label: '', separator: true },
            { label: t('clear', lang), onClick: () => setStrandClipboard(null) },
          ]}
          x={badgeMenu.x}
          y={badgeMenu.y}
          onClose={() => setBadgeMenu(null)}
        />
      )}

    </>
  );
}
