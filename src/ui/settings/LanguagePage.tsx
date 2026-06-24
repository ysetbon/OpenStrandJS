import { useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { t } from '../i18n';
import type { Language } from '../../model/types';
import { flagUrl } from './assets';
import type { PageProps } from './types';

// Change Language page (settings_dialog.py index 3). A flag combobox (en→us.png,
// he→il.png) + an info label. Selecting applies live (App.tsx flips <html dir> for
// Hebrew). Order is fixed: en, fr, de, it, es, pt, he.
const LANGS: ReadonlyArray<{ code: Language; nameKey: string }> = [
  { code: 'en', nameKey: 'english' },
  { code: 'fr', nameKey: 'french' },
  { code: 'de', nameKey: 'german' },
  { code: 'it', nameKey: 'italian' },
  { code: 'es', nameKey: 'spanish' },
  { code: 'pt', nameKey: 'portuguese' },
  { code: 'he', nameKey: 'hebrew' },
];

export function LanguagePage({ lang }: PageProps) {
  const set = useEditorStore((st) => st.setSettings);
  const [open, setOpen] = useState(false);
  const current = LANGS.find((l) => l.code === lang) ?? LANGS[0];

  const Flag = ({ code }: { code: Language }) => (
    <img
      src={flagUrl(code)}
      alt={code}
      style={{ height: 28, width: 'auto', border: '1px solid var(--set-list-border)', borderRadius: 2, verticalAlign: 'middle' }}
    />
  );

  return (
    <div className="set-page">
      <span className="set-label">{t('select_language', lang)}</span>

      <div style={{ position: 'relative', width: 'max-content' }}>
        <button
          type="button"
          className="set-combo"
          style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', minWidth: 200 }}
          onClick={() => setOpen((o) => !o)}
        >
          <Flag code={current.code} />
          <span style={{ flex: 1, textAlign: 'start' }}>{t(current.nameKey, lang)}</span>
          <span aria-hidden style={{ opacity: 0.7 }}>▾</span>
        </button>
        {open && (
          <ul
            className="set-nav"
            style={{ position: 'absolute', top: 'calc(100% + 4px)', insetInlineStart: 0, zIndex: 5, maxHeight: '60vh' }}
          >
            {LANGS.map((l) => (
              <li
                key={l.code}
                className={'set-nav-item' + (l.code === lang ? ' active' : '')}
                style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40 }}
                onClick={() => { set({ language: l.code }); setOpen(false); }}
              >
                <Flag code={l.code} />
                <span>{t(l.nameKey, lang)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="set-page-sub" style={{ textAlign: 'start', margin: '6px 0 0', maxWidth: 460 }}>
        {t('language_settings_info', lang)}
      </p>
    </div>
  );
}
