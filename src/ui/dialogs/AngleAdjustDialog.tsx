import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore, cloneDoc } from '../../store/editorStore';
import { snapshotAngleAdjust, applyAngleAdjustSnapshot } from '../../store/angleAdjust';
import { requestRender, requestOverlay } from '../../renderer/renderScheduler';
import { t } from '../i18n';

// OSS "Adjust Angle and Length" (angle_adjust_mode.py:127-263): the modal
// opened by the toolbar Angle button on a selected non-mask strand.
//   * Angle row: slider −360..360 step 1 + spinbox (2 decimals), no snapping.
//   * Length row: slider 10..max(10, 2·original) with 5px ticks + spinbox
//     step 5 — EVERY length value is quantized round(v/5)*5 (:232-241).
//   * One OK button only; Enter = OK; Esc/close = cancel. Live preview every
//     tick with undo suppressed; exactly ONE undo state on OK, none on cancel.
//     (OSS cancel restores only the endpoints (:603-629) — we restore the whole
//     doc, which is strictly more correct and matches the group dialogs.)
//   * OK deselects all and returns to the previous mode (:572-601).
export function AngleAdjustDialog(props: { layerName: string; onClose: (ok: boolean) => void }): JSX.Element {
  const { layerName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);

  const init = useEditorStore.getState();
  const baseRef = useRef(cloneDoc(init.doc));
  const snapRef = useRef(snapshotAngleAdjust(init.doc, layerName));
  const snap = snapRef.current;
  const [angle, setAngle] = useState(() => round2(snap?.initialAngle ?? 0));
  const [length, setLength] = useState(() => quant5(snap?.initialLength ?? 10, snap));

  // Engage the gesture + renderer drag fast-path for the strand and its glued
  // children; arm the overlay arc/line.
  useEffect(() => {
    const s = useEditorStore.getState();
    if (!snapRef.current) return;
    s.beginGesture();
    s.setDragging(true);
    s.setDragMoving([layerName, ...snapRef.current.children.map((c) => c.name)]);
    s.setAngleAdjust({ name: layerName, deltaDeg: 0 });
    return () => {
      const z = useEditorStore.getState();
      z.setAngleAdjust(null);
      if (z.dragging) { z.setDragging(false); z.setDragMoving([]); requestRender(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preview = (a: number, len: number) => {
    if (!snap) return;
    const st = useEditorStore.getState();
    st.mutateDoc((d) => applyAngleAdjustSnapshot(d, snap, a, len));
    st.setAngleAdjust({ name: layerName, deltaDeg: a - snap.initialAngle });
    requestOverlay();
  };
  const setA = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    const a = Math.max(-360, Math.min(360, raw));
    setAngle(a);
    preview(a, length);
  };
  const setL = (raw: number) => {
    if (!Number.isFinite(raw) || !snap) return;
    const len = quant5(raw, snap);
    setLength(len);
    preview(angle, len);
  };

  const endDrag = () => {
    const s = useEditorStore.getState();
    s.setAngleAdjust(null);
    s.setDragging(false);
    s.setDragMoving([]);
  };
  const apply = () => {
    endDrag();
    useEditorStore.getState().commit(); // one undo step (OSS save_state on confirm)
    requestRender();
    onClose(true);
  };
  const cancel = () => {
    endDrag();
    useEditorStore.getState().setDoc(cloneDoc(baseRef.current));
    useEditorStore.getState().commit(); // base == gestureBase -> no history entry
    requestRender();
    onClose(false);
  };

  if (!snap) return <></>;
  return (
    <Modal
      title={t('adjust_angle_and_length', lang)}
      onClose={cancel}
      lang={lang}
      onEnter={apply}
      footer={<button onClick={apply}>{t('ok', lang)}</button>}
    >
      <div className="gd-row">
        <span className="gd-label">{t('angle_label', lang)}</span>
        <input
          type="range"
          min={-360}
          max={360}
          step={1}
          value={Math.round(angle)}
          onChange={(e) => setA(Number(e.target.value))}
        />
        <input
          type="number"
          className="gd-num"
          dir="ltr"
          min={-360}
          max={360}
          step={1}
          value={angle}
          onChange={(e) => setA(Number(e.target.value))}
        />
      </div>
      <div className="gd-row">
        <span className="gd-label">{t('length_label', lang)}</span>
        <input
          type="range"
          min={10}
          max={snap.maxLength}
          step={5}
          value={length}
          onChange={(e) => setL(Number(e.target.value))}
        />
        <input
          type="number"
          className="gd-num"
          dir="ltr"
          min={10}
          max={snap.maxLength}
          step={5}
          value={length}
          onChange={(e) => setL(Number(e.target.value))}
        />
      </div>
    </Modal>
  );
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// OSS update_length: every value from either widget snaps to a multiple of 5,
// clamped to [10, maxLength] (:232-241).
function quant5(v: number, snap: { maxLength: number } | null): number {
  const q = Math.round(v / 5) * 5;
  return Math.max(10, Math.min(snap?.maxLength ?? 10, q));
}
