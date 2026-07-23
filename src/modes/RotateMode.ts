// OSS RotateMode (rotate_mode.py, whole file) — rotate one free endpoint of a
// strand about its OTHER endpoint, chord-length preserved.
//   * Grab (press, :59-70,142-178): iterate strands in FORWARD (bottom-first)
//     z-order, skip MaskedStrand (:166-167); hit areas are SQUARES of side
//     2·strand.width centered on each endpoint (get_end_rectangle :215-227);
//     an endpoint is rotatable only when `!has_circles[side]` (free end,
//     :172-175); start is tested before end; first hit wins. Hidden strands
//     are NOT skipped and lock mode is not consulted — faithful to OSS.
//   * Drag (:72-85,241-262): the endpoint follows atan2(cursor − pivot) at the
//     ORIGINAL straight-line chord length; cp1/cp2/center rotate rigidly about
//     the pivot by the same delta (:296-307,370-390). (OSS eases the motion
//     through a 16 ms timer at factor 0.3 — cosmetic smoothing, not ported.)
//   * Attached strands whose start sat on the old endpoint are rigidly
//     TRANSLATED by the movement delta — start, end and both cps (:392-418).
//   * Release (:87-110): one undo step if a rotation happened. No overlay is
//     drawn — RotateMode has no draw() and the canvas gates its squares on
//     MoveMode (strand_drawing_canvas.py:2213).
import { useEditorStore, cloneDoc } from '../store/editorStore';
import type { EditorDocument, Point } from '../model/types';
import type { Mode, ModeContext, PointerInfo } from './Mode';

interface ChildSnap { name: string; start: Point; end: Point; cp1: Point; cp2: Point; cpCenter: Point | null }

interface RotateGesture {
  name: string;
  side: 0 | 1;                 // which endpoint rotates (0 = start, 1 = end)
  pivot: Point;
  origPoint: Point;            // the rotating endpoint at grab time
  origAngle: number;           // rad, pivot -> origPoint
  chordLen: number;
  cp1: Point; cp2: Point; cpCenter: Point | null;
  children: ChildSnap[];       // strands glued to origPoint at grab time
  base: EditorDocument;        // for ESC abort
  rotated: boolean;
}

let gesture: RotateGesture | null = null;

function grabAt(doc: EditorDocument, w: Point): { name: string; side: 0 | 1 } | null {
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s || s.type === 'MaskedStrand') continue;
    for (const side of [0, 1] as const) {
      if (s.has_circles[side]) continue; // only FREE ends rotate
      const p = side === 0 ? s.start : s.end;
      const half = s.width; // square side = 2 * width (get_end_rectangle)
      if (Math.abs(w.x - p.x) <= half && Math.abs(w.y - p.y) <= half) return { name, side };
    }
  }
  return null;
}

function applyRotation(draft: EditorDocument, g: RotateGesture, angle: number): void {
  const s = draft.strands[g.name];
  if (!s) return;
  const np: Point = {
    x: g.pivot.x + Math.cos(angle) * g.chordLen,
    y: g.pivot.y + Math.sin(angle) * g.chordLen,
  };
  if (g.side === 0) s.start = np; else s.end = np;
  // Rotate the control points rigidly about the PIVOT by the angle delta.
  const d = angle - g.origAngle;
  const cos = Math.cos(d), sin = Math.sin(d);
  const rot = (pt: Point): Point => {
    const vx = pt.x - g.pivot.x, vy = pt.y - g.pivot.y;
    return { x: g.pivot.x + vx * cos - vy * sin, y: g.pivot.y + vx * sin + vy * cos };
  };
  s.control_points = [rot(g.cp1), rot(g.cp2)];
  if (g.cpCenter && s.control_point_center) s.control_point_center = rot(g.cpCenter);
  // Rigidly translate strands that were glued to the old endpoint (:392-418).
  const ddx = np.x - g.origPoint.x, ddy = np.y - g.origPoint.y;
  for (const c of g.children) {
    const cs = draft.strands[c.name];
    if (!cs) continue;
    cs.start = { x: c.start.x + ddx, y: c.start.y + ddy };
    cs.end = { x: c.end.x + ddx, y: c.end.y + ddy };
    cs.control_points = [
      { x: c.cp1.x + ddx, y: c.cp1.y + ddy },
      { x: c.cp2.x + ddx, y: c.cp2.y + ddy },
    ];
    if (c.cpCenter && cs.control_point_center) {
      cs.control_point_center = { x: c.cpCenter.x + ddx, y: c.cpCenter.y + ddy };
    }
  }
}

export const RotateMode: Mode = {
  name: 'rotate',
  cursor: 'move', // OSS SizeAllCursor (strand_drawing_canvas.py:5003-5005)

  onPointerDown(p: PointerInfo, ctx: ModeContext): void {
    if (p.button !== 0) return;
    const st = useEditorStore.getState();
    const hit = grabAt(st.doc, p.world);
    if (!hit) return;
    const s = st.doc.strands[hit.name];
    const pivot = hit.side === 0 ? { ...s.end } : { ...s.start };
    const origPoint = hit.side === 0 ? { ...s.start } : { ...s.end };
    const children: ChildSnap[] = [];
    for (const other of Object.keys(st.doc.strands)) {
      if (other === hit.name) continue;
      const o = st.doc.strands[other];
      if (!o || o.type === 'MaskedStrand') continue;
      if (Math.abs(o.start.x - origPoint.x) < 1e-6 && Math.abs(o.start.y - origPoint.y) < 1e-6) {
        children.push({
          name: other,
          start: { ...o.start }, end: { ...o.end },
          cp1: { ...o.control_points[0] }, cp2: { ...o.control_points[1] },
          cpCenter: o.control_point_center ? { ...o.control_point_center } : null,
        });
      }
    }
    gesture = {
      name: hit.name,
      side: hit.side,
      pivot,
      origPoint,
      origAngle: Math.atan2(origPoint.y - pivot.y, origPoint.x - pivot.x),
      chordLen: Math.hypot(origPoint.x - pivot.x, origPoint.y - pivot.y),
      cp1: { ...s.control_points[0] }, cp2: { ...s.control_points[1] },
      cpCenter: s.control_point_center ? { ...s.control_point_center } : null,
      children,
      base: cloneDoc(st.doc),
      rotated: false,
    };
    st.beginGesture();
    st.setDragging(true);
    st.setDragMoving([hit.name, ...children.map((c) => c.name)]);
    ctx.requestRender();
  },

  onPointerMove(p: PointerInfo, ctx: ModeContext): void {
    if (!gesture) return;
    const g = gesture;
    const angle = Math.atan2(p.world.y - g.pivot.y, p.world.x - g.pivot.x);
    g.rotated = true;
    useEditorStore.getState().mutateDoc((d) => applyRotation(d, g, angle));
    ctx.requestRender();
  },

  onPointerUp(_p: PointerInfo, ctx: ModeContext): void {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    const st = useEditorStore.getState();
    st.setDragging(false);
    st.setDragMoving([]);
    if (g.rotated) {
      st.commit(); // one undo step (rotate_mode.py:96-101)
    } else {
      st.setDoc(cloneDoc(g.base));
      st.commit(); // base == gestureBase -> no history entry
    }
    ctx.requestRender();
  },

  onCancel(ctx: ModeContext): void {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    const st = useEditorStore.getState();
    st.setDragging(false);
    st.setDragMoving([]);
    st.setDoc(cloneDoc(g.base));
    st.commit();
    ctx.requestRender();
  },
};
