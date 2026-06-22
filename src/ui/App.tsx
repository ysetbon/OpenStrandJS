import { Toolbar } from './Toolbar';
import { CanvasStage } from './CanvasStage';
import { LayerPanel } from './LayerPanel';

export function App() {
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
