import { useEditorStore } from '../store/editorStore';
import { requestRender } from '../renderer/renderScheduler';
import { fitPan } from '../interaction/viewTransform';
import { STRINGS, t } from './i18n';
import type { Language } from '../model/types';

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
const RED:    V = { bg: '#8B0000', bgh: '#DC143C', bgp: '#400000', bd: '#4B0000', gc: '#fff', gs: 24 };
const GREEN:  V = { bg: '#32CD32', bgh: '#00FF00', bgp: '#228B22', bd: '#228B22', gc: '#fff', gs: 20 };
const TAN:    V = { bg: '#D2B48C', bgh: '#CD853F', bgp: '#654321', bd: '#BC9A6A', gc: '#000', gs: 20 };

// OSS tooltip keys (layer_panel.py): reset_tooltip / undo_tooltip / redo_tooltip /
// zoom_in_tooltip / zoom_out_tooltip / pan_tooltip / refresh_tooltip / center_tooltip /
// hide_mode_tooltip (the multi-select button uses hide_mode_tooltip, NOT a multi_select key).
// TODO(oss-fidelity): these *_tooltip keys are not yet in translations.ts (not an owned
// file in this slice). Until they're added, fall back to the existing English title so we
// never surface a raw key string. Once the keys land, t() resolves them automatically.
function tip(key: string, fallbackEn: string, lang: Language): string {
  return STRINGS[key] ? t(key, lang) : fallbackEn;
}

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
  const lang = useEditorStore((s) => s.settings.language);

  const center = () => {
    const st = useEditorStore.getState();
    st.setView(fitPan(st.doc, st.view));
  };
  const resetStates = () => {
    const st = useEditorStore.getState();
    // Reset/home restores view.zoom to 1.0 (OSS zoom_factor default). The app's
    // 65% "default view" look comes from the CSS page zoom, not view.zoom, so home
    // returns to the same framing the app opens with.
    st.setView({ zoom: 1, ...fitPan(st.doc, { ...st.view, zoom: 1 }) });
    st.setSelection({ layerName: null, handle: null });
    requestRender();
  };

  return (
    <div className="control-column">
      <div className="cc-row cc-row-top">
        <CCBtn v={PURPLE} glyph="🏠" title={tip('reset_tooltip', 'Reset states', lang)} onClick={resetStates} />
        <CCBtn v={BLUE} glyph="⮌" title={tip('undo_tooltip', 'Undo', lang)} disabled={!canUndo} onClick={() => { undo(); requestRender(); }} />
        <CCBtn v={BLUE} glyph="⮎" title={tip('redo_tooltip', 'Redo', lang)} disabled={!canRedo} onClick={() => { redo(); requestRender(); }} />
      </div>
      <div className="cc-row cc-row-mid">
        <CCBtn v={GOLD} glyph="🔍" title={tip('zoom_in_tooltip', 'Zoom in (coming soon)', lang)} disabled />
        <CCBtn v={GOLD} glyph="🔎" title={tip('zoom_out_tooltip', 'Zoom out (coming soon)', lang)} disabled />
        <CCBtn v={RED} glyph="🖐" title={tip('pan_tooltip', 'Pan (hand tool)', lang)} checked={panMode} onClick={togglePanMode} />
      </div>
      <div className="cc-row cc-row-mid">
        <CCBtn v={GREEN} glyph="🔄" title={tip('refresh_tooltip', 'Refresh', lang)} onClick={() => requestRender()} />
        <CCBtn v={TAN} glyph="🎯" title={tip('center_tooltip', 'Center on content', lang)} onClick={center} />
        <CCBtn v={TAN} glyph="📄" title={tip('hide_mode_tooltip', 'Multi-select', lang)} checked={multiSel} onClick={toggleMulti} />
      </div>
    </div>
  );
}
