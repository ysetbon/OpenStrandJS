// Inert modes for toolbar parity. `view` is a read-only inspect mode (no edits);
// `rotate` / `angle` are registered placeholders until their gestures are ported.
// They satisfy the exhaustive Record<ModeName, Mode> and no-op on every event.

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
