import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { resolveGroupMembers } from '../../model/group';
import { movingStrandSet } from '../../interaction/connections';
import { setStrandAngle } from '../../store/actions';
import { requestRender } from '../../renderer/renderScheduler';
import { t } from '../i18n';
import type { EditorDocument } from '../../model/types';

// "Edit Strand Angles" for a group — OSS StrandAngleEditDialog (group_layers.py:6109).
// A 9-column table (Layer, Angle, Adjust ±1°, Fast Adjust, End X, End Y, x, 180+x,
// Attachable) over EVERY group member; non-editable rows (the "_1" main of a set,
// or a strand closed at both ends) are shown greyed, not hidden. The bottom row is
// a global "Angle X" field with --/-/+/++ buttons that adjust it with press-and-hold
// acceleration (initial ±5/±1, then after 500ms continuous ±0.4/±0.025 every 10ms);
// the per-row "x" / "180+x" checkboxes snap that strand to the X angle (or +180).
//
// Each angle change live-previews via mutateDoc(setStrandAngle) — rotating the
// strand's END about its START (length preserved), dragging welded children. The
// session is one undo step (beginGesture); OSS commits on both OK and close, so
// there is no Cancel (Escape also commits).
const normalize180 = (a: number): number => {
  let r = a % 360;
  if (r > 180) r -= 360;
  else if (r <= -180) r += 360;
  return r;
};

const angleOf = (doc: EditorDocument, name: string): number => {
  const s = doc.strands[name];
  if (!s) return 0;
  return normalize180((Math.atan2(s.end.y - s.start.y, s.end.x - s.start.x) * 180) / Math.PI);
};

export function GroupAngleEditorDialog(props: {
  groupName: string;
  onClose: () => void;
}): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const init = useEditorStore.getState();

  // Re-render on every doc mutation so the Angle / End X / End Y cells stay live.
  const liveDoc = useEditorStore((s) => s.doc);

  // EVERY non-masked member (resolved once), with its editability metadata.
  const rows = useRef(
    resolveGroupMembers(init.doc, groupName).regular.map((n) => {
      const s = init.doc.strands[n];
      const isMain = n.endsWith('_1');
      const attachable = s ? !(s.has_circles[0] && s.has_circles[1]) : false;
      return { name: n, isMain, attachable, editable: !isMain && attachable };
    }),
  ).current;
  const editableNames = rows.filter((r) => r.editable).map((r) => r.name);

  const [angles, setAngles] = useState<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.name] = angleOf(init.doc, r.name);
    return out;
  });

  // Global X angle + per-row sync checkboxes. Refs shadow the state so the
  // press-and-hold interval reads current values (no stale closures).
  const [xAngle, setXAngleState] = useState(0);
  const xAngleRef = useRef(0);
  const [xChk, setXChk] = useState<Record<string, boolean>>({});
  const [x180Chk, setX180Chk] = useState<Record<string, boolean>>({});
  const xChkRef = useRef<Record<string, boolean>>({});
  const x180Ref = useRef<Record<string, boolean>>({});

  // Open the gesture + engage the drag fast-path for every member's branch.
  useEffect(() => {
    const s = useEditorStore.getState();
    s.beginGesture();
    s.setDragging(true);
    const moving = new Set<string>();
    for (const r of rows) for (const m of movingStrandSet(s.doc, r.name, 'end')) moving.add(m);
    s.setDragMoving([...moving]);
    return () => {
      stopHold();
      const z = useEditorStore.getState();
      if (z.dragging) { z.setDragging(false); z.setDragMoving([]); requestRender(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set an absolute angle for one row and live-preview; re-read the other rows
  // from the resulting doc (a welded sibling's angle can shift).
  const setAngle = (n: string, deg: number) => {
    const v = normalize180(deg);
    const curve = useEditorStore.getState().settings.curve_params;
    useEditorStore.getState().mutateDoc((d) => setStrandAngle(d, n, v, curve));
    const doc = useEditorStore.getState().doc;
    const next: Record<string, number> = {};
    for (const r of rows) next[r.name] = r.name === n ? v : angleOf(doc, r.name);
    setAngles(next);
  };
  const bump = (n: string, delta: number) => setAngle(n, (angles[n] ?? 0) + delta);

  // Apply the current X angle to every checked row.
  const applyXAngle = (v: number) => {
    for (const n of editableNames) {
      if (xChkRef.current[n]) setAngle(n, v);
      else if (x180Ref.current[n]) setAngle(n, normalize180(v + 180));
    }
  };
  const setXAngle = (v: number) => {
    xAngleRef.current = v;
    setXAngleState(v);
    applyXAngle(v);
  };
  const adjustXAngle = (delta: number) => setXAngle(xAngleRef.current + delta);

  const toggleX = (n: string) => {
    const on = !xChk[n];
    xChkRef.current = { ...xChkRef.current, [n]: on };
    setXChk((p) => ({ ...p, [n]: on }));
    if (on) {
      x180Ref.current = { ...x180Ref.current, [n]: false };
      setX180Chk((p) => ({ ...p, [n]: false }));
      setAngle(n, xAngleRef.current);
    }
  };
  const toggleX180 = (n: string) => {
    const on = !x180Chk[n];
    x180Ref.current = { ...x180Ref.current, [n]: on };
    setX180Chk((p) => ({ ...p, [n]: on }));
    if (on) {
      xChkRef.current = { ...xChkRef.current, [n]: false };
      setXChk((p) => ({ ...p, [n]: false }));
      setAngle(n, normalize180(xAngleRef.current + 180));
    }
  };

  // Press-and-hold acceleration on the global --/-/+/++ buttons.
  const holdRef = useRef<{ delay?: number; interval?: number }>({});
  const stopHold = () => {
    if (holdRef.current.delay) { clearTimeout(holdRef.current.delay); holdRef.current.delay = undefined; }
    if (holdRef.current.interval) { clearInterval(holdRef.current.interval); holdRef.current.interval = undefined; }
  };
  const startHold = (initialDelta: number, contDelta: number) => {
    stopHold();
    adjustXAngle(initialDelta);
    holdRef.current.delay = window.setTimeout(() => {
      holdRef.current.interval = window.setInterval(() => adjustXAngle(contDelta), 10);
    }, 500);
  };

  const apply = () => {
    stopHold();
    const s = useEditorStore.getState();
    s.setDragging(false);
    s.setDragMoving([]);
    s.commit();
    requestRender();
    onClose();
  };

  const endX = (n: string) => (liveDoc.strands[n]?.end.x ?? 0).toFixed(2);
  const endY = (n: string) => (liveDoc.strands[n]?.end.y ?? 0).toFixed(2);
  const attachText = (r: { isMain: boolean; attachable: boolean }) =>
    r.isMain ? 'X' : r.attachable ? '' : 'No';

  const HoldBtn = (p: { label: string; initial: number; cont: number; disabled?: boolean }) => (
    <button
      type="button"
      className="gd-angle-holdbtn"
      disabled={p.disabled}
      onPointerDown={() => startHold(p.initial, p.cont)}
      onPointerUp={stopHold}
      onPointerLeave={stopHold}
    >
      {p.label}
    </button>
  );

  return (
    <Modal
      title={`${t('edit_strand_angles', lang)} ${groupName}`}
      onClose={apply}
      lang={lang}
      onEnter={apply}
      width={840}
      footer={<button onClick={apply}>{t('ok', lang)}</button>}
    >
      <div className="gd-angle-editor">
        <div className="gd-member-list gd-angle-scroll">
          <table className="gd-angle-table">
            <thead>
              <tr>
                <th>{t('layer', lang)}</th>
                <th>{t('angle', lang)}</th>
                <th>{t('adjust_1_degree', lang)}</th>
                <th>{t('fast_adjust', lang)}</th>
                <th>{t('end_x', lang)}</th>
                <th>{t('end_y', lang)}</th>
                <th>{t('x', lang)}</th>
                <th>{t('x_plus_180', lang)}</th>
                <th>{t('attachable', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign: 'center', opacity: 0.6 }}>—</td></tr>
              )}
              {rows.map((r) => {
                const n = r.name;
                const ed = r.editable;
                return (
                  <tr key={n} className={ed ? '' : 'gd-angle-disabled'}>
                    <td className="gd-angle-name">{n}</td>
                    <td>
                      <input
                        type="number"
                        step={0.01}
                        disabled={!ed}
                        value={Number((angles[n] ?? 0).toFixed(2))}
                        onChange={(e) => setAngle(n, Number(e.target.value))}
                      />
                    </td>
                    <td>
                      <button disabled={!ed} onClick={() => bump(n, -1)}>-</button>
                      <button disabled={!ed} onClick={() => bump(n, 1)}>+</button>
                    </td>
                    <td>
                      <button disabled={!ed} onClick={() => bump(n, -5)}>--</button>
                      <button disabled={!ed} onClick={() => bump(n, 5)}>++</button>
                    </td>
                    <td className="gd-angle-num">{endX(n)}</td>
                    <td className="gd-angle-num">{endY(n)}</td>
                    <td>
                      <input type="checkbox" disabled={!ed} checked={!!xChk[n]} onChange={() => toggleX(n)} />
                    </td>
                    <td>
                      <input type="checkbox" disabled={!ed} checked={!!x180Chk[n]} onChange={() => toggleX180(n)} />
                    </td>
                    <td className="gd-angle-attach">{attachText(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Global X-angle field with press-and-hold acceleration buttons */}
        <div className="gd-angle-xrow">
          <span className="gd-label">{t('X_angle', lang)}</span>
          <input
            type="number"
            step={0.01}
            className="gd-angle-xinput"
            value={Number(xAngle.toFixed(2))}
            onChange={(e) => setXAngle(Number(e.target.value))}
          />
          <span className="gd-spacer" />
          <HoldBtn label="--" initial={-5} cont={-0.4} />
          <HoldBtn label="-" initial={-1} cont={-0.025} />
          <HoldBtn label="+" initial={1} cont={0.025} />
          <HoldBtn label="++" initial={5} cont={0.4} />
        </div>
      </div>
    </Modal>
  );
}
