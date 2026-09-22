// Stylized free ends ("Stylize End Side") — the RECORD half of OSS end_style.py
// (OpenStrand Studio 1.111). The geometry half lives in web/strand-renderer.js
// (endStyleGeometry) for painting, shadows and masks, and in
// interaction/endStyleFootprint.ts for the click / hover footprint.
//
// A free end (an end with no circle) may carry one record describing the shape
// of its edge, its tilt, its depth, how far it is extended or trimmed along the
// strand's tangent, and the thickness / colour of the side line drawn along it.
// `null` is the fast path: a strand whose end style is null renders through the
// classic code, and a record that changes nothing is stored as null rather than
// as an explicit default (normalizeEndStyle), exactly as OSS does.

import type { RGBA } from './types';

export type EndShape = 'straight' | 'angled' | 'rounded' | 'pointed' | 'notched' | 'concave';

export const END_SHAPES: ReadonlyArray<EndShape> = ['straight', 'angled', 'rounded', 'pointed', 'notched', 'concave'];
// Shapes whose Depth slider does something (end_style.py DEPTH_SHAPES).
export const DEPTH_SHAPES: ReadonlyArray<EndShape> = ['rounded', 'pointed', 'notched', 'concave'];
export const TILT_MAX = 60;
export const MIN_LINE_WIDTH = 0.5;

export interface EndStyle {
  shape: EndShape;
  tilt: number;                 // degrees, -TILT_MAX..TILT_MAX; always 0 for straight
  depth: number;                // 0..1, share of the strand width (rounded/pointed/notched/concave)
  offset: number;               // px along the tangent: + extends, - trims (the endpoint never moves)
  line_width: number | null;    // px, null = follow stroke_width
  line_color: RGBA | null;      // null = follow stroke_color
}

export type EndStyles = [EndStyle | null, EndStyle | null];

export function defaultEndStyle(): EndStyle {
  return { shape: 'straight', tilt: 0, depth: 0.5, offset: 0, line_width: null, line_color: null };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function asNumber(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asColor(v: unknown): RGBA | null {
  if (v == null) return null;
  if (Array.isArray(v) && v.length >= 3) {
    const n = v.map((c) => Number(c));
    if (n.slice(0, 3).some((c) => !Number.isFinite(c))) return null;
    return { r: n[0] | 0, g: n[1] | 0, b: n[2] | 0, a: v.length > 3 && Number.isFinite(n[3]) ? n[3] | 0 : 255 };
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const r = Number(o.r ?? 0), g = Number(o.g ?? 0), b = Number(o.b ?? 0), a = Number(o.a ?? 255);
    if ([r, g, b, a].some((c) => !Number.isFinite(c))) return null;
    return { r: r | 0, g: g | 0, b: b | 0, a: a | 0 };
  }
  return null;
}

// True when the record draws exactly what an unstyled end draws.
export function isDefaultEndStyle(style: EndStyle | null | undefined): boolean {
  if (!style) return true;
  return (style.shape ?? 'straight') === 'straight'
    && Math.abs(asNumber(style.tilt, 0)) < 1e-9
    && Math.abs(asNumber(style.offset, 0)) < 1e-9
    && style.line_width == null
    && style.line_color == null;
}

// A clean copy of `style`, or null when it is the default look (OSS
// normalize_style). Straight is always square to the strand: Angled is the
// tilted cut, so a straight record's tilt is forced to 0.
export function normalizeEndStyle(style: Partial<EndStyle> | Record<string, unknown> | null | undefined): EndStyle | null {
  if (!style) return null;
  const src = style as Record<string, unknown>;
  const clean = defaultEndStyle();
  const shape = src.shape as EndShape;
  clean.shape = END_SHAPES.includes(shape) ? shape : 'straight';
  clean.tilt = clamp(asNumber(src.tilt, 0), -TILT_MAX, TILT_MAX);
  if (clean.shape === 'straight') clean.tilt = 0;
  clean.depth = clamp(asNumber(src.depth, 0.5), 0, 1);
  clean.offset = asNumber(src.offset, 0);
  clean.line_width = src.line_width == null ? null : Math.max(MIN_LINE_WIDTH, asNumber(src.line_width, 0));
  clean.line_color = asColor(src.line_color);
  return isDefaultEndStyle(clean) ? null : clean;
}

export function copyEndStyle(style: EndStyle | null): EndStyle | null {
  if (!style) return null;
  return { ...style, line_color: style.line_color ? { ...style.line_color } : null };
}

export function endStylesEqual(a: EndStyle | null | undefined, b: EndStyle | null | undefined): boolean {
  const x = normalizeEndStyle(a), y = normalizeEndStyle(b);
  if (!x || !y) return x === y;
  if (x.shape !== y.shape) return false;
  for (const k of ['tilt', 'depth', 'offset'] as const) if (Math.abs(x[k] - y[k]) > 1e-6) return false;
  if ((x.line_width == null) !== (y.line_width == null)) return false;
  if (x.line_width != null && Math.abs(x.line_width - (y.line_width as number)) > 1e-6) return false;
  if ((x.line_color == null) !== (y.line_color == null)) return false;
  if (x.line_color && y.line_color) {
    const p = x.line_color, q = y.line_color;
    if (p.r !== q.r || p.g !== q.g || p.b !== q.b || p.a !== q.a) return false;
  }
  return true;
}

// JSON form of a record, in OSS serialize_style's key order (null stays null).
export function serializeEndStyle(style: EndStyle | null | undefined): Record<string, unknown> | null {
  const s = normalizeEndStyle(style);
  if (!s) return null;
  return {
    shape: s.shape,
    tilt: s.tilt,
    depth: s.depth,
    offset: s.offset,
    line_width: s.line_width,
    line_color: s.line_color ? { r: s.line_color.r, g: s.line_color.g, b: s.line_color.b, a: s.line_color.a } : null,
  };
}

export function serializeEndStyles(styles: EndStyles | null | undefined): [Record<string, unknown> | null, Record<string, unknown> | null] {
  const st = styles ?? [null, null];
  return [serializeEndStyle(st[0]), serializeEndStyle(st[1])];
}

export function deserializeEndStyles(data: unknown): EndStyles {
  if (!Array.isArray(data) || data.length !== 2) return [null, null];
  const one = (v: unknown) => (v && typeof v === 'object' ? normalizeEndStyle(v as Record<string, unknown>) : null);
  return [one(data[0]), one(data[1])];
}

// Hashable signature for geometry caches (end_style.py style_key).
export function endStyleKey(style: EndStyle | null | undefined): string {
  const s = normalizeEndStyle(style);
  if (!s) return '';
  const c = s.line_color;
  return [s.shape, s.tilt.toFixed(4), s.depth.toFixed(4), s.offset.toFixed(4), s.line_width ?? '',
    c ? `${c.r},${c.g},${c.b},${c.a}` : ''].join('|');
}
