// Mask mode does two things:
//  - click two regular strands -> create an over/under MaskedStrand
//  - click+drag inside an existing mask -> erase that rectangle from the overlap
//    (adds a deletion_rectangle; the renderer subtracts it, revealing the under
//    strand). "Reset mask" (toolbar) clears a selected mask's erasers.
// Clicking the same strand twice or empty space resets the pending pick.

import { useEditorStore } from '../store/editorStore';
import { hitTest, maskHitTest } from '../interaction/hitTest';
import { addDeletionRect, createMask } from '../store/actions';
import type { Point } from '../model/types';
import type { Mode, ModeContext, PointerInfo } from './Mode';

let eraserDrag: { layerName: string; start: Point } | null = null;
const MIN_SIDE = 4; // world px

function rectOf(a: Point, b: Point) {
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

export const MaskMode: Mode = {
  name: 'mask',
  cursor: 'pointer',

  onPointerDown(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();

    // Drag inside an existing mask -> erase.
    const mask = maskHitTest(p.world, st.doc, st.settings);
    if (mask) {
      eraserDrag = { layerName: mask, start: p.world };
      st.setSelection({ layerName: mask, handle: null });
      st.setMaskPending([]);
      st.setEraser({ layerName: mask, rect: rectOf(p.world, p.world) });
      st.beginGesture();
      st.setDragging(true);
      ctx.requestOverlay();
      return;
    }

    // Otherwise: two-click create.
    const hit = hitTest(p.world, st.doc, st.settings);
    const layer = hit ? hit.layerName : null;
    if (!layer || st.doc.strands[layer]?.type === 'MaskedStrand') {
      st.setMaskPending([]);
      ctx.requestOverlay();
      return;
    }
    const pending = st.maskPending;
    if (pending.length === 0) { st.setMaskPending([layer]); ctx.requestOverlay(); return; }
    if (pending[0] === layer) { st.setMaskPending([]); ctx.requestOverlay(); return; }

    const first = pending[0];
    let newName: string | null = null;
    st.commitEdit((draft) => { newName = createMask(draft, first, layer); });
    st.setMaskPending([]);
    if (newName) st.setSelection({ layerName: newName, handle: null });
    ctx.requestRender();
  },

  onPointerMove(p: PointerInfo, ctx: ModeContext) {
    if (!eraserDrag) return;
    const st = useEditorStore.getState();
    st.setEraser({ layerName: eraserDrag.layerName, rect: rectOf(eraserDrag.start, p.world) });
    ctx.requestOverlay();
  },

  onPointerUp(p: PointerInfo, ctx: ModeContext) {
    if (!eraserDrag) return;
    const st = useEditorStore.getState();
    const rect = rectOf(eraserDrag.start, p.world);
    const layer = eraserDrag.layerName;
    eraserDrag = null;
    st.setEraser(null);
    st.setDragging(false);
    if (rect.maxX - rect.minX > MIN_SIDE && rect.maxY - rect.minY > MIN_SIDE) {
      st.mutateDoc((draft) => addDeletionRect(draft, layer, rect));
    }
    st.commit();                 // one erase = one undo step (no-op gesture discarded)
    ctx.requestRender();
  },
};
