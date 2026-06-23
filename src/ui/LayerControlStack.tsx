import { useEditorStore } from '../store/editorStore';
import {
  addNewStrand, clearAllLocks, deleteAllStrands, deleteStrand, toggleLockMode,
} from '../store/actions';
import { screenToWorld } from '../interaction/viewTransform';
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
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const setSelection = useEditorStore((s) => s.setSelection);
  const deselectAll = useEditorStore((s) => s.deselectAll);
  const toggleDrawNames = useEditorStore((s) => s.toggleDrawNames);

  // Delete is enabled only when a (non-locked, existing) strand is selected and
  // we are not in lock mode.
  const hasDeletable = !lockMode && !!selected && !!strands[selected];

  function addStrand() {
    const { view } = useEditorStore.getState();
    const c = screenToWorld({ x: view.width / 2, y: view.height / 2 }, view);
    let newName: string | null = null;
    commitEdit((d) => { newName = addNewStrand(d, { x: c.x - 80, y: c.y }, { x: c.x + 80, y: c.y }); });
    if (newName) setSelection({ layerName: newName, handle: null });
  }

  function removeSelected() {
    if (!selected) return;
    commitEdit((d) => deleteStrand(d, selected));
    setSelection({ layerName: null, handle: null });
  }

  function removeAll() {
    commitEdit(deleteAllStrands);
    setSelection({ layerName: null, handle: null });
  }

  return (
    <div className="layer-control-stack">
      <LCBtn v={DRAW} label={t('draw_names', lang)} onClick={toggleDrawNames} />
      <LCBtn
        v={LOCK}
        label={lockMode ? t('exit_lock_mode', lang) : t('lock_layers', lang)}
        checked={lockMode}
        onClick={() => commitEdit(toggleLockMode)}
      />
      <LCBtn v={ADD} label={t('add_new_strand', lang)} disabled={lockMode} onClick={addStrand} />
      <LCBtn v={DELETE} label={t('delete_strand', lang)} disabled={!hasDeletable} onClick={removeSelected} />
      <LCBtn
        v={DESELECT}
        label={lockMode ? t('clear_all_locks', lang) : t('deselect_all', lang)}
        onClick={() => (lockMode ? commitEdit(clearAllLocks) : deselectAll())}
      />
      <LCBtn v={DELALL} label={t('delete_all', lang)} onClick={removeAll} />
    </div>
  );
}
