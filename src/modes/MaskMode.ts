// Two-click over/under masking. First click picks the OVER strand, second click
// the UNDER strand -> a MaskedStrand "over_under" is appended on top. Clicking
// the same strand twice or empty space resets the pending pick.

import { useEditorStore } from '../store/editorStore';
import { hitTest } from '../interaction/hitTest';
import { createMask } from '../store/actions';
import type { Mode, ModeContext, PointerInfo } from './Mode';

export const MaskMode: Mode = {
  name: 'mask',
  cursor: 'pointer',

  onPointerDown(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    const hit = hitTest(p.world, st.doc, st.settings);
    const layer = hit ? hit.layerName : null;

    if (!layer || st.doc.strands[layer]?.type === 'MaskedStrand') {
      st.setMaskPending([]);
      ctx.requestOverlay();
      return;
    }

    const pending = st.maskPending;
    if (pending.length === 0) {
      st.setMaskPending([layer]);
      ctx.requestOverlay();
      return;
    }
    if (pending[0] === layer) {
      st.setMaskPending([]);     // clicked the same strand -> cancel
      ctx.requestOverlay();
      return;
    }

    const first = pending[0];
    let newName: string | null = null;
    st.mutateDoc((draft) => { newName = createMask(draft, first, layer); });
    st.setMaskPending([]);
    if (newName) st.setSelection({ layerName: newName, handle: null });
    ctx.requestRender();
  },

  onPointerMove() {},
  onPointerUp() {},
};
