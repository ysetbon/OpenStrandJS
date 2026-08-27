// OSS RotateMode (rotate_mode.py) — swing one FREE endpoint of a strand around its
// other endpoint at a fixed chord length.
//
//   press   try_rotate_strand (:153-178): forward (bottom-first) z-order, masks
//           skipped, square hit areas of side 2*width on each endpoint, start
//           before end, first hit wins, and only endpoints with has_circles false.
//   drag    calculate_new_position (:241-262): the endpoint follows
//           atan2(cursor - pivot) at the ORIGINAL chord length; the handles and any
//           glued child come with it (see applyRotateSnapshot).
//   release mouseReleaseEvent (:87-110): one undo step, but only if a rotation
//           actually happened.
//
// Two OSS behaviours are deliberately not reproduced:
//   * the 16 ms / factor-0.3 easing timer (gradual_move :112-141). It only changes
//     how the endpoint CATCHES UP to the cursor; the resting position after the
//     pointer stops is identical, so it is cosmetic and frame-rate dependent.
//   * update_cursor_position's QCursor.setPos warp — the browser cannot move the
//     system pointer, and OSS's own drag path no longer calls it.
//
// No overlay: RotateMode has no draw() and the canvas gates its endpoint squares on
// MoveMode (strand_drawing_canvas.py:2213), so nothing is painted while rotating.

import { useEditorStore } from '../store/editorStore';
import { rotateGrab, snapshotRotate, applyRotateSnapshot, seedMaskCenters } from '../store/actions';
import type { RotateSnapshot } from '../store/actions';
import type { Mode, ModeContext, PointerInfo } from './Mode';

let gesture: { snap: RotateSnapshot; rotated: boolean } | null = null;

export const RotateMode: Mode = {
  name: 'rotate',
  // OSS sets Qt.SizeAllCursor for rotate mode (strand_drawing_canvas.py:5003-5005).
  cursor: 'move',

  onPointerDown(p: PointerInfo, ctx: ModeContext) {
    if (p.button !== 0) return;
    const st = useEditorStore.getState();
    const hit = rotateGrab(st.doc, p.world);
    if (!hit) { gesture = null; return; }
    const snap = snapshotRotate(st.doc, hit.name, hit.side);
    // A zero-length strand has no chord to swing: atan2 of the null vector is
    // meaningless and every frame would land the endpoint back on the pivot.
    if (!snap || snap.chordLen <= 1e-9) { gesture = null; return; }
    gesture = { snap, rotated: false };
    st.beginGesture();
    // Ground each dependent mask's centroid from the CURRENT geometry so its erase
    // windows drift from the very first frame rather than from the second.
    const moving = new Set<string>([snap.name, ...snap.children.map((c) => c.name)]);
    st.mutateDoc((d) => seedMaskCenters(d, moving, st.settings.curve_params));
    st.setDragging(true);
    st.setDragMoving([...moving]);
    ctx.requestRender();
  },

  onPointerMove(p: PointerInfo, ctx: ModeContext) {
    if (!gesture) return;
    const g = gesture;
    const st = useEditorStore.getState();
    const angle = Math.atan2(p.world.y - g.snap.pivot.y, p.world.x - g.snap.pivot.x);
    g.rotated = true;
    // In-place edit, same contract as MoveMode: snapshotRotate + beginGesture
    // ran at pointer-down, so the undo baseline is already independent.
    st.mutateDocLive((d) => applyRotateSnapshot(d, g.snap, angle, st.settings.curve_params));
    ctx.requestRender();   // paint this move in THIS frame, not the next one
  },

  onPointerUp(_p: PointerInfo, ctx: ModeContext) {
    if (!gesture) return;
    const rotated = gesture.rotated;
    gesture = null;
    const st = useEditorStore.getState();
    st.setDragging(false);
    st.setDragMoving([]);
    // OSS only calls save_state when a rotation happened; commit() is a no-op when
    // the document is unchanged, so a press-and-release with no motion adds no step.
    if (rotated) st.commit(); else st.cancelGesture();
    ctx.requestRender();   // dragging=false -> one full-quality render (shadows back)
  },

  // ESC / pointercancel mid-drag: drop the gesture with no undo entry, exactly like
  // MoveMode's abort. OSS has no rotate abort, but leaving a half-applied rotation
  // live with an open gesture would strand the store.
  onCancel(ctx: ModeContext) {
    if (!gesture) return;
    gesture = null;
    const st = useEditorStore.getState();
    st.setDragging(false);
    st.setDragMoving([]);
    st.cancelGesture();
    ctx.requestRender();
  },
};
