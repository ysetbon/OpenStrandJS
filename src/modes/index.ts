import type { ModeName } from '../model/types';
import type { Mode } from './Mode';
import { SelectMode } from './SelectMode';
import { MoveMode } from './MoveMode';
import { AttachMode } from './AttachMode';
import { MaskMode } from './MaskMode';
import { RotateMode } from './RotateMode';
import { AngleMode } from './AngleMode';
import { passiveMode } from './PassiveMode';

export const modes: Record<ModeName, Mode> = {
  select: SelectMode,
  move: MoveMode,
  attach: AttachMode,
  mask: MaskMode,
  view: passiveMode('view', 'grab'), // read-only inspect; OSS open-hand cursor (view_mode.py activate)
  rotate: RotateMode,              // drag a free endpoint about the opposite end
  angle: AngleMode,                // click a strand -> Adjust Angle and Length dialog
};
