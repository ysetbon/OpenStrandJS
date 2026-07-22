import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { createGroup, createMask, reorderLayer } from '../store/actions';
import { requestRender } from '../renderer/renderScheduler';
import { ControlColumn } from './ControlColumn';
import { NumberedLayerButton } from './NumberedLayerButton';
import { LayerControlStack } from './LayerControlStack';
import {
  GroupPanel,
  type GroupDialogs,
  type RenameDialogProps,
  type MainStrandSelectDialogProps,
} from './GroupPanel';
import { GroupMoveDialog } from './dialogs/GroupMoveDialog';
import { GroupRotateDialog } from './dialogs/GroupRotateDialog';
import { GroupShadowEditorDialog } from './dialogs/GroupShadowEditorDialog';
import { GroupAngleEditorDialog } from './dialogs/GroupAngleEditorDialog';
import { RenameDialog } from './dialogs/RenameDialog';
import { MainStrandSelectDialog } from './dialogs/MainStrandSelectDialog';
import { MaskGridDialog } from './dialogs/MaskGridDialog';

// Adapters: the C4 dialogs expose onSubmit; GroupPanel's contract expects
// onAccept. GroupMove/Rotate/Shadow already match ({groupName,onClose}) so they
// are passed straight through.
function RenameDialogAdapter(props: RenameDialogProps): JSX.Element {
  return (
    <RenameDialog
      title={props.title}
      initial={props.initial}
      siblings={props.siblings}
      onClose={props.onClose}
      onSubmit={(name) => props.onAccept(name)}
    />
  );
}

// The OSS-faithful member picker owns its own group-name field (and candidate
// list), so the adapter commits createGroup with that name directly instead of
// routing through GroupPanel's auto-naming onAccept.
function MainStrandSelectDialogAdapter(props: MainStrandSelectDialogProps): JSX.Element {
  const commitEdit = useEditorStore((s) => s.commitEdit);
  return (
    <MainStrandSelectDialog
      onClose={props.onClose}
      onSubmit={(name, members) => commitEdit((d) => createGroup(d, name, members))}
    />
  );
}

const GROUP_DIALOGS: GroupDialogs = {
  GroupMoveDialog,
  GroupRotateDialog,
  GroupShadowEditorDialog,
  GroupAngleEditorDialog,
  RenameDialog: RenameDialogAdapter,
  MainStrandSelectDialog: MainStrandSelectDialogAdapter,
  // Props ({groupName,onClose}) already match the contract — no adapter needed.
  MaskGridDialog,
};

// OSS layer panel. Top-to-bottom: the vertical ControlColumn, the scrollable
// layer list (newest/topmost first = [...order].reverse()) of NumberedLayer-
// Buttons with drag-reorder + a full-width blue insertion line, then the six-
// button LayerControlStack and the GroupPanel tree. (No inline strand-
// properties editor — OSS edits via the layer right-click menu instead. OSS
// left_panel has no Layer Panel title and no empty-list placeholder.)
//
// All mutation goes through the store actions, so the panel stays decoupled.
export function LayerPanel() {
  const order = useEditorStore((s) => s.doc.order);
  const strands = useEditorStore((s) => s.doc.strands);
  const lockMode = useEditorStore((s) => s.doc.lock_mode);
  const multiSelectMode = useEditorStore((s) => s.multiSelectMode);
  const multiSelectedLayers = useEditorStore((s) => s.multiSelectedLayers);
  const toggleMultiSelectLayer = useEditorStore((s) => s.toggleMultiSelectLayer);
  const setMode = useEditorStore((s) => s.setMode);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const setSelection = useEditorStore((s) => s.setSelection);
  // Panel mask-create (Ctrl-hold) state.
  const maskCreateMode = useEditorStore((s) => s.maskCreateMode);
  const firstMaskedLayer = useEditorStore((s) => s.firstMaskedLayer);
  const enterMaskCreate = useEditorStore((s) => s.enterMaskCreate);
  const exitMaskCreate = useEditorStore((s) => s.exitMaskCreate);

  // OSS layer_panel masked_mode: holding Ctrl WHILE THE PANEL IS HOVERED enters the
  // transient mask-create mode (every button flat gray, two clicks make a mask);
  // releasing Ctrl or leaving the panel exits. Scoped to panel-hover so Ctrl never
  // hijacks global shortcuts (undo/redo/save) when the pointer is elsewhere.
  const panelHovered = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' && panelHovered.current) useEditorStore.getState().enterMaskCreate();
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Control') useEditorStore.getState().exitMaskCreate(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, []);

  // Drag-reorder state: source order index + the resolved insertion boundary in
  // VISUAL space (0 = above the topmost row, visual.length = below the bottom-
  // most row). OSS resolves both the indicator line and the drop by each row's
  // vertical CENTER (midpoint rule), so the line and the drop always agree.
  // `dropTop` is the line's pixel y relative to .lp-list (OSS _drag_indicator_y,
  // computed from widget geometry) — robust under the bottom-aligned layout.
  const dragIdx = useRef<number | null>(null);
  const [dropBoundary, setDropBoundary] = useState<number | null>(null);
  const [dropTop, setDropTop] = useState<number>(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Visual list: top (z-top) first. order index 0 = bottom (lowest z-order).
  const visual = [...order].map((name, i) => ({ name, orderIdx: i })).reverse();
  const L = visual.length;

  // Clicking a layer must repaint the canvas so the selection highlight appears —
  // exactly like OSS select_layer, which ends with canvas.update() (layer_panel.py:2428).
  // A panel click bumps no docRevision (setSelection/setMode don't) and nothing
  // subscribes to selection changes, so CanvasStage's [docRevision,view,settings]
  // render effect never fires. We therefore repaint #c imperatively here — mirroring
  // SelectMode.ts / ControlColumn.tsx. requestRender is rAF-coalesced, so double
  // requests are harmless. Covers regular Strand, AttachedStrand AND
  // MaskedStrand (the highlight depends only on is_selected, set for all types).
  function select(name: string) {
    // OSS checks multi-select BEFORE masked_mode, so multi-select wins when both are
    // somehow active; otherwise a Ctrl-hold mask-create pick takes the click.
    if (!multiSelectMode && maskCreateMode) { pickMaskLayer(name); return; }
    selectLayer(name);
    requestRender();
  }

  // Two-click panel mask create (OSS handle_masked_layer_selection): the first
  // click picks (darkens) a regular layer; a second distinct regular layer creates
  // the over/under mask at their crossing and selects it; re-clicking the first
  // clears. Stays armed for the next pair while Ctrl is held.
  function pickMaskLayer(name: string) {
    const st = useEditorStore.getState();
    const t = st.doc.strands[name];
    if (!t || t.type === 'MaskedStrand') return;     // can't mask a MaskedStrand
    const first = st.firstMaskedLayer;
    if (!first) { st.setFirstMaskedLayer(name); requestRender(); return; }
    if (first === name) { st.setFirstMaskedLayer(null); requestRender(); return; }
    let newName: string | null = null;
    commitEdit((d) => { newName = createMask(d, first, name, st.settings.curve_params); });
    st.setFirstMaskedLayer(null);
    if (newName) setSelection({ layerName: newName, handle: null });
    requestRender();
  }

  // OSS select_layer dispatcher (branch order: multi -> lock -> normal).
  function selectLayer(name: string) {
    // (1) Multi-select mode: toggle membership only; never change the main
    //     selection (OSS select_layer 2298-2309, returns early).
    if (multiSelectMode) {
      toggleMultiSelectLayer(name);
      return;
    }
    // (2) Lock mode (OSS 1.109 rework): clicking the layer body selects it
    //     normally — locked or not — and does NOT switch to attach mode
    //     (select_layer gates the attach switch on `not lock_mode`). Locking is
    //     the padlock chip's job (NumberedLayerButton), not this click.
    if (lockMode) {
      setSelection({ layerName: name, handle: null });
      return;
    }
    // (3) Normal selection: selecting switches the app to Attach mode
    //     (OSS set_attach_mode tail, 2442). Locked layers select like any other
    //     (1.109); locks only block moving/attaching while lock mode is on.
    setSelection({ layerName: name, handle: null });
    setMode('attach');
  }

  function onDragStart(orderIdx: number) {
    dragIdx.current = orderIdx;
  }

  // Map a VISUAL insertion boundary (0..L) to the source's own "no-op" boundaries.
  // Removing the source then re-inserting just above or just below itself yields
  // the same order; suppress the line + skip the commit in those cases. The
  // source row sits at visual index `srcVisual = L-1-from`; its own gap is the
  // boundary at srcVisual (just above it) and srcVisual+1 (just below it).
  function isNoopBoundary(from: number, boundary: number): boolean {
    const srcVisual = L - 1 - from;
    return boundary === srcVisual || boundary === srcVisual + 1;
  }

  // Resolve the visual insertion boundary from a row hovered/dropped on, using
  // the row's vertical center (OSS midpoint rule). `above` true => boundary sits
  // above this row (its visual index); false => below it (visual index + 1).
  // Also returns the line's pixel y relative to .lp-list (the row's top edge when
  // above, its bottom edge when below — the line nestles in the 2px gap).
  function boundaryFor(visualIdx: number, e: React.DragEvent): { boundary: number; top: number } {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const listTop = listRef.current?.getBoundingClientRect().top ?? r.top;
    const scroll = listRef.current?.scrollTop ?? 0;
    const above = e.clientY < r.top + r.height / 2;
    const edge = above ? r.top : r.bottom;
    return { boundary: above ? visualIdx : visualIdx + 1, top: edge - listTop + scroll };
  }

  function onDragOver(orderIdx: number, e: React.DragEvent) {
    const from = dragIdx.current;
    if (from == null) return;
    const visualIdx = L - 1 - orderIdx;
    const { boundary, top } = boundaryFor(visualIdx, e);
    const next = isNoopBoundary(from, boundary) ? null : boundary;
    if (dropBoundary !== next) setDropBoundary(next);
    if (next != null) setDropTop(top);
  }

  function onDrop(orderIdx: number, e: React.DragEvent) {
    const from = dragIdx.current;
    dragIdx.current = null;
    setDropBoundary(null);
    if (from == null) return;
    const visualIdx = L - 1 - orderIdx;
    const { boundary } = boundaryFor(visualIdx, e);
    if (isNoopBoundary(from, boundary)) return;

    // Mirror OSS dropEvent exactly, then map back to doc.order. Work in VISUAL
    // space (top = index 0): the resolved boundary is OSS target_visual_index
    // (insert-before; === L means the bottom default). Take the source out, apply
    // the downward-drag -1 shift, insert, then reverse to order space and ask
    // reorderLayer to splice the dragged name to where it now sits.
    const srcVisual = L - 1 - from;
    const newVisual = visual.map((v) => v.name); // top -> bottom names
    const [moved] = newVisual.splice(srcVisual, 1);
    const finalInsert = boundary - (srcVisual < boundary ? 1 : 0);
    newVisual.splice(finalInsert, 0, moved);
    const newOrder = [...newVisual].reverse(); // bottom -> top == doc.order
    const to = newOrder.indexOf(moved);
    commitEdit((d) => reorderLayer(d, from, to));
  }

  function onDragEnd() {
    dragIdx.current = null;
    setDropBoundary(null);
  }

  // The full-width blue insertion line (QColor(0,120,215), 2px) is rendered as
  // an absolute overlay over .lp-list so it can sit below the bottom row and
  // span edge-to-edge. Its top is the resolved pixel y (OSS _drag_indicator_y).
  const showLine = dragIdx.current != null && dropBoundary != null;

  return (
    <div
      className="layer-panel"
      onMouseEnter={() => { panelHovered.current = true; }}
      onMouseLeave={() => { panelHovered.current = false; exitMaskCreate(); }}
    >
      {/* Left sub-column: control column, layer list, 6-button stack (OSS left_panel). */}
      <div className="lp-left">
        {/* 10px transparent splitter strip (OSS SplitterHandle, fixed 10px). */}
        <div className="lp-splitter-handle" />

        <ControlColumn />

        <div className="lp-list" ref={listRef}>
          {visual.map(({ name, orderIdx }) => {
            if (!strands[name]) return null;
            const s = strands[name];
            const attachable = !!s && !(s.has_circles[0] && s.has_circles[1]);
            const selectable = lockMode;
            return (
              <div key={name} className="lp-item">
                <NumberedLayerButton
                  name={name}
                  orderIdx={orderIdx}
                  onSelect={select}
                  attachable={attachable}
                  selectable={selectable}
                  multiSelected={multiSelectMode && multiSelectedLayers.includes(name)}
                  maskedMode={maskCreateMode}
                  pickedForMask={firstMaskedLayer === name}
                  draggable
                  onDragStart={(idx) => onDragStart(idx)}
                  onDragOver={(idx, e) => onDragOver(idx, e)}
                  onDrop={(idx, e) => onDrop(idx, e)}
                  onDragEnd={onDragEnd}
                />
              </div>
            );
          })}
          {showLine && (
            <div className="lp-drop-line" style={{ top: `${dropTop}px` }} />
          )}
        </div>

        <LayerControlStack />
      </div>

      {/* Right sub-column: the fixed 270px group panel (OSS right_panel). */}
      <div className="lp-right">
        <GroupPanel dialogs={GROUP_DIALOGS} />
      </div>
    </div>
  );
}
