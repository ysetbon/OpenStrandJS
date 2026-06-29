import { useEffect } from 'react';
import { Modal } from '../Modal';
import { ColorField } from '../ColorField';
import { useEditorStore } from '../../store/editorStore';
import { setArrowCustomization } from '../../store/actions';
import { t } from '../i18n';
import type { RGBA } from '../../model/types';

// OSS arrow-customization sub-widget (numbered_layer_button.py:577-729), shown when a
// strand's full arrow is visible. OSS embeds it inline in the context menu; the JS
// ContextMenu can't host dropdowns/sliders, so we present the same six controls in a
// small modal. Applies immediately (one undo step), matching OSS.
//   * Color / Transparency / Show Head — RENDERED by the full-arrow renderer.
//   * Texture / Shaft Style / Casts Shadow — STORED-ONLY (Qt pixmap-tile brushes and
//     arrow shadow are not ported to the canvas renderer); they round-trip + drive OSS.
const TEXTURES = ['none', 'stripes', 'dots', 'crosshatch'] as const;
const TEXTURE_KEYS = ['texture_none', 'texture_stripes', 'texture_dots', 'texture_crosshatch'] as const;
const SHAFTS = ['solid', 'tiles', 'stripes', 'dots'] as const;
const SHAFT_KEYS = ['shaft_solid', 'shaft_tiles', 'shaft_stripes', 'shaft_dots'] as const;

export function ArrowCustomizeDialog(props: {
  layerName: string;
  onClose: () => void;
}): JSX.Element {
  const { layerName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const strand = useEditorStore((s) => s.doc.strands[layerName]);
  const ex = (strand?.extra ?? {}) as Record<string, unknown>;

  useEffect(() => {
    useEditorStore.getState().beginGesture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => { useEditorStore.getState().commit(); onClose(); };
  const set = (patch: Parameters<typeof setArrowCustomization>[2]) =>
    useEditorStore.getState().mutateDoc((d) => setArrowCustomization(d, layerName, patch));

  // Current values (defaults match OSS: color -> stroke_color, transparency 100,
  // texture none, shaft solid, head visible, casts shadow true).
  const color = (ex.arrow_color as RGBA | null | undefined) ?? strand?.stroke_color ?? { r: 0, g: 0, b: 0, a: 255 };
  const transparency = (ex.arrow_transparency as number | undefined) ?? 100;
  const texture = (ex.arrow_texture as string | undefined) ?? 'none';
  const shaft = (ex.arrow_shaft_style as string | undefined) ?? 'solid';
  const headVisible = (ex.arrow_head_visible as boolean | undefined) ?? true;
  const castsShadow = (ex.arrow_casts_shadow as boolean | undefined) ?? true;

  const storedNote = t('arrow_stored_only_note', lang);

  return (
    <Modal
      title={t('customize_arrow', lang).replace('…', '')}
      onClose={close}
      lang={lang}
      modeless
      onEnter={close}
      width={360}
      footer={<button onClick={close}>{t('close', lang)}</button>}
    >
      <div className="gd-row">
        <ColorField label={t('arrow_color', lang)} value={color} onChange={(c) => set({ arrow_color: c })} />
      </div>

      <div className="gd-row">
        <span className="gd-label" style={{ minWidth: 150 }}>{t('arrow_transparency', lang)}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={transparency}
          onChange={(e) => set({ arrow_transparency: Number(e.target.value) })}
        />
        <span style={{ minWidth: 36, textAlign: 'right' }}>{transparency}%</span>
      </div>

      <div className="gd-row" title={storedNote}>
        <span className="gd-label" style={{ minWidth: 150 }}>{t('arrow_texture', lang)}</span>
        <select value={texture} onChange={(e) => set({ arrow_texture: e.target.value })}>
          {TEXTURES.map((v, i) => <option key={v} value={v}>{t(TEXTURE_KEYS[i], lang)}</option>)}
        </select>
      </div>

      <div className="gd-row" title={storedNote}>
        <span className="gd-label" style={{ minWidth: 150 }}>{t('arrow_shaft_style', lang)}</span>
        <select value={shaft} onChange={(e) => set({ arrow_shaft_style: e.target.value })}>
          {SHAFTS.map((v, i) => <option key={v} value={v}>{t(SHAFT_KEYS[i], lang)}</option>)}
        </select>
      </div>

      <label className="gd-check" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={headVisible} onChange={(e) => set({ arrow_head_visible: e.target.checked })} />
        <span>{t('show_arrow_head', lang)}</span>
      </label>

      <label className="gd-check" style={{ cursor: 'pointer' }} title={storedNote}>
        <input type="checkbox" checked={castsShadow} onChange={(e) => set({ arrow_casts_shadow: e.target.checked })} />
        <span>{t('arrow_casts_shadow', lang)}</span>
      </label>
    </Modal>
  );
}
