// Owns the DOM pointer/wheel/key listeners on #c and routes them. Intercepts
// pan FIRST (middle-drag, right-drag, or space+left-drag), otherwise delegates
// to the active Mode. Lives outside React so high-frequency pointermove never
// triggers a React re-render directly.

import { useEditorStore } from '../store/editorStore';
import { screenToWorld, worldToScreen } from './viewTransform';
import { requestOverlay, requestRender } from '../renderer/renderScheduler';
import { modes } from '../modes';
import { SelectMode } from '../modes/SelectMode';
import type { Mode, ModeContext, PointerInfo } from '../modes/Mode';
import type { Point } from '../model/types';

export class InteractionHost {
  private panning = false;
  private panStart: Point = { x: 0, y: 0 };
  private panOrigin: Point = { x: 0, y: 0 };
  private spaceHeld = false;

  constructor(private el: HTMLCanvasElement) {
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    const el = this.el;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private mode(): Mode {
    return modes[useEditorStore.getState().mode] ?? SelectMode;
  }

  private ctx(): ModeContext {
    const view = useEditorStore.getState().view;
    return {
      screenToWorld: (p) => screenToWorld(p, view),
      worldToScreen: (p) => worldToScreen(p, view),
      requestRender,
      requestOverlay,
    };
  }

  private toScreen(e: PointerEvent | WheelEvent): Point {
    const rect = this.el.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * (this.el.width / Math.max(1, rect.width));
    const sy = (e.clientY - rect.top) * (this.el.height / Math.max(1, rect.height));
    return { x: sx, y: sy };
  }

  private info(e: PointerEvent): PointerInfo {
    const screen = this.toScreen(e);
    const world = screenToWorld(screen, useEditorStore.getState().view);
    return { world, screen, button: e.button, buttons: e.buttons, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
  }

  private onPointerDown = (e: PointerEvent) => {
    try { this.el.setPointerCapture(e.pointerId); } catch { /* synthetic/no-op */ }
    const isPan = e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceHeld);
    if (isPan) {
      const view = useEditorStore.getState().view;
      this.panning = true;
      this.panStart = this.toScreen(e);
      this.panOrigin = { x: view.panX, y: view.panY };
      return;
    }
    if (e.button !== 0) return;
    this.mode().onPointerDown(this.info(e), this.ctx());
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.panning) {
      const screen = this.toScreen(e);
      useEditorStore.getState().setView({
        panX: this.panOrigin.x + (screen.x - this.panStart.x),
        panY: this.panOrigin.y + (screen.y - this.panStart.y),
      });
      return;
    }
    this.mode().onPointerMove(this.info(e), this.ctx());
    // Cursor feedback: show a grab cursor when a handle is under the pointer.
    const hov = useEditorStore.getState().hover;
    this.el.style.cursor = hov.handle ? 'grab' : this.mode().cursor;
  };

  private onPointerUp = (e: PointerEvent) => {
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.panning) { this.panning = false; return; }
    this.mode().onPointerUp(this.info(e), this.ctx());
  };

  private onWheel = (e: WheelEvent) => {
    // Wheel zooms about the cursor, clamped to [0.1, 5]. The world point under the
    // pointer stays fixed: screen = world*zoom + pan  =>  pan = screen - world*zoom.
    e.preventDefault();
    const st = useEditorStore.getState();
    const view = st.view;
    const screen = this.toScreen(e);
    const world = screenToWorld(screen, view);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const zoom = Math.max(0.1, Math.min(5, view.zoom * factor));
    st.setView({ zoom, panX: screen.x - world.x * zoom, panY: screen.y - world.y * zoom });
  };

  private onContextMenu = (e: MouseEvent) => { e.preventDefault(); };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space') { this.spaceHeld = true; }
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // don't hijack typing
    const st = useEditorStore.getState();
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      st.setSelection({ layerName: null, handle: null });
      requestOverlay();
      return;
    }
    // Undo: Ctrl/Cmd+Z (no shift) or bare Z. Redo: Ctrl/Cmd+Shift+Z, Ctrl+Y, or bare X.
    if ((ctrl && k === 'z' && !e.shiftKey) || (!ctrl && k === 'z')) {
      e.preventDefault(); st.undo(); requestRender(); return;
    }
    if ((ctrl && k === 'z' && e.shiftKey) || (ctrl && k === 'y') || (!ctrl && k === 'x')) {
      e.preventDefault(); st.redo(); requestRender(); return;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') this.spaceHeld = false;
  };
}
