import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { applyStrandAngleLength } from '../../store/actions';
import { movingStrandSet } from '../../interaction/connections';
import { requestRender } from '../../renderer/renderScheduler';
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

  // Engage the renderer drag fast-path for the adjusted strand's branch (bake every
  // static strand once, redraw only the moving set per tick, shadows off) so the live
  // angle/length preview stays smooth instead of triggering a full re-render of all
  // strands on every slider tick — mirroring GroupRotateDialog / GroupAngleEditorDialog.
  // The single undo gesture is already open (store.enterAngleEdit -> beginGesture);
  // confirm/cancel commit/revert it. The cleanup drops the fast-path on unmount (OK /
  // Cancel clear angleEditTarget -> this dialog unmounts) and forces one full-quality
  // render with shadows back on.
  useEffect(() => {
    const s = useEditorStore.getState();
    const tgt = s.angleEditTarget;
    if (!tgt) return;
    const moving = new Set(movingStrandSet(s.doc, tgt, 'end'));
    // applyStrandAngleLength shifts EVERY direct child whose start sits on the adjusted
    // END (a non-directed manhattan<1 loop), but movingStrandSet's directed first-claim
    // walk keeps only ONE sibling per endpoint. Union in the rest so a 2nd+ child sharing
    // that end (reachable via loaded multi-child JSON) can't render frozen/stale during
    // the live preview while its geometry is actually being moved.
    const end = s.doc.strands[tgt]?.end;
    if (end) {
      for (const n of s.doc.order) {
        const c = s.doc.strands[n];
        if (c && c.type === 'AttachedStrand' && c.attached_to === tgt
            && Math.abs(c.start.x - end.x) + Math.abs(c.start.y - end.y) < 1) moving.add(n);
      }
    }
    s.setDragging(true);
    s.setDragMoving([...moving]);
    return () => {
      const z = useEditorStore.getState();
      if (z.dragging) { z.setDragging(false); z.setDragMoving([]); requestRender(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!target || !session) return null;

  const apply = (a: number, l: number) => {
    // Hot path: deep-clone only the moving set (== dragMoving), share the rest.
    // applyStrandAngleLength writes only the target + its end-children, all ⊆ dragMoving.
    const st = useEditorStore.getState();
    st.mutateDocDuringDrag((d) => applyStrandAngleLength(d, target, a, l, session), st.dragMoving);
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
