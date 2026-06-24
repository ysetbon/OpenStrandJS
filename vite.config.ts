import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The editor lives at the repo root (index.html). It reuses the proven
// renderer in web/strand-renderer.js, so Vite must be allowed to serve files
// from web/ and node_modules (paper). Those are already inside the project
// root, so the default fs.allow covers them.
// `base` differs by command: dev serves from root (nice localhost URLs),
// while the production build is served from the GitHub Pages project subpath
// https://ysetbon.github.io/OpenStrandJS/ so assets must be prefixed.
export default defineConfig(({ command }) => ({
  root: '.',
  base: command === 'build' ? '/OpenStrandJS/' : '/',
  plugins: [react()],
  server: { port: 5173, open: true },
  build: { outDir: 'dist-editor', emptyOutDir: true },
}));
