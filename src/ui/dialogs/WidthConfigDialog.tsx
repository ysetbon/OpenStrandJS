import { useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { setWidth, setWidthGridUnits } from '../../store/actions';
import { requestRender } from '../../renderer/renderScheduler';
import { t } from '../i18n';

// OSS WidthConfigDialog (numbered_layer_button.py:3892-4400). Total thickness is
// expressed in GRID SQUARES of 27px — chosen so the default strand (46px colour +
// 2x4px stroke = 54px) is exactly 2 squares (:4085-4088) — and the slider then
// splits that fixed total between colour and stroke:
//
//   total  = squares * 27
//   stroke = slider value, in px PER SIDE, clamped to [1, floor(total / 2)]
//   colour = max(0, total - 2 * stroke)
//
// so pushing the slider to its maximum leaves a strand that is all stroke. The
// arithmetic already lived in NumberedLayerButton; what was missing was the dialog
// — the grid-square count was collected through window.prompt, which meant no
// slider, no live preview, and no way to redistribute colour vs stroke at all.
//
// NOT ported: the "Match connected strand (elliptical end-cap)" checkbox that OSS
// adds for the per-layer variant (:4176-4184). elliptical_end_caps round-trips
// through the `extra` bag, but the renderer has no elliptical-cap geometry yet
// (strand-renderer.js:234), so surfacing the checkbox would only add another
// control that changes nothing on the canvas.
const GRID_UNIT = 27;

export function WidthConfigDialog(props: {
  layerName: string;
  /** true = OSS "Change Width" (whole set); false = "Change Width (This Layer Only)". */
  wholeSet: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const { layerName, wholeSet, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const strand = useEditorStore((s) => s.doc.strands[layerName]);
  const defWidth = useEditorStore((s) => s.settings.default_strand_width);
  const defStroke = useEditorStore((s) => s.settings.default_stroke_width);

  // OSS prefers the stored width_in_grid_units and only derives from the pixel
  // widths when it is absent, falling back to the SETTINGS defaults for a strand
  // with no width at all (:4092-4115).
  const [squares, setSquares] = useState(() => {
    if (!strand) return 2;
    const stored = strand.extra.width_in_grid_units;
    if (typeof stored === 'number' && stored) return Math.max(0.5, stored);
    const px = strand.width > 0
      ? strand.width + 2 * strand.stroke_width
      : defWidth + 2 * defStroke;
    return Math.max(0.5, Math.round((px / GRID_UNIT) * 10) / 10);
  });
  const [stroke, setStroke] = useState(() => {
    const px = strand && strand.stroke_width > 0 ? strand.stroke_width : defStroke;
    return Math.max(1, Math.round(px));
  });

  if (!strand) return null;

  const total = squares * GRID_UNIT;
  const maxStroke = Math.max(1, Math.floor(total / 2));
  // Qt reconfigures the slider's range on every thickness change and clamps the
  // current value into it (update_slider_range :4345-4360); deriving the effective
  // value here does the same without a second piece of state to keep in sync.
  const effStroke = Math.max(1, Math.min(maxStroke, stroke));
  const colorWidth = Math.max(0, total - 2 * effStroke);

  const apply = () => {
    useEditorStore.getState().commitEdit((d) => {
      setWidth(d, layerName, 'width', Math.trunc(colorWidth), wholeSet);
      setWidth(d, layerName, 'stroke_width', Math.trunc(effStroke), wholeSet);
      setWidthGridUnits(d, layerName, squares, wholeSet);
    });
    requestRender();
    onClose();
  };

  const preview = t('width_preview_label', lang)
    .replace('{total}', String(Math.trunc(total)))
    .replace('{color}', String(Math.trunc(colorWidth)))
    .replace('{stroke}', String(Math.trunc(effStroke)));

  return (
    <Modal
      title={t('change_width', lang)}
      onClose={onClose}
      lang={lang}
      onEnter={apply}
      width={450}
      footer={
        <>
          <button onClick={apply}>{t('ok', lang)}</button>
          <button onClick={onClose}>{t('cancel', lang)}</button>
        </>
      }
    >
      <div className="gd-row">
        <span className="gd-label">{t('total_thickness_label', lang)}</span>
        {/* OSS: QDoubleSpinBox range 0.5..100, ONE decimal, arrows step a whole
            square so 2 -> 3 -> 4 while 3.5 stays typeable (:4124-4129). */}
        <input
          type="number" min={0.5} max={100} step={1} value={squares}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) setSquares(Math.max(0.5, Math.min(100, Math.round(v * 10) / 10)));
          }}
        />
        <span className="gd-label">{t('grid_squares', lang)}</span>
      </div>

      <div className="gd-row gd-col">
        <span className="gd-label">{t('color_vs_stroke_label', lang)}</span>
        <input
          type="range" min={1} max={maxStroke} step={1} value={effStroke}
          onChange={(e) => setStroke(Number(e.target.value))}
        />
        <span className="gd-label">{effStroke} {t('stroke_pixels_label', lang)}</span>
      </div>

      <div className="gd-row">
        <span className="gd-label">{preview}</span>
      </div>
    </Modal>
  );
}
