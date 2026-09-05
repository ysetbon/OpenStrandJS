// Drag an endpoint or control point. Endpoints carry their welded peers (and
// each strand's associated control point) rigidly via the connection graph;
// control points move alone. Grab + selection semantics are a faithful port of
// OpenStrand Studio's move_mode press logic (moveGrab): a click that misses every
// endpoint/control-point square neither grabs NOR changes the selection (move mode
// has no body hit-test — a body click does nothing, move_mode.py:1428-1443). A grab
// that HITS a handle selects it only as a transient drag highlight: on release the
// selection always reverts to whatever was selected before the press, whether the
// pointer moved or not (move_mode.py:1648-1650) — move mode itself never leaves a
// new strand selected once you let go.

import { useEditorStore } from '../store/editorStore';
import { moveGrab } from '../interaction/hitTest';
import { movingStrandSet, beginWeldGesture, endWeldGesture } from '../interaction/connections';
import { moveHandle, snapMove, autoAdjustCp1OnGrab, resetStraightCurveFlags, seedMaskCenters } from '../store/actions';
import type { HandleKind, Point, Selection, StrandRecord } from '../model/types';
import type { Mode, ModeContext, PointerInfo } from './Mode';

let drag: {
  layer: string;
  handle: HandleKind;
  offset: Point;
  lastSnap: Point | null;
  prevSelection: Selection;     // selection before this grab — restored on abort (OSS originally_selected_strand)
} | null = null;

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
    const hit = moveGrab(p.world, st.doc, st.settings, st.docRevision);   // handle-only, square areas, OSS pass order
    if (hit) {
      const s = st.doc.strands[hit.layerName];
      const hp = handlePos(s, hit.handle);
      const moving = movingStrandSet(st.doc, hit.layerName, hit.handle);
      drag = {
        layer: hit.layerName, handle: hit.handle,
        offset: { x: hp.x - p.world.x, y: hp.y - p.world.y },   // cursor-lock offset (no jump)
        // Seed the snapped-target early-out to the snapped CLICK position (OSS seeds
        // last_snapped_pos = snap_to_grid(press pos), move_mode.py:1375). This is NOT the
        // snapped handle: when the off-grid handle and the click sit in different grid
        // cells, the first move (adjusted == handle) snaps the handle onto the grid — OSS
        // does this, and seeding from the click (not the handle) preserves it.
        lastSnap: snapMove(p.world, st.settings, st.view.zoom, p.ctrl),
        prevSelection: st.selection,
      };
      st.setSelection({ layerName: hit.layerName, handle: hit.handle });
      // Stage the provenance now: pointer-down is where we know WHAT was grabbed.
      st.beginGesture({ action: 'move.handle', source: 'mode', targets: [hit.layerName], detail: hit.handle });
      // Press-time auto-adjust: grabbing cp1 on a collapsed triangle snaps cp2 onto the
      // end (passive) before the first move (and pins the center if the third CP is on).
      // Folds into this gesture's single undo step and reverts on cancel.
      if (hit.handle === 'control_point1') {
        st.mutateDoc((d) => autoAdjustCp1OnGrab(d, hit.layerName, st.settings.enable_third_control_point));
      }
      // Ground each affected mask's centroid from current geometry so its deletion
      // rectangles track from the very first drag frame (OSS keeps centers always-live).
      st.mutateDoc((d) => seedMaskCenters(d, moving, st.settings.curve_params));
      st.setDragging(true);
      // Topology is invariant across an endpoint drag: mint a per-gesture weld-graph
      // token so moveHandle reuses one cached connection table for the whole gesture.
      beginWeldGesture();
      // Publish the set of strands that move with this handle so the renderer can bake
      // everything else as a static background and redraw only these per frame.
      st.setDragMoving([...moving]);
      ctx.requestRender();   // selection highlight is drawn in #c (under the body)
    } else {
      // No grab. OSS re-asserts the existing selection (a blank/body click does NOT
      // deselect and does NOT select) — so we leave store.selection untouched. Clear any
      // stale drag so a press that grabs nothing can't leave a prior gesture armed.
      drag = null;
    }
  },

  onPointerMove(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    if (drag) {
      const raw = { x: p.world.x + drag.offset.x, y: p.world.y + drag.offset.y };
      // Zoom/Ctrl-gated grid snap (OSS mouseMoveEvent:4036-4079).
      const pos = snapMove(raw, st.settings, st.view.zoom, p.ctrl);
      // OSS skips the entire update when the snapped target is unchanged (move_mode.py:4086).
      if (drag.lastSnap && drag.lastSnap.x === pos.x && drag.lastSnap.y === pos.y) return;
      drag.lastSnap = pos;
      const d = drag;
      // In-place edit (no per-frame document clone, no layer-panel re-render):
      // the gesture's undo baseline was snapshotted at pointer-down, so the
      // history entry this drag will commit is untouched by it.
      st.mutateDocLive((doc) => moveHandle(doc, d.layer, d.handle, pos, st.settings.curve_params));
      ctx.requestRender();   // paint this move in THIS frame, not the next one
    } else {
      const hit = moveGrab(p.world, st.doc, st.settings, st.docRevision);   // hover mirrors what a press would grab
      const next = hit
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
      const layer = drag.layer;
      const prevSelection = drag.prevSelection;
      drag = null;
      const st = useEditorStore.getState();
      st.setDragging(false);
      st.setDragMoving([]);      // end the gesture's moving set
      endWeldGesture();          // drop the per-gesture connection-table cache
      // Re-hide cp2/center if the curve returned to straight (OSS mouseReleaseEvent:1620).
      st.mutateDoc((draft) => resetStraightCurveFlags(draft, layer));
      st.commit();               // one drag = one undo step (no-op if nothing changed)
      // The grab-time selection (onPointerDown) is a TRANSIENT drag highlight, not a
      // real selection change: OSS mouseReleaseEvent always restores the pre-press
      // selection once a grab succeeded, whether the pointer moved or not
      // (final_selected_strand = originally_selected_strand when was_moving,
      // move_mode.py:1648-1650) — move mode never leaves a new strand selected on
      // release; only Select mode's body click does that.
      st.setSelection(prevSelection);
      ctx.requestRender();       // dragging=false -> one full-quality render (shadows + supersample)
    }
  },

  // Abort (pointercancel / ESC mid-drag): revert the in-progress move, create NO undo
  // entry, and restore the pre-press selection — mirroring OSS cancel_movement (which
  // resets without save_state and re-selects originally_selected_strand, move_mode.py:1491).
  onCancel(ctx: ModeContext) {
    if (drag) {
      const d = drag;
      drag = null;
      const st = useEditorStore.getState();
      st.setDragging(false);
      st.setDragMoving([]);
      endWeldGesture();
      st.cancelGesture();             // restore the pre-drag document, drop the gesture
      st.setSelection(d.prevSelection);
      ctx.requestRender();
    }
  },
};
