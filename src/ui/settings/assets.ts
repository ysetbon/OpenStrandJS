// Static-asset paths for the settings dialog. Files live in public/settings/** and
// are served at <BASE_URL>settings/** (BASE_URL is '/' in dev, '/OpenStrandJS/' in
// the GitHub Pages build), so every URL is prefixed with import.meta.env.BASE_URL.
import type { Language } from '../../model/types';

const BASE = import.meta.env.BASE_URL; // ends with '/'
const root = `${BASE}settings`;

// Flag image per language. OSS gotcha: English uses the US flag, Hebrew the IL flag.
const FLAG_FILE: Record<Language, string> = {
  en: 'us', fr: 'fr', de: 'de', it: 'it', es: 'es', pt: 'pt', he: 'il',
};
export const flagUrl = (lang: Language): string => `${root}/flags/${FLAG_FILE[lang]}.png`;

// Tutorial videos (4), 1-indexed to match OSS tutorial_1..4.mp4.
export const tutorialVideoUrl = (n: number): string => `${root}/tutorials/tutorial_${n}.mp4`;
export const TUTORIAL_COUNT = 4;

// Button-guide assets.
export const guideIconUrl = (file: string): string => `${root}/guide-icons/${file}`;
export const guideSvgUrl = (file: string): string => `${root}/guide-svgs/${file}`;

// Samples: ordered list of (label translation key, project JSON filename).
export const SAMPLES: ReadonlyArray<{ key: string; file: string }> = [
  { key: 'sample_closed_knot', file: 'closed_knot.json' },
  { key: 'sample_box_stitch', file: 'box_stitch.json' },
  { key: 'sample_overhand_knot', file: 'overhand_knot.json' },
  { key: 'sample_three_strand_braid', file: 'three_strand_braid.json' },
  { key: 'sample_interwoven_double_closed_knot', file: 'Interwoven_double_closed_knot.json' },
];
export const sampleUrl = (file: string): string => `${root}/samples/${file}`;
