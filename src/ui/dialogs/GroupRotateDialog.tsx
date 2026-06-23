import { useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore, cloneDoc } from '../../store/editorStore';
import { rotateGroup } from '../../store/actions';
import { t } from '../i18n';

// Rotate a group live: an angle slider (-180..180) plus a precise number input.
// We snapshot the doc on open and live-preview each angle change by applying the
// DELTA from the last angle via rotateGroup (mutateDoc = no history). OK rolls
// the snapshot back and re-applies the total angle as ONE undo step; Cancel just
// restores the snapshot.
export function GroupRotateDialog(props: {
  groupName: string;
  onClose: () => void;
}): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);

  // Doc snapshot captured once on mount (the pre-rotation baseline).
  const baseRef = useRef(cloneDoc(useEditorStore.getState().doc));
  const lastRef = useRef(0); // last applied angle (deg)
  const [angle, setAngle] = useState(0);

  // Apply the incremental rotation (newAngle - lastAngle) as a live preview.
  const preview = (newAngle: number) => {
    const delta = newAngle - lastRef.current;
    if (delta !== 0) {
      useEditorStore.getState().mutateDoc((d) => rotateGroup(d, groupName, delta));
      lastRef.current = newAngle;
    }
    setAngle(newAngle);
  };

  const apply = () => {
    // Roll back to baseline, then commit the total rotation as one undo step.
    useEditorStore.getState().setDoc(cloneDoc(baseRef.current));
    const total = lastRef.current;
    if (total !== 0) {
      useEditorStore.getState().commitEdit((d) => rotateGroup(d, groupName, total));
    }
    onClose();
  };

  const cancel = () => {
    useEditorStore.getState().setDoc(cloneDoc(baseRef.current));
    onClose();
  };

  return (
    <Modal
      title={t('rotate_group_strands', lang)}
      onClose={cancel}
      footer={
        <>
          <button onClick={cancel}>{t('cancel', lang)}</button>
          <button onClick={apply}>{t('ok', lang)}</button>
        </>
      }
    >
      <div className="gd-row">
        <span className="gd-label">{t('angle_label', lang)}</span>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={angle}
          onChange={(e) => preview(Number(e.target.value))}
        />
        <input
          type="number"
          min={-180}
          max={180}
          step={1}
          value={angle}
          onChange={(e) => preview(Number(e.target.value))}
        />
      </div>
    </Modal>
  );
}
