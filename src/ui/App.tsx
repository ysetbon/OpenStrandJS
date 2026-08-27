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
export function App() {
  const theme = useEditorStore((s) => s.settings.theme);
  const language = useEditorStore((s) => s.settings.language);
  const showTabs = useEditorStore((s) => s.showTabs);
  const [panelW, setPanelW] = useState(490);
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
      <div className="shell" style={{ ['--panel-w' as string]: `${panelW}px` }}>
        <div className="left-widget">
          <Toolbar />
          <div className="canvas-wrap" dir="ltr">
            <CanvasStage />
            {showTabs && <TabEdge />}
          </div>
        </div>
        <Splitter width={panelW} setWidth={setPanelW} min={460} max={860} rtl={rtl} />
        <LayerPanel />
      </div>
    </div>
  );
}
