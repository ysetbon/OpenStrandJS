import { useEditorStore } from '../store/editorStore';
import { requestRender } from '../renderer/renderScheduler';
import { fitPan } from '../interaction/viewTransform';

// OSS left control column (main_window.py) — sits at the top of the layer panel.
// Four rows of 40×40 circular buttons. Colors are theme-independent literals
// (UI_PORT_PLAN.md §2.3). Zoom in/out are disabled placeholders until zoom is
// unpinned in the renderer; pan/center/refresh/reset/undo/redo are functional.

interface V { bg: string; bgh: string; bgp: string; bd: string; gc: string; gs: number; }
const vars = (v: V): React.CSSProperties => ({
  ['--bg' as string]: v.bg, ['--bgh' as string]: v.bgh, ['--bgp' as string]: v.bgp,
  ['--bd' as string]: v.bd, ['--gc' as string]: v.gc, ['--gs' as string]: `${v.gs}px`,
});

const PURPLE: V = { bg: '#8A2BE2', bgh: '#DA70D6', bgp: '#663399', bd: '#6A1B9A', gc: '#fff', gs: 20 };
const BLUE:   V = { bg: '#4387c2', bgh: '#2c5c8a', bgp: '#10253a', bd: '#3c77a5', gc: '#fff', gs: 24 };
const GOLD:   V = { bg: '#FFD700', bgh: '#FFA500', bgp: '#FF8C00', bd: '#B8860B', gc: '#000', gs: 20 };
const RED:    V = { bg: '#8B0000', bgh: '#DC143C', bgp: '#400000', bd: '#4B0000', gc: '#fff', gs: 22 };
const GREEN:  V = { bg: '#32CD32', bgh: '#00FF00', bgp: '#228B22', bd: '#228B22', gc: '#fff', gs: 20 };
const TAN:    V = { bg: '#D2B48C', bgh: '#CD853F', bgp: '#654321', bd: '#BC9A6A', gc: '#000', gs: 20 };

function CCBtn(props: {
  v: V; glyph: string; title: string;
  onClick?: () => void; checked?: boolean; disabled?: boolean;
}) {
  return (
    <button
      className={`cc-btn${props.checked ? ' checked' : ''}`}
      style={vars(props.v)}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="cc-glyph">{props.glyph}</span>
    </button>
  );
}

export function ControlColumn() {
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const panMode = useEditorStore((s) => s.panMode);
  const togglePanMode = useEditorStore((s) => s.togglePanMode);
  const multiSel = useEditorStore((s) => s.multiSelectMode);
  const toggleMulti = useEditorStore((s) => s.toggleMultiSelect);

  const center = () => {
    const st = useEditorStore.getState();
    st.setView(fitPan(st.doc, st.view));
  };
  const resetStates = () => {
    const st = useEditorStore.getState();
    st.setView({ zoom: 1, ...fitPan(st.doc, { ...st.view, zoom: 1 }) });
    st.setSelection({ layerName: null, handle: null });
    requestRender();
  };

  return (
    <div className="control-column">
      <div className="cc-row">
        <CCBtn v={PURPLE} glyph="🏠" title="Reset states" onClick={resetStates} />
        <CCBtn v={BLUE} glyph="↶" title="Undo" disabled={!canUndo} onClick={() => { undo(); requestRender(); }} />
        <CCBtn v={BLUE} glyph="↷" title="Redo" disabled={!canRedo} onClick={() => { redo(); requestRender(); }} />
      </div>
      <div className="cc-row">
        <CCBtn v={GOLD} glyph="🔍" title="Zoom in (coming soon)" disabled />
        <CCBtn v={GOLD} glyph="🔎" title="Zoom out (coming soon)" disabled />
        <CCBtn v={RED} glyph="🖐" title="Pan (hand tool)" checked={panMode} onClick={togglePanMode} />
      </div>
      <div className="cc-row">
        <CCBtn v={GREEN} glyph="🔄" title="Refresh" onClick={() => requestRender()} />
        <CCBtn v={TAN} glyph="🎯" title="Center on content" onClick={center} />
        <CCBtn v={TAN} glyph="📄" title="Multi-select" checked={multiSel} onClick={toggleMulti} />
      </div>
    </div>
  );
}
