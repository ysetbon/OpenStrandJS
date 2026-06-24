import { useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { t } from '../i18n';
import type { Language } from '../../model/types';

// Faithful port of DefaultWidthConfigDialog (settings_dialog.py). Total thickness
// is fixed in grid squares (grid_unit = 23 px); a slider splits it into colour vs
// stroke. OK returns int(color_width), int(stroke_width) — replicated exactly.
const GRID_UNIT = 23;

export function DefaultWidthDialog({ lang, onClose }: { lang: Language; onClose: () => void }) {
  const s = useEditorStore.getState().settings;
  const set = useEditorStore((st) => st.setSettings);

  // Initial total squares from current strand+2*stroke, clamped >=2 and made even.
  const initSquares = (() => {
    const totalW = s.default_strand_width + 2 * s.default_stroke_width;
    let sq = Math.round(totalW / GRID_UNIT);
    if (sq < 2) sq = 2;
    else if (sq % 2 !== 0) sq += 1;
    return sq;
  })();
  const initPct = (() => {
    const totalW = s.default_strand_width + 2 * s.default_stroke_width;
    const p = totalW > 0 ? Math.round((s.default_strand_width / totalW) * 100) : 50;
    return Math.max(10, Math.min(90, p));
  })();

  const [squares, setSquares] = useState(initSquares);
  const [pct, setPct] = useState(initPct);

  const totalW = squares * GRID_UNIT;
  const colorW = totalW * (pct / 100);
  const strokeW = (totalW - colorW) / 2;

  const preview = t('width_preview_label', lang)
    .replace('{total}', String(Math.trunc(totalW)))
    .replace('{color}', String(Math.trunc(colorW)))
    .replace('{stroke}', String(Math.trunc(strokeW)));

  const apply = () => {
    set({
      default_strand_width: Math.trunc(colorW),
      default_stroke_width: Math.trunc(strokeW),
      default_width_grid_units: squares,
    });
    onClose();
  };

  return (
    <Modal
      title={t('default_strand_width', lang)}
      onClose={onClose}
      lang={lang}
      onEnter={apply}
      footer={(
        <>
          <button className="set-btn" onClick={apply}>{t('ok', lang)}</button>
          <button className="set-btn" onClick={onClose}>{t('cancel', lang)}</button>
        </>
      )}
    >
      <div className="set-page" style={{ minWidth: 360 }}>
        <div className="set-row">
          <span className="set-label">{t('total_thickness_label', lang)}</span>
          <input
            type="number"
            className="set-num"
            min={2}
            max={20}
            step={2}
            value={squares}
            onChange={(e) => {
              let v = Math.round(parseFloat(e.target.value));
              if (Number.isNaN(v)) return;
              v = Math.max(2, Math.min(20, v));
              if (v % 2 !== 0) v += v < 20 ? 1 : -1; // keep even
              setSquares(v);
            }}
          />
          <span style={{ opacity: 0.8 }}>{t('grid_squares', lang)}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>{t('color_vs_stroke_label', lang)}</span>
          <input
            type="range"
            min={10}
            max={90}
            value={pct}
            onChange={(e) => setPct(Number(e.target.value))}
          />
          <div style={{ textAlign: 'center', opacity: 0.85 }}>{pct}{t('percent_available_color', lang)}</div>
        </div>

        <div style={{ minHeight: 40 }}>{preview}</div>
      </div>
    </Modal>
  );
}
