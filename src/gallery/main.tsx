import { createRoot } from 'react-dom/client';
import '../renderer/rendererBridge'; // side effect: window.paper + window.renderFixture
import { GalleryApp } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(<GalleryApp />);
