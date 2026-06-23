// Core editable state model for the OpenStrandJS editor.
//
// Design note (fidelity-first): the desktop app's save_load_manager serializes
// ~40 fields per strand. The editor only actively edits a subset, but must
// round-trip the file byte-faithfully so saves re-open in `python main.py`.
// So every strand carries an `extra` passthrough bag holding any serialized
// keys we don't model explicitly (arrow_*, width_in_grid_units, angle/length,
// bias_control, start/end_circle_stroke_color, ...). On save we spread `extra`
// first, then write the typed fields over it. New strands start with the
// authentic defaults the Python constructors use.

export interface Point { x: number; y: number; }
export interface RGBA { r: number; g: number; b: number; a: number; } // 0..255

export type StrandType = 'Strand' | 'AttachedStrand' | 'MaskedStrand';
export type LayerName = string;            // "1_2"  (masked: "1_2_3_1")
export type EndKey = 'start' | 'end';

// A connection saved by name (never object refs — matches the Python JSON).
export interface KnotConnection {
  connected_strand_name: LayerName;
  connected_end: EndKey;
  is_closing_strand?: boolean;
}

// Desktop writes corner arrays; renderer also accepts {x,y,width,height}.
export interface DeletionRect {
  top_left?: [number, number];
  top_right?: [number, number];
  bottom_left?: [number, number];
  bottom_right?: [number, number];
  x?: number; y?: number; width?: number; height?: number;
}

// One strand record. Flat and JSON-serializable (no object cross-references),
// so document snapshots are trivially cloneable for undo/redo later.
export interface StrandRecord {
  type: StrandType;
  layer_name: LayerName;
  set_number: number;

  start: Point;
  end: Point;
  control_points: [Point, Point];        // [cp1, cp2]
  control_point_center: Point | null;
  control_point_center_locked: boolean;

  width: number;
  stroke_width: number;
  color: RGBA;
  stroke_color: RGBA;

  has_circles: [boolean, boolean];
  is_hidden: boolean;
  shadow_only: boolean;

  circle_stroke_color: RGBA | null;
  knot_connections: Record<string, KnotConnection>;

  // AttachedStrand only
  attached_to?: LayerName | null;
  attachment_side?: 0 | 1;

  // MaskedStrand only
  deletion_rectangles?: DeletionRect[];
  using_absolute_coords?: boolean;

  // visibility / control-point state flags carried through save/load
  triangle_has_moved?: boolean;
  control_point2_shown?: boolean;
  control_point2_activated?: boolean;

  // every other serialized key we don't model — preserved verbatim
  extra: Record<string, unknown>;
}

// A group record: arbitrary membership of (non-masked) layer_names that move /
// rotate / shadow-toggle together. Serialization-safe (plain string[]); stored
// under doc.groups[name] but the field type stays Record<string,unknown> so the
// save/load round-trip is permissive — actions cast to GroupRecord internally.
export interface GroupRecord { main_strands: string[]; }

// One document == one tab == one undo snapshot.
export interface EditorDocument {
  order: LayerName[];                        // draw order == z-order (last = topmost)
  strands: Record<LayerName, StrandRecord>;  // keyed by layer_name
  groups: Record<string, unknown>;           // GroupRecord values (cast in actions)
  selected_strand_name: LayerName | null;
  locked_layers: LayerName[];
  lock_mode: boolean;
  shadow_enabled: boolean;
  show_control_points: boolean;
  shadow_overrides: ShadowOverrides;
}

// Per-pair shadow tuning, OSS-faithful (layer_state_manager.py shadow_overrides):
// nested dict keyed by layer NAME, casting_layer -> receiving_layer -> override.
// casting_layer = the strand ABOVE that casts; receiving_layer = a strand BELOW
// (lower z) the shadow lands on. All three sub-keys are OPTIONAL; absent keys use
// defaults (visibility default true; allow_full_shadow default false;
// subtracted_layers default []).
export interface ShadowOverride {
  visibility?: boolean;            // false => skip this (casting->receiving) shadow pair
  allow_full_shadow?: boolean;     // true => shadow ignores mask/intermediate subtraction
  subtracted_layers?: string[];    // layer names whose body is cut out of this shadow
}
export type ShadowOverrides = Record<string, Record<string, ShadowOverride>>;

// Interaction modes. select/move/attach/mask are fully implemented; view is a
// read-only inspect mode; rotate/angle are registered stubs (toolbar parity with
// OSS, wired to passive modes until their gestures land).
export type ModeName = 'select' | 'move' | 'attach' | 'mask' | 'view' | 'rotate' | 'angle';

export type HandleKind =
  | 'start' | 'end'
  | 'control_point1' | 'control_point2' | 'control_point_center';

export interface Selection {
  layerName: LayerName | null;
  handle: HandleKind | null;
}

export interface ViewState {
  zoom: number;          // Phase 1 pinned to 1.0
  panX: number;          // world->screen translation (CSS px)
  panY: number;
  width: number;         // canvas client size (CSS px)
  height: number;
  supersample: number;   // offscreen render multiplier (quality)
}

export type Theme = 'default' | 'light' | 'dark';
export type Language = 'en' | 'fr' | 'de' | 'it' | 'es' | 'pt' | 'he';

export interface Settings {
  curve_params: { base_fraction: number; dist_multiplier: number; exponent: number };
  grid_size: number;
  show_grid: boolean;
  snap_to_grid_enabled: boolean;
  default_strand_color: RGBA;
  default_stroke_color: RGBA;
  default_strand_width: number;
  default_stroke_width: number;
  theme: Theme;
  language: Language;
}

// What the renderer (window.renderFixture) consumes.
export interface RenderStrand {
  type: StrandType;
  layer_name: string;
  start: Point;
  end: Point;
  width: number;
  stroke_width: number;
  color: RGBA;
  stroke_color: RGBA;
  has_circles: [boolean, boolean];
  control_points: [Point, Point];
  control_point_center: Point | null;
  control_point_center_locked: boolean;
  deletion_rectangles?: DeletionRect[];
  // Cap / side-line inputs the renderer reads (flat-end side lines, closed-knot
  // caps, folded/unfolded state, has_circles recompute).
  start_line_visible?: boolean;
  end_line_visible?: boolean;
  closed_connections?: [boolean, boolean];
  manual_circle_visibility?: [boolean | null, boolean | null];
  circle_stroke_color?: RGBA | null;
  start_circle_stroke_color?: RGBA | null;
  end_circle_stroke_color?: RGBA | null;
  is_setting_staring_circle?: boolean;
  is_selected?: boolean;          // draws the unified selection highlight (under the body)
  // OSS shadow_only: suppress this strand's own body/extension drawing but keep
  // its shadow contribution (it still casts onto lower strands). Absent/false ==
  // normal full body. Opt-in / absent-safe so the fidelity oracle is unchanged.
  shadow_only?: boolean;
}

export interface RenderMeta {
  image_width: number;
  image_height: number;
  x_offset: number;
  y_offset: number;
  supersample: number;
  zoom?: number;            // content scale; absent/1 == pre-zoom behavior
  shadow_enabled: boolean;
  // OSS per-pair shadow visibility (casting -> receiving -> {visibility}). The
  // renderer reads ONLY the `visibility` sub-key today (false => skip that pair);
  // allow_full_shadow/subtracted_layers are carried for forward-compat but not yet
  // consumed by the geometry. Absent == every pair visible (current behavior), so
  // the fidelity oracle (which never sets it) is byte-identical.
  shadow_overrides?: Record<string, Record<string, { visibility?: boolean }>>;
  curve_params: { base_fraction: number; dist_multiplier: number; exponent: number };
  // Interactive drag fast-path ONLY (the fidelity harness never sets this). The
  // layer_names whose geometry moves with the dragged endpoint: renderDragBackground
  // bakes everything EXCEPT these once, and renderDragFrame draws only these over
  // the bake each frame. Absent => normal full render.
  drag?: { moving: string[] };
  // LIVE EDITOR ONLY (the offline oracle never sets this). When true, the ss×
  // supersampled offscreen is downscaled with the browser's native high-quality
  // filter (a fast GPU blit) instead of the exact-but-slow JS box-average loop the
  // oracle uses to byte-match Qt. Keeps full supersampled quality; ~5× faster
  // full render. Absent => exact box-average (byte-identical fidelity path).
  fast_downscale?: boolean;
}
