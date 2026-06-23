// Click the topmost strand (body or handle) to select; click empty space to
// deselect. Hover tracks the handle under the cursor for overlay highlighting.

import { useEditorStore } from '../store/editorStore';
import { hitTest } from '../interaction/hitTest';
import type { Mode, ModeContext, PointerInfo } from './Mode';

function hoverFromHit(world: PointerInfo['world']) {
  const st = useEditorStore.getState();
  const hit = hitTest(world, st.doc, st.settings);
  if (hit && hit.kind === 'handle') return { layerName: hit.layerName, handle: hit.handle };
  return { layerName: hit ? hit.layerName : null, handle: null };
}

export const SelectMode: Mode = {
  name: 'select',
  cursor: 'default',

  onPointerDown(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    const hit = hitTest(p.world, st.doc, st.settings);
    st.setSelection({
      layerName: hit ? hit.layerName : null,
      handle: hit && hit.kind === 'handle' ? hit.handle : null,
    });
    // OSS promotes Select -> Attach after a real canvas pick
    // (handle_canvas_strand_selection -> update_mode('attach'), main_window.py:2465-2469;
    // canvas.select_strand sets attach_mode, strand_drawing_canvas.py:4001-4003), so you
    // can immediately drag a child out of the just-selected strand. Empty-space clicks
    // deselect and stay in Select. setMode preserves the selection (only resets
    // newStrandArmed).
    if (hit) st.setMode('attach');
    ctx.requestRender();   // selection highlight is drawn in #c (under the body)
  },

  onPointerMove(p: PointerInfo, ctx: ModeContext) {
    const st = useEditorStore.getState();
    const next = hoverFromHit(p.world);
    if (st.hover.layerName !== next.layerName || st.hover.handle !== next.handle) {
      st.setHover(next);
      ctx.requestOverlay();
    }
  },

  onPointerUp() {},
};
