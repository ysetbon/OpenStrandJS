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
// button, so the button's far edge — the outer screen edge, right in LTR and
// left in RTL — is where the panel ends at every window size and browser zoom.
// (OSS's full-size right_panel is 270px with the button anchored to its inner
// edge; the empty outer strip that leaves is the one thing this port drops.)
//
// The panel is sized to its widest CONTENT rather than to a round number, so
// the canvas keeps everything the panel does not actually need:
//
//   list column   132px layer button + 12px scrollbar room + 2 slack = 146
//   group column  112px Create Group button + the 1px hairline that stands in
//                 for the splitter handle beside it = 113
//   +1            .layer-panel's own border-inline-start
//
// The 12px is what a scrolling list needs to take without narrowing the
// buttons, the way OSS's list_w carries its scrollbar extent: it must fit
// whichever thin scrollbar the browser draws — Chromium lays out 10px for
// `scrollbar-width: thin`, Firefox a little more — plus OSS's own 2px of
// slack. The room is only claimed while the scrollbar is on screen; see
// styles.css for why it is not reserved permanently.
//
// 112px clears the widest Create Group label of the seven languages (French
// "Créer Groupe", 90px in bold 14px) with 11px each side, and the list column
// clears the widest bottom-stack label (Spanish "Nuevo Cordón", 96px) with
// 24px each side.
//
// This is also OSS's own compact geometry (layer_panel.py set_compact_reduction
// trims the list column to exactly the buttons plus a scrollbar gutter), so the
// port no longer needs a separate wide/compact split: the compact column is the
// only column, and it is narrower at every window size than the old compact
// mode was. The splitter can still widen the panel past this floor.
const GROUP_PANEL_W = 113;
const LIST_COLUMN_W = 146;
const PANEL_BORDER_W = 1;
const PANEL_DEFAULT_W = LIST_COLUMN_W + GROUP_PANEL_W + PANEL_BORDER_W;   // 260
const PANEL_MIN_W = PANEL_DEFAULT_W;
const PANEL_MAX_W = 860;

export function App() {
  const theme = useEditorStore((s) => s.settings.theme);
  const language = useEditorStore((s) => s.settings.language);
  const showTabs = useEditorStore((s) => s.showTabs);
  const [panelW, setPanelW] = useState(PANEL_DEFAULT_W);
  const rtl = isRTL(language);

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
        className="shell"
        style={{
          ['--panel-w' as string]: `${panelW}px`,
          ['--panel-min-w' as string]: `${PANEL_MIN_W}px`,
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
          min={PANEL_MIN_W}
          max={PANEL_MAX_W}
          rtl={rtl}
        />
        <LayerPanel />
      </div>
    </div>
  );
}
