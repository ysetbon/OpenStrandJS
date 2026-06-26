// Rotate a strand's FREE endpoint around the opposite (fixed) endpoint, preserving
// length — a faithful port of OpenStrand Studio's RotateMode (rotate_mode.py).
//
// Grab: a press whose position falls inside the ±width square of a free endpoint
// (one with no attachment circle, has_circles[side] == false) starts a rotation
// about the OTHER endpoint as the pivot. Masked strands are not rotatable. The
// gesture is continuous (no Shift/grid snapping) and the strand never stretches:
// the grabbed end is reprojected onto the circle of grab-time radius each move.
// One drag == one undo step; ESC / pointercancel aborts without an undo entry.

import { useEditorStore } from '../store/editorStore';
import { rotateStrandEndpoint } from '../store/actions';
import type { EditorDocument, Point, Selection } from '../model/types';
import type { Mode, ModeContext, PointerInfo } from './Mode';

// OSS get_end_rectangle: a square of half-extent `strand.width` centered on the
// endpoint, grabbable only when that end is free (no circle). First hit in
// doc.order wins; masked/hidden strands are skipped.
function rotateGrab(world: Point, doc: EditorDocument): { layer: string; side: 0 | 1 } | null {
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s || s.type === 'MaskedStrand' || s.is_hidden) continue;
    const half = s.width;
    const inSq = (c: Point) => Math.abs(world.x - c.x) <= half && Math.abs(world.y - c.y) <= half;
    if (inSq(s.start) && !s.has_circles[0]) return { layer: name, side: 0 };
    if (inSq(s.end) && !s.has_circles[1]) return { layer: name, side: 1 };
  }
  return null;
}

let drag: {
  layer: string;
  side: 0 | 1;
  radius: number;             // grab-time length (kept constant)
  lastAngle: number;          // early-out: skip identical angles
  prevSelection: Selection;   // restored on abort (OSS originally_selected_strand)
} | null = null;

export const RotateMode: Mode = {
  name: 'rotate',
  cursor: 'move',             // OSS Qt.SizeAllCursor

  onPointerDown(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    const hit = rotateGrab(p.world, st.doc);
    if (!hit) { drag = null; return; }
    const s = st.doc.strands[hit.layer];
    const pivot = hit.side === 0 ? s.end : s.start;
    const moving = hit.side === 0 ? s.start : s.end;
    drag = {
      layer: hit.layer,
      side: hit.side,
      radius: Math.hypot(moving.x - pivot.x, moving.y - pivot.y),
      lastAngle: NaN,
      prevSelection: st.selection,
    };
    st.setSelection({ layerName: hit.layer, handle: hit.side === 0 ? 'start' : 'end' });
    st.beginGesture();          // one undo step per drag
    st.setDragging(true);
    ctx.requestRender();        // selection highlight is drawn in #c (under the body)
  },

  onPointerMove(p: PointerInfo, _ctx: ModeContext) {
    const st = useEditorStore.getState();
    if (!drag) return;
    const d = drag;
    const s = st.doc.strands[d.layer];
    if (!s) return;
    const pivot = d.side === 0 ? s.end : s.start;
    const angle = Math.atan2(p.world.y - pivot.y, p.world.x - pivot.x);
    if (angle === d.lastAngle) return;
    d.lastAngle = angle;
    st.mutateDoc((draft) => rotateStrandEndpoint(draft, d.layer, d.side, p.world, d.radius));
    // mutateDoc bumps docRevision -> CanvasStage re-renders #c + overlay.
  },

  onPointerUp(_p: PointerInfo, ctx: ModeContext) {
    if (!drag) return;
    drag = null;
    const st = useEditorStore.getState();
    st.setDragging(false);
    st.commit();                // one drag = one undo step (no-op if unchanged)
    ctx.requestRender();        // full-quality render (shadows + supersample)
  },

  // Abort (ESC mid-drag / pointercancel): revert without an undo entry and restore
  // the pre-press selection (OSS cancel-style revert).
  onCancel(ctx: ModeContext) {
    if (!drag) return;
    const d = drag;
    drag = null;
    const st = useEditorStore.getState();
    st.setDragging(false);
    st.cancelGesture();
    st.setSelection(d.prevSelection);
    ctx.requestRender();
  },
};
