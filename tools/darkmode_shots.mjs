// Dark-mode "printscreen fidelity" harness.
//
//   node tools/darkmode_shots.mjs <distGalleryDir> [theme1,theme2,...]
//
// Serves the built gallery (dist-gallery/), then for each theme × window in the
// gallery registry, navigates to gallery.html?window=<id>&theme=<theme>, waits
// for the frame to settle, and screenshots the window (its declared selector, or
// the whole viewport for modal dialogs). The Settings window is expanded into one
// screenshot per category page by driving its nav. Output:
//
//   artifacts/darkmode/<theme>/<id>.png
//   artifacts/darkmode/manifest.json   (drives tools/darkmode_artifact.mjs)
//
// Themes default to default,light,dark (dark is the focus; the other two give a
// side-by-side reference to judge dark-mode correctness against). This is a UI
// screenshot tool — NOT the pixel-fidelity oracle (that lives in fidelity_run.mjs).
//
// OSS_CHROMIUM: absolute path to a Chromium binary, when the pre-installed browser
// revision doesn't match this Playwright version.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const distArg = process.argv[2] || 'dist-gallery';
const themes = (process.argv[3] || 'default,light,dark').split(',').map((s) => s.trim()).filter(Boolean);
const distDir = path.resolve(root, distArg);
const outRoot = path.join(root, 'artifacts', 'darkmode');

const VIEWPORT = { width: 1440, height: 960 };

const launchBrowser = () =>
  chromium.launch(process.env.OSS_CHROMIUM ? { executablePath: process.env.OSS_CHROMIUM } : {});

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

// Static file server rooted at dist-gallery/. '/' serves gallery.html so query
// strings work at the root too.
function serve(dir) {
  const server = createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/' || rel === '') rel = 'gallery.html';
    const file = path.join(dir, rel.replace(/^\/+/, ''));
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';

async function waitReady(page) {
  await page.waitForFunction(() => window.__GALLERY_READY__ === true, null, { timeout: 20000 });
}

// Screenshot either the whole viewport or a specific element (clipped to the
// viewport so an oversized panel doesn't produce a giant image).
async function shoot(page, selector, file) {
  if (selector) {
    const el = await page.$(selector);
    if (el) {
      const box = await el.boundingBox();
      if (box && box.width > 2 && box.height > 2) {
        const clip = {
          x: Math.max(0, box.x), y: Math.max(0, box.y),
          width: Math.min(box.width, VIEWPORT.width - Math.max(0, box.x)),
          height: Math.min(box.height, VIEWPORT.height - Math.max(0, box.y)),
        };
        await page.screenshot({ path: file, clip });
        return;
      }
    }
  }
  await page.screenshot({ path: file });
}

async function main() {
  if (!existsSync(path.join(distDir, 'gallery.html'))) {
    console.error(`FAIL: ${distDir}/gallery.html not found — run \`npm run build:gallery\` first`);
    process.exit(1);
  }
  const server = await serve(distDir);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser();
  const shots = [];
  let errors = 0;

  try {
    // Enumerate the registry once.
    const probe = await browser.newPage({ viewport: VIEWPORT });
    await probe.goto(`${origin}/gallery.html?theme=dark`, { waitUntil: 'load', timeout: 30000 });
    await probe.waitForFunction(() => !!window.__GALLERY__, null, { timeout: 20000 });
    const entries = await probe.evaluate(() => window.__GALLERY__.entries);
    await probe.close();
    console.log(`Registry: ${entries.length} windows × ${themes.length} themes (${themes.join(', ')})`);

    for (const theme of themes) {
      const themeDir = path.join(outRoot, theme);
      mkdirSync(themeDir, { recursive: true });

      for (const entry of entries) {
        const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        const url = `${origin}/gallery.html?window=${encodeURIComponent(entry.id)}&theme=${theme}`;
        try {
          await page.goto(url, { waitUntil: 'load', timeout: 30000 });
          await waitReady(page);

          if (entry.isSettings) {
            // One shot per settings category page (drive the nav list).
            const navCount = await page.$$eval('.set-nav-item', (els) => els.length);
            for (let i = 0; i < navCount; i++) {
              const label = await page.$$eval('.set-nav-item', (els, idx) => els[idx]?.textContent?.trim() || `page${idx}`, i);
              await page.$$eval('.set-nav-item', (els, idx) => els[idx]?.click(), i);
              // Wait for the click to commit (the clicked nav item gains .active in the
              // same React render that swaps the page content) rather than a blind sleep,
              // so a slow CI runner can't screenshot a stale/half-rendered page.
              await page.waitForFunction(
                (idx) => document.querySelectorAll('.set-nav-item')[idx]?.classList.contains('active'),
                i,
              );
              const id = `${entry.id}-${String(i + 1).padStart(2, '0')}-${slug(label)}`;
              const file = path.join(themeDir, `${id}.png`);
              await shoot(page, '.modal', file);
              shots.push({ theme, id, title: `Settings → ${label}`, category: 'settings', file: path.relative(outRoot, file), note: null });
            }
          } else {
            const file = path.join(themeDir, `${entry.id}.png`);
            await shoot(page, entry.selector, file);
            shots.push({ theme, id: entry.id, title: entry.title, category: entry.category, file: path.relative(outRoot, file), note: entry.note });
          }
          if (pageErrors.length) { errors++; console.log(`  WARN ${theme}/${entry.id}: page errors: ${pageErrors.join(' | ')}`); }
          else console.log(`  ok  ${theme}/${entry.id}`);
        } catch (e) {
          errors++;
          console.log(`  FAIL ${theme}/${entry.id}: ${String(e).split('\n')[0]}`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify({ themes, shots }, null, 2));
  console.log(`\nWrote ${shots.length} screenshots + manifest.json to ${path.relative(root, outRoot)}/`);
  if (errors) { console.error(`${errors} window(s) had errors`); process.exit(1); }
}

main();
