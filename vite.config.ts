import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The editor lives at the repo root (index.html). It reuses the proven
// renderer in web/strand-renderer.js, so Vite must be allowed to serve files
// from web/ and node_modules (paper). Those are already inside the project
// root, so the default fs.allow covers them.
export default defineConfig({
  root: '.',
  plugins: [react()],
  server: { port: 5173, open: true },
  build: { outDir: 'dist-editor', emptyOutDir: true },
});
