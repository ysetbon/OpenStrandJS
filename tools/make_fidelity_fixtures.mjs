// Author purpose-built fidelity TEST-CASE fixtures from scratch (not derived from
// existing OpenStrandStudio save files). Each is a small, readable scene designed
// to exercise ONE rendering behavior; CI renders it with both the Qt oracle and
// the JS renderer and diffs them. This is the pattern: when a renderer change
// lands, Claude Code writes the JSON that proves it.
//
// Usage: node tools/make_fidelity_fixtures.mjs   (writes fixtures/fid_*.json)
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const OPAQUE = { r: 0, g: 0, b: 0, a: 255 };
const CLEAR = { r: 0, g: 0, b: 0, a: 0 };
const PINK = { r: 232, g: 122, b: 158, a: 255 };
const GREEN = { r: 120, g: 190, b: 140, a: 255 };
const BLUE = { r: 110, g: 150, b: 220, a: 255 };

// A full strand record with sensible defaults; `o` overrides any field.
// control_points default to [start, start] which both renderers treat as a
// straight line (buildProfile / get_path: cp1==cp2==start -> line).
function strand(o) {
  const start = o.start, end = o.end;
  return {
    type: 'Strand', index: 0,
    start, end,
    width: 48, color: PINK, stroke_color: OPAQUE, stroke_width: 4,
    width_in_grid_units: null, elliptical_end_caps: false,
    has_circles: [false, false],
    layer_name: '1_1', set_number: 1,
    is_first_strand: false, is_start_side: true,
    start_line_visible: true, end_line_visible: true, is_hidden: false,
    start_extension_visible: false, end_extension_visible: false,
    start_arrow_visible: false, end_arrow_visible: false, full_arrow_visible: false,
    shadow_only: false, closed_connections: [false, false],
    arrow_color: null, arrow_transparency: 100, arrow_texture: 'none',
    arrow_shaft_style: 'solid', arrow_head_visible: true, arrow_casts_shadow: false,
    knot_connections: {},
    circle_stroke_color: OPAQUE, start_circle_stroke_color: OPAQUE, end_circle_stroke_color: OPAQUE,
    control_points: [start, start], control_point_center: start, control_point_center_locked: false,
    triangle_has_moved: false, control_point2_shown: false, control_point2_activated: false,
    ...o,
  };
}

function attached(o) {
  const s = strand(o);
  s.type = 'AttachedStrand';
  s.is_start_side = false;
  const dx = o.end.x - o.start.x, dy = o.end.y - o.start.y;
  s.angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  s.length = Math.hypot(dx, dy);
  s.has_circles = o.has_circles || [true, false]; // attachment start keeps its circle
  return s;
}

function scene(strands, meta = {}) {
  // OSS keys strands by `index` on load — duplicates overwrite each other, so
  // every strand needs a unique index. Assign them by position.
  strands.forEach((s, i) => { s.index = i; });
  return {
    strands,
    groups: {},
    selected_strand_name: null,
    locked_layers: [],
    lock_mode: false,
    shadow_enabled: true,
    show_control_points: false,
    shadow_overrides: {},
    ...meta,
  };
}

const FIX = path.join(process.cwd(), 'fixtures');
const write = (name, obj) => {
  writeFileSync(path.join(FIX, `${name}.json`), JSON.stringify(obj, null, 2) + '\n');
  console.log('wrote fixtures/' + name + '.json');
};

// ---- Case 1: baseline drop shadow -----------------------------------------
// A vertical strand crossing OVER a horizontal one, shadows on. No unfolded
// ends — this is the control: normal strand-over-strand shadow must match.
write('fid_shadow_cross', scene([
  strand({ layer_name: '1_1', set_number: 1, start: { x: 160, y: 520 }, end: { x: 840, y: 520 }, width: 56, color: PINK }),
  strand({ layer_name: '2_1', set_number: 2, start: { x: 500, y: 180 }, end: { x: 500, y: 860 }, width: 48, color: BLUE }),
]));

// ---- Case 2: UNFOLDED attached start over a strand (the fix) ---------------
// Horizontal receiver (1_1). A vertical parent (2_1) drops onto it; its attached
// child (2_2) continues DOWN through the receiver with an UNFOLDED start
// (transparent start circle) right at the crossing. The fix cuts the caster
// shadow back at that unfolded start instead of casting a square end-cap halo.
write('fid_shadow_unfolded_attach', scene([
  strand({ layer_name: '1_1', set_number: 1, start: { x: 150, y: 520 }, end: { x: 850, y: 520 }, width: 60, color: PINK }),
  strand({ layer_name: '2_1', set_number: 2, start: { x: 500, y: 180 }, end: { x: 500, y: 520 }, width: 46, color: GREEN, has_circles: [false, true] }),
  attached({
    layer_name: '2_2', set_number: 2, index: 1, start: { x: 500, y: 520 }, end: { x: 500, y: 880 },
    width: 46, color: GREEN, attached_to: '2_1', attachment_side: 1,
    has_circles: [true, false],
    start_circle_stroke_color: CLEAR, circle_stroke_color: CLEAR, end_circle_stroke_color: OPAQUE,
  }),
]));

// ---- Case 3: FOLDED attached start over a strand (contrast) ----------------
// Identical geometry to case 2 but the attached start is FOLDED (opaque circle),
// so it casts the full rounded end-circle shadow. Pairs with case 2 to prove the
// unfolded cut is applied ONLY when the start is transparent.
write('fid_shadow_folded_attach', scene([
  strand({ layer_name: '1_1', set_number: 1, start: { x: 150, y: 520 }, end: { x: 850, y: 520 }, width: 60, color: PINK }),
  strand({ layer_name: '2_1', set_number: 2, start: { x: 500, y: 180 }, end: { x: 500, y: 520 }, width: 46, color: GREEN, has_circles: [false, true] }),
  attached({
    layer_name: '2_2', set_number: 2, index: 1, start: { x: 500, y: 520 }, end: { x: 500, y: 880 },
    width: 46, color: GREEN, attached_to: '2_1', attachment_side: 1,
    has_circles: [true, false],
    start_circle_stroke_color: OPAQUE, circle_stroke_color: OPAQUE, end_circle_stroke_color: OPAQUE,
  }),
]));
