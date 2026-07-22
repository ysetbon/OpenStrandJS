import type { ModeName } from '../model/types';
import type { Mode } from './Mode';
import { SelectMode } from './SelectMode';
import { MoveMode } from './MoveMode';
import { AttachMode } from './AttachMode';
import { MaskMode } from './MaskMode';
import { passiveMode } from './PassiveMode';

export const modes: Record<ModeName, Mode> = {
  select: SelectMode,
  move: MoveMode,
  attach: AttachMode,
  mask: MaskMode,
  view: passiveMode('view'),       // read-only inspect
  rotate: passiveMode('rotate', 'move'), // stub gesture; OSS cursor = SizeAll (strand_drawing_canvas.py:5003-5005)
  // Angle-adjust: interaction lives entirely in AngleAdjustDialog (opened by the
  // toolbar button); the mode itself only sets the OSS SizeAll cursor (:4995-4998).
  angle: passiveMode('angle', 'move'),
};
