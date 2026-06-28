import { useState } from 'react';
import { Modal } from '../Modal';
import { t } from '../i18n';
import type { Language, StrandRecord } from '../../model/types';

// Faithful port of WidthConfigDialog (numbered_layer_button.py:2902-3396).
// Total thickness is fixed in grid squares (grid_unit = 27 px); a slider sets the
// stroke (border) width per side in pixels, and the colour width is whatever is
// left: color = total - 2*stroke. get_values() returns int(color), int(stroke).
//
//   wholeSet = true   -> "Change Width" (applies to the whole set; NO elliptical)
//   wholeSet = false  -> "Change Width (This Layer Only)" (this strand + elliptical)
const GRID_UNIT = 27;
const DEFAULT_STROKE_PX = 4;

export function StrandWidthDialog({
  strand, wholeSet, lang, onClose, onApply,
}: {
  strand: StrandRecord;
  wholeSet: boolean;
  lang: Language;
  onClose: () => void;
  onApply: (width: number, strokeWidth: number, gridUnits: number, elliptical: boolean) => void;
}): JSX.Element {
  const showElliptical = !wholeSet;
  const ex = (strand.extra ?? {}) as Record<string, unknown>;

  // Initial total squares: width_in_grid_units if present, else derived from the
  // current width+2*stroke; clamped to the 0.5 minimum (numbered_layer_button.py:3109-3122).
  const initSquares = (() => {
    const u = ex.width_in_grid_units;
    let sq = typeof u === 'number' && u
      ? u
      : Math.round(((strand.width + 2 * strand.stroke_width) || (46 + 2 * DEFAULT_STROKE_PX)) / GRID_UNIT * 10) / 10;
    if (sq < 0.5) sq = 0.5;
    return sq;
  })();
  const initStrokePx = strand.stroke_width > 0 ? Math.round(strand.stroke_width) : DEFAULT_STROKE_PX;

  const clampStroke = (px: number, sq: number) => {
    const maxS = Math.max(1, Math.floor((sq * GRID_UNIT) / 2));
    return Math.max(1, Math.min(maxS, px));
  };

  const [squares, setSquares] = useState(initSquares);
  const [stroke, setStroke] = useState(() => clampStroke(initStrokePx, initSquares));
  const [elliptical, setElliptical] = useState(!!ex.elliptical_end_caps);

  const total = squares * GRID_UNIT;
  const maxStroke = Math.max(1, Math.floor(total / 2));
  const colorW = Math.max(0, total - 2 * stroke);

  const preview = t('width_preview_label', lang)
    .replace('{total}', String(Math.trunc(total)))
    .replace('{color}', String(Math.trunc(colorW)))
    .replace('{stroke}', String(Math.trunc(stroke)));

  // Spinbox change: clamp squares to [0.5, 100] at 1-decimal, then re-clamp the
  // stroke into the new range (numbered_layer_button.py:update_slider_range).
  const onSquares = (raw: string) => {
    let v = parseFloat(raw);
    if (Number.isNaN(v)) return;
    v = Math.max(0.5, Math.min(100, Math.round(v * 10) / 10));
    setSquares(v);
    setStroke((s) => clampStroke(s, v));
  };

  const apply = () => onApply(Math.trunc(colorW), Math.trunc(stroke), squares, elliptical);

  return (
    <Modal
      title={t(wholeSet ? 'change_width' : 'change_layer_width', lang)}
      onClose={onClose}
      lang={lang}
      onEnter={apply}
      width={450}
      footer={(
        <>
          <button onClick={apply}>{t('ok', lang)}</button>
          <button onClick={onClose}>{t('cancel', lang)}</button>
        </>
      )}
    >
      <div className="gd-row">
        <span className="gd-label" style={{ minWidth: 200 }}>{t('total_thickness_label', lang)}</span>
        <input
          type="number"
          min={0.5}
          max={100}
          step={1}
          value={squares}
          onChange={(e) => onSquares(e.target.value)}
        />
        <span style={{ opacity: 0.8 }}>{t('grid_squares', lang)}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span>{t('color_vs_stroke_label', lang)}</span>
        <input
          type="range"
          min={1}
          max={maxStroke}
          value={stroke}
          onChange={(e) => setStroke(clampStroke(Number(e.target.value), squares))}
        />
        <div style={{ textAlign: 'center', opacity: 0.85 }}>{stroke} {t('stroke_pixels_label', lang)}</div>
      </div>

      <div style={{ minHeight: 40, opacity: 0.9 }}>{preview}</div>

      {showElliptical && (
        <label className="gd-check" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={elliptical} onChange={(e) => setElliptical(e.target.checked)} />
          <span>{t('make_elliptical_end', lang)}</span>
        </label>
      )}
    </Modal>
  );
}
