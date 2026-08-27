// Inert modes. `view` is OSS's read-only inspect mode, whose mousePressEvent does
// nothing (view_mode.py:35-38); `angle` is inert on the canvas because OSS's
// AngleAdjustMode does all its work in a modal dialog. Both satisfy the exhaustive
// Record<ModeName, Mode> and no-op on every event, carrying only their cursor.

import type { ModeName } from '../model/types';
import type { Mode } from './Mode';

export function passiveMode(name: ModeName, cursor = 'default'): Mode {
  return {
    name,
    cursor,
    onPointerDown() { /* no-op */ },
    onPointerMove() { /* no-op */ },
    onPointerUp() { /* no-op */ },
  };
}
