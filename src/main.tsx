import { createRoot } from 'react-dom/client';
import './renderer/rendererBridge'; // side effect: window.paper + window.renderFixture
import { App } from './ui/App';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(<App />);
