// Load/serialize the authentic OpenStrandStudio project JSON.
//
// A port of save_load_manager.py — serialize_strand / serialize_project_state /
// serialize_groups on the way out, load_strands_from_data on the way in — plus
// the history wrapper that undo_redo_manager.export_history writes and
// import_history_payload reads. Every key the desktop writes is written here, in
// the desktop's order, with the desktop's defaults, so a file saved by this
// editor is indistinguishable from one saved by `python main.py`, and a file
// loaded here lands in the same state it would land in there.
//
// Input shapes accepted:
//   - bare project state:  { strands:[...], groups:{...}, ... }
//   - history wrapper:     { type:"OpenStrandStudioHistory", version, current_step,
//                            max_step, states:[{step, data}] }
//
// What OSS writes per strand (serialize_strand), in this order:
//   type index start end width color stroke_color stroke_width
//   width_in_grid_units elliptical_end_caps has_circles layer_name set_number
//   is_first_strand is_start_side start_line_visible end_line_visible is_hidden
//   start_extension_visible end_extension_visible start_arrow_visible
//   end_arrow_visible full_arrow_visible shadow_only hide_shadow
//   closed_connections arrow_color arrow_transparency arrow_texture
//   arrow_shaft_style arrow_head_visible arrow_casts_shadow knot_connections
//   circle_stroke_color start_circle_stroke_color end_circle_stroke_color
//   [AttachedStrand: attached_to attachment_side angle length]
//   control_points control_point_center control_point_center_locked bias_control
//   triangle_has_moved control_point2_shown control_point2_activated
//   [MaskedStrand: deletion_rectangles (+ control_point_center rewritten in place)]
//   manual_circle_visibility
// Unmodeled OSS keys ride `StrandRecord.extra` and are re-emitted in their slot;
// keys OSS does not know are kept for the session but, as in OSS, never written.

import type {
  DeletionRect, EditorDocument, GroupRecord, KnotConnection, Point, RGBA, StrandRecord, StrandType,
} from '../model/types';
import { readBiasData, readBias, refreshBiasPositions, serializedBias, NEUTRAL_BIAS, BIAS_EPS } from '../model/biasControl';
import { resolveGroupMembers } from '../model/group';
import { maskComponents } from '../model/layerName';
import type { HistoryMeta } from '../store/historyMeta';

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
// (whatever a future OSS release adds) rides `doc.extra`. `undo_metadata` is the
// per-step provenance record undo_redo_metadata.py injects into a state file; it
// is read back into the history stack, never into the document.
const MODELED_PROJECT_KEYS = new Set([
  'strands', 'groups', 'strand_colors', 'selected_strand_name', 'locked_layers', 'lock_mode',
  'shadow_enabled', 'show_control_points', 'shadow_overrides', 'undo_metadata',
]);

const UNDO_METADATA_KEY = 'undo_metadata';

// Settings that change what OSS's loader/serializer produce. They are read off
// the canvas there (canvas.enable_curvature_bias_control), so the editor threads
// the live setting through. Leaving it out is for tools that do not model the
// setting: the loader then keeps a strand's saved bias data untouched (neither
// the ON-path restore/update_shape nor the OFF-path drop runs) and the
// serializer writes the stored squares as they stand.
export interface SaveLoadOptions {
  enable_curvature_bias_control?: boolean;
}

// ---- primitives ------------------------------------------------------------

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };

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

// serialize_point: None stays None; a point becomes {x, y}.
function pt(p: Point | null | undefined): { x: number; y: number } | null {
  return p ? { x: p.x, y: p.y } : null;
}

// serialize_color: a QColor / {r,g,b,a} dict becomes {r,g,b,a}; anything else is black.
function color(c: unknown): RGBA {
  if (c && typeof c === 'object' && 'r' in c && 'g' in c && 'b' in c) {
    const v = c as RGBA;
    return { r: v.r, g: v.g, b: v.b, a: v.a == null ? 255 : v.a };
  }
  return { ...BLACK };
}

// Nullable color the way `serialize_color(x) if x else None` writes it.
function colorOrNull(c: unknown): RGBA | null {
  return c ? color(c) : null;
}

// QPointF equality (qFuzzyCompare on both coordinates).
function samePoint(a: Point, b: Point): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return eq(a.x, b.x) && eq(a.y, b.y);
}

const isEmptyDoc = (doc: EditorDocument): boolean =>
  doc.order.length === 0 && Object.keys(doc.groups ?? {}).length === 0;

// ---- history wrapper -------------------------------------------------------

// Pull the bare project-state dict of the CURRENT step out of either accepted
// wrapper (import_history_payload loads `current_step`, clamped to the states
// that exist). A wrapper with no states yields an empty project.
export function unwrapProject(data: any): any {
  if (data && data.type === 'OpenStrandStudioHistory') {
    const states = sortedStates(data);
    if (!states.length) return { strands: [] };
    const cur = currentStepIndex(data, states);
    return states[cur].data;
  }
  return data;
}

function sortedStates(data: any): Array<{ step: number; data: any }> {
  const raw: any[] = Array.isArray(data?.states) ? data.states : [];
  const out: Array<{ step: number; data: any }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const step = entry.step, d = entry.data;
    if (typeof step !== 'number' || d == null) continue;   // OSS skips these too
    out.push({ step, data: d });
  }
  out.sort((a, b) => a.step - b.step);
  return out;
}

// import_history_payload: max_step = the states recreated, current_step =
// min(saved current_step, max_step). Returned as a 0-based index into `states`.
function currentStepIndex(data: any, states: Array<{ step: number; data: any }>): number {
  const recreated = states.length;
  const saved = typeof data?.current_step === 'number' ? data.current_step : recreated;
  const cur = Math.min(saved, recreated);
  // OSS steps are 1-based and contiguous after an import; a file whose steps
  // are not is matched by step number first, then by position.
  const byStep = states.findIndex((s) => s.step === cur);
  if (byStep >= 0) return byStep;
  return Math.max(0, Math.min(recreated - 1, cur - 1));
}

// ---- undo metadata (undo_redo_metadata.py) ---------------------------------

// Local-time ISO stamp to the second, what datetime.now().isoformat(timespec=
// "seconds") writes.
function localIso(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// The record build_metadata() stores under `undo_metadata`, in its key order.
export function metaToOss(meta: HistoryMeta | null): Record<string, unknown> | null {
  if (!meta) return null;
  return {
    action: meta.action || 'system.unknown',
    source: meta.source || (meta.mode ? 'mode' : 'system'),
    mode: meta.mode ?? null,
    targets: [...(meta.targets ?? [])],
    detail: meta.detail ?? null,
    origin: null,
    at: localIso(meta.at),
  };
}

export function metaFromOss(raw: unknown): HistoryMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const at = typeof m.at === 'string' ? Date.parse(m.at) : typeof m.at === 'number' ? m.at : NaN;
  return {
    action: typeof m.action === 'string' && m.action ? m.action : 'system.unknown',
    source: (typeof m.source === 'string' && m.source ? m.source : 'system') as HistoryMeta['source'],
    targets: Array.isArray(m.targets) ? m.targets.filter((t) => t != null).map(String) : [],
    detail: m.detail == null ? undefined : String(m.detail),
    mode: (typeof m.mode === 'string' && m.mode ? m.mode : null) as HistoryMeta['mode'],
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

// ---- load: one strand ------------------------------------------------------

function loadStrand(raw: any, opts?: SaveLoadOptions): StrandRecord {
  const start = asPoint(raw.start, { x: 0, y: 0 });
  const end = asPoint(raw.end, { x: 0, y: 0 });
  const type = (raw.type || 'Strand') as StrandType;
  const masked = type === 'MaskedStrand';

  // control_points: [cp1, cp2]. Strand.__init__ parks BOTH on the start
  // (strand.py:52-58), and a file without the key leaves them there.
  let cp1 = { ...start }, cp2 = { ...start };
  if (Array.isArray(raw.control_points)) {
    cp1 = asPoint(raw.control_points[0], start);
    cp2 = asPoint(raw.control_points[1], start);
  }
  // control_point_center: the file's value when it has one (locked or not —
  // Strand.update leaves an unlocked centre alone); otherwise the midpoint of
  // the loaded control points, which is where update_shape puts it after
  // update_control_points(reset_control_points=False).
  const center: Point | null = raw.control_point_center != null
    ? asPoint(raw.control_point_center, start)
    : { x: (cp1.x + cp2.x) / 2, y: (cp1.y + cp2.y) / 2 };

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
  // Never restored by any loader path, never assigned anywhere in OSS: the
  // attribute does not exist after a load, so the next save writes False.
  delete extra.is_first_strand;

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

  // triangle_has_moved: restored when saved, otherwise inferred from whether the
  // triangle (cp1) sits more than a pixel away from the start (deserialize_strand
  // :550-561). control_point2_shown / _activated default to False (:563-572).
  let triangle_has_moved: boolean;
  if (typeof raw.triangle_has_moved === 'boolean') triangle_has_moved = raw.triangle_has_moved;
  else triangle_has_moved = Math.hypot(cp1.x - start.x, cp1.y - start.y) > 1.0;

  const rec: StrandRecord = {
    type,
    layer_name: raw.layer_name ?? '',
    set_number: raw.set_number ?? 1,
    start, end,
    control_points: [cp1, cp2],
    control_point_center: center,
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
    triangle_has_moved,
    control_point2_shown: !!raw.control_point2_shown,
    control_point2_activated: !!raw.control_point2_activated,
    extra,
  };

  if (type === 'AttachedStrand') {
    rec.attached_to = raw.attached_to ?? null;
    rec.attachment_side = (raw.attachment_side ?? 0) as 0 | 1;
  }

  if (masked) {
    // The third pass (load_strands_from_data :913-988) rebuilds a mask from its
    // two components and restores only the mask-relevant fields; everything a
    // MaskedStrand cannot carry comes back as the constructor default, and that
    // is what the next save writes. Mirror that here so the round trip is exact.
    rec.deletion_rectangles = (raw.deletion_rectangles ?? []) as DeletionRect[];
    // deserialize sets using_absolute_coords, and load_strands_from_data clears
    // it again once the strands are on the canvas (:1087-1089).
    rec.using_absolute_coords = false;
    // has_circles is a property that always reads [False, False]. The centre
    // caches stay empty: in this editor base/edited_center_point are the
    // baseline the mask-tracking drift measures from and are re-seeded at the
    // start of every gesture (seedMaskCenters); what OSS writes for a mask that
    // has not been touched since it was loaded is settled in serializeStrand.
    rec.base_center_point = null;
    rec.edited_center_point = null;
    rec.control_point_center = null;
    rec.has_circles = [false, false];
    rec.control_points = [start, end];
    rec.control_point_center_locked = false;
    rec.triangle_has_moved = false;
    rec.control_point2_shown = false;
    rec.control_point2_activated = false;
    rec.circle_stroke_color = null;
    for (const k of ['start_circle_stroke_color', 'end_circle_stroke_color', 'elliptical_end_caps',
      'bias_control', 'angle', 'length', 'attached_to', 'attachment_side']) {
      delete extra[k];
    }
    // The third pass assigns closed_connections with a [False, False] default,
    // so a loaded mask owns it (a mask created in-session does not — see
    // maskDelegated). width_in_grid_units is owned only when truthy.
    if (!Array.isArray(extra.closed_connections)) extra.closed_connections = [false, false];
    if (!extra.width_in_grid_units) delete extra.width_in_grid_units;
  }

  // Curvature bias (deserialize_strand :574-626, and :853-901 for attached
  // strands): with the setting ON the biases are restored (neutral when absent)
  // and a bias that deviates from neutral counts as the triangle having moved;
  // with it OFF the strand's bias control is dropped. A mask never restores one.
  // An omitted setting (a tool that does not model it) leaves the file's bias
  // data exactly as saved: nothing restored, nothing dropped, no update_shape.
  const biasOn = opts?.enable_curvature_bias_control;
  if (!masked && biasOn === false) {
    delete extra.bias_control;
  } else if (!masked && biasOn === true) {
    // The saved positions are read and then immediately overwritten by
    // update_positions_from_biases (:591-608) from the centre AS LOADED — the
    // update_shape below may still move that centre, and the squares keep the
    // old placement until something redraws them.
    const bc = readBiasData(rec);
    extra.bias_control = {
      triangle_bias: typeof bc?.triangle_bias === 'number' ? bc.triangle_bias : NEUTRAL_BIAS,
      circle_bias: typeof bc?.circle_bias === 'number' ? bc.circle_bias : NEUTRAL_BIAS,
    };
    refreshBiasPositions(rec);
    const b = readBias(rec);
    if (Math.abs(b.triangle - NEUTRAL_BIAS) > BIAS_EPS || Math.abs(b.circle - NEUTRAL_BIAS) > BIAS_EPS) {
      rec.triangle_has_moved = true;
    }
    // The bias branch ends with strand.update_shape() (:620-621, :895-896),
    // which re-derives an UNLOCKED centre as the control-point midpoint and
    // auto-unlocks a locked one that sits within half a pixel of it
    // (strand.py:831-851). With the setting off no update_shape runs and the
    // file's centre stands.
    const mid = { x: (cp1.x + cp2.x) / 2, y: (cp1.y + cp2.y) / 2 };
    if (rec.control_point_center_locked && rec.control_point_center
        && Math.hypot(rec.control_point_center.x - mid.x, rec.control_point_center.y - mid.y) < 0.5) {
      rec.control_point_center_locked = false;
    }
    if (!rec.control_point_center_locked) rec.control_point_center = mid;
  }
  return rec;
}

// ---- load: whole project ---------------------------------------------------

// Port of load_strands_from_data. Strands are placed by their `index` (array
// position when absent). Plain strands always load; an AttachedStrand loads only
// once its `attached_to` parent has (in as many passes as it takes); a
// MaskedStrand only when both components named by its layer_name exist. What
// never resolves is dropped, exactly as the desktop drops it. Then the "fourth
// pass" replaces every has_circles with whether a child really attaches at that
// end (manual_circle_visibility overrides winning), and the canonical set colors
// are restored.
export function loadProject(data: unknown, opts?: SaveLoadOptions): EditorDocument {
  const proj = unwrapProject(data) ?? {};
  return loadProjectState(proj, opts);
}

function loadProjectState(proj: any, opts?: SaveLoadOptions): EditorDocument {
  const rawStrands: any[] = Array.isArray(proj.strands) ? proj.strands : [];

  const indexed = rawStrands
    .filter((raw) => raw && typeof raw === 'object')
    .map((raw, pos) => ({ raw, index: typeof raw.index === 'number' ? raw.index : pos }));
  indexed.sort((a, b) => a.index - b.index);

  const created: Record<string, StrandRecord> = {};
  const nameOf = (raw: any): string => (typeof raw.layer_name === 'string' ? raw.layer_name : '');

  // First pass: plain strands.
  for (const { raw } of indexed) {
    if ((raw.type || 'Strand') !== 'Strand') continue;
    const name = nameOf(raw);
    if (!name) continue;
    created[name] = loadStrand(raw, opts);
  }

  // Second pass: attached strands, until no more resolve.
  let pending = indexed.filter(({ raw }) => raw.type === 'AttachedStrand');
  let prev = -1;
  while (pending.length && prev !== pending.length) {
    prev = pending.length;
    const remaining: typeof pending = [];
    for (const item of pending) {
      const parentName = item.raw.attached_to;
      if (typeof parentName !== 'string' || !created[parentName] || created[parentName].type === 'MaskedStrand') {
        remaining.push(item);
        continue;
      }
      const name = nameOf(item.raw);
      if (!name) continue;
      created[name] = loadStrand(item.raw, opts);
    }
    pending = remaining;
  }

  // Third pass: masks whose components both exist.
  for (const { raw } of indexed) {
    if (raw.type !== 'MaskedStrand') continue;
    const name = nameOf(raw);
    if (!name) continue;
    const comp = maskComponents(name);
    if (!comp || !created[comp.first] || !created[comp.second]) continue;
    created[name] = loadStrand(raw, opts);
  }

  const strands: Record<string, StrandRecord> = {};
  const order: string[] = [];
  for (const { raw } of indexed) {
    const name = nameOf(raw);
    const rec = created[name];
    if (!rec || strands[name]) continue;
    strands[name] = rec;
    order.push(name);
  }

  // Fourth pass: has_circles from the actual attachments (:993-1052).
  validateHasCircles(strands, order);

  const extra: Record<string, unknown> = Object.create(null); // see loadStrand
  for (const k of Object.keys(proj || {})) {
    if (!MODELED_PROJECT_KEYS.has(k)) extra[k] = proj[k];
  }

  const doc: EditorDocument = {
    order,
    strands,
    groups: loadGroups(proj.groups, strands),
    selected_strand_name: proj.selected_strand_name ?? null,
    locked_layers: lockedNamesFromFile(proj.locked_layers, order),
    lock_mode: !!proj.lock_mode,
    shadow_enabled: proj.shadow_enabled ?? true,
    show_control_points: !!proj.show_control_points,
    shadow_overrides: proj.shadow_overrides ?? {},
    strand_colors: {},
    extra,
  };
  doc.strand_colors = canonicalSetColors(doc, proj.strand_colors);
  return doc;
}

// The desktop's fourth pass. `attached_strands` of a strand are the
// AttachedStrands whose parent it is; a child "is at" an end when its start
// coincides with that end AND its attachment_side names that end.
function validateHasCircles(strands: Record<string, StrandRecord>, order: string[]): void {
  const children = new Map<string, StrandRecord[]>();
  for (const name of order) {
    const s = strands[name];
    if (s.type !== 'AttachedStrand' || !s.attached_to) continue;
    const arr = children.get(s.attached_to);
    if (arr) arr.push(s); else children.set(s.attached_to, [s]);
  }
  for (const name of order) {
    const s = strands[name];
    if (s.type === 'MaskedStrand') { s.has_circles = [false, false]; continue; }
    const kids = children.get(name) ?? [];
    const mcvRaw = s.extra?.manual_circle_visibility;
    const mcv: [boolean | null, boolean | null] = Array.isArray(mcvRaw)
      ? [mcvRaw[0] == null ? null : !!mcvRaw[0], mcvRaw[1] == null ? null : !!mcvRaw[1]]
      : [null, null];
    const endHas = kids.some((c) => samePoint(c.start, s.end) && (c.attachment_side ?? 0) === 1);
    if (s.type === 'AttachedStrand') {
      s.has_circles = [mcv[0] == null ? true : mcv[0], mcv[1] == null ? endHas : mcv[1]];
    } else {
      const startHas = kids.some((c) => samePoint(c.start, s.start) && (c.attachment_side ?? 0) === 0);
      s.has_circles = [mcv[0] == null ? startHas : mcv[0], mcv[1] == null ? endHas : mcv[1]];
    }
  }
}

// apply_loaded_strands (:1317-1358): a group is kept only when at least one of
// its `strands` still exists; its layers list is taken verbatim, its main
// strands filtered to existing names, its control points deserialized.
function loadGroups(raw: unknown, strands: Record<string, StrandRecord>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, info] of Object.entries(raw as Record<string, any>)) {
    if (!info || typeof info !== 'object') continue;
    // `strands` is what OSS indexes; `layers`, then `main_strands`, cover files
    // an older build of this editor wrote (it stored only the main strands).
    const stored = Array.isArray(info.strands) ? info.strands
      : Array.isArray(info.layers) ? info.layers
        : Array.isArray(info.main_strands) ? info.main_strands : [];
    const members = stored.filter((n: unknown): n is string => typeof n === 'string' && !!strands[n]);
    if (!members.length) continue;
    const main_strands = (Array.isArray(info.main_strands) ? info.main_strands : [])
      .filter((n: unknown): n is string => typeof n === 'string' && !!strands[n]);
    const control_points: Record<string, unknown> = {};
    for (const [layer, points] of Object.entries((info.control_points ?? {}) as Record<string, any>)) {
      if (!points || typeof points !== 'object') continue;
      control_points[layer] = {
        control_point1: points.control_point1 ? asPoint(points.control_point1, { x: 0, y: 0 }) : null,
        control_point2: points.control_point2 ? asPoint(points.control_point2, { x: 0, y: 0 }) : null,
        control_point_center: points.control_point_center ? asPoint(points.control_point_center, { x: 0, y: 0 }) : null,
        control_point_center_locked: !!points.control_point_center_locked,
      };
    }
    out[name] = {
      layers: Array.isArray(info.layers) ? [...info.layers] : [...members],
      strands: members,
      main_strands,
      control_points,
    };
  }
  return out;
}

// ---- set colors: canvas.strand_colors ---------------------------------------
//
// serialize_project_state (:314-360) and _restore_canonical_set_colors
// (:1162-1199) both build the same map: every ACTIVE set (one that still has a
// non-masked strand) keeps its recorded color, and any active set without one
// takes the color of its main (_1) strand, else of its first strand.
function canonicalSetColors(doc: EditorDocument, source: unknown): Record<string, RGBA> {
  const regular = doc.order.map((n) => doc.strands[n]).filter((s) => s && s.type !== 'MaskedStrand');
  const active = new Set<number>(regular.map((s) => s.set_number).filter((n) => typeof n === 'number'));
  const out: Record<string, RGBA> = {};
  if (source && typeof source === 'object') {
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
      const n = Number.parseInt(k, 10);
      if (!Number.isFinite(n) || !active.has(n)) continue;
      if (!(String(n) in out)) out[String(n)] = color(v);
    }
  }
  // Stable sort: main (_1) strands first, then everything else in z-order.
  const sorted = regular.map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.layer_name.endsWith('_1') ? 0 : 1) - (b.s.layer_name.endsWith('_1') ? 0 : 1) || a.i - b.i)
    .map((x) => x.s);
  for (const s of sorted) {
    const key = String(s.set_number);
    if (!(key in out)) out[key] = color(s.color);
  }
  return out;
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
  return out.sort((a, b) => a - b);   // list(set_of_ints) iterates ascending
}

// ---- groups: the desktop needs the resolved membership, not just main_strands --
//
// serialize_groups writes exactly {layers, main_strands, strands, control_points}
// and the loader indexes `group_info["strands"]` / `["layers"]` DIRECTLY
// (save_load_manager.py:1320, :1350). A group written with only `main_strands`
// therefore raised KeyError inside apply_loaded_strands — swallowed by
// main_window.py:1684 `except Exception: pass` AFTER canvas.strands had already
// been assigned, so the file appeared to load while groups, the button states,
// the lock restore and the undo baseline were all silently skipped.
//
// Resolving on save (instead of trusting whatever was loaded) also keeps the
// membership fresh: the editor only maintains `main_strands` through renames and
// deletions, so a passed-through `strands` list goes stale. OSS re-resolves from
// main_strands for its own operations anyway (group_layers.py resolve_group_data,
// which is what get_group_data feeds the serializer).
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

  // Only entries with a control point (masks have none) — serialize_groups:1426.
  const control_points: Record<string, unknown> = {};
  for (const n of layers) {
    const st = doc.strands[n];
    if (!st || st.type === 'MaskedStrand') continue;
    control_points[n] = {
      control_point1: pt(st.control_points[0]),
      control_point2: pt(st.control_points[1]),
      control_point_center: pt(st.control_point_center),
      control_point_center_locked: !!st.control_point_center_locked,
    };
  }

  return {
    layers,
    main_strands: (rec?.main_strands ?? []).filter((n) => !!doc.strands[n]),
    strands: layers,
    control_points,
  };
}

// ---- save: one strand (serialize_strand) -----------------------------------

// MaskedStrand.__getattr__ (masked_strand.py:1061-1073) answers for any
// attribute the mask itself lacks with the FIRST component's, then the SECOND's.
// serialize_strand's getattr/hasattr lookups therefore see a component's value
// for the few attributes Strand.__init__ does not create and the mask loader does
// not restore: width_in_grid_units, closed_connections (a mask created in the
// session — a loaded one owns the value), and manual_circle_visibility.
function maskDelegated(s: StrandRecord, doc: EditorDocument | undefined, key: string): unknown {
  const own = (s.extra ?? {})[key];
  if (own !== undefined && own !== null) return own;
  if (!doc) return undefined;
  const comp = maskComponents(s.layer_name);
  if (!comp) return undefined;
  for (const name of [comp.first, comp.second]) {
    const v = doc.strands[name]?.extra?.[key];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function maskFirstStart(s: StrandRecord, doc: EditorDocument | undefined): Point | null {
  const comp = maskComponents(s.layer_name);
  const first = comp && doc ? doc.strands[comp.first] : undefined;
  return first ? first.start : null;
}

function serializeStrand(
  s: StrandRecord, index: number, opts?: SaveLoadOptions, doc?: EditorDocument,
): Record<string, unknown> {
  const ex: Record<string, unknown> = { ...(s.extra ?? {}) };
  const masked = s.type === 'MaskedStrand';
  const attached = s.type === 'AttachedStrand';
  if (masked) {
    for (const k of ['width_in_grid_units', 'closed_connections', 'manual_circle_visibility']) {
      const v = maskDelegated(s, doc, k);
      if (v !== undefined) ex[k] = v; else delete ex[k];
    }
  }
  const out: Record<string, unknown> = {};

  out.type = s.type;
  out.index = index;
  out.start = pt(s.start);
  out.end = pt(s.end);
  out.width = s.width;
  out.color = color(s.color);
  out.stroke_color = color(s.stroke_color);
  out.stroke_width = s.stroke_width;
  out.width_in_grid_units = ex.width_in_grid_units ?? null;
  out.elliptical_end_caps = masked ? false : ex.elliptical_end_caps ?? false;
  out.has_circles = masked ? [false, false] : [!!s.has_circles[0], !!s.has_circles[1]];
  out.layer_name = s.layer_name;
  out.set_number = s.set_number;
  out.is_first_strand = false;   // getattr(strand, 'is_first_strand', False): never set by OSS
  out.is_start_side = ex.is_start_side ?? true;
  out.start_line_visible = ex.start_line_visible ?? true;
  out.end_line_visible = ex.end_line_visible ?? true;
  out.is_hidden = !!s.is_hidden;
  out.start_extension_visible = ex.start_extension_visible ?? false;
  out.end_extension_visible = ex.end_extension_visible ?? false;
  out.start_arrow_visible = ex.start_arrow_visible ?? false;
  out.end_arrow_visible = ex.end_arrow_visible ?? false;
  out.full_arrow_visible = ex.full_arrow_visible ?? false;
  out.shadow_only = !!s.shadow_only;
  out.hide_shadow = !!s.hide_shadow;
  out.closed_connections = Array.isArray(ex.closed_connections)
    ? [!!ex.closed_connections[0], !!ex.closed_connections[1]] : [false, false];
  out.arrow_color = colorOrNull(ex.arrow_color);
  out.arrow_transparency = ex.arrow_transparency ?? 100;
  out.arrow_texture = ex.arrow_texture ?? 'none';
  out.arrow_shaft_style = ex.arrow_shaft_style ?? 'solid';
  out.arrow_head_visible = ex.arrow_head_visible ?? true;
  out.arrow_casts_shadow = ex.arrow_casts_shadow ?? false;
  out.knot_connections = serializeKnots(s);
  // circle_stroke_color is a compatibility getter that returns the START color,
  // and each per-end getter falls back to the general one, then black
  // (strand.py:497-552). A mask restores none of them, so it writes black.
  const general = masked ? null : s.circle_stroke_color;
  const startC = masked ? BLACK : color(ex.start_circle_stroke_color ?? general);
  const endC = masked ? BLACK : color(ex.end_circle_stroke_color ?? general);
  out.circle_stroke_color = { ...startC };
  out.start_circle_stroke_color = { ...startC };
  out.end_circle_stroke_color = { ...endC };

  if (attached) {
    out.attached_to = s.attached_to ?? null;
    out.attachment_side = s.attachment_side ?? 0;
    // AttachedStrand.angle / .length describe the current geometry
    // (update_angle_length_from_geometry); the saved pair is kept when it still
    // does, so an untouched file round-trips bit-for-bit.
    // AttachedStrand.angle / .length are plain attributes: 0 at construction,
    // restored as saved (restore_attached_strand_geometry_state), derived from
    // the geometry only when a file has none. They do not follow a drag.
    const dx = s.end.x - s.start.x, dy = s.end.y - s.start.y;
    out.angle = typeof ex.angle === 'number' ? ex.angle : (Math.atan2(dy, dx) * 180) / Math.PI;
    out.length = typeof ex.length === 'number' ? ex.length : Math.hypot(dx, dy);
  }

  // MaskedStrands have no control points; the desktop writes [null, null].
  out.control_points = masked ? [null, null] : [pt(s.control_points[0]), pt(s.control_points[1])];
  // A mask writes its edited centre (the region centroid, recomputed whenever
  // a component is edited — base when nothing is erased). A mask untouched
  // since it was LOADED writes the FIRST component's start instead: the file's
  // centre is copied into base/edited (:963-966), but apply_loaded_strands then
  // runs force_complete_update with skip_center_recalculation still set
  // (:1290-1292), which overwrites both with the Strand-level
  // control_point_center — Strand.__init__ set that to the first component's
  // start and MaskedStrand.update_shape never recomputes it.
  out.control_point_center = masked
    ? pt(s.edited_center_point ?? s.base_center_point ?? maskFirstStart(s, doc) ?? s.control_point_center)
    : pt(s.control_point_center);
  out.control_point_center_locked = masked ? false : !!s.control_point_center_locked;
  // Every strand on a canvas owns a bias control (strand.py:423-430 creates one
  // whenever the canvas is assigned), so `bias_control` is always written. With
  // the setting off it holds the neutral defaults with no positions — the loader
  // dropped whatever was saved (deserialize_strand:624-626) and the canvas
  // recreated it blank; a mask never gets past those defaults either.
  const biasOff = opts?.enable_curvature_bias_control === false;
  out.bias_control = (masked || biasOff)
    ? { triangle_bias: NEUTRAL_BIAS, circle_bias: NEUTRAL_BIAS, triangle_position: null, circle_position: null }
    : serializedBias(s);
  out.triangle_has_moved = masked ? false : !!s.triangle_has_moved;
  out.control_point2_shown = masked ? false : !!s.control_point2_shown;
  out.control_point2_activated = masked ? false : !!s.control_point2_activated;

  if (masked) {
    out.deletion_rectangles = s.deletion_rectangles ?? [];
  }

  // Written only `if hasattr(strand, 'manual_circle_visibility')`: the attribute
  // exists once a layer-menu choice (or a load that carried it) set it.
  if (Array.isArray(ex.manual_circle_visibility)) {
    out.manual_circle_visibility = [ex.manual_circle_visibility[0] ?? null, ex.manual_circle_visibility[1] ?? null];
  }

  // serialize_strand builds an explicit dict: a key it does not know (a
  // fixture's is_selected, a foreign writer's field) is not written. Such keys
  // stay in `extra` for the session but never reach the file — as in OSS.
  return out;
}

function serializeKnots(s: StrandRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [endKey, info] of Object.entries(s.knot_connections ?? {})) {
    if (!info || !info.connected_strand_name) continue;
    out[endKey] = {
      connected_strand_name: info.connected_strand_name,
      connected_end: info.connected_end,
      is_closing_strand: info.is_closing_strand ?? false,
    };
  }
  return out;
}

// ---- save: whole project (serialize_project_state) -------------------------

export function serializeProject(doc: EditorDocument, opts?: SaveLoadOptions): Record<string, unknown> {
  const groups: Record<string, unknown> = {};
  for (const name of Object.keys(doc.groups ?? {})) groups[name] = serializeGroup(doc, name);

  const out: Record<string, unknown> = {
    strands: doc.order.map((name, i) => doc.strands[name] && serializeStrand(doc.strands[name], i, opts, doc)).filter(Boolean),
    groups,
    strand_colors: canonicalSetColors(doc, doc.strand_colors ?? {}),
    selected_strand_name: doc.selected_strand_name ?? null,
    locked_layers: lockedIndicesForFile(doc),
    lock_mode: !!doc.lock_mode,
    shadow_enabled: doc.shadow_enabled ?? true,
    show_control_points: !!doc.show_control_points,
    shadow_overrides: doc.shadow_overrides ?? {},
  };
  // serialize_project_state writes exactly these nine keys; anything else a
  // file carried (doc.extra) stays in memory and is not written, as in OSS.
  return out;
}

// ---- history wrapper (export_history / import_history_payload) --------------

export interface HistoryState { doc: EditorDocument; meta: HistoryMeta | null }

export interface LoadedProject {
  doc: EditorDocument;
  past: HistoryState[];
  future: HistoryState[];
  presentMeta: HistoryMeta | null;
}

// The file save_project writes: every undo step in order, each one a full
// project state carrying its `undo_metadata`, plus the step counters. `past`
// (oldest first), the present document, and `future` (a redo STACK — its last
// entry is the next redo) become steps 1..max_step. A leading empty document is
// the state before anything was drawn, which OSS never records (save_state
// refuses an empty canvas), so it is left out.
export function serializeHistory(
  past: HistoryState[],
  present: HistoryState,
  future: HistoryState[],
  opts?: SaveLoadOptions,
): Record<string, unknown> {
  const ordered: HistoryState[] = [...past, present, ...[...future].reverse()];
  let currentIndex = past.length;
  while (ordered.length && ordered[0] !== present && isEmptyDoc(ordered[0].doc)) {
    ordered.shift();
    currentIndex -= 1;
  }
  if (ordered.length === 1 && isEmptyDoc(present.doc)) {
    ordered.length = 0;
    currentIndex = -1;
  }
  const states = ordered.map((entry, i) => {
    const data = serializeProject(entry.doc, opts);
    const meta = metaToOss(entry.meta);
    if (meta) data[UNDO_METADATA_KEY] = meta;
    return { step: i + 1, data };
  });
  return {
    type: 'OpenStrandStudioHistory',
    version: 1,
    current_step: currentIndex + 1,
    max_step: states.length,
    states,
  };
}

// Load a project file the way main_window.load_project does: a history wrapper
// restores the whole undo/redo stack around its current step; a bare project
// state becomes a document with no history (the snapshot path clears it).
export function loadProjectFile(data: unknown, opts?: SaveLoadOptions): LoadedProject {
  const d = data as any;
  if (d && d.type === 'OpenStrandStudioHistory') {
    const states = sortedStates(d);
    if (states.length) {
      const cur = currentStepIndex(d, states);
      const loaded = states.map((s) => ({
        doc: loadProjectState(s.data && typeof s.data === 'object' ? s.data : {}, opts),
        meta: metaFromOss(s.data?.[UNDO_METADATA_KEY]),
      }));
      return {
        doc: loaded[cur].doc,
        past: loaded.slice(0, cur),
        future: loaded.slice(cur + 1).reverse(),
        presentMeta: loaded[cur].meta,
      };
    }
  }
  const proj = unwrapProject(d) ?? {};
  return {
    doc: loadProjectState(proj, opts),
    past: [],
    future: [],
    presentMeta: metaFromOss(proj?.[UNDO_METADATA_KEY]),
  };
}

// Dev-only debug handle for round-trip testing.
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__io = {
    loadProject, loadProjectFile, serializeProject, serializeHistory, unwrapProject,
  };
}
