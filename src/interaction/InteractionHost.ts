// Owns the DOM pointer/wheel/key listeners on #c and routes them. Intercepts
// pan FIRST (middle-drag, right-drag, or space+left-drag), otherwise delegates
// to the active Mode. Lives outside React so high-frequency pointermove never
// triggers a React re-render directly.

import { useEditorStore } from '../store/editorStore';
import { screenToWorld, worldToScreen } from './viewTransform';
import { requestOverlay, requestRender, beginPanGesture, endPanGesture } from '../renderer/renderScheduler';
import { modes } from '../modes';
import { SelectMode } from '../modes/SelectMode';
import { addDeletionRect } from '../store/actions';
import { getAppRotationDeg, isAppGestureActive } from '../ui/mobileLayout';
import type { Mode, ModeContext, PointerInfo } from '../modes/Mode';
import type { Point } from '../model/types';

// Normalized world-space rectangle from two corners.
function rectOf(a: Point, b: Point) {
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

export class InteractionHost {
  private panning = false;
  private panStart: Point = { x: 0, y: 0 };
  private panOrigin: Point = { x: 0, y: 0 };
  private spaceHeld = false;
  // Active per-mask "Edit Mask" eraser drag (OSS mask_edit_mode erase_start_pos /
  // current_erase_rect). Set on pointer-down while store.maskEditTarget is active.
  private maskErase: { start: Point } | null = null;
  // Multi-touch tracking: a two-finger gesture (mobile pinch-zoom / pan, handled
  // in mobileLayout) must not draw. We track active touch pointers, and once a
  // second touch lands we abort the in-progress one-finger action and swallow
  // every event until all fingers lift (`multiTouched`).
  private touchPointers = new Set<number>();
  private multiTouched = false;
  private gestureAborting = false;

  constructor(private el: HTMLCanvasElement) {
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
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
    el.removeEventListener('pointercancel', this.onPointerCancel);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private mode(): Mode {
    return modes[useEditorStore.getState().mode] ?? SelectMode;
  }

  // The active Edit-Mask target, but ONLY if the mask still exists in the doc — a
  // tab switch / file load / undo / delete that removed it ends the session, so we
  // never erase against (or lock the UI to) a stale cross-document target.
  private editTarget(): string | null {
    const st = useEditorStore.getState();
    const t = st.maskEditTarget;
    return (t && st.doc.strands[t]?.type === 'MaskedStrand') ? t : null;
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

  // Single source of truth for the canvas cursor, recomputed from CURRENT state on
  // every pointer/key event so it can never get stuck (the old code set it only in
  // onPointerMove, and the pan/erase branches `return` before reaching it — so the
  // pan tool's open/closed hand never updated after a press). Faithful to OSS
  // strand_drawing_canvas.py: the pan/hand tool is OpenHandCursor idle and
  // ClosedHandCursor while dragging (toggle_pan_mode / mousePress / mouseRelease);
  // an Edit-Mask session forces the crosshair. We also surface the open hand over a
  // grabbable handle and the closed hand while a handle is actively dragged, so a
  // grab reads the same as the pan tool ('grab' == OpenHand, 'grabbing' == ClosedHand).
  private updateCursor = (): void => {
    const st = useEditorStore.getState();
    if (this.editTarget()) { this.el.style.cursor = 'crosshair'; return; }
    // Hand/pan tool (toolbar pan button or Space held) OR any active pan drag
    // (middle / right-drag): open hand idle, closed hand while panning.
    if (st.panMode || this.spaceHeld || this.panning) {
      this.el.style.cursor = this.panning ? 'grabbing' : 'grab';
      return;
    }
    // A live canvas handle drag (move/rotate pointer gesture) = closed hand. The angle
    // dialog also sets `dragging`, but it is dialog-driven (mode 'angle'), not a canvas
    // grab, so it is excluded here.
    if (st.dragging && (st.mode === 'move' || st.mode === 'rotate')) { this.el.style.cursor = 'grabbing'; return; }
    // Hovering a grabbable handle = open hand (ready to grab).
    if (st.hover.handle) { this.el.style.cursor = 'grab'; return; }
    this.el.style.cursor = this.mode().cursor;
  };

  private toScreen(e: PointerEvent | WheelEvent): Point {
    const rect = this.el.getBoundingClientRect();
    const W = this.el.width;
    const H = this.el.height;
    // On a portrait phone the whole app is rotated 90° clockwise (mobileLayout.ts)
    // to force a horizontal layout. getBoundingClientRect then reports the rotated
    // bounding box, so map the client point through the inverse rotation: the
    // canvas's +x runs down the screen (from rect.top) and +y runs left (from
    // rect.right). The scale factor cancels with W/H, so this also covers the
    // uniform scale-to-fit on landscape phones.
    if (getAppRotationDeg() === 90) {
      return {
        x: (e.clientY - rect.top) * (W / Math.max(1, rect.height)),
        y: (rect.right - e.clientX) * (H / Math.max(1, rect.width)),
      };
    }
    const sx = (e.clientX - rect.left) * (W / Math.max(1, rect.width));
    const sy = (e.clientY - rect.top) * (H / Math.max(1, rect.height));
    return { x: sx, y: sy };
  }

  private info(e: PointerEvent): PointerInfo {
    const screen = this.toScreen(e);
    const world = screenToWorld(screen, useEditorStore.getState().view);
    return { world, screen, button: e.button, buttons: e.buttons, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
  }

  // Abort whatever single-finger action is in flight (pan / mask erase / mode
  // gesture) WITHOUT committing, so a starting two-finger gesture leaves no trace.
  private abortForGesture = () => {
    if (this.panning) { this.panning = false; endPanGesture(); return; }
    if (this.maskErase) { this.maskErase = null; useEditorStore.getState().setEraser(null); requestOverlay(); return; }
    this.mode().onCancel?.(this.ctx());
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      this.touchPointers.add(e.pointerId);
      if (this.touchPointers.size >= 2) {
        // Second finger down → a pinch/pan, not a draw. Abort the first finger's
        // action once and let mobileLayout own the gesture from here.
        this.multiTouched = true;
        if (!this.gestureAborting) { this.gestureAborting = true; this.abortForGesture(); }
        return;
      }
    }
    if (isAppGestureActive()) return; // gesture started off-canvas; don't draw
    this.gestureAborting = false;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* synthetic/no-op */ }
    const panTool = useEditorStore.getState().panMode;   // hand tool active
    const isPan = e.button === 1 || e.button === 2 || (e.button === 0 && (this.spaceHeld || panTool));
    if (isPan) {
      // A pan starting mid strand-drag: cancel that drag so it can't keep store.dragging=true
      // (pan takes precedence in the scheduler) and its armed gesture doesn't linger.
      if (useEditorStore.getState().dragging) this.mode().onCancel?.(this.ctx());
      const view = useEditorStore.getState().view;
      this.panning = true;
      this.panStart = this.toScreen(e);
      this.panOrigin = { x: view.panX, y: view.panY };
      beginPanGesture();     // snapshot the current crisp #c as the pan translation base
      this.updateCursor();   // OSS ClosedHandCursor on pan press
      return;
    }
    if (e.button !== 0) return;
    // Per-mask Edit Mask session intercepts the drag as a deletion-rectangle erase
    // (OSS strand_drawing_canvas mousePressEvent checks mask_edit_mode first). Only
    // when the target mask still exists (a doc change that removed it ends the session).
    const target = this.editTarget();
    if (target) {
      const w = this.info(e).world;
      this.maskErase = { start: w };
      useEditorStore.getState().setEraser({ layerName: target, rect: rectOf(w, w) });
      requestOverlay();
      return;
    }
    this.mode().onPointerDown(this.info(e), this.ctx());
    this.updateCursor();   // closed hand once a handle grab (move/rotate) is armed
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.multiTouched || isAppGestureActive()) {
      if (!this.gestureAborting) { this.gestureAborting = true; this.abortForGesture(); }
      return;
    }
    if (this.panning) {
      const screen = this.toScreen(e);
      useEditorStore.getState().setView({
        panX: this.panOrigin.x + (screen.x - this.panStart.x),
        panY: this.panOrigin.y + (screen.y - this.panStart.y),
      });
      this.updateCursor();   // keep the closed hand while panning
      return;
    }
    // Edit Mask eraser drag: grow the white preview rectangle (OSS current_erase_rect).
    if (this.maskErase) {
      const target = this.editTarget();
      const world = screenToWorld(this.toScreen(e), useEditorStore.getState().view);
      if (target) useEditorStore.getState().setEraser({ layerName: target, rect: rectOf(this.maskErase.start, world) });
      requestOverlay();
      return;
    }
    this.mode().onPointerMove(this.info(e), this.ctx());
    this.updateCursor();
  };

  private onPointerUp = (e: PointerEvent) => {
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (e.pointerType === 'touch') this.touchPointers.delete(e.pointerId);
    // Swallow the up-events of every finger that took part in a multi-touch
    // gesture; the action was already aborted, so committing here would be wrong.
    if (this.multiTouched) {
      if (this.touchPointers.size === 0) { this.multiTouched = false; this.gestureAborting = false; }
      return;
    }
    if (this.panning) { this.panning = false; endPanGesture(); this.updateCursor(); return; }   // pan release -> crisp render + OpenHandCursor
    // Finalize an Edit Mask erase: commit one deletion rectangle (one undo step),
    // OSS mouseReleaseEvent appends to deletion_rectangles + subtracts the path.
    if (this.maskErase) {
      const st = useEditorStore.getState();
      const target = this.editTarget();
      const rect = rectOf(this.maskErase.start, screenToWorld(this.toScreen(e), st.view));
      this.maskErase = null;
      st.setEraser(null);
      // Live mutation (no commit): the enclosing Edit-Mask gesture commits the whole
      // session as ONE undo step on exit (OSS saves once, not per rectangle).
      if (target && rect.maxX > rect.minX && rect.maxY > rect.minY) {
        st.mutateDoc((d) => addDeletionRect(d, target, rect));
      }
      requestRender();
      return;
    }
    this.mode().onPointerUp(this.info(e), this.ctx());
    this.updateCursor();   // drop the closed hand once the grab releases
  };

  // Pointer interrupted (OS gesture, focus loss, touch-cancel). Abort any in-progress
  // mode gesture WITHOUT committing — mirrors OSS cancel_movement (no undo entry). An
  // in-flight Edit-Mask erase is dropped without appending its rectangle.
  private onPointerCancel = (e: PointerEvent) => {
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (e.pointerType === 'touch') this.touchPointers.delete(e.pointerId);
    if (this.multiTouched) {
      if (this.touchPointers.size === 0) { this.multiTouched = false; this.gestureAborting = false; }
      return;
    }
    if (this.panning) { this.panning = false; endPanGesture(); this.updateCursor(); return; }
    if (this.maskErase) { this.maskErase = null; useEditorStore.getState().setEraser(null); requestOverlay(); return; }
    this.mode().onCancel?.(this.ctx());
    this.updateCursor();
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
    if (e.code === 'Space') { this.spaceHeld = true; this.updateCursor(); }   // space = temporary hand tool
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // don't hijack typing
    const st = useEditorStore.getState();
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const editing = this.editTarget();
    if (e.key === 'Escape') {
      // In an Edit Mask session ESC exits it (OSS mask_edit_mode_message: "Press
      // ESC to exit").
      if (editing) { st.exitMaskEdit(); this.maskErase = null; requestRender(); return; }
      // Mid-drag ESC ABORTS the move (revert, no undo entry) — OSS cancel_movement.
      // updateCursor() drops the closed (grabbing) hand the abort just invalidated;
      // without it the cursor stays stuck until the next canvas pointer event.
      if (st.dragging) { this.mode().onCancel?.(this.ctx()); this.updateCursor(); return; }
      // Otherwise ESC clears the selection.
      st.setSelection({ layerName: null, handle: null });
      requestOverlay();
      return;
    }
    // OSS disables the main-window buttons + shortcuts during an Edit Mask session
    // (request_edit_mask -> disable_all_mainwindow_buttons). Swallow undo/redo/New
    // Strand so they can't mutate the doc mid-erase; exit with ESC.
    if (editing) return;
    // Undo: Ctrl/Cmd+Z (no shift) or bare Z. Redo: Ctrl/Cmd+Shift+Z, Ctrl+Y, or bare X.
    if ((ctrl && k === 'z' && !e.shiftKey) || (!ctrl && k === 'z')) {
      e.preventDefault(); st.undo(); requestRender(); return;
    }
    if ((ctrl && k === 'z' && e.shiftKey) || (ctrl && k === 'y') || (!ctrl && k === 'x')) {
      e.preventDefault(); st.redo(); requestRender(); return;
    }
    // 'N' (no modifiers): arm a new-strand draw, exactly like the "New Strand"
    // button (OSS main_window.py:2201 — Key_N clicks add_new_strand_button).
    if (!ctrl && k === 'n') {
      e.preventDefault(); st.armNewStrand(); return;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') { this.spaceHeld = false; this.updateCursor(); }
  };
}
