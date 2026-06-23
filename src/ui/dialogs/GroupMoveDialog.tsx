import { useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore, cloneDoc } from '../../store/editorStore';
import { translateGroup } from '../../store/actions';
import { t } from '../i18n';

// Move a group live: X/Y sliders (-600..600) plus grid-step number inputs
// (-50..50, in grid cells) and a "Snap to grid" checkbox. We snapshot the doc on
// open and live-preview each change by translating the group by the DELTA from
// the last (x,y) via translateGroup (mutateDoc = no history). OK rolls the
// snapshot back and re-applies the total offset as ONE undo step; Cancel restores
// the snapshot. The grid-step inputs express the target offset in grid units, so
// changing the step moves to step*grid_size px on that axis.
export function GroupMoveDialog(props: {
  groupName: string;
  onClose: () => void;
}): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const grid = useEditorStore((s) => s.settings.grid_size) || 28;

  const baseRef = useRef(cloneDoc(useEditorStore.getState().doc));
  const lastRef = useRef({ x: 0, y: 0 }); // last applied offset (px)
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [snap, setSnap] = useState(false);

  // Apply the absolute target offset (px) by translating by the delta from last.
  const preview = (nx: number, ny: number) => {
    let tx = nx, ty = ny;
    if (snap) { tx = Math.round(tx / grid) * grid; ty = Math.round(ty / grid) * grid; }
    const dx = tx - lastRef.current.x;
    const dy = ty - lastRef.current.y;
    if (dx !== 0 || dy !== 0) {
      useEditorStore.getState().mutateDoc((d) => translateGroup(d, groupName, dx, dy));
      lastRef.current = { x: tx, y: ty };
    }
    setX(nx); setY(ny);
  };

  const apply = () => {
    useEditorStore.getState().setDoc(cloneDoc(baseRef.current));
    const { x: tx, y: ty } = lastRef.current;
    if (tx !== 0 || ty !== 0) {
      useEditorStore.getState().commitEdit((d) => translateGroup(d, groupName, tx, ty));
    }
    onClose();
  };

  const cancel = () => {
    useEditorStore.getState().setDoc(cloneDoc(baseRef.current));
    onClose();
  };

  return (
    <Modal
      title={t('move_group_strands', lang)}
      onClose={cancel}
      footer={
        <>
          <button onClick={cancel}>{t('cancel', lang)}</button>
          <button onClick={apply}>{t('ok', lang)}</button>
        </>
      }
    >
      <div className="gd-row">
        <span className="gd-label">{t('x_movement', lang)}</span>
        <input
          type="range"
          min={-600}
          max={600}
          step={1}
          value={x}
          onChange={(e) => preview(Number(e.target.value), y)}
        />
        <input
          type="number"
          min={-50}
          max={50}
          step={1}
          value={Math.round((x / grid) * 100) / 100}
          onChange={(e) => preview(Number(e.target.value) * grid, y)}
        />
      </div>
      <div className="gd-row">
        <span className="gd-label">{t('y_movement', lang)}</span>
        <input
          type="range"
          min={-600}
          max={600}
          step={1}
          value={y}
          onChange={(e) => preview(x, Number(e.target.value))}
        />
        <input
          type="number"
          min={-50}
          max={50}
          step={1}
          value={Math.round((y / grid) * 100) / 100}
          onChange={(e) => preview(x, Number(e.target.value) * grid)}
        />
      </div>
      <label className="gd-check">
        <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
        <span>{t('snap_to_grid', lang)}</span>
      </label>
    </Modal>
  );
}
