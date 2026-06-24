import { t } from '../i18n';
import { HtmlBlock } from './HtmlBlock';
import type { PageProps } from './types';

// About page (settings_dialog.py index 10). A single scrollable panel with the
// localized `about_info` HTML (heading, paragraphs, links, copyright). Links open
// in a new tab; mailto: passes through.
export function AboutPage({ lang }: PageProps) {
  return (
    <div className="set-page">
      <HtmlBlock html={t('about_info', lang)} lang={lang} />
    </div>
  );
}
