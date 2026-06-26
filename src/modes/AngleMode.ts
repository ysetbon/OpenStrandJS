// Angle-adjust mode — a faithful port of OpenStrand Studio's AngleAdjustMode
// (angle_adjust_mode.py). It is a DIALOG-driven mode (not a drag): clicking a
// strand selects it and opens the "Adjust Angle and Length" modal, which pivots on
// the strand's start, recomputes the end from angle+length live, and rotates/scales
// the control points. The store's enterAngleEdit captures the activation geometry
// and opens a single undo gesture; the dialog (AngleAdjustDialog) drives the live
// edit and confirm/cancel. Masked strands are not adjustable (OSS guard).

import { useEditorStore } from '../store/editorStore';
import { hitTest } from '../interaction/hitTest';
import type { Mode, ModeContext, PointerInfo } from './Mode';

export const AngleMode: Mode = {
  name: 'angle',
  cursor: 'pointer',

  onPointerDown(p: PointerInfo, _ctx: ModeContext) {
    const st = useEditorStore.getState();
    if (st.angleEditTarget) return;     // a dialog is already open
    const hit = hitTest(p.world, st.doc, st.settings);
    if (!hit) return;
    const s = st.doc.strands[hit.layerName];
    if (!s || s.type === 'MaskedStrand') return;
    st.enterAngleEdit(hit.layerName);   // opens the dialog (CanvasStage mounts it)
  },

  onPointerMove(_p: PointerInfo, _ctx: ModeContext) {},
  onPointerUp(_p: PointerInfo, _ctx: ModeContext) {},

  // pointercancel: drop any in-flight session (the dialog's own Escape/Cancel is the
  // normal exit; this is just a safety net).
  onCancel(_ctx: ModeContext) {
    useEditorStore.getState().cancelAngleEdit();
  },
};
