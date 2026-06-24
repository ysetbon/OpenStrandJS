// Draw a new strand on empty space (press-drag-release at a FREE angle, grid-snapped
// when snap-to-grid is enabled — matching OSS, which never 45-locks a mouse-drawn
// first strand) OR attach a child by dragging out of a free parent endpoint's 120px
// circle. The strand is created on pointer-up so a zero-length drag cancels cleanly.

import { useEditorStore } from '../store/editorStore';
import { addNewStrand, attachChild, snapPoint } from '../store/actions';
import { screenToWorld } from '../interaction/viewTransform';
import type { EditorDocument, HandleKind, Point, ViewState } from '../model/types';
import type { Mode, ModeContext, PointerInfo } from './Mode';

const ATTACH_R = 60;        // world px (120px-diameter circle around free endpoints)
const MIN_LEN = 8;          // world px; shorter drags are cancelled
const MIN_ATTACH_LEN = 40;  // world px; attached child clamped to >= this (OSS attached_strand.py min_length)

// Push `end` out to `min` px along the cursor direction when the drag is shorter
// than the minimum (but non-zero) — mirrors AttachedStrand.update (min_length).
function clampMinLen(start: Point, end: Point, min: number): Point {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len <= 0 || len >= min) return end;
  const a = Math.atan2(dy, dx);
  return { x: start.x + min * Math.cos(a), y: start.y + min * Math.sin(a) };
}

// Constrain a world point to ~50px inside the visible canvas edges, matching OSS
// attach_mode.py constrain_coordinates_to_visible_viewport (~874): zoom<1 allows
// +/-0.5x the visible extent; while panned, +/-2x; otherwise clamp to the
// visible rect shrunk by 50/zoom.
function constrainToViewport(world: Point, view: ViewState): Point {
  const zoom = view.zoom || 1;
  const tl = screenToWorld({ x: 0, y: 0 }, view);
  const br = screenToWorld({ x: view.width, y: view.height }, view);
  const vw = br.x - tl.x, vh = br.y - tl.y;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  if (zoom < 1) {
    const f = 0.5; // allow some extension beyond the visible area
    return {
      x: clamp(world.x, tl.x - vw * f, br.x + vw * f),
      y: clamp(world.y, tl.y - vh * f, br.y + vh * f),
    };
  }
  if (view.panX !== 0 || view.panY !== 0) {
    const e = 2.0; // panned: allow drawing up to 2x the visible area outside the view
    return {
      x: clamp(world.x, tl.x - vw * e, br.x + vw * e),
      y: clamp(world.y, tl.y - vh * e, br.y + vh * e),
    };
  }
  const margin = 50 / zoom; // not panning: tighter constraint
  return {
    x: clamp(world.x, tl.x + margin, br.x - margin),
    y: clamp(world.y, tl.y + margin, br.y - margin),
  };
}

interface FreeEnd { layer: string; side: 0 | 1; pos: Point; }

function nearestFreeEndpoint(doc: EditorDocument, world: Point): FreeEnd | null {
  let best: FreeEnd | null = null;
  let bestD = ATTACH_R;
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s || s.type === 'MaskedStrand' || s.is_hidden || doc.locked_layers.includes(name)) continue;
    const ends: [Point, 0 | 1][] = [[s.start, 0], [s.end, 1]];
    for (const [pt, side] of ends) {
      if (s.has_circles[side]) continue; // occupied
      const d = Math.hypot(world.x - pt.x, world.y - pt.y);
      if (d <= bestD) { bestD = d; best = { layer: name, side, pos: { ...pt } }; }
    }
  }
  return best;
}

let drag: { kind: 'new' | 'attach'; start: Point; parent?: string; side?: 0 | 1 } | null = null;

export const AttachMode: Mode = {
  name: 'attach',
  cursor: 'crosshair',

  onPointerDown(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    // OSS is_drawing_new_strand: when the "New Strand" button/'N' armed this gesture,
    // it always draws a NEW main strand — endpoint-attach detection is skipped — and
    // the flag clears on the press (attach_mode.py:668) so the mode reverts to plain
    // attach for the next gesture.
    const forceNew = st.newStrandArmed;
    if (forceNew) st.setNewStrandArmed(false);
    const free = forceNew ? null : nearestFreeEndpoint(st.doc, p.world);
    if (free) {
      drag = { kind: 'attach', start: free.pos, parent: free.layer, side: free.side };
      st.setPending({ kind: 'attach', start: free.pos, end: free.pos, parent: free.layer, side: free.side });
    } else {
      drag = { kind: 'new', start: p.world };
      st.setPending({ kind: 'new', start: p.world, end: p.world });
    }
    st.beginGesture();
    st.setDragging(true);
    // OSS start_attachment clears the previously-selected strand's highlight the
    // instant an attach/new gesture begins (attach_mode.py:1088-1108) — so a strand
    // you attach onto stops showing its red-halo + C-shape highlight during the
    // drag (its new circle draws as a plain cap, not a highlighted C-ring). The
    // highlight lives in #c under the body, so an overlay-only redraw can't clear
    // it: drop the selection and re-render #c. On release the new child becomes the
    // selection (mirroring OSS's add_layer_button selection), so the end-state C-
    // shape belongs to the child, exactly like the original.
    if (st.selection.layerName !== null) {
      st.setSelection({ layerName: null, handle: null });
      ctx.requestRender();
    } else {
      ctx.requestOverlay();
    }
  },

  onPointerMove(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    if (drag) {
      const world = constrainToViewport(p.world, st.view);
      const end = drag.kind === 'new'
        ? snapPoint(world, st.settings)
        : clampMinLen(drag.start, world, MIN_ATTACH_LEN);
      st.setPending({ kind: drag.kind, start: drag.start, end, parent: drag.parent, side: drag.side });
      ctx.requestOverlay();
      return;
    }
    // Idle hover: light up the nearest free endpoint's attach circle (yellow) — but
    // not while a new-strand draw is armed: that gesture is forced-new, so OSS shows
    // a clean crosshair with no attach target.
    const free = st.newStrandArmed ? null : nearestFreeEndpoint(st.doc, p.world);
    const next = free
      ? { layerName: free.layer, handle: (free.side === 0 ? 'start' : 'end') as HandleKind }
      : { layerName: null, handle: null };
    if (st.hover.layerName !== next.layerName || st.hover.handle !== next.handle) {
      st.setHover(next);
      ctx.requestOverlay();
    }
  },

  onPointerUp(p: PointerInfo, ctx: ModeContext) {
    if (!drag) return;
    const st = useEditorStore.getState();
    const d = drag;
    const world = constrainToViewport(p.world, st.view);
    const end = d.kind === 'new'
      ? snapPoint(world, st.settings)        // free angle, grid-snapped when enabled
      : clampMinLen(d.start, world, MIN_ATTACH_LEN);
    drag = null;
    st.setPending(null);
    st.setDragging(false);

    // Cancel a too-short drag. For 'attach' measure the RAW cursor distance (clampMinLen
    // would otherwise stretch it to MIN_ATTACH_LEN); for 'new' measure the SNAPPED end so
    // a grid-snap that collapses the endpoint back onto the start cancels too.
    const dragLen = d.kind === 'new'
      ? Math.hypot(end.x - d.start.x, end.y - d.start.y)
      : Math.hypot(p.world.x - d.start.x, p.world.y - d.start.y);
    if (dragLen < MIN_LEN) {
      st.commit();               // nothing created -> commit() discards the no-op gesture
      ctx.requestOverlay();
      return;
    }

    let newName: string | null = null;
    st.mutateDoc((draft) => {
      newName = d.kind === 'new'
        ? addNewStrand(draft, d.start, end)
        : attachChild(draft, d.parent!, d.side!, d.start, end);
    });
    st.commit();                 // one create = one undo step
    if (newName) st.setSelection({ layerName: newName, handle: null });
    ctx.requestRender();
  },
};
