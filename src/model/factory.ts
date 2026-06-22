// Constructors for new strands with the desktop app's authentic defaults.
// Defaults mirror strand.py / attached_strand.py: width 46, stroke 4, black
// stroke, the default strand color, has_circles per strand type.

import type { LayerName, Point, RGBA, StrandRecord } from './types';

export const DEFAULT_STRAND_COLOR: RGBA = { r: 200, g: 170, b: 230, a: 255 }; // purple
export const DEFAULT_STROKE_COLOR: RGBA = { r: 0, g: 0, b: 0, a: 255 };
export const DEFAULT_STRAND_WIDTH = 46;
export const DEFAULT_STROKE_WIDTH = 4;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

interface MakeStrandOpts {
  layer_name: LayerName;
  set_number: number;
  start: Point;
  end: Point;
  color?: RGBA;
  width?: number;
  stroke_width?: number;
  is_first_strand?: boolean;
}

// A free first strand of a set: no circles, straight (control points collapsed
// onto the endpoints so the renderer draws a line).
export function makeStrand(o: MakeStrandOpts): StrandRecord {
  const color = o.color ?? DEFAULT_STRAND_COLOR;
  return {
    type: 'Strand',
    layer_name: o.layer_name,
    set_number: o.set_number,
    start: clone(o.start),
    end: clone(o.end),
    control_points: [clone(o.start), clone(o.end)],
    control_point_center: { x: (o.start.x + o.end.x) / 2, y: (o.start.y + o.end.y) / 2 },
    control_point_center_locked: false,
    width: o.width ?? DEFAULT_STRAND_WIDTH,
    stroke_width: o.stroke_width ?? DEFAULT_STROKE_WIDTH,
    color: clone(color),
    stroke_color: clone(DEFAULT_STROKE_COLOR),
    has_circles: [false, false],
    is_hidden: false,
    shadow_only: false,
    circle_stroke_color: clone(DEFAULT_STROKE_COLOR),
    manual_circle_visibility: [null, null],
    knot_connections: {},
    triangle_has_moved: false,
    control_point2_shown: false,
    control_point2_activated: false,
    extra: {
      is_first_strand: o.is_first_strand ?? true,
      is_start_side: true,
      start_line_visible: true,
      end_line_visible: true,
      start_extension_visible: false,
      end_extension_visible: false,
      start_arrow_visible: false,
      end_arrow_visible: false,
      full_arrow_visible: false,
      closed_connections: [false, false],
    },
  };
}

// An attached child: hangs off a parent endpoint. has_circles[0] = true (the
// attachment-point circle), per the desktop app's loader validation.
export function makeAttachedStrand(o: MakeStrandOpts & {
  attached_to: LayerName;
  attachment_side: 0 | 1;
}): StrandRecord {
  const s = makeStrand(o);
  s.type = 'AttachedStrand';
  s.attached_to = o.attached_to;
  s.attachment_side = o.attachment_side;
  s.has_circles = [true, false];
  delete (s.extra as Record<string, unknown>).is_first_strand;
  return s;
}
