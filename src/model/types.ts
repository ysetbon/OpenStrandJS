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

// One document == one tab == one undo snapshot.
export interface EditorDocument {
  order: LayerName[];                        // draw order == z-order (last = topmost)
  strands: Record<LayerName, StrandRecord>;  // keyed by layer_name
  groups: Record<string, unknown>;           // passthrough in Phase 1
  selected_strand_name: LayerName | null;
  locked_layers: LayerName[];
  lock_mode: boolean;
  shadow_enabled: boolean;
  show_control_points: boolean;
  shadow_overrides: Record<string, unknown>;
}

export type ModeName = 'select' | 'move' | 'attach' | 'mask';

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

export interface Settings {
  curve_params: { base_fraction: number; dist_multiplier: number; exponent: number };
  grid_size: number;
  show_grid: boolean;
  snap_to_grid_enabled: boolean;
  default_strand_color: RGBA;
  default_stroke_color: RGBA;
  default_strand_width: number;
  default_stroke_width: number;
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
}

export interface RenderMeta {
  image_width: number;
  image_height: number;
  x_offset: number;
  y_offset: number;
  supersample: number;
  zoom?: number;            // content scale; absent/1 == pre-zoom behavior
  shadow_enabled: boolean;
  curve_params: { base_fraction: number; dist_multiplier: number; exponent: number };
}
