import { useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import {
  setArrowColor, setArrowTransparency, setArrowTexture, setArrowShaftStyle,
  setArrowHeadVisible, setArrowCastsShadow,
} from '../../store/actions';
import type { ArrowTexture, ArrowShaftStyle } from '../../store/actions';
import type { RGBA } from '../../model/types';
import { requestRender } from '../../renderer/renderScheduler';
import { t } from '../i18n';
import { ColorPickerDialog } from './ColorPickerDialog';

// OSS "Arrow Customization" (numbered_layer_button.py:1092-1350). Six per-strand
// controls plus the canvas-level size group:
//
//   Arrow Color         a colour well, defaulting to the strand's stroke colour
//   Arrow Transparency  slider 0..100 %, live % readout
//   Arrow Texture       none / stripes / dots / crosshatch   (head fill)
//   Arrow Shaft Style   solid / tiles / stripes / dots       (shaft overlay)
//   Show Arrow Head     checkbox, default on
//   Arrow Casts Shadow  checkbox, default off (see setArrowCastsShadow)
//   Arrow Sizes         the six canvas dimensions, shared with Settings
//
// SHAPE DEVIATION, deliberate: OSS embeds this panel INSIDE the context menu as a
// QWidgetAction, with the size group behind a nested "Adjust" popup. A browser
// context menu holding live sliders and selects is a worse control than a modal,
// and every other rich per-layer editor in this port is already a dialog
// (WidthConfigDialog, StrandShadowEditorDialog). The controls, ranges, defaults
// and effects are faithful; only the container differs.
//
// Gating matches OSS exactly: the entry point only appears while full_arrow_visible
// is set (:1093), because these settings drive the full arrow alone.
export function ArrowCustomizeDialog(props: { layerName: string; onClose: () => void }): JSX.Element | null {
  const { layerName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const strand = useEditorStore((s) => s.doc.strands[layerName]);
  const settings = useEditorStore((s) => s.settings);
  const setSettings = useEditorStore((s) => s.setSettings);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const mutateDoc = useEditorStore((s) => s.mutateDoc);
  const beginGesture = useEditorStore((s) => s.beginGesture);
  const commit = useEditorStore((s) => s.commit);

  const ex = (strand?.extra ?? {}) as Record<string, unknown>;
  const [transparency, setTransparencyLocal] = useState(
    typeof ex.arrow_transparency === 'number' ? ex.arrow_transparency : 100,
  );

  if (!strand) return null;

  const arrowColor = (ex.arrow_color as RGBA | undefined) ?? strand.stroke_color;
  const [colorDialog, setColorDialog] = useState(false);
  const texture = (ex.arrow_texture as ArrowTexture | undefined) ?? 'none';
  const shaft = (ex.arrow_shaft_style as ArrowShaftStyle | undefined) ?? 'solid';
  const headVisible = ex.arrow_head_visible !== false;
  const castsShadow = ex.arrow_casts_shadow === true;

  // Discrete control (checkbox, select) -> one undo step per change.
  const edit = (fn: Parameters<typeof commitEdit>[0]) => { commitEdit(fn); requestRender(); };

  // Continuous control (slider, colour well). These fire an onChange per pixel of
  // drag; routing each one through commitEdit would open and close a gesture per
  // frame and bury the pre-drag state under dozens of undo steps. beginGesture is
  // idempotent while a gesture is open, so the whole drag shares one baseline and
  // seal() closes it exactly once -- and commit() is a no-op when the document
  // did not actually change, so a stray seal costs nothing.
  const live = (fn: Parameters<typeof commitEdit>[0]) => { beginGesture(); mutateDoc(fn); requestRender(); };
  const seal = () => commit();
  const close = () => { seal(); onClose(); };

  // The six canvas-level dimensions the OSS "Arrow Sizes" popup edits. It writes
  // straight to the canvas AND mirrors into the settings dialog (:1293-1300), so
  // here it simply edits the same settings the General page owns.
  const SIZES: { key: keyof typeof settings & string; label: string; min: number; max: number; step: number }[] = [
    { key: 'arrow_head_length', label: 'arrow_head_length', min: 0, max: 500, step: 1 },
    { key: 'arrow_head_width', label: 'arrow_head_width', min: 0, max: 500, step: 1 },
    { key: 'arrow_head_stroke_width', label: 'arrow_head_stroke_width', min: 1, max: 30, step: 1 },
    { key: 'arrow_gap_length', label: 'arrow_gap_length', min: 0, max: 1000, step: 1 },
    { key: 'arrow_line_length', label: 'arrow_line_length', min: 0, max: 1000, step: 1 },
    { key: 'arrow_line_width', label: 'arrow_line_width', min: 0.1, max: 100, step: 0.1 },
  ];

  return (
    <Modal title={t('arrow_customization', lang)} onClose={close} lang={lang} width={430}
      footer={<button onClick={close}>{t('ok', lang)}</button>}>

      {/* OSS choose_arrow_color (:3815) opens a modal QColorDialog with an alpha
          channel and writes the colour once, on Accept. The well below is the button
          that opens it — not a native <input type="color">, whose OS popup applied a
          colour per drag frame and could not be cancelled. */}
      <div className="gd-row">
        <span className="gd-label">{t('arrow_color', lang)}</span>
        <span className="gd-spacer" />
        <button
          type="button"
          className="gd-color-well"
          style={{ backgroundColor: `rgba(${arrowColor.r}, ${arrowColor.g}, ${arrowColor.b}, ${arrowColor.a / 255})` }}
          title={rgbaToHex(arrowColor)}
          onClick={() => setColorDialog(true)}
        />
      </div>

      {colorDialog && (
        <ColorPickerDialog
          title={t('arrow_color', lang)}
          value={arrowColor}
          lang={lang}
          onAccept={(c) => edit((d) => setArrowColor(d, layerName, { ...c, a: arrowColor.a }))}
          onClose={() => setColorDialog(false)}
        />
      )}

      <div className="gd-row">
        <span className="gd-label">{t('arrow_transparency', lang)}</span>
        <input
          type="range" min={0} max={100} step={1} value={transparency}
          onChange={(e) => {
            const v = Number(e.target.value);
            setTransparencyLocal(v);
            live((d) => setArrowTransparency(d, layerName, v));
          }}
          onPointerUp={seal}
          onKeyUp={seal}
          onBlur={seal}
        />
        <span className="gd-value">{transparency}%</span>
      </div>

      <div className="gd-row">
        <span className="gd-label">{t('arrow_texture', lang)}</span>
        <span className="gd-spacer" />
        <select value={texture}
          onChange={(e) => edit((d) => setArrowTexture(d, layerName, e.target.value as ArrowTexture))}>
          {(['none', 'stripes', 'dots', 'crosshatch'] as const).map((k) => (
            <option key={k} value={k}>{t(`texture_${k}`, lang)}</option>
          ))}
        </select>
      </div>

      <div className="gd-row">
        <span className="gd-label">{t('arrow_shaft_style', lang)}</span>
        <span className="gd-spacer" />
        <select value={shaft}
          onChange={(e) => edit((d) => setArrowShaftStyle(d, layerName, e.target.value as ArrowShaftStyle))}>
          {(['solid', 'tiles', 'stripes', 'dots'] as const).map((k) => (
            <option key={k} value={k}>{t(`shaft_${k}`, lang)}</option>
          ))}
        </select>
      </div>

      <div className="gd-row">
        <label className="gd-label" style={{ minWidth: 0 }}>
          <input type="checkbox" checked={headVisible}
            onChange={(e) => edit((d) => setArrowHeadVisible(d, layerName, e.target.checked))} />
          {' '}{t('show_arrow_head', lang)}
        </label>
      </div>

      <div className="gd-row">
        <label className="gd-label" style={{ minWidth: 0 }}>
          <input type="checkbox" checked={castsShadow}
            onChange={(e) => edit((d) => setArrowCastsShadow(d, layerName, e.target.checked))} />
          {' '}{t('arrow_casts_shadow', lang)}
        </label>
      </div>

      <div className="gd-sub">
        <span className="gd-label">{t('arrow_sizes', lang)}</span>
        {SIZES.map((row) => (
          <div className="gd-row" key={row.key}>
            <span className="gd-label">{t(row.label, lang)}</span>
            <span className="gd-spacer" />
            <input
              type="number" min={row.min} max={row.max} step={row.step}
              value={settings[row.key] as number}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                setSettings({ [row.key]: Math.max(row.min, Math.min(row.max, v)) });
                requestRender();
              }}
            />
          </div>
        ))}
      </div>
    </Modal>
  );
}

const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const rgbaToHex = (c: RGBA | null | undefined): string =>
  (c ? `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` : '#000000');

