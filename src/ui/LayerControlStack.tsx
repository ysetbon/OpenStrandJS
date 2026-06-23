import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  addNewStrand, clearAllLocks, deleteAllStrands, deleteStrand, isStrandDeletable,
} from '../store/actions';
import { screenToWorld } from '../interaction/viewTransform';
import { Modal } from './Modal';
import { t } from './i18n';
import './layerControls.css';

// OSS bottom control stack (LayerPanel) — six full-width colored buttons.
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
}) {
  return (
    <button
      className={`lc-btn${props.checked ? ' checked' : ''}`}
      style={vars(props.v)}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

export function LayerControlStack() {
  const lang = useEditorStore((s) => s.settings.language);
  const lockMode = useEditorStore((s) => s.doc.lock_mode);
  const selected = useEditorStore((s) => s.selection.layerName);
  const strands = useEditorStore((s) => s.doc.strands);
  const multiSelectMode = useEditorStore((s) => s.multiSelectMode);
  const multiSelectedLayers = useEditorStore((s) => s.multiSelectedLayers);
  const clearMultiSelectedLayers = useEditorStore((s) => s.clearMultiSelectedLayers);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const setSelection = useEditorStore((s) => s.setSelection);
  const deselectAll = useEditorStore((s) => s.deselectAll);
  const toggleDrawNames = useEditorStore((s) => s.toggleDrawNames);

  const [confirmAll, setConfirmAll] = useState(false);

  // Delete-enable (OSS is_strand_deletable): single-select needs a selected,
  // existing, deletable strand; multi-select needs every selected layer
  // deletable. Lock mode always disables delete.
  const sel = selected ? strands[selected] : undefined;
  const hasDeletable = !lockMode && !!sel && isStrandDeletable(sel);
  const multiDeletable =
    multiSelectMode &&
    multiSelectedLayers.length > 0 &&
    multiSelectedLayers.every((n) => strands[n] && isStrandDeletable(strands[n]));
  const deleteDisabled = lockMode ? true : (multiSelectMode ? !multiDeletable : !hasDeletable);

  function addStrand() {
    const { view } = useEditorStore.getState();
    const c = screenToWorld({ x: view.width / 2, y: view.height / 2 }, view);
    let newName: string | null = null;
    commitEdit((d) => { newName = addNewStrand(d, { x: c.x - 80, y: c.y }, { x: c.x + 80, y: c.y }); });
    if (newName) setSelection({ layerName: newName, handle: null });
  }

  function removeSelected() {
    // Multi-select delete path: delete every selected layer, then clear.
    if (multiSelectMode && multiSelectedLayers.length) {
      commitEdit((d) => {
        for (const n of multiSelectedLayers) deleteStrand(d, n);
      });
      clearMultiSelectedLayers();
      setSelection({ layerName: null, handle: null });
      return;
    }
    if (!selected) return;
    commitEdit((d) => deleteStrand(d, selected));
    setSelection({ layerName: null, handle: null });
  }

  function removeAll() {
    // OSS request_delete_all: no-op on empty list; otherwise confirm first.
    if (Object.keys(strands).length === 0) return;
    setConfirmAll(true);
  }

  function confirmRemoveAll() {
    commitEdit(deleteAllStrands);
    clearMultiSelectedLayers();
    setSelection({ layerName: null, handle: null });
    setConfirmAll(false);
  }

  return (
    <div className="layer-control-stack">
      <LCBtn v={DRAW} label={t('draw_names', lang)} onClick={toggleDrawNames} />
      <LCBtn
        v={LOCK}
        label={lockMode ? t('exit_lock_mode', lang) : t('lock_layers', lang)}
        checked={lockMode}
        onClick={() => useEditorStore.getState().enterExitLockMode()}
      />
      <LCBtn v={ADD} label={t('add_new_strand', lang)} disabled={lockMode} onClick={addStrand} />
      <LCBtn v={DELETE} label={t('delete_strand', lang)} disabled={deleteDisabled} onClick={removeSelected} />
      <LCBtn
        v={DESELECT}
        label={lockMode ? t('clear_all_locks', lang) : t('deselect_all', lang)}
        onClick={() => (lockMode ? commitEdit(clearAllLocks) : deselectAll())}
      />
      <LCBtn v={DELALL} label={t('delete_all', lang)} onClick={removeAll} />
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
    </div>
  );
}
