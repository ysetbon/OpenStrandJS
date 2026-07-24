import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone build of the dark-mode window gallery (gallery.html + src/gallery/*).
// Kept separate from the editor build (vite.config.ts) so it never ships to the
// GitHub Pages editor bundle. Relative `base` lets a plain static server host the
// output from any path (the screenshot harness serves dist-gallery/ directly).
export default defineConfig({
  root: '.',
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-gallery',
    emptyOutDir: true,
    rollupOptions: { input: { gallery: 'gallery.html' } },
  },
});
