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
  rotate: passiveMode('rotate'),   // stub (OSS rotate gesture not yet ported)
  angle: passiveMode('angle'),     // stub (OSS angle-adjust not yet ported)
};
