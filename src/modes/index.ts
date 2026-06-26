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
  view: passiveMode('view', 'grab'), // read-only inspect; OSS open-hand cursor (view_mode.py activate)
  rotate: passiveMode('rotate'),   // stub (OSS rotate gesture not yet ported)
  angle: passiveMode('angle'),     // stub (OSS angle-adjust not yet ported)
};
