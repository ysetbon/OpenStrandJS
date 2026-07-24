import { useEffect, useState } from 'react';
import { App as EditorApp } from '../ui/App';
import { seedGallery } from './seed';
import { ENTRIES, ENTRY_IDS, entryById } from './registry';
import type { Theme, Language } from '../model/types';

// The dark-mode gallery shell. URL params:
//   ?window=<id>   which window to render (omit for the index)
//   ?theme=dark|light|default
//   ?lang=en|fr|de|it|es|pt|he
// It seeds the store once, mounts the real editor <App/>, and renders the chosen
// window's dialog/menu overlay on top. A Playwright harness enumerates
// window.__GALLERY__.ids and screenshots each; window.__GALLERY_READY__ flips true
// once the frame has settled.

const THEMES: Theme[] = ['default', 'light', 'dark'];
const LANGS: Language[] = ['en', 'fr', 'de', 'it', 'es', 'pt', 'he'];

function params() {
  const q = new URLSearchParams(location.search);
  const theme = (q.get('theme') as Theme) || 'dark';
  const lang = (q.get('lang') as Language) || 'en';
  return {
    windowId: q.get('window') || '',
    theme: THEMES.includes(theme) ? theme : 'dark',
    lang: LANGS.includes(lang) ? lang : 'en',
  };
}

function signalReady() {
  // Two rAFs + a short timeout lets the canvas render + dialogs measure/clamp.
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      setTimeout(() => {
        (window as unknown as Record<string, unknown>).__GALLERY_READY__ = true;
        document.body.setAttribute('data-gallery-ready', '1');
      }, 250),
    ),
  );
}

export function GalleryApp() {
  const { windowId, theme, lang } = params();

  // Seed exactly once, synchronously, before the first render so EditorApp's
  // theme effect classes <html> with the requested theme on mount.
  const [seed] = useState(() => seedGallery(theme, lang));

  const entry = windowId ? entryById(windowId) : undefined;

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__GALLERY__ = {
      ids: ENTRY_IDS,
      entries: ENTRIES.map((e) => ({ id: e.id, title: e.title, category: e.category, selector: e.selector || null, isSettings: !!e.isSettings, note: e.note || null })),
    };
    signalReady();
  }, [windowId, theme]);

  // Index page (no window selected): a simple themed list of links.
  if (!windowId) {
    return (
      <div style={{ padding: 24, color: 'var(--text)', font: '14px system-ui' }}>
        <h1 style={{ fontSize: 18 }}>OpenStrandJS — dark-mode window gallery</h1>
        <p style={{ opacity: 0.75 }}>theme=<b>{theme}</b> · lang=<b>{lang}</b> · {ENTRIES.length} windows</p>
        <ul style={{ lineHeight: 1.9 }}>
          {ENTRIES.map((e) => (
            <li key={e.id}>
              <a style={{ color: 'var(--accent)' }} href={`?window=${e.id}&theme=${theme}&lang=${lang}`}>
                [{e.category}] {e.title}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const close = () => {};
  return (
    <>
      <EditorApp />
      {entry?.overlay?.({ seed, lang, close })}
      {!entry && (
        <div style={{ position: 'fixed', top: 8, left: 8, color: 'red', background: '#fff', padding: 8, zIndex: 9999 }}>
          unknown window id: {windowId}
        </div>
      )}
    </>
  );
}
