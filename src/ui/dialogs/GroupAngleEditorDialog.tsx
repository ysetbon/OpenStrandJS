import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore, cloneDoc } from '../../store/editorStore';
import { resolveGroupMembers } from '../../model/group';
import { movingStrandSet } from '../../interaction/connections';
import { setStrandAngle } from '../../store/actions';
import { requestRender } from '../../renderer/renderScheduler';
import { t } from '../i18n';
import type { EditorDocument } from '../../model/types';

// Per-strand "Edit Strand Angles" for a group, OSS-faithful to
// StrandAngleEditDialog (group_layers.py:6109). Lists every EDITABLE member
// strand with its current absolute angle (start->end, atan2(dy,dx) in degrees,
// 0deg=+x, y-down so positive = clockwise on screen, normalized to (-180,180]).
// Each row has a number input + -1/+1 and -5/+5 buttons; every change live-
// previews via mutateDoc(setStrandAngle) which rotates that strand's END about
// its START (length preserved) and drags welded attached children rigidly --
// identical to dragging the endpoint.
//
// Lifecycle mirrors GroupRotateDialog:
//   * snapshot the doc on open (baseRef) for Cancel,
//   * beginGesture() so the whole session collapses to ONE undo step,
//   * engage the renderer drag fast-path over the resolved members (+ welded
//     peers + dependent masks), shadows off, only the group redraws,
//   * OK commits the live state (one undo), Cancel restores baseRef (no undo).
//
// Editability (OSS populate_table 6437-6441): editable <=> not a "_1" main
// strand, not a MaskedStrand, and is_attachable() (at least one open end, i.e.
// NOT both has_circles true). resolveGroupMembers already excludes masks; we
// additionally drop "_1" mains and strands closed at both ends.
//
// Deferred vs OSS (core angle editing implemented faithfully):
//   * End X / End Y read-out columns (OSS cols 4-5),
//   * the shared x_angle "x" / "180+x" checkbox sync (OSS cols 6-7),
//   * continuous press-and-hold acceleration on the bottom global buttons
//     (500ms initial delay then 10ms repeat at +/-0.025 / +/-0.4).
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
  const baseRef = useRef(cloneDoc(init.doc));

  // Editable member rows resolved once on open.
  const members = useRef(
    resolveGroupMembers(init.doc, groupName).regular.filter((n) => {
      const s = init.doc.strands[n];
      if (!s) return false;
      if (s.type === 'MaskedStrand') return false; // masks never editable
      if (s.layer_name.endsWith('_1')) return false; // main strand excluded
      // is_attachable(): editable unless BOTH ends are closed (have circles).
      return !(s.has_circles[0] && s.has_circles[1]);
    }),
  ).current;

  // Live angle values (degrees), seeded from each strand's current geometry.
  const [angles, setAngles] = useState<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const n of members) out[n] = angleOf(init.doc, n);
    return out;
  });

  // Open the gesture + engage the drag fast-path for every member's branch
  // (welded peers + attached children) plus any masks that depend on them.
  useEffect(() => {
    const s = useEditorStore.getState();
    s.beginGesture();
    s.setDragging(true);
    const moving = new Set<string>();
    for (const n of members) for (const m of movingStrandSet(s.doc, n, 'end')) moving.add(m);
    s.setDragMoving([...moving]);
    return () => {
      const z = useEditorStore.getState();
      if (z.dragging) {
        z.setDragging(false);
        z.setDragMoving([]);
        requestRender();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set an absolute angle for one row and live-preview it. Because moving this
  // strand's end can drag a welded sibling's start (changing that sibling's
  // angle), re-read every other row from the resulting live doc so the displayed
  // angles stay accurate; the edited row keeps the exact value set.
  const setAngle = (n: string, deg: number) => {
    const v = normalize180(deg);
    useEditorStore.getState().mutateDoc((d) => setStrandAngle(d, n, v));
    const doc = useEditorStore.getState().doc;
    const next: Record<string, number> = {};
    for (const m of members) next[m] = m === n ? v : angleOf(doc, m);
    setAngles(next);
  };

  // ±delta relative to the row's current angle.
  const bump = (n: string, delta: number) => setAngle(n, (angles[n] ?? 0) + delta);

  const endDrag = () => {
    const s = useEditorStore.getState();
    s.setDragging(false);
    s.setDragMoving([]);
  };

  const apply = () => {
    endDrag();
    useEditorStore.getState().commit(); // live state is final -> one undo step
    requestRender();
    onClose();
  };

  const cancel = () => {
    endDrag();
    const st = useEditorStore.getState();
    st.setDoc(cloneDoc(baseRef.current));
    st.commit(); // base == gestureBase -> clears gesture, no history
    requestRender();
    onClose();
  };

  return (
    <Modal
      title={`${t('edit_strand_angles', lang)}: ${groupName}`}
      onClose={cancel}
      footer={
        <>
          <button onClick={cancel}>{t('cancel', lang)}</button>
          <button onClick={apply}>{t('ok', lang)}</button>
        </>
      }
    >
      <div
        style={{
          minWidth: 750 - 48,
          minHeight: 450 - 120,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="gd-member-list">
          {members.length === 0 ? (
            <div className="gd-row">
              <span className="gd-label">—</span>
            </div>
          ) : (
            members.map((n) => (
              <div key={n} className="gd-row" style={{ padding: '4px 0' }}>
                <span className="gd-label">{n}</span>
                <span className="gd-label">{t('angle_label', lang)}</span>
                <input
                  type="number"
                  min={-180}
                  max={180}
                  step={0.01}
                  value={Number((angles[n] ?? 0).toFixed(2))}
                  onChange={(e) => setAngle(n, Number(e.target.value))}
                />
                <span className="gd-label">°</span>
                <button onClick={() => bump(n, -5)}>-5</button>
                <button onClick={() => bump(n, -1)}>-1</button>
                <button onClick={() => bump(n, 1)}>+1</button>
                <button onClick={() => bump(n, 5)}>+5</button>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
