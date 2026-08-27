import type { ModeName } from '../model/types';
import type { Mode } from './Mode';
import { SelectMode } from './SelectMode';
import { MoveMode } from './MoveMode';
import { AttachMode } from './AttachMode';
import { MaskMode } from './MaskMode';
import { RotateMode } from './RotateMode';
import { passiveMode } from './PassiveMode';

export const modes: Record<ModeName, Mode> = {
  select: SelectMode,
  move: MoveMode,
  attach: AttachMode,
  mask: MaskMode,
  // Read-only inspect. OSS ViewMode.activate sets an OpenHand cursor and its
  // mousePressEvent does nothing (view_mode.py:20-38).
  view: passiveMode('view', 'grab'),
  rotate: RotateMode,
  // Angle adjust is MODAL in OSS, not a canvas gesture: the toolbar button opens
  // "Adjust Angle and Length" for the selected strand and the canvas mode itself
  // only sets the SizeAll cursor (strand_drawing_canvas.py:5001-5004). The dialog
  // lives in ui/dialogs/AngleAdjustDialog.tsx; this entry keeps the mode registered
  // (and the toolbar button checkable) while the dialog is up.
  angle: passiveMode('angle', 'move'),
};
