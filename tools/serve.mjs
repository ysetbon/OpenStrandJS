// Tiny zero-dependency static file server for the repo root, so the viewer can
// fetch fixtures/artifacts (file:// blocks fetch). Usage: node tools/serve.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8123;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = urlPath === '/' ? '/web/viewer.html' : urlPath;
    const filePath = path.normalize(path.join(root, rel));
    if (!filePath.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(port, () => {
  const url = `http://localhost:${port}/`;
  console.log(`\n  OpenStrandJS viewer:  ${url}\n`);
  console.log('  (serves the repo root; Ctrl-C to stop)\n');
  // Auto-open the default browser unless disabled (OSJS_NO_OPEN=1).
  if (!process.env.OSJS_NO_OPEN) {
    try {
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch { /* user can open the URL manually */ }
  }
});
