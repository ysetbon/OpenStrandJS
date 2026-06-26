import { useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { applyStrandAngleLength } from '../../store/actions';
import { t } from '../i18n';

// The "Adjust Angle and Length" modal — a faithful port of OpenStrand Studio's
// AngleAdjustMode dialog (angle_adjust_mode.py prompt_for_adjustments):
//   * an angle row (slider + spinbox, range -360..360, step 1, no snapping),
//   * a length row (slider + spinbox, range 10..max=2*initial, step 5, snapped to
//     the nearest 5),
//   * each change recomputes the strand's end + control points live via
//     applyStrandAngleLength (pivot = start), inside the open undo gesture,
//   * OK commits one undo step (confirmAngleEdit); Cancel/Escape revert
//     (cancelAngleEdit). Modeless so the canvas stays visible for the live preview.
// Mounted by CanvasStage only while store.angleEditTarget is set.
export function AngleAdjustDialog(): JSX.Element | null {
  const lang = useEditorStore((s) => s.settings.language);
  const target = useEditorStore((s) => s.angleEditTarget);
  // Capture the activation session once (set by enterAngleEdit before this mounts).
  const sessionRef = useRef(useEditorStore.getState().angleEditInitial);
  const session = sessionRef.current;

  const maxLen = Math.max(10, Math.round((session?.length0 ?? 100) * 2));
  const [angle, setAngle] = useState(Math.round(session?.angle0 ?? 0));
  const [length, setLength] = useState(
    Math.max(10, Math.min(maxLen, Math.round((session?.length0 ?? 100) / 5) * 5)),
  );

  if (!target || !session) return null;

  const apply = (a: number, l: number) => {
    useEditorStore.getState().mutateDoc((d) => applyStrandAngleLength(d, target, a, l, session));
  };
  const onAngle = (v: number) => {
    const a = Math.max(-360, Math.min(360, v));
    setAngle(a);
    apply(a, length);
  };
  const onLength = (v: number) => {
    const l = Math.max(10, Math.min(maxLen, Math.round(v / 5) * 5));
    setLength(l);
    apply(angle, l);
  };
  const ok = () => useEditorStore.getState().confirmAngleEdit();
  const cancel = () => useEditorStore.getState().cancelAngleEdit();

  return (
    <Modal
      title={t('adjust_angle_and_length', lang)}
      onClose={cancel}
      lang={lang}
      onEnter={ok}
      modeless
      footer={
        <>
          <button onClick={cancel}>{t('cancel', lang)}</button>
          <button onClick={ok}>{t('ok', lang)}</button>
        </>
      }
    >
      <div className="gd-row">
        <span className="gd-label">{t('angle_label', lang)}</span>
        <input type="range" min={-360} max={360} step={1} value={angle}
          onChange={(e) => onAngle(Number(e.target.value))} />
        <input type="number" min={-360} max={360} step={1} value={angle}
          onChange={(e) => onAngle(Number(e.target.value))} />
        <span className="gd-label">°</span>
      </div>
      <div className="gd-row">
        <span className="gd-label">{t('length_label', lang)}</span>
        <input type="range" min={10} max={maxLen} step={5} value={length}
          onChange={(e) => onLength(Number(e.target.value))} />
        <input type="number" min={10} max={maxLen} step={5} value={length}
          onChange={(e) => onLength(Number(e.target.value))} />
      </div>
    </Modal>
  );
}
