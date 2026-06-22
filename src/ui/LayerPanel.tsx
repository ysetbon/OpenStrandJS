import { useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  addNewStrand, createGroupFromSet, deleteAllStrands, deleteGroup, deleteStrand,
  reorderLayer, toggleHidden, toggleLock, translateGroup,
} from '../store/actions';
import { maskComponents } from '../model/layerName';
import { screenToWorld } from '../interaction/viewTransform';
import { StrandProperties } from './StrandProperties';
import { t } from './i18n';
import type { RGBA } from '../model/types';

const rgba = (c: RGBA) => `rgba(${c.r},${c.g},${c.b},${(c.a ?? 255) / 255})`;
const textOn = (c: RGBA) => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 150 ? '#111' : '#fff');

// One row per strand, rendered top = z-top ([...order].reverse()). Talks to the
// store only through actions, so this whole subsystem is decoupled.
export function LayerPanel() {
  const order = useEditorStore((s) => s.doc.order);
  const strands = useEditorStore((s) => s.doc.strands);
  const locked = useEditorStore((s) => s.doc.locked_layers);
  const selected = useEditorStore((s) => s.selection.layerName);
  const lang = useEditorStore((s) => s.settings.language);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const setSelection = useEditorStore((s) => s.setSelection);
  const dragIdx = useRef<number | null>(null);

  const visual = [...order].map((name, i) => ({ name, orderIdx: i })).reverse();

  function select(name: string) {
    if (locked.includes(name)) return;
    setSelection({ layerName: name, handle: null });
  }

  function remove(name: string) {
    commitEdit((d) => deleteStrand(d, name));
    if (selected === name) setSelection({ layerName: null, handle: null });
  }

  function addStrand() {
    const { view } = useEditorStore.getState();
    const c = screenToWorld({ x: view.width / 2, y: view.height / 2 }, view);
    let newName: string | null = null;
    commitEdit((d) => { newName = addNewStrand(d, { x: c.x - 80, y: c.y }, { x: c.x + 80, y: c.y }); });
    if (newName) setSelection({ layerName: newName, handle: null });
  }

  function onDrop(targetOrderIdx: number) {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from == null) return;
    commitEdit((d) => reorderLayer(d, from, targetOrderIdx));
  }

  return (
    <div className="layer-panel">
      <div className="lp-head">
        <span>{t('layers', lang)}</span>
        <div className="lp-actions">
          <button title="Add strand" onClick={addStrand}>＋</button>
          <button title="Deselect" onClick={() => setSelection({ layerName: null, handle: null })}>▢</button>
          <button title="Delete all" onClick={() => { commitEdit(deleteAllStrands); setSelection({ layerName: null, handle: null }); }}>🗑</button>
        </div>
      </div>

      <div className="lp-list">
        {visual.length === 0 && <div className="lp-empty">No strands. Load a file or ＋.</div>}
        {visual.map(({ name, orderIdx }) => {
          const s = strands[name];
          if (!s) return null;
          const isMask = s.type === 'MaskedStrand';
          const comp = isMask ? maskComponents(name) : null;
          const under = comp ? strands[comp.second] : null;
          const bg = isMask ? '#efeff2' : rgba(s.color);
          const fg = isMask ? '#222' : textOn(s.color);
          const isLocked = locked.includes(name);
          return (
            <div
              key={name}
              className={`lp-row${selected === name ? ' sel' : ''}${s.is_hidden ? ' hidden' : ''}${isLocked ? ' locked' : ''}`}
              style={{
                background: bg,
                color: fg,
                borderLeft: isMask && under ? `6px solid ${rgba(under.color)}` : '6px solid transparent',
              }}
              draggable
              onDragStart={() => { dragIdx.current = orderIdx; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(orderIdx)}
              onClick={() => select(name)}
            >
              <span className="lp-name">{name}{isMask ? '  (mask)' : ''}</span>
              <span className="lp-row-actions" onClick={(e) => e.stopPropagation()}>
                <button title={s.is_hidden ? 'Show' : 'Hide'} onClick={() => commitEdit((d) => toggleHidden(d, name))}>{s.is_hidden ? '🚫' : '👁'}</button>
                <button title={isLocked ? 'Unlock' : 'Lock'} onClick={() => commitEdit((d) => toggleLock(d, name))}>{isLocked ? '🔒' : '🔓'}</button>
                <button title="Delete" onClick={() => remove(name)}>✕</button>
              </span>
            </div>
          );
        })}
      </div>

      <GroupsSection />
      <StrandProperties />
    </div>
  );
}

// Minimal groups: create a group from the selected strand's set (the "<set>_*"
// family), then nudge the whole group by the grid step (one undo step each).
function GroupsSection() {
  const groups = useEditorStore((s) => s.doc.groups) as Record<string, { main_strands: string[] }>;
  const selName = useEditorStore((s) => s.selection.layerName);
  const strands = useEditorStore((s) => s.doc.strands);
  const grid = useEditorStore((s) => s.settings.grid_size);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const selSet = selName && strands[selName] ? strands[selName].set_number : null;
  const names = Object.keys(groups || {});

  return (
    <div className="groups">
      <div className="groups-head">
        <span>Groups</span>
        <button disabled={selSet == null} onClick={() => selSet != null && commitEdit((d) => createGroupFromSet(d, selSet))}>
          Group set
        </button>
      </div>
      {names.map((n) => (
        <div key={n} className="group-row">
          <span className="group-name">{n}</span>
          <span className="group-nudge">
            <button title="left" onClick={() => commitEdit((d) => translateGroup(d, n, -grid, 0))}>←</button>
            <button title="right" onClick={() => commitEdit((d) => translateGroup(d, n, grid, 0))}>→</button>
            <button title="up" onClick={() => commitEdit((d) => translateGroup(d, n, 0, -grid))}>↑</button>
            <button title="down" onClick={() => commitEdit((d) => translateGroup(d, n, 0, grid))}>↓</button>
            <button title="delete group" onClick={() => commitEdit((d) => deleteGroup(d, n))}>✕</button>
          </span>
        </div>
      ))}
    </div>
  );
}
