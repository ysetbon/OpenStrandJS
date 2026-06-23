// Public i18n API for the chrome. The string table lives in `translations.ts`
// (auto-extracted from OpenStrand Studio's translations.py — 7 languages incl.
// Hebrew RTL). This module is the stable import site: components import { t, tt,
// isRTL } from './i18n'. Strings missing for a language fall back to English,
// then to the key itself.
import type { Language } from '../model/types';
import { STRINGS, t as rawT } from './translations';

export { STRINGS };

export function t(key: string, lang: Language): string {
  return rawT(key, lang);
}

// Positional-format variant for OSS strings that embed {0}, {1}, … placeholders
// (e.g. mask_grid_info, group_shadow_editor_info). Mirrors Python str.format(*args).
export function tf(key: string, lang: Language, ...args: Array<string | number>): string {
  return rawT(key, lang).replace(/\{(\d+)\}/g, (m, i) => {
    const v = args[Number(i)];
    return v === undefined ? m : String(v);
  });
}

// Tooltip variant: prefers a `<key>_tooltip` entry if present, else falls back to
// the plain label. (Some OSS tooltips are multiline — callers render with
// white-space: pre-line.)
export function tt(key: string, lang: Language): string {
  return STRINGS[`${key}_tooltip`] ? rawT(`${key}_tooltip`, lang) : rawT(key, lang);
}

export const isRTL = (lang: Language): boolean => lang === 'he';
