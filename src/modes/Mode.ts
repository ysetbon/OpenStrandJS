// The interaction Mode contract. Modes are plain objects (not React). They
// read/write the store via useEditorStore.getState() and use the ModeContext
// for coordinate transforms + render requests bound to the current view.

import type { ModeName, Point } from '../model/types';

export interface ModeContext {
  screenToWorld(p: Point): Point;
  worldToScreen(p: Point): Point;
  requestRender(): void;   // full re-render (#c) + overlay
  requestOverlay(): void;  // overlay only
}

export interface PointerInfo {
  world: Point;
  screen: Point;
  button: number;
  buttons: number;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export interface Mode {
  readonly name: ModeName;
  readonly cursor: string;
  onPointerDown(p: PointerInfo, ctx: ModeContext): void;
  onPointerMove(p: PointerInfo, ctx: ModeContext): void;
  onPointerUp(p: PointerInfo, ctx: ModeContext): void;
}
