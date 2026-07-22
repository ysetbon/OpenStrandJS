import { useEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { isRTL } from './i18n';
import { t } from './translations';
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
    root.lang = language;
    root.classList.remove('theme-default', 'theme-light', 'theme-dark');
    root.classList.add(`theme-${theme}`);
    // OSS setWindowTitle(main_window_title) — same string, localized.
    document.title = t('main_window_title', language);
  }, [theme, rtl, language]);

  // Background session-history recorder (feeds the Settings → History page).
  useEffect(() => startHistoryRecorder(), []);

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
