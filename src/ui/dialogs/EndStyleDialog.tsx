import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { copyEndStyleToOtherEnd, setEndStyle, setLineVisible } from '../../store/actions';
import {
  DEPTH_SHAPES, END_SHAPES, TILT_MAX, defaultEndStyle, normalizeEndStyle,
} from '../../model/endStyle';
import type { EndShape, EndStyle } from '../../model/endStyle';
import type { RGBA, RenderMeta, RenderStrand, StrandRecord } from '../../model/types';
import { callRenderTo } from '../../renderer/rendererBridge';
import { buildMeta, toRenderArray } from '../../renderer/toRenderArray';
import { requestRender } from '../../renderer/renderScheduler';
import { NumberInput } from '../settings/controls';
import { t } from '../i18n';
import { ColorPickerDialog } from './ColorPickerDialog';
import './endStyleDialog.css';

// OSS 1.111 "Stylize End Side" (end_style_dialog.py). Opened from a layer
// button's right-click menu for ONE free end of a strand; edits that end's
// style record (model/endStyle.ts) and previews every change live on the
// canvas, like the shadow editor: Cancel puts the end back exactly as it was
// when the dialog opened, OK keeps the result and saves one undo step.
//
// The controls are OSS's own: the shape picker (six real-geometry icons), the
// Move Group dialog's slider rows (label / slider / live value / text field),
// the Settings dialog's segmented [ - | value | + ] stepper, the mask-grid
// checkbox. The preview picture is the strand's actual end, painted by the
// same renderer the canvas uses, centred on the endpoint with a dashed green
// circle marking it.

const ANGLED_DEFAULT_TILT = 30;   // what Angled starts at when picked with Tilt still at 0
const PREVIEW_W = 380, PREVIEW_H = 120;
const ICON_W = 56, ICON_H = 34;

type Side = 0 | 1;

function lineVisibleOf(s: StrandRecord, side: Side): boolean {
  return s.extra[side === 0 ? 'start_line_visible' : 'end_line_visible'] !== false;
}

const rgbaCss = (c: RGBA) => `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;

export function EndStyleDialog(props: { layerName: string; side: Side; onClose: () => void }): JSX.Element | null {
  const { layerName, side, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const theme = useEditorStore((s) => s.settings.theme);
  const settings = useEditorStore((s) => s.settings);
  const strand = useEditorStore((s) => s.doc.strands[layerName]);
  const docRevision = useEditorStore((s) => s.docRevision);
  const dark = theme === 'dark';

  // The record the controls start from (a null style reads as the default).
  const initial = useMemo(() => {
    const st = useEditorStore.getState().doc.strands[layerName];
    const cur = normalizeEndStyle(st?.end_styles?.[side]) ?? defaultEndStyle();
    return {
      style: cur,
      lineVisible: st ? lineVisibleOf(st, side) : true,
      strokeColor: st?.stroke_color ?? { r: 0, g: 0, b: 0, a: 255 },
      strokeWidth: st?.stroke_width ?? 4,
      total: st ? st.width + 2 * st.stroke_width : 54,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [shape, setShape] = useState<EndShape>(initial.style.shape);
  const [tilt, setTilt] = useState(Math.round(initial.style.tilt));
  const [depth, setDepth] = useState(Math.round(initial.style.depth * 100));
  const offsetMin = -Math.floor(initial.total / 2), offsetMax = Math.ceil(initial.total * 2);
  const [offset, setOffset] = useState(Math.round(Math.max(offsetMin, Math.min(offsetMax, initial.style.offset))));
  const [showLine, setShowLine] = useState(initial.lineVisible);
  const [thickness, setThickness] = useState(Math.max(1, Math.round(initial.style.line_width ?? initial.strokeWidth)));
  const [useStrokeColor, setUseStrokeColor] = useState(initial.style.line_color == null);
  const [pinnedColor, setPinnedColor] = useState<RGBA>(initial.style.line_color ?? initial.strokeColor);
  const [bothEnds, setBothEnds] = useState(false);
  const [colorDialog, setColorDialog] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [icons, setIcons] = useState<Record<string, string>>({});
  // Set once a control has been touched. OSS applies only on a control change
  // (_apply_live), never on open: a record loaded with values the integer
  // controls cannot show (depth 0.333, tilt 12.5, a fractional stroke width)
  // must survive an open + OK untouched, and must not cost an undo step.
  const touched = useRef(false);
  // Set by OK / Cancel so the unmount cleanup knows the gesture was closed.
  const settled = useRef(false);

  // One gesture for the whole dialog: its baseline is the snapshot Cancel
  // restores, and OK commits it as one undo step (end_style_dialog.py accept /
  // reject). beginGesture is a no-op while a gesture is already open, so the
  // dialog can never bury another gesture's baseline.
  useEffect(() => {
    useEditorStore.getState().beginGesture({
      action: 'strand.end_style', source: 'dialog', targets: [layerName], detail: side === 0 ? 'start' : 'end',
    });
    // Unmounted without OK / Cancel (the layer button re-rendered away, the
    // strand vanished): close the gesture the way Cancel would, so the baseline
    // never lingers to become some later edit's undo snapshot.
    return () => {
      if (!settled.current) {
        useEditorStore.getState().cancelGesture();
        requestRender();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The record described by the controls (normalizeEndStyle may turn it null).
  const currentStyle = (): EndStyle => ({
    shape,
    tilt,
    depth: depth / 100,
    offset,
    line_width: Math.abs(thickness - initial.strokeWidth) < 1e-6 ? null : thickness,
    line_color: useStrokeColor ? null : { ...pinnedColor },
  });

  // Live apply: every control change lands on the canvas immediately
  // (end_style_dialog.py _apply_live). mutateDocLive edits the gesture's live
  // document in place, so a slider drag never clones the whole document per step.
  useEffect(() => {
    if (!touched.current) return;
    const st = useEditorStore.getState();
    const apply = (d: typeof st.doc) => {
      setEndStyle(d, layerName, side, currentStyle());
      setLineVisible(d, layerName, side === 0 ? 'start' : 'end', showLine);
    };
    if (st.gestureBase) st.mutateDocLive(apply); else st.mutateDoc(apply);
    requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, tilt, depth, offset, showLine, thickness, useStrokeColor, pinnedColor]);

  // Every control goes through this, so the live apply above knows a change
  // came from the user and not from the mount.
  const touch = <T,>(set: (v: T) => void) => (v: T) => { touched.current = true; set(v); };
  const setShapeT = touch(setShape), setTiltT = touch(setTilt), setDepthT = touch(setDepth);
  const setOffsetT = touch(setOffset), setShowLineT = touch(setShowLine), setThicknessT = touch(setThickness);
  const setUseStrokeColorT = touch(setUseStrokeColor), setPinnedColorT = touch(setPinnedColor);

  // Preview picture: the real end, as the canvas paints it, centred on the
  // endpoint (end_style_dialog.py _paint_preview). Re-painted after every live
  // apply, which is what docRevision tracks.
  useEffect(() => {
    const canvas = previewRef.current;
    const st = useEditorStore.getState();
    const s = st.doc.strands[layerName];
    if (!canvas || !s) return;
    const total = s.width + 2 * s.stroke_width;
    const scale = Math.min(1.6, 0.6 * PREVIEW_H / Math.max(total, 1));
    const point = side === 0 ? s.start : s.end;
    paintPreview(canvas, toRenderArray({ ...st.doc, order: [layerName] }), {
      ...buildMeta(st.doc, { ...st.view, zoom: scale, width: PREVIEW_W, height: PREVIEW_H }, st.settings),
      image_width: PREVIEW_W, image_height: PREVIEW_H, supersample: 2,
      x_offset: PREVIEW_W / 2 - point.x * scale, y_offset: PREVIEW_H / 2 - point.y * scale,
      shadow_enabled: false, show_grid: false, canvas_bg: 'transparent', scene_key: undefined,
    }, scale, dark);
  }, [docRevision, layerName, side, dark]);

  // Shape icons: a tiny real-geometry sample of each end shape, in the strand's
  // colours (end_style_dialog.py _shape_icon). Painted once per open.
  useEffect(() => {
    const s = useEditorStore.getState().doc.strands[layerName];
    if (!s) return;
    const out: Record<string, string> = {};
    const canvas = document.createElement('canvas');
    for (const key of END_SHAPES) {
      const sample: RenderStrand = {
        type: 'Strand', layer_name: 'icon', start: { x: -30, y: ICON_H / 2 }, end: { x: ICON_W - 16, y: ICON_H / 2 },
        width: 16, stroke_width: 2, color: s.color, stroke_color: s.stroke_color, has_circles: [false, false],
        control_points: [{ x: -10, y: ICON_H / 2 }, { x: ICON_W - 30, y: ICON_H / 2 }],
        control_point_center: null, control_point_center_locked: false,
        start_line_visible: true, end_line_visible: true,
        end_styles: [null, {
          shape: key, depth: 0.6, tilt: key === 'angled' ? 30 : 0,
          // any non-default value so the styled path is used
          offset: key === 'straight' ? 0.001 : 0, line_width: null, line_color: null,
        }],
      };
      const meta: RenderMeta = {
        ...buildMeta(useEditorStore.getState().doc, { ...useEditorStore.getState().view, zoom: 1, width: ICON_W, height: ICON_H }, settings),
        image_width: ICON_W, image_height: ICON_H, x_offset: 0, y_offset: 0, supersample: 2, zoom: 1,
        shadow_enabled: false, show_grid: false, canvas_bg: 'transparent', scene_key: undefined,
        enable_third_control_point: false,
      };
      try {
        callRenderTo(canvas, [sample], meta);
        out[key] = canvas.toDataURL('image/png');
      } catch { /* icon stays blank; the label still names the shape */ }
    }
    setIcons(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!strand) return null;

  const isAttached = strand.type === 'AttachedStrand';
  const hasTwoFreeEnds = !isAttached && !strand.has_circles[0] && !strand.has_circles[1];
  const tiltEnabled = shape !== 'straight';
  const depthEnabled = DEPTH_SHAPES.includes(shape);
  const swatch = useStrokeColor ? strand.stroke_color : pinnedColor;

  const onShape = (key: EndShape) => {
    const previous = shape;
    setShapeT(key);
    if (key === 'straight') setTiltT(0);
    // Angled is the slanted cut: start it visibly slanted
    else if (key === 'angled' && previous === 'straight' && tilt === 0) setTiltT(ANGLED_DEFAULT_TILT);
  };

  const resetToStraight = () => {
    setShapeT('straight');
    setTiltT(0);
    setDepthT(50);
    setOffsetT(0);
    setThicknessT(Math.max(1, Math.round(initial.strokeWidth)));
    setUseStrokeColorT(true);
    setShowLineT(true);
  };

  const accept = () => {
    settled.current = true;
    const st = useEditorStore.getState();
    if (bothEnds && hasTwoFreeEnds) {
      const apply = (d: typeof st.doc) => copyEndStyleToOtherEnd(d, layerName, side);
      if (st.gestureBase) st.mutateDocLive(apply); else st.mutateDoc(apply);
    }
    st.commit({ action: 'strand.end_style', source: 'dialog', targets: [layerName], detail: side === 0 ? 'start' : 'end' });
    requestRender();
    onClose();
  };

  // Cancel / Escape / the title-bar X: put both ends back exactly as they were
  // (end_style_dialog.py restore_snapshot) — no undo entry.
  const cancel = () => {
    settled.current = true;
    useEditorStore.getState().cancelGesture();
    requestRender();
    onClose();
  };

  const sideText = t(side === 0 ? 'side_start' : 'side_end', lang);
  const header = t('end_style_header', lang).replace('{layer}', layerName).replace('{side}', sideText);

  const sliderRow = (
    label: string, lo: number, hi: number, value: number, fmt: (v: number) => string,
    set: (v: number) => void, enabled: boolean,
  ) => (
    <div className={'gd-row es-slider-row' + (enabled ? '' : ' es-disabled')}>
      <span className="gd-label">{label}</span>
      <input type="range" min={lo} max={hi} step={1} value={value} disabled={!enabled}
        onChange={(e) => set(Number(e.target.value))} />
      <span className="gd-value">{fmt(value)}</span>
      <input type="number" className="es-field" min={lo} max={hi} step={1} value={value} disabled={!enabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) set(Math.max(lo, Math.min(hi, Math.round(v))));
        }} />
    </div>
  );

  return (
    <Modal
      title={t('stylize_end_side', lang)}
      onClose={cancel}
      onEnter={accept}
      lang={lang}
      // Wide enough for the six shape buttons on one row, as OSS opens it; the
      // grid reflows to two rows of three on a narrow screen (ShapeGrid).
      width={640}
      dismissOnBackdrop={false}
      closeButton
      footer={
        <>
          <button type="button" onClick={resetToStraight}>{t('reset_to_straight', lang)}</button>
          <span className="es-footer-spacer" />
          <button type="button" onClick={accept}>{t('ok', lang)}</button>
          <button type="button" onClick={cancel}>{t('cancel', lang)}</button>
        </>
      }
    >
      <div className="es-header">{header}</div>

      {/* Preview */}
      <div className="es-section">
        <div className="es-section-title">{t('end_style_preview', lang)}</div>
        <canvas ref={previewRef} className="es-preview" width={PREVIEW_W * 2} height={PREVIEW_H * 2} />
        <div className="es-hint">{t('end_style_live_hint', lang)}</div>
      </div>

      {/* End shape */}
      <div className="es-section">
        <div className="es-section-title">{t('end_shape', lang)}</div>
        <div className="es-shape-grid">
          {END_SHAPES.map((key) => (
            <button
              key={key}
              type="button"
              className={'es-shape-btn' + (shape === key ? ' active' : '')}
              onClick={() => onShape(key)}
              aria-pressed={shape === key}
            >
              {icons[key]
                ? <img src={icons[key]} width={ICON_W} height={ICON_H} alt="" draggable={false} />
                : <span className="es-shape-icon-blank" />}
              <span>{t(`end_shape_${key}`, lang)}</span>
            </button>
          ))}
        </div>
        {sliderRow(t('end_tilt', lang), -TILT_MAX, TILT_MAX, tilt, (v) => `${v > 0 ? '+' : ''}${v}°`, setTiltT, tiltEnabled)}
        <div className="es-hint">{t('end_tilt_hint', lang)}</div>
        {sliderRow(t('end_depth', lang), 0, 100, depth, (v) => `${v} %`, setDepthT, depthEnabled)}
        <div className="es-hint">{t('end_depth_hint', lang)}</div>
        <div className="gd-row">
          <span className="gd-label">{t('end_extend_trim', lang)}</span>
          <NumberInput value={offset} min={offsetMin} max={offsetMax} step={1}
            onChange={(v) => setOffsetT(Math.round(v))} />
          <span className="gd-label" style={{ minWidth: 0 }}>{t('px', lang)}</span>
        </div>
        <div className="es-hint">{t('end_extend_trim_hint', lang)}</div>
      </div>

      {/* Side line */}
      <div className="es-section">
        <div className="es-section-title">{t('side_line_section', lang)}</div>
        <label className="set-check es-check">
          <input type="checkbox" checked={showLine} onChange={(e) => setShowLineT(e.target.checked)} />
          <span>{t('show_side_line', lang)}</span>
        </label>
        <div className={'gd-row' + (showLine ? '' : ' es-disabled')}>
          <span className="gd-label">{t('side_line_thickness', lang)}</span>
          <NumberInput value={thickness} min={1} max={40} step={1} onChange={(v) => setThicknessT(Math.round(v))} />
          <span className="gd-label" style={{ minWidth: 0 }}>{t('px', lang)}</span>
        </div>
        <div className={'gd-row' + (showLine ? '' : ' es-disabled')}>
          <span className="gd-label">{t('side_line_color', lang)}</span>
          <button
            type="button"
            className="gd-color-well"
            style={{ backgroundColor: rgbaCss(swatch) }}
            disabled={!showLine || useStrokeColor}
            onClick={() => setColorDialog(true)}
          />
          <label className="set-check es-check" style={{ marginInlineStart: 12 }}>
            <input type="checkbox" checked={useStrokeColor} disabled={!showLine}
              onChange={(e) => setUseStrokeColorT(e.target.checked)} />
            <span>{t('use_stroke_color', lang)}</span>
          </label>
        </div>
      </div>

      {hasTwoFreeEnds && (
        <label className="set-check es-check">
          <input type="checkbox" checked={bothEnds} onChange={(e) => setBothEnds(e.target.checked)} />
          <span>{t('apply_to_both_free_ends', lang)}</span>
        </label>
      )}

      {colorDialog && (
        <ColorPickerDialog
          title={t('side_line_color', lang)}
          value={pinnedColor}
          lang={lang}
          onAccept={(c) => setPinnedColorT(c)}
          onClose={() => setColorDialog(false)}
        />
      )}
    </Modal>
  );
}

// The preview picture: the theme's canvas colour, a faint 27px grid, the
// rendered end, and a dashed green circle on the endpoint (end_style_dialog.py
// _paint_preview). Drawn at 2x for a crisp picture.
function paintPreview(canvas: HTMLCanvasElement, strands: RenderStrand[], meta: RenderMeta, scale: number, dark: boolean): void {
  const ratio = 2;
  const w = PREVIEW_W, h = PREVIEW_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = dark ? '#2C2C2C' : '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = 0; gx < w; gx += 27) { ctx.moveTo(gx, 0); ctx.lineTo(gx, h); }
  for (let gy = 0; gy < h; gy += 27) { ctx.moveTo(0, gy); ctx.lineTo(w, gy); }
  ctx.stroke();
  const frame = document.createElement('canvas');
  try {
    callRenderTo(frame, strands, meta);
    ctx.drawImage(frame, 0, 0, w, h);
  } catch { /* leave the backdrop; the canvas itself still previews live */ }
  ctx.strokeStyle = 'rgb(59, 164, 36)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  void scale;
}
