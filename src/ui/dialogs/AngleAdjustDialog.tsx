import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore, cloneDoc } from '../../store/editorStore';
import { snapshotAngleAdjust, applyAngleAdjustSnapshot } from '../../store/actions';
import { requestRender } from '../../renderer/renderScheduler';
import { t } from '../i18n';

// OSS "Adjust Angle and Length" (angle_adjust_mode.py prompt_for_adjustments:127-263).
// Two slider+spinbox rows over the selected strand, previewing live:
//
//   angle   slider and box both -360..360, step 1 (:165-174)
//   length  slider and box both 10..max_length, QUANTIZED to multiples of 5 by
//           update_length (:232-241); max_length = max(10, int(initial * 2)) (:68)
//
// Every preview is applied ABSOLUTELY from the activate() snapshot, so dragging a
// slider back to its opening value restores the original curve exactly rather than
// accumulating rounding. beginGesture + commit collapse the whole session into ONE
// undo step (OSS sets undo_redo_manager._skip_save for the dialog's lifetime and
// calls save_state once in confirm_adjustment, :134-136 / :578-580).
//
// One deliberate improvement: OSS's cancel_adjustment restores only `start` and
// `end` (:603-609), leaving the rotated/scaled control points and every re-glued
// child where the preview put them — Escape there does not actually undo the edit.
// We restore the whole pre-dialog document, which is what Cancel is for.
export function AngleAdjustDialog(props: { layerName: string; onClose: () => void }): JSX.Element | null {
  const { layerName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);

  const init = useEditorStore.getState();
  const baseRef = useRef(cloneDoc(init.doc));
  const snapRef = useRef(snapshotAngleAdjust(init.doc, layerName));
  const snap = snapRef.current;

  // Qt clamps a spin box's initial value into its range, and that clamp fires
  // valueChanged — so a strand shorter than the slider's 10px floor really does
  // jump to 10 the moment the dialog opens. Reproduce the clamp, but seed state
  // with it rather than firing a preview before the user has touched anything.
  const [angle, setAngle] = useState(() => (snap ? clampAngle(snap.initialAngle) : 0));
  const [length, setLength] = useState(() => (snap ? clampLength(snap.initialLength, snap.maxLength) : 10));

  useEffect(() => {
    if (!snap) return;
    const s = useEditorStore.getState();
    s.beginGesture({ action: 'angle.adjust', source: 'dialog', targets: [layerName] });
    s.setAngleAdjust({ layerName, spanDeg: 0 });
    requestRender();
    return () => {
      // Safety net: an unmount that skipped OK/Cancel must not leave the arc up.
      useEditorStore.getState().setAngleAdjust(null);
      requestRender();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!snap) return null;

  const preview = (a: number, l: number) => {
    setAngle(a);
    setLength(l);
    const st = useEditorStore.getState();
    st.mutateDoc((d) => applyAngleAdjustSnapshot(d, snap, a, l, st.settings.curve_params));
    // angle_adjustment is measured from the angle at activate() (:218).
    st.setAngleAdjust({ layerName, spanDeg: a - snap.initialAngle });
  };

  const apply = () => {
    const st = useEditorStore.getState();
    st.setAngleAdjust(null);
    st.commit();          // the previewed state is already live -> one undo step
    requestRender();
    onClose();
  };

  const cancel = () => {
    const st = useEditorStore.getState();
    st.setAngleAdjust(null);
    st.setDoc(cloneDoc(baseRef.current));
    st.commit();          // base == gestureBase -> clears the gesture, no history
    requestRender();
    onClose();
  };

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
          type="range" min={-360} max={360} step={1} value={angle}
          onChange={(e) => preview(clampAngle(Number(e.target.value)), length)}
        />
        <input
          type="number" min={-360} max={360} step={1} value={angle}
          onChange={(e) => preview(clampAngle(Number(e.target.value)), length)}
        />
      </div>
      <div className="gd-row">
        <span className="gd-label">{t('length_label', lang)}</span>
        <input
          type="range" min={10} max={snap.maxLength} step={1} value={length}
          onChange={(e) => preview(angle, quantize(Number(e.target.value), snap.maxLength))}
        />
        <input
          type="number" min={10} max={snap.maxLength} step={5} value={length}
          onChange={(e) => preview(angle, quantize(Number(e.target.value), snap.maxLength))}
        />
      </div>
    </Modal>
  );
}

const clampAngle = (v: number): number =>
  (Number.isFinite(v) ? Math.max(-360, Math.min(360, v)) : 0);

const clampLength = (v: number, max: number): number =>
  (Number.isFinite(v) ? Math.max(10, Math.min(max, v)) : 10);

// OSS rounds every length to the nearest multiple of 5 BEFORE clamping to the
// slider range (update_length :234-240), so the box and the slider always agree.
const quantize = (v: number, max: number): number =>
  clampLength(Math.round((Number.isFinite(v) ? v : 10) / 5) * 5, max);
