import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  clearAllLocks, deleteAllMasks, deleteAllStrands, deleteStrand, isStrandDeletable,
} from '../store/actions';
import { layerTabOf, type LayerTab } from '../store/editorStore';
import { Modal } from './Modal';
import { isRTL, t } from './i18n';
import './layerControls.css';

// OSS bottom control stack (LayerPanel). On top, the Strands / Masks switch (OSS
// 2.0 layer_tab_row, commit 9fc7cbd); under it each tab's own full-width
// colored buttons — Strands: Draw Names, Lock Layers, New Strand, Delete
// Strand, Deselect All, Delete All; Masks: New Mask, Delete Mask, Deselect All,
// Delete All (each Masks button copies its Strands twin's colors,
// _sync_mask_button_styles). Below the stack, the panel's notification label.
// Colors are theme-independent literals (UI_PORT_PLAN.md §2.4). Per-button
// hover/pressed colors are passed as inline CSS vars (--bg/--bgh/--bgp); the
// css applies them on base/:hover/:active. Disabled styling is in css.

interface V { bg: string; bgh: string; bgp: string; }
const vars = (v: V): React.CSSProperties => ({
  ['--bg' as string]: v.bg, ['--bgh' as string]: v.bgh, ['--bgp' as string]: v.bgp,
});

const DRAW:     V = { bg: '#e07bdb', bgh: '#e694e2', bgp: '#ba62b5' };
const LOCK:     V = { bg: '#FFA500', bgh: '#FFB84D', bgp: '#E69500' };
const ADD:      V = { bg: '#90EE90', bgh: '#BFFFBF', bgp: '#7BBF7B' };
const DELETE:   V = { bg: '#FF6B6B', bgh: '#FF4C4C', bgp: '#FF0000' };
const DESELECT: V = { bg: '#76acdc', bgh: '#9bc2e6', bgp: '#5890c0' };
const DELALL:   V = { bg: '#a1a1a1', bgh: '#b5b5b5', bgp: '#8a8a8a' };

function LCBtn(props: {
  v: V; label: string; onClick?: () => void; checked?: boolean; disabled?: boolean;
  // New Mask's own checked look (OSS QPushButton:checked: keeps the New Strand
  // green, gets a 2px #3c3c3c border) instead of the pressed colour.
  checkedClass?: string; testId?: string;
}) {
  const on = props.checked ? ` ${props.checkedClass ?? 'checked'}` : '';
  return (
    <button
      className={`lc-btn${on}`}
      data-testid={props.testId}
      aria-pressed={props.checkedClass ? !!props.checked : undefined}
      style={vars(props.v)}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

// One half of the Strands / Masks switch (OSS _layer_tab_half_style): only its
// outer corners are rounded; pressed = Mocha brown (#a47551), released = flat
// grey with a 3px bottom border. Colours live in layerControls.css.
function TabHalf(props: {
  tab: LayerTab; side: 'left' | 'right'; pressed: boolean; label: string;
  disabled: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`lc-tab lc-tab-${props.side}${props.pressed ? ' pressed' : ''}`}
      data-tab={props.tab}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

export function LayerControlStack() {
  const lang = useEditorStore((s) => s.settings.language);
  const layerTab = useEditorStore((s) => s.layerTab);
  const setLayerTab = useEditorStore((s) => s.setLayerTab);
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const lockMode = useEditorStore((s) => s.doc.lock_mode);
  const lockedLayers = useEditorStore((s) => s.doc.locked_layers);
  // The panel's selection, not the canvas's: OSS update_delete_button_state keys off
  // get_selected_layer() (the checked layer button), which a move-mode drag never moves.
  const selected = useEditorStore((s) => s.doc.selected_strand_name);
  const strands = useEditorStore((s) => s.doc.strands);
  const multiSelectMode = useEditorStore((s) => s.multiSelectMode);
  const multiSelectedLayers = useEditorStore((s) => s.multiSelectedLayers);
  const clearMultiSelectedLayers = useEditorStore((s) => s.clearMultiSelectedLayers);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const setSelection = useEditorStore((s) => s.setSelection);
  const deselectAll = useEditorStore((s) => s.deselectAll);
  const toggleDrawNames = useEditorStore((s) => s.toggleDrawNames);
  // OSS disable_controls: Draw Names is greyed out for the length of an Edit
  // Mask session (the '1' shortcut clicks the button, so it is blocked too).
  // Same validated-target test as CanvasStage / InteractionHost.editTarget: a
  // target whose mask no longer exists is not an active session.
  const maskEditing = useEditorStore((s) =>
    !!s.maskEditTarget && s.doc.strands[s.maskEditTarget]?.type === 'MaskedStrand');

  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmAllMasks, setConfirmAllMasks] = useState(false);
  const doc = useEditorStore((s) => s.doc);

  // Delete-enable (OSS update_delete_button_state, 1.109): single-select needs a
  // selected, existing, deletable strand; multi-select needs every selected
  // layer deletable. Delete stays AVAILABLE in lock mode — it is blocked only
  // when the target (any target, in multi-select) is a locked layer.
  const sel = selected ? strands[selected] : undefined;
  const selLocked = lockMode && !!selected && lockedLayers.includes(selected);
  const hasDeletable = !selLocked && !!sel && isStrandDeletable(sel);
  const multiLocked = lockMode && multiSelectedLayers.some((n) => lockedLayers.includes(n));
  const multiDeletable =
    multiSelectMode &&
    !multiLocked &&
    multiSelectedLayers.length > 0 &&
    multiSelectedLayers.every((n) => strands[n] && isStrandDeletable(strands[n]));
  const deleteDisabled = multiSelectMode ? !multiDeletable : !hasDeletable;

  // OSS update_delete_mask_button_state: Delete Mask works only on selected
  // masks (never locked ones), and never during an Edit Mask session.
  const isMaskName = (n: string) => layerTabOf(doc, n) === 'masks';
  const deleteMaskEnabled = maskEditing ? false
    : (multiSelectMode && multiSelectedLayers.length)
      ? multiSelectedLayers.every(isMaskName) && !multiLocked
      : !!selected && !!sel && isMaskName(selected) && !selLocked;

  // New Mask is pressed exactly while mask mode is on (OSS set_new_mask_active,
  // called from MainWindow.update_button_states on every mode change).
  const maskModeOn = mode === 'mask';
  const masksTab = layerTab === 'masks';

  // OSS "New Strand" button (layer_panel.py request_new_strand): does NOT create a
  // strand immediately. It enters attach mode and arms a one-shot new-strand draw
  // (crosshair cursor), then the user presses-drags-releases on the canvas to draw
  // it. The strand is committed on pointer-up (AttachMode), so a zero-length click
  // cancels cleanly — identical to the original.
  function addStrand() {
    useEditorStore.getState().armNewStrand();
  }

  function removeSelected() {
    // Multi-select delete path: delete every selected layer, then clear.
    if (multiSelectMode && multiSelectedLayers.length) {
      commitEdit((d) => {
        for (const n of multiSelectedLayers) deleteStrand(d, n);
      }, { action: 'layer.delete', source: 'panel', targets: [...multiSelectedLayers] });
      clearMultiSelectedLayers();
      setSelection({ layerName: null, handle: null });
      return;
    }
    if (!selected) return;
    commitEdit((d) => deleteStrand(d, selected),
      { action: 'layer.delete', source: 'panel', targets: [selected] });
    setSelection({ layerName: null, handle: null });
  }

  // OSS toggle_new_mask: start the canvas mask mode (click two crossing strands
  // to make a mask); pressed again, cancel back to attach mode.
  function toggleNewMask() {
    setMode(maskModeOn ? 'attach' : 'mask');
  }

  // OSS request_delete_mask: the selected mask(s) through the existing delete paths.
  function removeSelectedMask() {
    if (multiSelectMode && multiSelectedLayers.length) {
      if (multiSelectedLayers.every(isMaskName)) removeSelected();
      return;
    }
    if (selected && isMaskName(selected)) removeSelected();
  }

  // OSS request_delete_all_masks: nothing to do without masks; otherwise a
  // Yes / No question (No is the default) before anything is removed.
  function removeAllMasks() {
    if (!doc.order.some(isMaskName)) return;
    setConfirmAllMasks(true);
  }

  // Every mask goes, every strand stays, in ONE undo step. Locks on the removed
  // masks go with them (also from the lock-mode snapshot), and the
  // multi-selection is cleared, as OSS does after delete_masked_layer.
  function confirmRemoveAllMasks() {
    setConfirmAllMasks(false);
    const st = useEditorStore.getState();
    const names = st.doc.order.filter((n) => st.doc.strands[n]?.type === 'MaskedStrand');
    if (!names.length) return;
    st.commitEdit((d) => { deleteAllMasks(d); },
      { action: 'layer.delete_all', source: 'panel', targets: names, detail: 'all masks deleted' });
    const gone = new Set(names);
    useEditorStore.setState((s) => ({
      previouslyLockedLayers: s.previouslyLockedLayers.filter((n) => !gone.has(n)),
    }));
    clearMultiSelectedLayers();
    const now = useEditorStore.getState();
    if (now.selection.layerName && gone.has(now.selection.layerName)) {
      setSelection({ layerName: null, handle: null });
    }
  }

  function removeAll() {
    // OSS request_delete_all: no-op on empty list; otherwise confirm first.
    if (Object.keys(strands).length === 0) return;
    setConfirmAll(true);
  }

  function confirmRemoveAll() {
    commitEdit(deleteAllStrands, { action: 'layer.delete_all', source: 'panel' });
    clearMultiSelectedLayers();
    setSelection({ layerName: null, handle: null });
    setConfirmAll(false);
  }

  // OSS disable_controls / enable_controls: an Edit Mask session greys out
  // New Strand, Delete Strand, Draw Names, Lock Layers, Deselect All, both halves
  // of the switch, New Mask, Delete Mask and the Masks tab's Delete All.
  const editLock = maskEditing;

  // _apply_layer_tab_style: in Hebrew the halves swap sides so Strands reads
  // first, on the right.
  const rtl = isRTL(lang);
  const strandsHalf = { tab: 'strands' as const, label: t('layer_tab_strands', lang) };
  const masksHalf = { tab: 'masks' as const, label: t('layer_tab_masks', lang) };
  const [leftHalf, rightHalf] = rtl ? [masksHalf, strandsHalf] : [strandsHalf, masksHalf];

  const deselectButton = (
    <LCBtn
      v={DESELECT}
      label={lockMode ? t('clear_all_locks', lang) : t('deselect_all', lang)}
      disabled={editLock}
      onClick={() => (lockMode
        ? commitEdit(clearAllLocks, { action: 'layer.clear_locks', source: 'panel' })
        : deselectAll())}
    />
  );

  return (
    <>
    <div className="layer-control-stack" data-layer-tab={layerTab}>
      <div className="lc-tab-row">
        {[leftHalf, rightHalf].map((h, i) => (
          <TabHalf
            key={h.tab}
            tab={h.tab}
            side={i === 0 ? 'left' : 'right'}
            pressed={layerTab === h.tab}
            label={h.label}
            disabled={editLock}
            onClick={() => setLayerTab(h.tab)}
          />
        ))}
      </div>
      {!masksTab && (
        <>
          <LCBtn v={DRAW} label={t('draw_names', lang)} disabled={editLock} onClick={toggleDrawNames} />
          <LCBtn
            v={LOCK}
            label={lockMode ? t('exit_lock_mode', lang) : t('lock_layers', lang)}
            checked={lockMode}
            disabled={editLock}
            onClick={() => useEditorStore.getState().enterExitLockMode()}
          />
          {/* 1.109: New Strand stays available in lock mode. */}
          <LCBtn v={ADD} label={t('add_new_strand', lang)} disabled={editLock} onClick={addStrand} />
          <LCBtn v={DELETE} label={t('delete_strand', lang)} disabled={deleteDisabled || editLock} onClick={removeSelected} />
          {deselectButton}
          <LCBtn v={DELALL} label={t('delete_all', lang)} onClick={removeAll} />
        </>
      )}
      {masksTab && (
        <>
          <LCBtn
            v={ADD}
            label={t('new_mask', lang)}
            checked={maskModeOn}
            checkedClass="mask-on"
            testId="new-mask"
            disabled={editLock}
            onClick={toggleNewMask}
          />
          <LCBtn
            v={DELETE}
            label={t('delete_mask', lang)}
            testId="delete-mask"
            disabled={!deleteMaskEnabled}
            onClick={removeSelectedMask}
          />
          {deselectButton}
          <LCBtn v={DELALL} label={t('delete_all', lang)} testId="delete-all-masks" disabled={editLock} onClick={removeAllMasks} />
        </>
      )}
      {confirmAll && (
        <Modal
          title={t('delete_all', lang)}
          onClose={() => setConfirmAll(false)}
          footer={
            <>
              <button autoFocus className="dlg-btn" onClick={() => setConfirmAll(false)}>
                {t('no', lang)}
              </button>
              <button className="dlg-btn" onClick={confirmRemoveAll}>
                {t('yes', lang)}
              </button>
            </>
          }
        >
          {t('delete_all_confirm', lang)}
        </Modal>
      )}
      {confirmAllMasks && (
        <Modal
          title={t('delete_all', lang)}
          lang={lang}
          onClose={() => setConfirmAllMasks(false)}
          footer={
            <>
              <button autoFocus className="dlg-btn" data-testid="delete-all-masks-no" onClick={() => setConfirmAllMasks(false)}>
                {t('no', lang)}
              </button>
              <button className="dlg-btn" data-testid="delete-all-masks-yes" onClick={confirmRemoveAllMasks}>
                {t('yes', lang)}
              </button>
            </>
          }
        >
          {t('delete_all_masks_confirm', lang)}
        </Modal>
      )}
    </div>
    {/* OSS notification_label (under the bottom buttons, centered, hidden when
      * empty): shows new_mask_hint while New Mask is on (set_new_mask_active). */}
    {maskModeOn && (
      <div className="lp-notification" role="status">{t('new_mask_hint', lang)}</div>
    )}
    </>
  );
}
