import { isRTL } from '../i18n';
import type { Language } from '../../model/types';

// Renders an OSS translation HTML blob (whats_new_info / about_info) faithfully.
// Anchor clicks are intercepted and opened in a new tab (rel=noopener) so the SPA
// never navigates away; mailto: links pass through. RTL-aware for Hebrew.
export function HtmlBlock({ html, lang }: { html: string; lang: Language }) {
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('mailto:')) return; // let the browser handle email
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
  };
  return (
    <div
      className="set-html"
      dir={isRTL(lang) ? 'rtl' : 'ltr'}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
