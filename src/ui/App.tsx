import { useEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { isRTL } from './i18n';
import { Toolbar } from './Toolbar';
import { TabEdge } from './TabEdge';
import { CanvasStage } from './CanvasStage';
import { LayerPanel } from './LayerPanel';
import { Splitter } from './Splitter';
import { startHistoryRecorder } from './settings/history';

// OSS main-window shell: a horizontal splitter with `left_widget` (toolbar over
// canvas) on one side and the layer panel on the other. Theme + RTL are applied
// as classes / dir on <html>; the canvas wrapper is forced LTR so painting is
// never mirrored (matches OSS is_rtl handling).
// Layer-panel widths. The group column is always exactly the Create Group
// button (group_layers.py gives it a fixed 140px), so the button's far edge —
// the outer screen edge, right in LTR and left in RTL — is where the panel
// ends at every window size and browser zoom. (OSS's full-size right_panel is
// 270px with the button anchored to its inner edge; the empty outer strip that
// leaves is the one thing this port drops.)
//
// OSS compact layout (main_window.py COMPACT_WINDOW_WIDTH / layer_panel.py
// set_compact_reduction): on a narrow window the list column shrinks to
// exactly the 146px layer buttons plus a scrollbar gutter so the toolbar keeps
// its room; wide windows keep the full list column. OSS switches at a 1350px
// window with its 350px panel, so the switch here is offset by the difference
// in full-size panel width, keeping the toolbar the same room at the switch.
// .lp-right: 140 + the 1px hairline standing in for the splitter handle.
const GROUP_PANEL_W = 141;
// OSS list_w: LAYER_LIST_BUTTON_WIDTH 146 + scrollbar extent (17) + 2.
const LIST_COLUMN_COMPACT_W = 165;
const LIST_COLUMN_DEFAULT_W = 219;
const LIST_COLUMN_MIN_W = 189;
const PANEL_DEFAULT_W = LIST_COLUMN_DEFAULT_W + GROUP_PANEL_W;   // 360
const PANEL_MIN_W = LIST_COLUMN_MIN_W + GROUP_PANEL_W;           // 330
const PANEL_MAX_W = 860;
const PANEL_COMPACT_W = LIST_COLUMN_COMPACT_W + GROUP_PANEL_W;   // 306
const COMPACT_REDUCTION = PANEL_DEFAULT_W - PANEL_COMPACT_W;
const COMPACT_WINDOW_WIDTH = 1350 + (PANEL_DEFAULT_W - 350);

/** True while the viewport is narrower than OSS's compact threshold. */
function useCompactLayout(): boolean {
  const query = `(max-width: ${COMPACT_WINDOW_WIDTH - 1}px)`;
  const [compact, setCompact] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setCompact(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return compact;
}

export function App() {
  const theme = useEditorStore((s) => s.settings.theme);
  const language = useEditorStore((s) => s.settings.language);
  const showTabs = useEditorStore((s) => s.showTabs);
  const [panelW, setPanelW] = useState(PANEL_DEFAULT_W);
  const rtl = isRTL(language);
  const compact = useCompactLayout();
  // The splitter keeps the user's chosen width; compact mode takes the
  // reduction off it (never below the compact floor), like OSS re-applying the
  // outer split when the panel's minimum drops.
  const effectivePanelW = compact
    ? Math.max(PANEL_COMPACT_W, panelW - COMPACT_REDUCTION)
    : panelW;
  const panelMinW = compact ? PANEL_COMPACT_W : PANEL_MIN_W;

  useEffect(() => {
    const root = document.documentElement;
    root.dir = rtl ? 'rtl' : 'ltr';
    root.classList.remove('theme-default', 'theme-light', 'theme-dark');
    root.classList.add(`theme-${theme}`);
  }, [theme, rtl]);

  // Background session-history recorder (feeds the Settings → History page).
  useEffect(() => startHistoryRecorder(), []);

  // Quit guard — OSS confirm_close_with_unsaved_tabs (main_window.py:2826-2861):
  // leaving with ANY dirty tab prompts, unless "Skip the unsaved-changes prompt
  // when quitting" is ticked. The setting was previously stored and round-tripped
  // through settings JSON with nothing reading it, because the port had no quit
  // guard at all. A browser will not render OSS's Quit anyway / Cancel buttons —
  // preventDefault() is the whole API — so this is the same decision point in the
  // shell's own words.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useEditorStore.getState();
      if (s.settings.skip_quit_warning) return;
      if (!s.tabs.some((tab) => tab.dirty)) return;
      e.preventDefault();
      e.returnValue = '';   // required by older browsers to show the prompt
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <div className="app">
      <div
        className={`shell${compact ? ' compact' : ''}`}
        style={{
          ['--panel-w' as string]: `${effectivePanelW}px`,
          ['--panel-min-w' as string]: `${panelMinW}px`,
          ['--group-panel-w' as string]: `${GROUP_PANEL_W}px`,
        }}
      >
        <div className="left-widget">
          <Toolbar />
          <div className="canvas-wrap" dir="ltr">
            <CanvasStage />
            {showTabs && <TabEdge />}
          </div>
        </div>
        <Splitter
          width={panelW}
          setWidth={setPanelW}
          min={compact ? PANEL_COMPACT_W + COMPACT_REDUCTION : PANEL_MIN_W}
          max={PANEL_MAX_W}
          rtl={rtl}
        />
        <LayerPanel />
      </div>
    </div>
  );
}
