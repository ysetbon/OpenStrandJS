// The SELECTION footprint of a MaskedStrand — OSS MaskedStrand.get_selection_path()
// = get_mask_path_stroke() ∪ get_mask_path() minus the deletion rectangles
// (masked_strand.py:281-287) — as a world-unit Path2D, for the select-mode hover
// highlight and the click hit-test (selection_utils.find_strands_at_point).
//
// The region is a Boolean intersection of two stroked bodies, so it comes from
// the renderer (window.maskSelectionPath, strand-renderer.js — the same
// maskRegion builders that paint the mask), reached through the global the
// renderer installs rather than an import: hitTest.ts is also compiled and
// required under plain node by tools/bias_check.mjs, where the renderer script
// (and `window`) do not exist. There this module simply reports "no footprint".
//
// Results are memoized per mask on a geometry signature (both components'
// geometry + widths + cap state, the deletion rects, the curve settings), so a
// hover sweep re-runs the Boolean only when the document actually changed.

import type { EditorDocument, Point, Settings, StrandRecord, ViewState } from '../model/types';
import { buildMeta, toRenderArray } from '../renderer/toRenderArray';
import { maskComponents } from '../model/layerName';
import { HIT_SAMPLE_OFFSETS } from './selectionFootprint';

export interface MaskFootprint {
  pathData: string;
  path: Path2D;
  bounds: { x: number; y: number; width: number; height: number };
}

interface Entry { key: string; fp: MaskFootprint | null }
const cache = new Map<string, Entry>();
const CACHE_MAX = 256;

type MaskPathFn = (name: string, strands: unknown[], meta: unknown) => { pathData: string; bounds: MaskFootprint['bounds'] } | null;

function rendererFn(): MaskPathFn | null {
  const w = (globalThis as { window?: { maskSelectionPath?: MaskPathFn } }).window;
  return w && typeof w.maskSelectionPath === 'function' ? w.maskSelectionPath : null;
}

const geomSig = (s: StrandRecord | undefined): string => s ? [
  s.start.x, s.start.y, s.end.x, s.end.y,
  s.control_points[0].x, s.control_points[0].y, s.control_points[1].x, s.control_points[1].y,
  s.control_point_center ? `${s.control_point_center.x},${s.control_point_center.y}` : '-',
  s.control_point_center_locked ? 1 : 0, s.width, s.stroke_width, s.has_circles.join(','),
  s.circle_stroke_color ? s.circle_stroke_color.a : 'n',
  JSON.stringify(s.extra?.start_circle_stroke_color ?? null),
  JSON.stringify(s.extra?.manual_circle_visibility ?? null),
  JSON.stringify(s.extra?.bias_control ?? null),
].join('|') : 'none';

// Which strands END at a component's ends changes its render-time has_circles,
// so the signature also folds in every AttachedStrand start in the document.
function attachSig(doc: EditorDocument): string {
  const parts: string[] = [];
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (s && s.type === 'AttachedStrand') parts.push(`${s.start.x},${s.start.y}`);
  }
  return parts.join(';');
}

export function maskFootprint(ms: StrandRecord, doc: EditorDocument, settings: Settings): MaskFootprint | null {
  const fn = rendererFn();
  if (!fn || typeof Path2D === 'undefined') return null;
  const comp = maskComponents(ms.layer_name);
  if (!comp) return null;
  const first = doc.strands[comp.first], second = doc.strands[comp.second];
  if (!first || !second) return null;
  const key = [
    geomSig(first), geomSig(second), JSON.stringify(ms.deletion_rectangles ?? []),
    JSON.stringify(settings.curve_params), settings.enable_third_control_point ? 1 : 0,
    settings.enable_curvature_bias_control ? 1 : 0, attachSig(doc),
  ].join('#');
  const hit = cache.get(ms.layer_name);
  if (hit && hit.key === key) return hit.fp;
  // World-unit geometry: identity offset, no supersample, no zoom.
  const unitView: ViewState = { zoom: 1, panX: 0, panY: 0, width: 1, height: 1, supersample: 1 };
  let fp: MaskFootprint | null = null;
  try {
    const r = fn(ms.layer_name, toRenderArray(doc), buildMeta(doc, unitView, settings));
    if (r) fp = { pathData: r.pathData, path: new Path2D(r.pathData), bounds: r.bounds };
  } catch (err) {
    console.error('[OpenStrandJS] mask selection footprint failed:', err);
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ms.layer_name, { key, fp });
  return fp;
}

// Point-in-path needs a 2D context; one scratch context serves every test.
let probe: CanvasRenderingContext2D | null | undefined;
function probeCtx(): CanvasRenderingContext2D | null {
  if (probe !== undefined) return probe;
  probe = null;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    probe = c.getContext('2d');
  }
  return probe;
}

// OSS _path_hit: the nine 0.5px samples against the mask's exact region.
export function maskFootprintContains(fp: MaskFootprint, p: Point): boolean {
  const b = fp.bounds;
  if (p.x < b.x - 0.5 || p.x > b.x + b.width + 0.5 || p.y < b.y - 0.5 || p.y > b.y + b.height + 0.5) return false;
  const ctx = probeCtx();
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const [dx, dy] of HIT_SAMPLE_OFFSETS) {
    if (ctx.isPointInPath(fp.path, p.x + dx, p.y + dy, 'nonzero')) return true;
  }
  return false;
}
