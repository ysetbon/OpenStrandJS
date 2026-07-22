import React, { useState } from 'react';
import type { RGBA } from '../../model/types';

// Shared primitive controls for the settings pages. Faithful to settings_dialog.py:
// the green custom checkbox, the 64x27 colour swatch button (with a simple
// input+alpha popover per the chosen scope), themed number spins and selects.

export const rgbaCss = (c: RGBA): string => `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const toHex = (c: RGBA) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const fromHex = (h: string) => ({
  r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16),
});

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

// Colour swatch button (64x27 with a 22x22 alpha-checkerboard chip). Clicking
// toggles an inline popover with a native colour input + an alpha slider — the
// chosen "simple input + alpha" fidelity. Applies live via onChange.
export function ColorSwatch(
  { value, onChange, title }: { value: RGBA; onChange: (c: RGBA) => void; title?: string },
) {
  const [open, setOpen] = useState(false);
  const chipStyle: React.CSSProperties = {
    background: `linear-gradient(${rgbaCss(value)}, ${rgbaCss(value)}), repeating-conic-gradient(#bbb 0% 25%, #fff 0% 50%) 0 0 / 10px 10px`,
  };
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto' }}>
      <button
        type="button"
        className="set-swatch"
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="set-swatch-chip" style={chipStyle} />
      </button>
      {open && (
        <div
          className="set-color-pop"
          style={{ position: 'absolute', top: 'calc(100% + 4px)', insetInlineEnd: 0, zIndex: 5 }}
        >
          <input
            type="color"
            value={toHex(value)}
            onChange={(e) => { const { r, g, b } = fromHex(e.target.value); onChange({ r, g, b, a: value.a }); }}
          />
          <input
            type="range"
            min={0}
            max={255}
            value={value.a}
            title={`alpha ${value.a}`}
            onChange={(e) => onChange({ ...value, a: Number(e.target.value) })}
          />
          <span className="set-color-a">{value.a}</span>
          <button type="button" className="set-btn" style={{ minWidth: 0, minHeight: 0, padding: '2px 8px' }} onClick={() => setOpen(false)}>✕</button>
        </div>
      )}
    </span>
  );
}
