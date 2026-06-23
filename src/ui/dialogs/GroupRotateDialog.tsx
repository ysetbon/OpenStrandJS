import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore, cloneDoc } from '../../store/editorStore';
import { snapshotGroupDrag, applyGroupRotateSnapshot } from '../../model/group';
import { requestRender } from '../../renderer/renderScheduler';
import { t } from '../i18n';

// Rotate a group live, OSS-faithful (group_layers.py GroupRotateDialog /
// _perform_immediate_group_rotation):
//   * snapshot every member's ORIGINAL geometry + the group pivot ONCE on open,
//   * engage the renderer drag fast-path so only the group redraws (shadows off),
//   * each tick rotate the snapshot ABSOLUTELY about the pivot (no per-tick
//     re-resolution, no incremental float drift),
//   * beginGesture + commit collapse the whole drag into ONE undo step.
// Angle slider (-180..180) + a precise degree input mirror the original's two rows.
export function GroupRotateDialog(props: { groupName: string; onClose: () => void }): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);

  const init = useEditorStore.getState();
  const baseRef = useRef(cloneDoc(init.doc));
  const snapRef = useRef(snapshotGroupDrag(init.doc, groupName));
  const [angle, setAngle] = useState(0);

  // Open the gesture + engage the drag fast-path for the group's members.
  useEffect(() => {
    const s = useEditorStore.getState();
    s.beginGesture();
    s.setDragging(true);
    s.setDragMoving([...snapRef.current.members.regular, ...snapRef.current.members.masks]);
    return () => {
      // Safety net: if unmounted without OK/Cancel, drop the fast-path.
      const z = useEditorStore.getState();
      if (z.dragging) { z.setDragging(false); z.setDragMoving([]); requestRender(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preview = (a: number) => {
    const clamped = Math.max(-180, Math.min(180, a));
    useEditorStore.getState().mutateDoc((d) => applyGroupRotateSnapshot(d, snapRef.current, clamped));
    setAngle(clamped);
  };

  const endDrag = () => {
    const s = useEditorStore.getState();
    s.setDragging(false);
    s.setDragMoving([]);
  };

  const apply = () => {
    endDrag();
    useEditorStore.getState().commit(); // final state is already live -> one undo step
    requestRender();                    // full-quality render (shadows back on)
    onClose();
  };

  const cancel = () => {
    endDrag();
    useEditorStore.getState().setDoc(cloneDoc(baseRef.current));
    useEditorStore.getState().commit(); // base == gestureBase -> clears gesture, no history
    requestRender();
    onClose();
  };

  return (
    <Modal
      title={`${t('rotate_group_strands', lang)} ${groupName}`}
      onClose={cancel}
      lang={lang}
      onEnter={apply}
      footer={<button onClick={apply}>{t('ok', lang)}</button>}
    >
      <div className="gd-row">
        <span className="gd-label">{t('angle', lang)}</span>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={angle}
          onChange={(e) => preview(Number(e.target.value))}
        />
      </div>
      <div className="gd-row">
        <span className="gd-label">{t('precise_angle', lang)}</span>
        <input
          type="number"
          min={-180}
          max={180}
          step={0.01}
          value={angle}
          onChange={(e) => preview(Number(e.target.value))}
        />
        <span className="gd-label">°</span>
      </div>
    </Modal>
  );
}
