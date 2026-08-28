import React, { useRef, useState } from 'react';
import type { Language, RGBA } from '../../model/types';
import { Modal } from '../Modal';
import { t } from '../i18n';
import './colorDialog.css';

// OSS opens a MODAL QColorDialog for every colour action (numbered_layer_button.py
// change_color:2833, change_stroke_color:3289, change_layer_stroke_color:3339,
// change_layer_color:3376) with ShowAlphaChannel + DontUseNativeDialog, and applies
// the colour ONLY when the dialog is accepted. This is that dialog.
//
// It replaces a hidden <input type="color"> that was click()ed from an effect. That
// input could not work: it is 0x0 / opacity 0 / pointer-events:none, so it never
// takes focus — its onBlur (the only thing that reset the "which colour action is
// open" state) never fired, and the browser anchored the OS picker to a zero-sized
// box, which put the popup in a corner or half off-screen. The picker also emits an
// input event per drag frame, so every frame committed its own undo step and there
// was no way to cancel. A real in-app dialog fixes all of that and matches OSS:
// one undo step on OK, nothing at all on Cancel.

/* ---- colour maths (0..255 channels, Qt's ranges: H 0..359, S/V 0..255) ---- */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const h2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

export const toHex = (c: RGBA): string => `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;

export function parseHex(hex: string, prev: RGBA): RGBA {
  const s = hex.trim().replace(/^#/, '');
  const m = /^([0-9a-f]{6})$/i.exec(s) ? s
    : /^([0-9a-f]{3})$/i.exec(s) ? s.split('').map((ch) => ch + ch).join('')
      : null;
  if (!m) return { ...prev };
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
    a: prev.a,
  };
}

type HSV = { h: number; s: number; v: number };

function rgbToHsv(c: RGBA): HSV {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h) % 360, s: Math.round((max === 0 ? 0 : d / max) * 255), v: Math.round(max * 255) };
}

function hsvToRgb(hsv: HSV, a: number): RGBA {
  const h = ((hsv.h % 360) + 360) % 360, s = hsv.s / 255, v = hsv.v / 255;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = seg === 0 ? [c, x, 0] : seg === 1 ? [x, c, 0] : seg === 2 ? [0, c, x]
    : seg === 3 ? [0, x, c] : seg === 4 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255), a };
}

const cssOf = (c: RGBA) => `rgba(${c.r}, ${c.g}, ${c.b}, ${clamp(c.a, 0, 255) / 255})`;

/* ---- Qt's 48 standard colours (QColorDialog::standardColor, 6 rows x 8 cols) ----
 * Qt builds them as qRgb(r*255/3, g*255/3, b*255/2) over g -> r -> b, and lays them
 * out row-major in a 6x8 well. Dumped from PyQt5 rather than eyeballed. */
const STANDARD_COLORS: string[] = [
  '#000000', '#00007f', '#0000ff', '#550000', '#55007f', '#5500ff', '#aa0000', '#aa007f',
  '#aa00ff', '#ff0000', '#ff007f', '#ff00ff', '#005500', '#00557f', '#0055ff', '#555500',
  '#55557f', '#5555ff', '#aa5500', '#aa557f', '#aa55ff', '#ff5500', '#ff557f', '#ff55ff',
  '#00aa00', '#00aa7f', '#00aaff', '#55aa00', '#55aa7f', '#55aaff', '#aaaa00', '#aaaa7f',
  '#aaaaff', '#ffaa00', '#ffaa7f', '#ffaaff', '#00ff00', '#00ff7f', '#00ffff', '#55ff00',
  '#55ff7f', '#55ffff', '#aaff00', '#aaff7f', '#aaffff', '#ffff00', '#ffff7f', '#ffffff',
];

// Qt's custom-colour row is static for the life of the process and starts all white;
// module scope gives the same lifetime here (one browser session).
const CUSTOM_COLORS: string[] = new Array(16).fill('#ffffff');
let customCursor = 0;

/* ---- the dialog ---- */

export function ColorPickerDialog(props: {
  title: string;
  /** Colour the dialog opens on (QColorDialog.setCurrentColor). */
  value: RGBA;
  lang: Language;
  /** Accepted: the chosen colour. Called once, on OK. */
  onAccept: (c: RGBA) => void;
  /** Cancelled or closed: nothing is applied. */
  onClose: () => void;
}): JSX.Element {
  const { title, value, lang, onAccept, onClose } = props;

  const [color, setColor] = useState<RGBA>({ ...value });
  // HSV is kept alongside RGB so dragging through a grey (S or V at 0, where hue is
  // mathematically undefined) does not snap the hue back to red.
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(value));
  const [hexText, setHexText] = useState<string>(() => toHex(value));
  const [, forceCustomRepaint] = useState(0);

  const setFromRgb = (c: RGBA) => {
    setColor(c);
    setHsv(rgbToHsv(c));
    setHexText(toHex(c));
  };
  const setFromHsv = (next: HSV, alpha = color.a) => {
    setHsv(next);
    const c = hsvToRgb(next, alpha);
    setColor(c);
    setHexText(toHex(c));
  };

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const alphaRef = useRef<HTMLDivElement>(null);

  // Pointer-capture drag on a strip/square: the handler keeps receiving moves even
  // when the pointer leaves the element, so a fast drag does not drop the gesture.
  const dragOn = (
    ref: React.RefObject<HTMLElement>,
    apply: (fx: number, fy: number) => void,
  ) => (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      apply(clamp((clientX - r.left) / r.width, 0, 1), clamp((clientY - r.top) / r.height, 0, 1));
    };
    move(e.clientX, e.clientY);
    const onMove = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  };

  const onSvDrag = dragOn(svRef, (fx, fy) =>
    setFromHsv({ h: hsv.h, s: Math.round(fx * 255), v: Math.round((1 - fy) * 255) }));
  const onHueDrag = dragOn(hueRef, (_fx, fy) =>
    setFromHsv({ ...hsv, h: Math.round((1 - fy) * 359) }));
  const onAlphaDrag = dragOn(alphaRef, (_fx, fy) =>
    setColor((c) => ({ ...c, a: Math.round((1 - fy) * 255) })));

  const pickStandard = (hex: string) => setFromRgb(parseHex(hex, color));

  const addToCustom = () => {
    CUSTOM_COLORS[customCursor] = toHex(color);
    customCursor = (customCursor + 1) % CUSTOM_COLORS.length;
    forceCustomRepaint((n) => n + 1);
  };

  // Chromium's EyeDropper is the web equivalent of Qt's "Pick Screen Color"; the
  // button is simply absent where the API is not implemented.
  const eyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;
  const pickScreen = async () => {
    try {
      const ED = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const res = await new ED().open();
      setFromRgb(parseHex(res.sRGBHex, color));
    } catch {
      /* the user dismissed the eyedropper — Qt's button does nothing then either */
    }
  };

  const numRow = (
    label: string, val: number, max: number, onNum: (n: number) => void,
  ) => (
    <label className="cpd-num">
      <span>{label}</span>
      <input
        type="number" min={0} max={max} value={val}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onNum(clamp(Math.round(n), 0, max));
        }}
      />
    </label>
  );

  // Enter accepts, matching the Qt dialog's default button.
  const accept = () => { onAccept(color); onClose(); };

  const svBg = `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ${cssOf(hsvToRgb({ h: hsv.h, s: 255, v: 255 }, 255))})`;
  const alphaBg = `linear-gradient(to top, rgba(${color.r},${color.g},${color.b},0), rgb(${color.r},${color.g},${color.b}))`;

  return (
    <Modal
      title={title}
      lang={lang}
      width={520}
      onClose={onClose}
      onEnter={accept}
      footer={(
        <>
          <button onClick={accept}>{t('ok', lang)}</button>
          <button onClick={onClose}>{t('cancel', lang)}</button>
        </>
      )}
    >
      <div className="cpd">
        <div className="cpd-left">
          <div className="cpd-caption">{t('basic_colors', lang)}</div>
          <div className="cpd-well">
            {STANDARD_COLORS.map((hex, i) => (
              <button
                key={i}
                type="button"
                className={'cpd-cell' + (toHex(color).toLowerCase() === hex ? ' is-current' : '')}
                style={{ background: hex }}
                title={hex}
                onClick={() => pickStandard(hex)}
              />
            ))}
          </div>

          <div className="cpd-caption">{t('custom_colors', lang)}</div>
          <div className="cpd-well cpd-well-custom">
            {CUSTOM_COLORS.map((hex, i) => (
              <button
                key={i}
                type="button"
                className="cpd-cell"
                style={{ background: hex }}
                title={hex}
                onClick={() => pickStandard(hex)}
              />
            ))}
          </div>

          {eyeDropper && (
            <button type="button" className="cpd-wide" onClick={pickScreen}>
              {t('pick_screen_color', lang)}
            </button>
          )}
          <button type="button" className="cpd-wide" onClick={addToCustom}>
            {t('add_to_custom_colors', lang)}
          </button>
        </div>

        <div className="cpd-right">
          <div className="cpd-canvas-row">
            <div
              ref={svRef}
              className="cpd-sv"
              style={{ background: svBg }}
              onPointerDown={onSvDrag}
            >
              <span
                className="cpd-sv-knob"
                style={{ left: `${(hsv.s / 255) * 100}%`, top: `${(1 - hsv.v / 255) * 100}%` }}
              />
            </div>
            <div ref={hueRef} className="cpd-hue" onPointerDown={onHueDrag}>
              <span className="cpd-strip-knob" style={{ top: `${(1 - hsv.h / 359) * 100}%` }} />
            </div>
            <div ref={alphaRef} className="cpd-alpha" onPointerDown={onAlphaDrag}>
              <span className="cpd-alpha-fill" style={{ background: alphaBg }} />
              <span className="cpd-strip-knob" style={{ top: `${(1 - color.a / 255) * 100}%` }} />
            </div>
          </div>

          <div className="cpd-preview-row">
            {/* backgroundColor, not the `background` shorthand: the shorthand would
                reset the checkerboard background-image the swatch is layered on, so a
                transparent colour would blend into the modal instead of showing it. */}
            <span className="cpd-preview" style={{ backgroundColor: cssOf(color) }} />
            <label className="cpd-html">
              <span>HTML</span>
              <input
                value={hexText}
                spellCheck={false}
                onChange={(e) => {
                  setHexText(e.target.value);
                  const parsed = parseHex(e.target.value, color);
                  if (toHex(parsed) !== toHex(color)) setFromRgb(parsed);
                }}
              />
            </label>
          </div>

          <div className="cpd-nums">
            {numRow(t('hue', lang), hsv.h, 359, (n) => setFromHsv({ ...hsv, h: n }))}
            {numRow(t('red', lang), color.r, 255, (n) => setFromRgb({ ...color, r: n }))}
            {numRow(t('sat', lang), hsv.s, 255, (n) => setFromHsv({ ...hsv, s: n }))}
            {numRow(t('green', lang), color.g, 255, (n) => setFromRgb({ ...color, g: n }))}
            {numRow(t('val', lang), hsv.v, 255, (n) => setFromHsv({ ...hsv, v: n }))}
            {numRow(t('blue', lang), color.b, 255, (n) => setFromRgb({ ...color, b: n }))}
            {numRow(t('alpha_channel', lang), color.a, 255, (n) => setColor({ ...color, a: n }))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
