import { useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { setWidth, setWidthGridUnits } from '../../store/actions';
import { t } from '../i18n';

// OSS WidthConfigDialog (numbered_layer_button.py:3750-4244) — the per-strand
// "Change Width" dialog (whole-set and this-layer-only variants):
//   * grid_unit = 27 px per square (:3946).
//   * Total Thickness (grid squares): spinbox 0.5-100.0, 1 decimal, step 1.0;
//     init from width_in_grid_units or round((width+2*stroke)/27, 1), >= 0.5.
//   * Color vs Stroke Distribution slider sets the STROKE px per side directly:
//     range 1..max(1, floor(total/2)), re-clamped whenever total changes
//     (update_slider_range :4202-4217); color = max(0, total - 2*stroke).
//   * Readout "{stroke} px stroke (each side)" + live preview line
//     "Total: {total}px | Color: {color}px | Stroke: {stroke}px each side".
//   * Per-layer variant adds the "Match connected strand (elliptical end-cap)"
//     checkbox writing strand.elliptical_end_caps (:4036-4042, 3627-3631).
//   * OK returns (int(color), int(stroke)); Cancel discards (:4236-4244).
const GRID_UNIT = 27;

export function WidthConfigDialog(props: {
  layerName: string;
  wholeSet: boolean;
  onClose: () => void;
}): JSX.Element {
  const { layerName, wholeSet, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const strand = useEditorStore((s) => s.doc.strands[layerName]);
  const commitEdit = useEditorStore((s) => s.commitEdit);

  const initUnits = (() => {
    if (!strand) return 2;
    const u = strand.extra.width_in_grid_units;
    if (typeof u === 'number' && u >= 0.5) return Math.round(u * 10) / 10;
    return Math.max(0.5, Math.round(((strand.width + 2 * strand.stroke_width) / GRID_UNIT) * 10) / 10);
  })();
  const [units, setUnits] = useState(initUnits);
  const maxStroke = (u: number) => Math.max(1, Math.floor((u * GRID_UNIT) / 2));
  const [stroke, setStroke] = useState(() =>
    Math.max(1, Math.min(maxStroke(initUnits), Math.round(strand?.stroke_width ?? 4))));
  const [elliptical, setElliptical] = useState(!!strand?.extra.elliptical_end_caps);

  const total = units * GRID_UNIT;
  const color = Math.max(0, total - 2 * stroke);

  const changeUnits = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    const u = Math.max(0.5, Math.min(100, Math.round(raw * 10) / 10));
    setUnits(u);
    setStroke((prev) => Math.max(1, Math.min(maxStroke(u), prev))); // OSS update_slider_range re-clamp
  };

  const apply = () => {
    if (!strand) { onClose(); return; }
    commitEdit((d) => {
      setWidth(d, layerName, 'width', Math.trunc(color), wholeSet);
      setWidth(d, layerName, 'stroke_width', Math.trunc(stroke), wholeSet);
      setWidthGridUnits(d, layerName, units, wholeSet);
      if (!wholeSet) {
        const s = d.strands[layerName];
        if (s) s.extra.elliptical_end_caps = elliptical;
      }
    });
    onClose();
  };

  return (
    <Modal
      title={t('change_width', lang)}
      lang={lang}
      onClose={onClose}
      onEnter={apply}
      width={400}
      footer={
        <>
          <button onClick={apply}>{t('ok', lang)}</button>
          <button onClick={onClose}>{t('cancel', lang)}</button>
        </>
      }
    >
      <div className="gd-row">
        <span className="gd-label">{t('total_thickness_label', lang)}</span>
        <input
          type="number"
          dir="ltr"
          min={0.5}
          max={100}
          step={1}
          value={units}
          onChange={(e) => changeUnits(Number(e.target.value))}
        />
        <span className="gd-label">{t('grid_squares', lang)}</span>
      </div>
      <div className="gd-row">
        <span className="gd-label">{t('color_vs_stroke_label', lang)}</span>
      </div>
      <div className="gd-row">
        <input
          type="range"
          min={1}
          max={maxStroke(units)}
          step={1}
          value={stroke}
          onChange={(e) => setStroke(Number(e.target.value))}
        />
      </div>
      <div className="gd-row" style={{ justifyContent: 'center' }}>
        <span className="gd-label">{`${Math.trunc(stroke)} ${t('stroke_pixels_label', lang)}`}</span>
      </div>
      <div className="gd-row" style={{ justifyContent: 'center' }}>
        <span className="gd-label">
          {t('width_preview_label', lang)
            .replace('{total}', String(Math.trunc(total)))
            .replace('{color}', String(Math.trunc(color)))
            .replace('{stroke}', String(Math.trunc(stroke)))}
        </span>
      </div>
      {!wholeSet && (
        <div className="gd-row">
          <label className="gd-check">
            <input
              type="checkbox"
              checked={elliptical}
              onChange={(e) => setElliptical(e.target.checked)}
            />
            <span>{t('make_elliptical_end', lang)}</span>
          </label>
        </div>
      )}
    </Modal>
  );
}
