import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { snapshotGroupDrag, applyGroupMoveSnapshot } from '../../model/group';
import { requestRender } from '../../renderer/renderScheduler';
import { t } from '../i18n';

// Move a group live, OSS-faithful (group_layers.py GroupMoveDialog /
// update_group_move):
//   * snapshot members ONCE on open, engage the renderer drag fast-path,
//   * apply the cumulative (dx,dy) ABSOLUTELY from the snapshot each tick
//     (no per-tick re-resolution, no incremental drift),
//   * beginGesture + commit collapse the whole drag into ONE undo step.
// X/Y sliders + px inputs (-600..600) drive the total directly; the grid-step
// rows add steps*grid_size px to the total on Apply (then reset to 0), matching
// the original. The Snap button rounds the current offset to whole grid steps.
export function GroupMoveDialog(props: { groupName: string; onClose: () => void }): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const grid = useEditorStore((s) => s.settings.grid_size) || 28;

  const init = useEditorStore.getState();
  const snapRef = useRef(snapshotGroupDrag(init.doc, groupName));
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [xStep, setXStep] = useState(0);
  const [yStep, setYStep] = useState(0);

  // Open the gesture + engage the drag fast-path for the group's members.
  useEffect(() => {
    const s = useEditorStore.getState();
    s.beginGesture();
    s.setDragging(true);
    s.setDragMoving([...snapRef.current.members.regular, ...snapRef.current.members.masks]);
    return () => {
      const z = useEditorStore.getState();
      if (z.dragging) { z.setDragging(false); z.setDragMoving([]); requestRender(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clampPx = (v: number) => Math.max(-600, Math.min(600, v));
  const clampStep = (v: number) => Math.max(-50, Math.min(50, Math.round(v)));

  // Slider/input drive a ±600-clamped total; the grid-step Apply may push the
  // TRUE total past ±600 (OSS keeps the real total_dx, the slider merely
  // saturates — group_layers.py:4102-4104), so raw previews skip the clamp.
  const preview = (nx: number, ny: number, clamp = true) => {
    const tx = clamp ? clampPx(nx) : nx;
    const ty = clamp ? clampPx(ny) : ny;
    useEditorStore.getState().mutateDoc((d) => applyGroupMoveSnapshot(d, snapRef.current, tx, ty));
    setDx(tx); setDy(ty);
  };

  const applyXGrid = () => { if (xStep) { preview(dx + xStep * grid, dy, false); setXStep(0); } };
  const applyYGrid = () => { if (yStep) { preview(dx, dy + yStep * grid, false); setYStep(0); } };

  const endDrag = () => {
    const s = useEditorStore.getState();
    s.setDragging(false);
    s.setDragMoving([]);
  };

  const apply = () => {
    endDrag();
    useEditorStore.getState().commit();
    requestRender();
    onClose();
  };

  // OSS Cancel/close KEEPS the moved geometry — reject never restores the
  // originals (group_layers.py: cancel just closes; the last preview delta
  // stays). Committing here preserves that observable behavior while keeping
  // the whole session a single undo step.
  const cancel = apply;

  // OSS Snap to Grid: snap EVERY member point to the grid (canvas.
  // snap_group_to_grid — per-point, not offset rounding) then accept and
  // CLOSE the dialog (group_layers.py:4256-4266).
  const snap = () => {
    const q = (v: number) => Math.round(v / grid) * grid;
    const members = [...snapRef.current.members.regular, ...snapRef.current.members.masks];
    useEditorStore.getState().mutateDoc((d) => {
      for (const n of members) {
        const s = d.strands[n];
        if (!s) continue;
        s.start = { x: q(s.start.x), y: q(s.start.y) };
        s.end = { x: q(s.end.x), y: q(s.end.y) };
        s.control_points = [
          { x: q(s.control_points[0].x), y: q(s.control_points[0].y) },
          { x: q(s.control_points[1].x), y: q(s.control_points[1].y) },
        ];
        if (s.control_point_center) {
          s.control_point_center = { x: q(s.control_point_center.x), y: q(s.control_point_center.y) };
        }
      }
    });
    apply();
  };

  return (
    <Modal
      title={`${t('move_group', lang)}: ${groupName}`}
      onClose={cancel}
      lang={lang}
      onEnter={apply}
      footer={
        <>
          <button onClick={apply}>{t('ok', lang)}</button>
          <button onClick={cancel}>{t('cancel', lang)}</button>
          <button onClick={snap}>{t('snap_to_grid', lang)}</button>
        </>
      }
    >
      <div className="gd-row">
        <span className="gd-label">{t('x_movement', lang)}</span>
        <input type="range" min={-600} max={600} step={1} value={dx} onChange={(e) => preview(Number(e.target.value), dy)} />
        <span className="gd-value">{Math.round(dx)}</span>
        <input type="number" min={-600} max={600} step={1} value={Math.round(dx)} onChange={(e) => preview(Number(e.target.value), dy)} />
      </div>
      <div className="gd-row">
        <span className="gd-label">{t('y_movement', lang)}</span>
        <input type="range" min={-600} max={600} step={1} value={dy} onChange={(e) => preview(dx, Number(e.target.value))} />
        <span className="gd-value">{Math.round(dy)}</span>
        <input type="number" min={-600} max={600} step={1} value={Math.round(dy)} onChange={(e) => preview(dx, Number(e.target.value))} />
      </div>
      <div className="gd-row">
        <span className="gd-label">{t('x_grid_steps', lang)}</span>
        <span className="gd-spacer" />
        <input type="number" min={-50} max={50} step={1} value={xStep} onChange={(e) => setXStep(clampStep(Number(e.target.value)))} />
        <button onClick={() => setXStep((v) => clampStep(v - 1))}>-</button>
        <button onClick={() => setXStep((v) => clampStep(v + 1))}>+</button>
        <button onClick={applyXGrid}>{t('apply', lang)}</button>
      </div>
      <div className="gd-row">
        <span className="gd-label">{t('y_grid_steps', lang)}</span>
        <span className="gd-spacer" />
        <input type="number" min={-50} max={50} step={1} value={yStep} onChange={(e) => setYStep(clampStep(Number(e.target.value)))} />
        <button onClick={() => setYStep((v) => clampStep(v - 1))}>-</button>
        <button onClick={() => setYStep((v) => clampStep(v + 1))}>+</button>
        <button onClick={applyYGrid}>{t('apply', lang)}</button>
      </div>
    </Modal>
  );
}
