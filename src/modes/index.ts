import type { ModeName } from '../model/types';
import type { Mode } from './Mode';
import { SelectMode } from './SelectMode';
import { MoveMode } from './MoveMode';

// attach + mask are added in Slice C; until then they fall back to select so the
// toolbar buttons still allow selection.
export const modes: Record<ModeName, Mode> = {
  select: SelectMode,
  move: MoveMode,
  attach: SelectMode,
  mask: SelectMode,
};
