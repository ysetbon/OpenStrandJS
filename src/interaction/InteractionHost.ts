// Owns the DOM pointer/wheel/key listeners on #c and routes them. Intercepts
// pan FIRST (middle-drag, right-drag, or space+left-drag), otherwise delegates
// to the active Mode. Lives outside React so high-frequency pointermove never
// triggers a React re-render directly.
//
// It also owns the canvas CURSOR, mirroring OSS strand_drawing_canvas.py's
// setCursor calls (see syncCursor for the precedence):
//   * each mode's cursor is set on entry (set_mode + the mode's activate);
//   * an Edit Mask session forces the crosshair (enter_mask_edit_mode);
//   * the hand tool shows the open hand (toggle_pan_mode -> OpenHandCursor);
//   * any pan DRAG shows the closed hand for its duration (mousePressEvent ->
//     ClosedHandCursor) and the cursor it interrupted comes back on release
//     (_pre_right_pan_cursor restored in mouseReleaseEvent).
// OSS never changes the cursor on hover — a handle under the pointer highlights
// in the overlay, the cursor stays the mode's — so neither do we.

import { useEditorStore } from '../store/editorStore';
import { screenToWorld, worldToScreen, zoomAbout } from './viewTransform';
import {
  cancelFrameTask, flushFrameTask, releaseScene, requestFrameTask, requestOverlay, requestRender,
} from '../renderer/renderScheduler';
import { modes } from '../modes';
import { SelectMode } from '../modes/SelectMode';
import { addDeletionRect } from '../store/actions';
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
  private unsubscribeMode: () => void;

  constructor(private el: HTMLCanvasElement) {
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // Mode-switch deactivation (OSS main_window.update_mode deactivates the old
    // mode object before activating the new one). setMode() only swaps the name —
    // the OUTGOING mode's in-flight gesture state (AttachMode's module `drag` +
    // store pending/dragging/gestureBase, MoveMode's drag, MaskMode's armed pick)
    // survived, so Attach -> View/Select left a ghost attach preview and returning
    // to Attach resumed the dead gesture. Abort it via the outgoing mode's
    // onCancel, then drop stale hover so the new mode starts clean.
    this.unsubscribeMode = useEditorStore.subscribe((state, prev) => {
      if (state.mode === prev.mode) {
        // Not a mode switch, but the cursor may still have to change: the hand
        // tool toggled (OSS toggle_pan_mode), an Edit Mask session started or
        // ended (enter/exit_mask_edit_mode), or a doc change removed the mask
        // being edited.
        if (state.panMode !== prev.panMode || state.maskEditTarget !== prev.maskEditTarget
            || state.doc !== prev.doc) this.syncCursor();
        return;
      }
      this.cancelPendingMove();   // the queued move belongs to the outgoing mode
      modes[prev.mode]?.onCancel?.(this.ctx());
      const st = useEditorStore.getState();
      if (st.hover.layerName !== null || st.hover.handle !== null) {
        st.setHover({ layerName: null, handle: null });
      }
      this.syncCursor();
      // Entering/leaving view mode can change the RENDERER-drawn selection
      // highlight (view_hide_highlight lives in #c, not the overlay), so those
      // transitions need a full render; every other switch is overlay-only.
      if (state.mode === 'view' || prev.mode === 'view') requestRender();
      else requestOverlay();
    });
    this.syncCursor();
  }

  /**
   * The cursor the canvas should show right now, from the store + gesture state.
   * Precedence follows OSS strand_drawing_canvas.py:
   *
   *   1. a pan drag in progress   -> 'grabbing'  (ClosedHandCursor, mousePressEvent
   *                                  for middle / right / hand-tool left button)
   *   2. an Edit Mask session     -> 'crosshair' (enter_mask_edit_mode)
   *   3. the hand tool is on      -> 'grab'      (toggle_pan_mode -> OpenHandCursor)
   *   4. the active mode's cursor               (set_mode + Mode.activate)
   *
   * Written to the element only when it changes, so the per-frame move path can
   * call this freely.
   */
  cursorFor(): string {
    if (this.panning) return 'grabbing';
    if (this.editTarget()) return 'crosshair';
    if (useEditorStore.getState().panMode) return 'grab';
    return this.mode().cursor;
  }

  /** Write cursorFor() to the canvas element, touching the style only on a change. */
  private syncCursor(): void {
    const cursor = this.cursorFor();
    if (this.el.style.cursor !== cursor) this.el.style.cursor = cursor;
  }

  // Close a pan gesture. Just clear the flag: nothing has to be told that a pan
  // ended.
  //
  // No release render. Every frame of the gesture, the last one included, is the
  // resting render TRANSLATED — real geometry under a real transform, not a
  // reduced-quality stand-in (tools/pan_fidelity.mjs asserts exactly that, and
  // web/strand-renderer.js's pan header says what it does and does not claim). So
  // there is nothing to restore, and repainting would only buy a stall — measured
  // ~770ms on three_strand_braid. Nor is there a snapshot to free: the renderer
  // keeps its scene keyed, so the next pan starts from it instead of rebuilding,
  // and any edit invalidates it by key.
  private endPanGesture(): void {
    this.panning = false;
    // Closed hand -> whatever the pan interrupted (OSS restores _pre_right_pan_cursor;
    // the hand tool goes back to the open hand). cursorFor() recomputes exactly that.
    this.syncCursor();
    // OSS _update_pan_button_icon(False): the layer panel's pan button lets go.
    useEditorStore.getState().setPanning(false);
  }

  detach(): void {
    this.unsubscribeMode();
    this.cancelPendingMove();
    if (this.panning) this.endPanGesture();
    // Hand back the renderer's retained scene (a paper project + an offscreen
    // canvas). Not needed for correctness — the scene is keyed — but this canvas is
    // going away, so there is nothing left to reuse it.
    releaseScene();
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
    // Preserve event order: a move recorded before this press is applied first.
    flushFrameTask(this.applyMove);
    const st = useEditorStore.getState();
    const panTool = st.panMode;   // hand tool active
    // A right-click while the hand tool is on switches it OFF instead of panning
    // (OSS mousePressEvent: "Exit pan mode on right-click when pan mode is active"
    // -> exit_pan_mode). The cursor follows through the store subscription.
    if (panTool && e.button === 2) {
      st.setPanMode(false);
      return;
    }
    const isPan = e.button === 1 || e.button === 2 || (e.button === 0 && (this.spaceHeld || panTool));
    if (isPan) {
      const view = st.view;
      this.panning = true;
      this.panStart = this.toScreen(e);
      this.panOrigin = { x: view.panX, y: view.panY };
      // Closed hand for the length of the drag (OSS ClosedHandCursor on press) and,
      // mirrored into the layer panel, the pan button pressed with its closed-hand
      // icon (OSS _update_pan_button_icon(True)).
      this.syncCursor();
      st.setPanning(true);
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
  };

  // A pointer move is RECORDED here and APPLIED at the top of the next frame
  // (applyMove, registered as a render-scheduler frame task).
  //
  // Pointer hardware outruns the display: a 1000 Hz mouse delivers ~16 moves per
  // 60 Hz frame, and every one of them used to run the full pipeline — a
  // getBoundingClientRect (a forced layout), a hit test or a document edit, a
  // cursor write — only for the next move to overwrite the result before
  // anything was painted. Coalescing to one apply per frame does the work once
  // for the position that actually gets drawn. It costs no latency: the apply
  // runs inside the frame that renders it, and pointer-up flushes any pending
  // move first, so a gesture always ends on the exact last reported position.
  //
  // Positions are absolute, never deltas, so dropping intermediate moves cannot
  // accumulate drift — the coalesced move is simply the newest one.
  private pending: PointerEvent | null = null;

  private cancelPendingMove(): void {
    this.pending = null;
    cancelFrameTask(this.applyMove);
  }

  private applyMove = () => {
    const e = this.pending;
    if (!e) return;
    this.pending = null;
    if (this.panning) {
      const screen = this.toScreen(e);
      // Round the gesture delta to whole canvas pixels. This is what lets the pan
      // fast path serve a frame by blitting its snapshot: at a fractional delta
      // drawImage would resample (blurry, and no longer the pixels a real render
      // produces), so the renderer refuses the blit and falls back to a full
      // rebuild. The cursor is tracked to within half a backing pixel, which is
      // also how OSS pans — Qt's mousePressEvent/mouseMoveEvent deltas are integer
      // QPoints (strand_drawing_canvas.py:4432).
      useEditorStore.getState().setView({
        panX: this.panOrigin.x + Math.round(screen.x - this.panStart.x),
        panY: this.panOrigin.y + Math.round(screen.y - this.panStart.y),
      });
      // Ask for the repaint here rather than leaving it to CanvasStage's effect
      // on `view`: React commits that effect after this frame, so the pan would
      // land a frame late now that the move itself runs inside the frame.
      requestRender();
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
    // Re-assert the state-derived cursor after the mode ran (a mode may have
    // changed the store, e.g. Select promoting itself to Attach on a pick).
    this.syncCursor();
  };

  private onPointerMove = (e: PointerEvent) => {
    this.pending = e;
    requestFrameTask(this.applyMove);
  };

  private onPointerUp = (e: PointerEvent) => {
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // Land the last reported position before the gesture closes over it.
    flushFrameTask(this.applyMove);
    this.pending = null;
    if (this.panning) { this.endPanGesture(); return; }
    // A right/middle release that did not pan (e.g. the right-click that turned the
    // hand tool off) is not a mode gesture — onPointerDown never forwarded the press.
    if (e.button !== 0) return;
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
  };

  // Pointer interrupted (OS gesture, focus loss, touch-cancel). Abort any in-progress
  // mode gesture WITHOUT committing — mirrors OSS cancel_movement (no undo entry). An
  // in-flight Edit-Mask erase is dropped without appending its rectangle.
  private onPointerCancel = (e: PointerEvent) => {
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // An abort throws the gesture away, so a queued move must NOT be applied —
    // drop it before the mode unwinds.
    this.cancelPendingMove();
    if (this.panning) { this.endPanGesture(); return; }
    if (this.maskErase) { this.maskErase = null; useEditorStore.getState().setEraser(null); requestOverlay(); return; }
    this.mode().onCancel?.(this.ctx());
  };

  /**
   * Wheel zoom: about the cursor, over the same OSS [0.1, 5] range the zoom
   * buttons use — the cursor is the anchor here, the viewport centre there.
   */
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const st = useEditorStore.getState();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    st.setView(zoomAbout(st.view, st.view.zoom * factor, this.toScreen(e)));
  };

  private onContextMenu = (e: MouseEvent) => { e.preventDefault(); };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space') { this.spaceHeld = true; }
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // don't hijack typing
    // A modal dialog (Adjust Angle and Length, Settings, ...) owns the keyboard
    // while it is up: QDialog.exec_() blocks the main window, so OSS never sees
    // these shortcuts then. Without this, the Escape that closed the angle dialog
    // went on to clear the selection here, and Z/X could undo/redo straight
    // through a dialog's open gesture. Modeless dialogs leave the canvas live.
    if (document.querySelector('.modal-backdrop:not(.modeless)')) return;
    const st = useEditorStore.getState();
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const editing = this.editTarget();
    if (e.key === 'Escape') {
      // In an Edit Mask session ESC exits it (OSS mask_edit_mode_message: "Press
      // ESC to exit").
      if (editing) { st.exitMaskEdit(); this.maskErase = null; requestRender(); return; }
      // Mid-drag ESC ABORTS the move (revert, no undo entry) — OSS cancel_movement.
      if (st.dragging) { this.cancelPendingMove(); this.mode().onCancel?.(this.ctx()); return; }
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
    if (e.code === 'Space') this.spaceHeld = false;
  };
}
