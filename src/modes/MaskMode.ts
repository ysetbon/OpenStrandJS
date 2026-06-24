// Mask mode is OSS's two-click CREATE flow and nothing else (mask_mode.py):
//   - move the pointer -> the strand under it gets a yellow HOVER highlight
//   - click a strand where it is the ONLY strand at that point -> pick it
//   - click a second (different) strand the same way -> create an over/under
//     MaskedStrand at their crossing (first = OVER, second = UNDER)
// Clicking the same strand twice, or empty space, or a spot where two strands
// overlap, clears the pending pick (OSS only selects when EXACTLY ONE strand is
// at the point). Masked strands are never pickable/hoverable here.
//
// Erasing parts of a mask (deletion rectangles) is NOT part of mask mode — that
// is the separate per-mask "Edit Mask" session (store.maskEditTarget), entered
// from a masked layer's context menu and handled in InteractionHost.

import { useEditorStore } from '../store/editorStore';
import { maskStrandsAtPoint } from '../interaction/hitTest';
import { createMask } from '../store/actions';
import type { Mode, ModeContext, PointerInfo } from './Mode';

export const MaskMode: Mode = {
  name: 'mask',
  cursor: 'crosshair',          // OSS Qt.CrossCursor (mask_mode.py:25)

  onPointerDown(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    const at = maskStrandsAtPoint(p.world, st.doc, st.settings);

    // OSS handle_mouse_press: select only when exactly one strand is at the point;
    // otherwise clear the pending pick (clicking empty space OR an overlap resets).
    if (at.length !== 1) {
      if (st.maskPending.length) st.setMaskPending([]);
      ctx.requestOverlay();
      return;
    }
    const layer = at[0];
    const pending = st.maskPending;

    // First pick (or re-pick after a reset).
    if (pending.length === 0) { st.setMaskPending([layer]); ctx.requestOverlay(); return; }
    // Re-clicking the already-picked strand is a NO-OP (OSS handle_strand_selection
    // only appends a strand not already selected; the pick stays armed). Clicking
    // empty space or an overlap clears it via the at.length !== 1 branch above.
    if (pending[0] === layer) { ctx.requestOverlay(); return; }

    // Second pick -> create the over/under mask at the crossing. createMask gates
    // on strandsCross (OSS intersection-emptiness gate); a null return means the
    // two strands don't actually cross, so we just reset the pick.
    const first = pending[0];
    let newName: string | null = null;
    st.commitEdit((draft) => { newName = createMask(draft, first, layer, st.settings.curve_params); });
    st.setMaskPending([]);
    st.setHover({ layerName: null, handle: null });
    if (newName) {
      st.setSelection({ layerName: newName, handle: null });   // OSS selects the new mask
    }
    ctx.requestRender();
  },

  onPointerMove(p: PointerInfo, ctx: ModeContext) {
    // Hover the topmost strand under the cursor (OSS mouseMoveEvent ->
    // hovered_strand = strands_at_point[0]); the overlay draws the yellow body
    // highlight and suppresses it for an already-picked strand.
    const st = useEditorStore.getState();
    const at = maskStrandsAtPoint(p.world, st.doc, st.settings);
    const next = at.length ? at[0] : null;
    if (st.hover.layerName !== next) {
      st.setHover({ layerName: next, handle: null });
      ctx.requestOverlay();
    }
  },

  onPointerUp() {
    // Mask mode has no drag gesture (no eraser). Nothing to finalize.
  },
};
