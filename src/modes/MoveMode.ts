// Drag an endpoint or control point. Endpoints carry their welded peers (and
// each strand's associated control point) rigidly via the connection graph;
// control points move alone. Clicking a body selects it (so its handles appear);
// clicking empty space deselects.

import { useEditorStore } from '../store/editorStore';
import { hitTest } from '../interaction/hitTest';
import { movingStrandSet } from '../interaction/connections';
import { moveHandle, snapPoint } from '../store/actions';
import type { HandleKind, Point, StrandRecord } from '../model/types';
import type { Mode, ModeContext, PointerInfo } from './Mode';

let drag: { layer: string; handle: HandleKind; offset: Point } | null = null;

function handlePos(s: StrandRecord, handle: HandleKind): Point {
  switch (handle) {
    case 'start': return s.start;
    case 'end': return s.end;
    case 'control_point1': return s.control_points[0];
    case 'control_point2': return s.control_points[1];
    case 'control_point_center': return s.control_point_center ?? s.start;
  }
}

export const MoveMode: Mode = {
  name: 'move',
  cursor: 'crosshair',

  onPointerDown(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    const hit = hitTest(p.world, st.doc, st.settings);
    if (hit && hit.kind === 'handle') {
      const s = st.doc.strands[hit.layerName];
      const hp = handlePos(s, hit.handle);
      drag = { layer: hit.layerName, handle: hit.handle, offset: { x: hp.x - p.world.x, y: hp.y - p.world.y } };
      st.setSelection({ layerName: hit.layerName, handle: hit.handle });
      st.beginGesture();
      st.setDragging(true);
      // Publish the set of strands that move with this handle so the renderer can
      // bake everything else as a static background and redraw only these per frame.
      st.setDragMoving([...movingStrandSet(st.doc, hit.layerName, hit.handle)]);
      ctx.requestRender();   // selection highlight is drawn in #c (under the body)
    } else if (hit && hit.kind === 'body') {
      st.setSelection({ layerName: hit.layerName, handle: null });
      ctx.requestRender();
    } else {
      st.setSelection({ layerName: null, handle: null });
      ctx.requestRender();
    }
  },

  onPointerMove(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    if (drag) {
      const raw = { x: p.world.x + drag.offset.x, y: p.world.y + drag.offset.y };
      const pos = snapPoint(raw, st.settings);
      const d = drag;
      st.mutateDoc((draft) => moveHandle(draft, d.layer, d.handle, pos));
      // mutateDoc bumps docRevision -> CanvasStage re-renders #c + overlay.
    } else {
      const hit = hitTest(p.world, st.doc, st.settings);
      const next = hit && hit.kind === 'handle'
        ? { layerName: hit.layerName, handle: hit.handle }
        : { layerName: null, handle: null };
      if (st.hover.layerName !== next.layerName || st.hover.handle !== next.handle) {
        st.setHover(next);
        ctx.requestOverlay();
      }
    }
  },

  onPointerUp(_p: PointerInfo, ctx: ModeContext) {
    if (drag) {
      drag = null;
      const st = useEditorStore.getState();
      st.setDragging(false);
      st.setDragMoving([]);      // end the gesture's moving set
      st.commit();               // one drag = one undo step
      ctx.requestRender();       // dragging=false -> one full-quality render (shadows + supersample)
    }
  },
};
