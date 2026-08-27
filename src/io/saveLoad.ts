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
  DeletionRect, EditorDocument, GroupRecord, KnotConnection, Point, RGBA, StrandRecord, StrandType,
} from '../model/types';
import { resolveGroupMembers } from '../model/group';

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

// Project-level keys consumed into typed EditorDocument fields — everything else
// (strand_colors, and whatever a future OSS release adds) rides `doc.extra`.
const MODELED_PROJECT_KEYS = new Set([
  'strands', 'groups', 'selected_strand_name', 'locked_layers', 'lock_mode',
  'shadow_enabled', 'show_control_points', 'shadow_overrides',
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

  // Null-prototype: JSON.parse makes "__proto__" an OWN property, so Object.keys
  // yields it — and `bag[k] = v` on a normal object would hit the Object.prototype
  // __proto__ SETTER instead of defining a key, silently dropping the field from
  // the round trip (and re-pointing the bag's prototype). A passthrough bag whose
  // whole job is "every unmodeled key survives verbatim" cannot have a key that
  // vanishes. Object.create(null) has no such setter, so it stores plainly.
  const extra: Record<string, unknown> = Object.create(null);
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

  const extra: Record<string, unknown> = Object.create(null); // see loadStrand
  for (const k of Object.keys(proj || {})) {
    if (!MODELED_PROJECT_KEYS.has(k)) extra[k] = proj[k];
  }

  return {
    order,
    strands,
    groups: proj.groups ?? {},
    selected_strand_name: proj.selected_strand_name ?? null,
    locked_layers: lockedNamesFromFile(proj.locked_layers, order),
    lock_mode: !!proj.lock_mode,
    shadow_enabled: proj.shadow_enabled ?? true,
    show_control_points: !!proj.show_control_points,
    shadow_overrides: proj.shadow_overrides ?? {},
    extra,
  };
}

// ---- locked_layers: the desktop stores INDICES, we store NAMES --------------
//
// OSS's LayerPanel.locked_layers is a set of integer indices into canvas.strands
// (layer_panel.py:2284 `button.set_locked(i in self.locked_layers)`, :2792 remaps
// them by index after a deletion), and that is what save_load_manager writes. The
// editor keys everything by layer_name, so translate at the file boundary in both
// directions; index i == doc.order[i] == the strand whose serialized `index` is i.
// Strings are accepted on load too, so files written by older builds of this
// editor (which wrote names) still restore their locks.
function lockedNamesFromFile(raw: unknown, order: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    let name: string | undefined;
    if (typeof entry === 'number') name = order[entry];
    else if (typeof entry === 'string') name = order.includes(entry) ? entry : order[Number(entry)];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function lockedIndicesForFile(doc: EditorDocument): number[] {
  const out: number[] = [];
  for (const name of doc.locked_layers) {
    const i = doc.order.indexOf(name);
    if (i >= 0 && !out.includes(i)) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

// ---- groups: the desktop needs the resolved membership, not just main_strands --
//
// serialize_groups writes {layers, main_strands, strands, control_points} and the
// loader indexes `group_info["strands"]` / `["layers"]` DIRECTLY
// (save_load_manager.py:1320, :1350). A group written with only `main_strands`
// therefore raised KeyError inside apply_loaded_strands — swallowed by
// main_window.py:1684 `except Exception: pass` AFTER canvas.strands had already
// been assigned, so the file appeared to load while groups, the button states,
// the lock restore and the undo baseline were all silently skipped.
//
// Resolving on save (instead of trusting whatever was loaded) also keeps the
// membership fresh: the editor only maintains `main_strands` through renames and
// deletions, so a passed-through `strands` list goes stale. OSS re-resolves from
// main_strands for its own operations anyway (group_layers.py resolve_group_data).
function serializeGroup(doc: EditorDocument, name: string): Record<string, unknown> {
  const rec = (doc.groups as Record<string, unknown>)[name] as (GroupRecord & Record<string, unknown>) | undefined;
  const members = resolveGroupMembers(doc, name);
  const owned = new Set<string>([...members.regular, ...members.masks]);
  // Emit in z-order so the list reads like the layer panel.
  let layers = doc.order.filter((n) => owned.has(n));

  // Legacy/foreign records with no usable main_strands resolve to nothing; fall
  // back to their stored membership so the group still survives the round-trip
  // (OSS skips any group whose "strands" list comes back empty).
  if (!layers.length && rec) {
    const stored = (Array.isArray(rec.strands) ? rec.strands : rec.layers) as unknown;
    if (Array.isArray(stored)) layers = stored.filter((n): n is string => typeof n === 'string' && !!doc.strands[n]);
  }

  const control_points: Record<string, unknown> = {};
  for (const n of layers) {
    const st = doc.strands[n];
    if (!st || st.type === 'MaskedStrand') continue;
    control_points[n] = {
      control_point1: { x: st.control_points[0].x, y: st.control_points[0].y },
      control_point2: { x: st.control_points[1].x, y: st.control_points[1].y },
      control_point_center: st.control_point_center
        ? { x: st.control_point_center.x, y: st.control_point_center.y } : null,
      control_point_center_locked: !!st.control_point_center_locked,
    };
  }

  return {
    ...(rec ?? {}),
    layers,
    strands: layers,
    main_strands: (rec?.main_strands ?? []).filter((n) => !!doc.strands[n]),
    control_points,
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
  const groups: Record<string, unknown> = {};
  for (const name of Object.keys(doc.groups ?? {})) groups[name] = serializeGroup(doc, name);

  // Spread the project passthrough bag first, then write the modeled fields over
  // it — same contract as serializeStrand, so unmodeled desktop keys
  // (strand_colors, ...) survive while edited values win.
  return {
    ...(doc.extra ?? {}),
    strands: doc.order.map((name, i) => serializeStrand(doc.strands[name], i)).filter(Boolean),
    groups,
    selected_strand_name: doc.selected_strand_name,
    locked_layers: lockedIndicesForFile(doc),
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
