// Static-asset paths for the settings dialog. Files live in public/settings/** and
// are served at <BASE_URL>settings/** (BASE_URL is '/' in dev, '/OpenStrandJS/' in
// the GitHub Pages build), so every URL is prefixed with import.meta.env.BASE_URL.
import type { Language } from '../../model/types';

const BASE = import.meta.env.BASE_URL; // ends with '/'
const root = `${BASE}settings`;

// Flag image per language. OSS gotcha: English uses the US flag, Hebrew the IL
// flag, and the 1.111 languages use country files too (Swedish se, Japanese jp,
// Chinese cn — settings_dialog.py add_lang_item_*).
const FLAG_FILE: Record<Language, string> = {
  en: 'us', fr: 'fr', de: 'de', it: 'it', es: 'es', pt: 'pt', he: 'il',
  ru: 'ru', fi: 'fi', sv: 'se', ja: 'jp', zh: 'cn',
};
export const flagUrl = (lang: Language): string => `${root}/flags/${FLAG_FILE[lang]}.png`;

// Tutorial videos (4 per language), 1-indexed to match OSS tutorial_1..4.mp4.
// Per-language folders, like OSS video_path_for: <lang>/tutorial_N.mp4. Callers fall
// back to 'en' (fallbackLang) when a language's file fails to load.
export const tutorialVideoUrl = (n: number, lang: Language = 'en'): string =>
  `${root}/tutorials/${lang}/tutorial_${n}.mp4`;
export const TUTORIAL_COUNT = 4;

// Button-guide assets.
export const guideIconUrl = (file: string): string => `${root}/guide-icons/${file}`;
export const guideSvgUrl = (file: string): string => `${root}/guide-svgs/${file}`;

// Samples (18, in the order of OSS settings_dialog.py SAMPLES): ordered list of (label translation key, project JSON filename).
export const SAMPLES: ReadonlyArray<{ key: string; file: string }> = [
  { key: 'sample_closed_knot', file: 'closed_knot.json' },
  { key: 'sample_box_stitch', file: 'box_stitch.json' },
  { key: 'sample_overhand_knot', file: 'overhand_knot.json' },
  { key: 'sample_three_strand_braid', file: 'three_strand_braid.json' },
  { key: 'sample_interwoven_double_closed_knot', file: 'Interwoven_double_closed_knot.json' },
  { key: 'sample_straight_weave', file: 'straight_weave_12x12.json' },
  { key: 'sample_curved_weave', file: 'curved_weave_6x6.json' },
  { key: 'sample_plait', file: 'plait.json' },
  { key: 'sample_thick_and_thin', file: 'thick_and_thin.json' },
  { key: 'sample_bridge', file: 'bridge.json' },
  { key: 'sample_twisted_pairs', file: 'twisted_pairs.json' },
  { key: 'sample_kagome_weave', file: 'kagome_weave.json' },
  { key: 'sample_woven_heart', file: 'woven_heart.json' },
  { key: 'sample_tidal_waves', file: 'tidal_waves.json' },
  { key: 'sample_chinese_double_coin', file: 'chinese_double_coin.json' },
  { key: 'sample_chinese_cloverleaf', file: 'chinese_cloverleaf.json' },
  { key: 'sample_chinese_good_luck', file: 'chinese_good_luck.json' },
  { key: 'sample_chinese_pan_chang', file: 'chinese_pan_chang.json' },
];
export const sampleUrl = (file: string): string => `${root}/samples/${file}`;
