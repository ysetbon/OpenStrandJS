import { t } from '../i18n';
import { HtmlBlock } from './HtmlBlock';
import type { PageProps } from './types';

// What's New page (settings_dialog.py index 8). Renders the per-language
// `whats_new_info` HTML blob. The flag-emoji substitution OSS does is a no-op for
// the current version (browsers render emoji natively), so we render as-is.
export function WhatsNewPage({ lang }: PageProps) {
  return (
    <div className="set-page">
      <HtmlBlock html={t('whats_new_info', lang)} lang={lang} />
    </div>
  );
}
