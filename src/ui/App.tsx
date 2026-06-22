import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { isRTL } from './i18n';
import { Toolbar } from './Toolbar';
import { CanvasStage } from './CanvasStage';
import { LayerPanel } from './LayerPanel';

export function App() {
  const theme = useEditorStore((s) => s.settings.theme);
  const language = useEditorStore((s) => s.settings.language);

  useEffect(() => {
    const root = document.documentElement;
    root.dir = isRTL(language) ? 'rtl' : 'ltr';
    root.classList.remove('theme-default', 'theme-light', 'theme-dark');
    root.classList.add(`theme-${theme}`);
  }, [theme, language]);

  return (
    <div className="app">
      <Toolbar />
      <div className="workarea">
        <CanvasStage />
        <LayerPanel />
      </div>
    </div>
  );
}
