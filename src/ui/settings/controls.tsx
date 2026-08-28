import React, { useState } from 'react';
import type { RGBA } from '../../model/types';
import { useEditorStore } from '../../store/editorStore';
import { ColorPickerDialog } from '../dialogs/ColorPickerDialog';
import { t } from '../i18n';

// Shared primitive controls for the settings pages. Faithful to settings_dialog.py:
// the green custom checkbox, the 64x27 colour swatch button (which opens the modal
// colour dialog, as OSS's swatch buttons do), themed number spins and selects.

export const rgbaCss = (c: RGBA): string => `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;

// A labelled control row (label leading, control trailing).
export function Row(
  { label, children, wrap, title }: { label: React.ReactNode; children: React.ReactNode; wrap?: boolean; title?: string },
) {
  return (
    <div className={'set-row' + (wrap ? ' wrap' : '')} title={title}>
      <span className="set-label">{label}</span>
      {children}
    </div>
  );
}

// Custom green checkbox (setup_custom_checkmark). labelFirst mirrors OSS's
// arrow-color box-right special case.
export function Check(
  { label, checked, onChange, labelFirst, wrap, title }:
  { label: string; checked: boolean; onChange: (v: boolean) => void; labelFirst?: boolean; wrap?: boolean; title?: string },
) {
  return (
    <label className={'set-check' + (labelFirst ? ' label-first' : '')} title={title} style={wrap ? { whiteSpace: 'normal' } : undefined}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// A checkbox laid out as a full row (label on the leading edge, custom green box
// trailing). `disabled` mirrors OSS controls gated on another option.
export function CheckRow(
  { label, checked, onChange, wrap, title, disabled }:
  { label: string; checked: boolean; onChange: (v: boolean) => void; wrap?: boolean; title?: string; disabled?: boolean },
) {
  return (
    <Row label={label} wrap={wrap} title={title}>
      <input
        type="checkbox"
        className="set-toggle"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </Row>
  );
}

// Numeric spin input — OSS 1.109 SegmentedSpinBox (segmented_spin_box.py,
// c37da502 + the 406b24b9 gap tightening): a [− | value | +] segmented stepper
// replacing the native spin arrows. The center stays a directly editable field
// (typed entry clamps); the flat − / + segments step by `step` and round to
// `decimals` so float steps don't accumulate drift.
export function NumberInput(
  { value, onChange, min, max, step, decimals, title }:
  { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; decimals?: number; title?: string },
) {
  const clamp = (v: number) => {
    if (Number.isNaN(v)) return value;
    let n = v;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return n;
  };
  const stepBy = (dir: 1 | -1) => {
    const n = clamp(value + dir * (step ?? 1));
    onChange(decimals != null ? Number(n.toFixed(decimals)) : n);
  };
  return (
    <span className="set-num-seg" title={title}>
      <button type="button" tabIndex={-1} aria-label="decrease" onClick={() => stepBy(-1)}>−</button>
      <input
        type="number"
        className="set-num"
        value={decimals != null ? Number(value).toFixed(decimals) : value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => onChange(clamp(parseFloat(e.target.value)))}
      />
      <button type="button" tabIndex={-1} aria-label="increase" onClick={() => stepBy(1)}>+</button>
    </span>
  );
}

// Themed <select> combobox.
export function Select(
  { value, onChange, children, title }:
  { value: string; onChange: (v: string) => void; children: React.ReactNode; title?: string },
) {
  return (
    <select className="set-combo" value={value} title={title} onChange={(e) => onChange(e.target.value)}>
      {children}
    </select>
  );
}

// Themed push button.
export function Button(
  { onClick, children, wide, title, disabled }:
  { onClick: () => void; children: React.ReactNode; wide?: boolean; title?: string; disabled?: boolean },
) {
  return (
    <button type="button" className={'set-btn' + (wide ? ' wide' : '')} onClick={onClick} title={title} disabled={disabled}>
      {children}
    </button>
  );
}

// Colour swatch button (64x27 with a 22x22 alpha-checkerboard chip). Clicking opens
// the same modal colour dialog the layer menu uses: OSS's settings colour buttons
// (choose_shadow_color:6491, choose_default_arrow_color:6532,
// choose_default_strand_color:6570, choose_default_stroke_color:6601,
// choose_highlight_color:6631) all open a QColorDialog with ShowAlphaChannel and
// apply the colour only when it is accepted. The inline popover this replaces held
// a bare <input type="color"> whose OS picker anchored to a 36px well inside a
// scrolling panel — it could open clipped at the viewport edge — and it had no way
// to cancel: every drag frame was already applied.
export function ColorSwatch(
  { value, onChange, title }: { value: RGBA; onChange: (c: RGBA) => void; title?: string },
) {
  const [open, setOpen] = useState(false);
  const lang = useEditorStore((st) => st.settings.language);
  const chipStyle: React.CSSProperties = {
    background: `linear-gradient(${rgbaCss(value)}, ${rgbaCss(value)}), repeating-conic-gradient(#bbb 0% 25%, #fff 0% 50%) 0 0 / 10px 10px`,
  };
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto' }}>
      <button
        type="button"
        className="set-swatch"
        title={title}
        onClick={() => setOpen(true)}
      >
        <span className="set-swatch-chip" style={chipStyle} />
      </button>
      {open && (
        <ColorPickerDialog
          title={title ?? t('change_color', lang)}
          value={value}
          lang={lang}
          onAccept={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
