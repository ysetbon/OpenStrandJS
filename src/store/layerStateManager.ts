// LayerStateManager — a port of OpenStrand Studio's layer_state_manager.py.
//
// OSS keeps a `layer_state` dict on a QObject that it rebuilds from the canvas
// on every strand created / deleted / masked / moved (save_current_state), and
// the main window's "State" button prints that dict. The document IS the canvas
// here, so the same dict is derived from it on demand; the two runtime-only
// values OSS reads off the canvas (newest_strand, the selection) come from the
// store. Field names, formats and defaults are the desktop's:
//
//   order          every layer_name in z-order (dict.fromkeys dedup)
//   connections    {layer: [start, end]} with 'name(0|1)' or 'null' per end —
//                  the directed, single-slot table get_layer_connections builds
//                  (parent slot set, first child claim wins, knot overwrites);
//                  MaskedStrands never appear
//   masked_layers  the MaskedStrand layer names
//   colors         {layer: '#aarrggbb'}       (QColor.name(QColor.HexArgb))
//   stroke_colors  {layer: '#aarrggbb'}
//   set_colors     {'set': '#aarrggbb'} for every set that still has a strand
//   positions      {layer: (sx, sy, ex, ey)}
//   selected_strand / newest_strand / newest_layer   layer names or None
//   shadow_overrides                                the document's dict
//
// The shadow-override helpers at the bottom are the same module's
// get_default_shadow_visibility / get_shadow_visibility / get_subtracted_layers
// family: a mask never casts a regular shadow onto its own FIRST component by
// default, and onto its SECOND component it subtracts the first.

import type { EditorDocument, EndKey, RGBA, ShadowOverride, ShadowOverrides } from '../model/types';
import { buildConnTable, connectionSlot } from '../interaction/connections';
import { maskComponents } from '../model/layerName';

export type ConnectionPair = [string, string];

export interface LayerState {
  order: string[];
  connections: Record<string, ConnectionPair>;
  masked_layers: string[];
  colors: Record<string, string>;
  stroke_colors: Record<string, string>;
  set_colors: Record<string, string>;
  positions: Record<string, [number, number, number, number]>;
  selected_strand: string | null;
  newest_strand: string | null;
  newest_layer: string | null;
  shadow_overrides: ShadowOverrides;
}

// What OSS reads off the canvas rather than the strands.
export interface CanvasRuntime {
  newestStrand?: string | null;
  selectedStrand?: string | null;
}

// QColor.name(QColor.HexArgb): '#aarrggbb', lowercase.
export function hexArgb(c: RGBA): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(c.a ?? 255)}${h(c.r)}${h(c.g)}${h(c.b)}`;
}

// get_layer_connections: the directed endpoint table, formatted as
// 'neighbor(point)' / 'null' per end. Built by connections.ts, which is the
// same single-slot, first-claim-wins, knot-overwrites table move mode walks.
export function getLayerConnections(doc: EditorDocument): Record<string, ConnectionPair> {
  const table = buildConnTable(doc);
  const fmt = (layer: string, end: EndKey): string => {
    const slot = connectionSlot(table, layer, end);
    return slot ? `${slot.name}(${slot.point})` : 'null';
  };
  const out: Record<string, ConnectionPair> = {};
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s || s.type === 'MaskedStrand') continue;
    out[name] = [fmt(name, 'start'), fmt(name, 'end')];
  }
  return out;
}

// save_current_state: rebuild the whole dict from the canvas.
export function computeLayerState(doc: EditorDocument, runtime: CanvasRuntime = {}): LayerState {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const n of doc.order) if (doc.strands[n] && !seen.has(n)) { seen.add(n); order.push(n); }

  const colors: Record<string, string> = {};
  const stroke_colors: Record<string, string> = {};
  const positions: Record<string, [number, number, number, number]> = {};
  const masked_layers: string[] = [];
  const activeSets = new Set<string>();
  for (const n of order) {
    const s = doc.strands[n];
    colors[n] = hexArgb(s.color);
    stroke_colors[n] = hexArgb(s.stroke_color);
    positions[n] = [s.start.x, s.start.y, s.end.x, s.end.y];
    if (s.type === 'MaskedStrand') masked_layers.push(n);
    else activeSets.add(String(s.set_number));
  }

  const set_colors: Record<string, string> = {};
  for (const [set, c] of Object.entries(doc.strand_colors ?? {})) {
    if (activeSets.has(set)) set_colors[set] = hexArgb(c);
  }

  const selected = runtime.selectedStrand !== undefined ? runtime.selectedStrand : doc.selected_strand_name;
  const newest = runtime.newestStrand ?? null;
  return {
    order,
    connections: getLayerConnections(doc),
    masked_layers,
    colors,
    stroke_colors,
    set_colors,
    positions,
    selected_strand: selected && doc.strands[selected] ? selected : null,
    // canvas.newest_strand is dropped when that strand is deleted (:5481).
    newest_strand: newest && doc.strands[newest] ? newest : null,
    newest_layer: order.length ? order[order.length - 1] : null,
    shadow_overrides: doc.shadow_overrides ?? {},
  };
}

// getDetailedConnections: {layer: {start, end, attached}} with 'null' -> None.
export function getDetailedConnections(doc: EditorDocument): Record<string, { start: string | null; end: string | null; attached: string[] }> {
  const out: Record<string, { start: string | null; end: string | null; attached: string[] }> = {};
  for (const [name, [start, end]] of Object.entries(getLayerConnections(doc))) {
    out[name] = { start: start === 'null' ? null : start, end: end === 'null' ? null : end, attached: [] };
  }
  return out;
}

// ---- shadow overrides ----------------------------------------------------

export function getShadowOverrides(doc: EditorDocument): ShadowOverrides {
  return doc.shadow_overrides ?? {};
}

export function getShadowOverride(doc: EditorDocument, casting: string, receiving: string): ShadowOverride | undefined {
  return doc.shadow_overrides?.[casting]?.[receiving];
}

// get_default_shadow_visibility: a mask does not cast a regular, editable shadow
// onto its own first/source strand unless the user explicitly enables it.
export function getDefaultShadowVisibility(doc: EditorDocument, casting: string, receiving: string): boolean {
  const caster = doc.strands[casting];
  if (caster && caster.type === 'MaskedStrand') {
    const comp = maskComponents(casting);
    if (comp && receiving === comp.first) return false;
  }
  return true;
}

// get_default_subtracted_layers: for a masked caster, the second-component
// receiver defaults to subtracting the first component's path.
export function getDefaultSubtractedLayers(doc: EditorDocument, casting: string, receiving: string): string[] {
  const caster = doc.strands[casting];
  if (caster && caster.type === 'MaskedStrand') {
    const comp = maskComponents(casting);
    if (comp && receiving === comp.second && comp.first) return [comp.first];
  }
  return [];
}

// get_shadow_visibility: the override's `visibility` when it has one, else the default.
export function getShadowVisibility(doc: EditorDocument, casting: string, receiving: string): boolean {
  const ov = getShadowOverride(doc, casting, receiving);
  if (ov && ov.visibility !== undefined) return ov.visibility;
  return getDefaultShadowVisibility(doc, casting, receiving);
}

// get_subtracted_layers: the override's list when it has one, else the default.
export function getSubtractedLayers(doc: EditorDocument, casting: string, receiving: string): string[] {
  const ov = getShadowOverride(doc, casting, receiving);
  if (ov && 'subtracted_layers' in ov) return ov.subtracted_layers ?? [];
  return getDefaultSubtractedLayers(doc, casting, receiving);
}

// ---- the State dialog text ------------------------------------------------
//
// main_window.show_layer_state_log formats the dict with Python f-strings, so
// lists, dicts, tuples and None print as Python literals. These helpers write
// exactly those literals.

function pyStr(s: string): string {
  // repr(str): single quotes unless the string holds a single quote and no double.
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out + q;
}

// repr(float): shortest round-trip digits, '.0' on integral values, exponent
// notation outside [1e-4, 1e16) written like Python ('1e-05', '1e+16').
export function pyFloat(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf';
  const a = Math.abs(n);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) {
    const [m, e] = n.toExponential().split('e');
    const sign = e.startsWith('-') ? '-' : '+';
    const digits = e.replace(/^[-+]/, '').padStart(2, '0');
    return `${m}e${sign}${digits}`;
  }
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

function pyValue(v: unknown, floats = false): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return floats ? pyFloat(v) : (Number.isInteger(v) ? String(v) : pyFloat(v));
  if (typeof v === 'string') return pyStr(v);
  if (Array.isArray(v)) return `[${v.map((x) => pyValue(x, floats)).join(', ')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyStr(k)}: ${pyValue(x, floats)}`).join(', ')}}`;
  }
  return String(v);
}

function pyTuple(t: number[]): string {
  return `(${t.map(pyFloat).join(', ')})`;
}

// f"{value}" of a str is the bare text; of None it is 'None'.
const bare = (v: string | null): string => (v == null ? 'None' : v);

export interface LayerStateLabels {
  current_layer_state: string;
  order: string;
  connections: string;
  masked_layers: string;
  colors: string;
  positions: string;
  selected_strand: string;
  newest_strand: string;
  newest_layer: string;
}

// The exact QTextEdit contents of the "State" dialog (main_window.py:1849-1875).
export function formatLayerStateLog(state: LayerState, L: LayerStateLabels): string {
  const positions = `{${Object.entries(state.positions).map(([k, t]) => `${pyStr(k)}: ${pyTuple(t)}`).join(', ')}}`;
  return `
${L.current_layer_state}:

${L.order}:
${pyValue(state.order)}

${L.connections}:
${pyValue(state.connections)}

${L.masked_layers}:
${pyValue(state.masked_layers)}

${L.colors}:
${pyValue(state.colors)}

${L.positions}:
${positions}

${L.selected_strand}:
${bare(state.selected_strand)}

${L.newest_strand}:
${bare(state.newest_strand)}

${L.newest_layer}:
${bare(state.newest_layer)}
`;
}

// ---- the manager object -----------------------------------------------------
//
// The same surface OSS exposes (getOrder, getConnections, ...), for callers that
// prefer the desktop's API over the plain dict. `saveCurrentState` is the
// rebuild; every getter reads the last rebuilt state.
export class LayerStateManager {
  layerState: LayerState = computeLayerState({
    order: [], strands: {}, groups: {}, selected_strand_name: null, locked_layers: [], lock_mode: false,
    shadow_enabled: true, show_control_points: false, shadow_overrides: {}, strand_colors: {}, extra: {},
  });

  saveCurrentState(doc: EditorDocument, runtime: CanvasRuntime = {}): LayerState {
    this.layerState = computeLayerState(doc, runtime);
    return this.layerState;
  }

  getOrder(): string[] { return this.layerState.order; }
  getConnections(): Record<string, ConnectionPair> { return this.layerState.connections; }
  getMaskedLayers(): string[] { return this.layerState.masked_layers; }
  getColors(): Record<string, string> { return this.layerState.colors; }
  getPositions(): Record<string, [number, number, number, number]> { return this.layerState.positions; }
  getSelectedStrand(): string | null { return this.layerState.selected_strand; }
  getNewestStrand(): string | null { return this.layerState.newest_strand; }
  getNewestLayer(): string | null { return this.layerState.newest_layer; }
  getShadowOverrides(): ShadowOverrides { return this.layerState.shadow_overrides; }
}

if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__layerState = {
    computeLayerState, getLayerConnections, formatLayerStateLog, hexArgb, pyFloat,
  };
}
