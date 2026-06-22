// Draw a new strand on empty space (press-drag-release; 45-degree locked since
// it's the first strand of a new set) OR attach a child by dragging out of a
// free parent endpoint's 120px circle. The strand is created on pointer-up so a
// zero-length drag cancels cleanly.

import { useEditorStore } from '../store/editorStore';
import { addNewStrand, attachChild, snapAngle45 } from '../store/actions';
import type { EditorDocument, HandleKind, Point } from '../model/types';
import type { Mode, ModeContext, PointerInfo } from './Mode';

const ATTACH_R = 60;   // world px (120px-diameter circle around free endpoints)
const MIN_LEN = 8;     // world px; shorter drags are cancelled

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
    const free = nearestFreeEndpoint(st.doc, p.world);
    if (free) {
      drag = { kind: 'attach', start: free.pos, parent: free.layer, side: free.side };
      st.setPending({ kind: 'attach', start: free.pos, end: free.pos, parent: free.layer, side: free.side });
    } else {
      drag = { kind: 'new', start: p.world };
      st.setPending({ kind: 'new', start: p.world, end: p.world });
    }
    st.beginGesture();
    st.setDragging(true);
    ctx.requestOverlay();
  },

  onPointerMove(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    if (drag) {
      const end = drag.kind === 'new' ? snapAngle45(drag.start, p.world) : p.world;
      st.setPending({ kind: drag.kind, start: drag.start, end, parent: drag.parent, side: drag.side });
      ctx.requestOverlay();
      return;
    }
    // Idle hover: light up the nearest free endpoint's attach circle (yellow).
    const free = nearestFreeEndpoint(st.doc, p.world);
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
    const end = d.kind === 'new' ? snapAngle45(d.start, p.world) : p.world;
    drag = null;
    st.setPending(null);
    st.setDragging(false);

    if (Math.hypot(end.x - d.start.x, end.y - d.start.y) < MIN_LEN) {
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
