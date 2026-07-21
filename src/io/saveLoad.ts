// Load/serialize the authentic OpenStrandStudio project JSON.
//
// The desktop serializer (save_load_manager.py) writes ~40 fields per strand
// and orders the strands array by an `index` field that equals z-order. We
// preserve every field by routing unmodeled keys through `StrandRecord.extra`,
// so a load->save round-trip re-opens identically in `python main.py`.
//
// Input shapes accepted:
//   - bare project state:  { strands:[...], groups:{...}, ... }
//   - history wrapper:     { type:"OpenStrandStudioHistory", states:[{step,data}], current_step }

import type {
  DeletionRect, EditorDocument, KnotConnection, Point, RGBA, StrandRecord, StrandType,
} from '../model/types';

// Keys consumed into typed StrandRecord fields — everything else goes to `extra`.
const MODELED_KEYS = new Set([
  'type', 'index', 'layer_name', 'set_number', 'start', 'end',
  'control_points', 'control_point_center', 'control_point_center_locked',
  'width', 'stroke_width', 'color', 'stroke_color', 'has_circles',
  'is_hidden', 'shadow_only', 'hide_shadow', 'circle_stroke_color',
  'knot_connections', 'attached_to', 'attachment_side',
  'deletion_rectangles', 'using_absolute_coords',
  'triangle_has_moved', 'control_point2_shown', 'control_point2_activated',
]);

function asPoint(v: unknown, fallback: Point): Point {
  if (v && typeof v === 'object' && 'x' in v && 'y' in v) {
    const p = v as { x: number; y: number };
    return { x: p.x, y: p.y };
  }
  return { x: fallback.x, y: fallback.y };
}

function asColor(v: unknown, fallback: RGBA): RGBA {
  if (v && typeof v === 'object' && 'r' in v) {
    const c = v as RGBA;
    return { r: c.r, g: c.g, b: c.b, a: c.a == null ? 255 : c.a };
  }
  return { ...fallback };
}

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };

// Pull the bare project-state dict out of either accepted wrapper.
export function unwrapProject(data: any): any {
  if (data && data.type === 'OpenStrandStudioHistory') {
    const target = data.current_step;
    const state = (data.states || []).find((s: any) => s.step === target) || (data.states || [])[0];
    return state ? state.data : { strands: [] };
  }
  return data;
}

function loadStrand(raw: any): StrandRecord {
  const start = asPoint(raw.start, { x: 0, y: 0 });
  const end = asPoint(raw.end, { x: 0, y: 0 });
  const type = (raw.type || 'Strand') as StrandType;

  // control_points: [cp1, cp2]; collapse onto endpoints when absent.
  let cp1 = start, cp2 = end;
  if (Array.isArray(raw.control_points)) {
    cp1 = asPoint(raw.control_points[0], start);
    cp2 = asPoint(raw.control_points[1], end);
  }

  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) {
    if (!MODELED_KEYS.has(k)) extra[k] = raw[k];
  }

  const knot: Record<string, KnotConnection> = {};
  if (raw.knot_connections && typeof raw.knot_connections === 'object') {
    for (const [endKey, info] of Object.entries<any>(raw.knot_connections)) {
      if (info && info.connected_strand_name) {
        knot[endKey] = {
          connected_strand_name: info.connected_strand_name,
          connected_end: info.connected_end,
          is_closing_strand: info.is_closing_strand ?? false,
        };
      }
    }
  }

  const rec: StrandRecord = {
    type,
    layer_name: raw.layer_name ?? '',
    set_number: raw.set_number ?? 1,
    start, end,
    control_points: [cp1, cp2],
    control_point_center: raw.control_point_center != null ? asPoint(raw.control_point_center, start) : null,
    control_point_center_locked: !!raw.control_point_center_locked,
    width: raw.width ?? 46,
    stroke_width: raw.stroke_width ?? 4,
    color: asColor(raw.color, { r: 200, g: 170, b: 230, a: 255 }),
    stroke_color: asColor(raw.stroke_color, BLACK),
    has_circles: Array.isArray(raw.has_circles) ? [!!raw.has_circles[0], !!raw.has_circles[1]] : [false, false],
    is_hidden: !!raw.is_hidden,
    shadow_only: !!raw.shadow_only,
    hide_shadow: !!raw.hide_shadow,
    circle_stroke_color: raw.circle_stroke_color != null ? asColor(raw.circle_stroke_color, BLACK) : null,
    knot_connections: knot,
    triangle_has_moved: raw.triangle_has_moved ?? undefined,
    control_point2_shown: raw.control_point2_shown ?? undefined,
    control_point2_activated: raw.control_point2_activated ?? undefined,
    extra,
  };

  if (type === 'AttachedStrand') {
    rec.attached_to = raw.attached_to ?? null;
    rec.attachment_side = (raw.attachment_side ?? 0) as 0 | 1;
  }
  if (type === 'MaskedStrand') {
    rec.deletion_rectangles = (raw.deletion_rectangles ?? []) as DeletionRect[];
    rec.using_absolute_coords = true; // matches the loader: rects are absolute on load
  }
  return rec;
}

export function loadProject(data: unknown): EditorDocument {
  const proj = unwrapProject(data);
  const rawStrands: any[] = Array.isArray(proj.strands) ? proj.strands : [];

  // z-order = the `index` field when present (the desktop writes it); else
  // array position. Sort a copy by index without losing array fallback.
  const indexed = rawStrands.map((raw, pos) => ({
    raw,
    index: typeof raw.index === 'number' ? raw.index : pos,
  }));
  indexed.sort((a, b) => a.index - b.index);

  const strands: Record<string, StrandRecord> = {};
  const order: string[] = [];
  for (const { raw } of indexed) {
    const rec = loadStrand(raw);
    if (!rec.layer_name) continue;
    strands[rec.layer_name] = rec;
    order.push(rec.layer_name);
  }

  return {
    order,
    strands,
    groups: proj.groups ?? {},
    selected_strand_name: proj.selected_strand_name ?? null,
    locked_layers: proj.locked_layers ?? [],
    lock_mode: !!proj.lock_mode,
    shadow_enabled: proj.shadow_enabled ?? true,
    show_control_points: !!proj.show_control_points,
    shadow_overrides: proj.shadow_overrides ?? {},
  };
}

function serializeStrand(s: StrandRecord, index: number): Record<string, unknown> {
  // Spread the passthrough bag first, then write modeled fields over it so the
  // edited values win while every untouched field survives verbatim.
  const out: Record<string, unknown> = { ...s.extra };
  out.type = s.type;
  out.index = index;
  out.start = { x: s.start.x, y: s.start.y };
  out.end = { x: s.end.x, y: s.end.y };
  out.width = s.width;
  out.color = s.color;
  out.stroke_color = s.stroke_color;
  out.stroke_width = s.stroke_width;
  out.has_circles = s.has_circles;
  out.layer_name = s.layer_name;
  out.set_number = s.set_number;
  out.is_hidden = s.is_hidden;
  out.shadow_only = s.shadow_only;
  out.hide_shadow = s.hide_shadow;
  out.knot_connections = s.knot_connections;
  out.circle_stroke_color = s.circle_stroke_color;
  out.control_points = [
    { x: s.control_points[0].x, y: s.control_points[0].y },
    { x: s.control_points[1].x, y: s.control_points[1].y },
  ];
  out.control_point_center = s.control_point_center
    ? { x: s.control_point_center.x, y: s.control_point_center.y } : null;
  out.control_point_center_locked = s.control_point_center_locked;
  if (s.triangle_has_moved !== undefined) out.triangle_has_moved = s.triangle_has_moved;
  if (s.control_point2_shown !== undefined) out.control_point2_shown = s.control_point2_shown;
  if (s.control_point2_activated !== undefined) out.control_point2_activated = s.control_point2_activated;

  if (s.type === 'AttachedStrand') {
    out.attached_to = s.attached_to ?? null;
    out.attachment_side = s.attachment_side ?? 0;
  }
  if (s.type === 'MaskedStrand') {
    out.deletion_rectangles = s.deletion_rectangles ?? [];
    // MaskedStrands have no independent control points; the desktop app writes
    // them as [null, null] (the renderer resolves the mask from its components).
    out.control_points = [null, null];
  }
  return out;
}

export function serializeProject(doc: EditorDocument): Record<string, unknown> {
  return {
    strands: doc.order.map((name, i) => serializeStrand(doc.strands[name], i)).filter(Boolean),
    groups: doc.groups ?? {},
    selected_strand_name: doc.selected_strand_name,
    locked_layers: doc.locked_layers,
    lock_mode: doc.lock_mode,
    shadow_enabled: doc.shadow_enabled,
    show_control_points: doc.show_control_points,
    shadow_overrides: doc.shadow_overrides,
  };
}

// Dev-only debug handle for round-trip testing.
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__io = { loadProject, serializeProject, unwrapProject };
}
