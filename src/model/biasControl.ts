// Curvature bias controls — port of OpenStrand Studio's curvature_bias_control.py.
//
// Two small green squares (one with a triangle icon, one with a circle icon) sit
// on the dashed lines from the LOCKED third control point to cp1 and cp2. Each
// one slides along its line; where it sits is its bias in [0, 1] (0 at the
// centre, 1 at the control point, 0.5 neutral). The renderer scales the cubic
// handles by (0.5 + bias), so the two halves of the curve can be shaped
// independently (strand.py::_build_curve_profile).
//
// OSS serializes this under the strand's `bias_control` key as
//   { triangle_bias, circle_bias, triangle_position, circle_position }
// and the JS model keeps unmodeled keys in `StrandRecord.extra`, so the data
// rides `extra.bias_control` here — exactly what the renderer already reads.
// The positions are DERIVED from the biases (OSS update_positions_from_biases
// recomputes them whenever a main control point moves and on load), so the
// biases are the source of truth and positions are refreshed on write/save.

import type { EditorDocument, Point, Settings, StrandRecord } from './types';

export type BiasKind = 'triangle' | 'circle';

export interface BiasControlData {
  triangle_bias?: number;
  circle_bias?: number;
  triangle_position?: Point | null;
  circle_position?: Point | null;
}

export const NEUTRAL_BIAS = 0.5;
// OSS undo_redo_manager treats |Δbias| <= 0.001 as "unchanged".
export const BIAS_EPS = 0.001;

// A stored bias is a fraction of the centre->cp line, so anything outside [0, 1]
// (a hand-edited file, a foreign writer) is clamped at the read boundary; a
// missing or non-finite value reads as the fallback.
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback;

export function readBiasData(s: StrandRecord): BiasControlData | null {
  const bc = s.extra?.bias_control;
  return bc && typeof bc === 'object' ? (bc as BiasControlData) : null;
}

// Current (triangle, circle) bias, neutral when absent — matches the renderer's
// `bc.triangle_bias != null ? bc.triangle_bias : 0.5`.
export function readBias(s: StrandRecord): { triangle: number; circle: number } {
  const bc = readBiasData(s);
  return {
    triangle: num(bc?.triangle_bias, NEUTRAL_BIAS),
    circle: num(bc?.circle_bias, NEUTRAL_BIAS),
  };
}

export function isNeutralBias(s: StrandRecord): boolean {
  const b = readBias(s);
  return Math.abs(b.triangle - NEUTRAL_BIAS) <= BIAS_EPS && Math.abs(b.circle - NEUTRAL_BIAS) <= BIAS_EPS;
}

// Where the two squares sit: centre + (cp - centre) * bias
// (curvature_bias_control.py::update_positions_from_biases). Null without a centre.
export function biasPositions(s: StrandRecord): { triangle: Point; circle: Point } | null {
  const c = s.control_point_center;
  if (!c) return null;
  const [cp1, cp2] = s.control_points;
  const b = readBias(s);
  return {
    triangle: { x: c.x + (cp1.x - c.x) * b.triangle, y: c.y + (cp1.y - c.y) * b.triangle },
    circle: { x: c.x + (cp2.x - c.x) * b.circle, y: c.y + (cp2.y - c.y) * b.circle },
  };
}

export function biasPosition(s: StrandRecord, kind: BiasKind): Point | null {
  const p = biasPositions(s);
  return p ? p[kind] : null;
}

// Bias for a pointer position: project the pointer onto the centre->cp line and
// clamp to [0, 1] (curvature_bias_control.py::handle_mouse_move). A degenerate
// line (cp on the centre) keeps the current value.
export function biasFromPointer(s: StrandRecord, kind: BiasKind, world: Point): number {
  const c = s.control_point_center;
  if (!c) return readBias(s)[kind];
  const cp = kind === 'triangle' ? s.control_points[0] : s.control_points[1];
  const lx = cp.x - c.x, ly = cp.y - c.y;
  const len = Math.hypot(lx, ly);
  if (len <= 0) return readBias(s)[kind];
  const proj = ((world.x - c.x) * lx + (world.y - c.y) * ly) / len;   // along the unit line vector
  return Math.max(0, Math.min(len, proj)) / len;
}

// Serialized form. OSS stores the square positions on the CurvatureBiasControl
// (None until something places them) and refreshes them only at specific
// moments (update_positions_from_biases: on load, on a bias drag, and whenever
// a main control point moves while the squares are drawn), so a saved position
// is whatever the last refresh left — and a strand whose squares were never
// placed writes null. The stored pair is therefore written as it stands.
export function serializedBias(s: StrandRecord): BiasControlData {
  const b = readBias(s);
  const bc = readBiasData(s);
  const stored = bc && bc.triangle_position && bc.circle_position
    ? { triangle: bc.triangle_position, circle: bc.circle_position } : null;
  return {
    triangle_bias: b.triangle,
    circle_bias: b.circle,
    triangle_position: stored ? { x: stored.triangle.x, y: stored.triangle.y } : null,
    circle_position: stored ? { x: stored.circle.x, y: stored.circle.y } : null,
  };
}

// update_positions_from_biases: recompute the stored square positions from the
// current centre and control points. Installs a fresh bias_control object so an
// in-flight gesture's cloned undo baseline can't alias it. A strand without a
// bias control (the setting off, a mask) is left alone.
export function refreshBiasPositions(s: StrandRecord): void {
  if (!readBiasData(s)) return;
  const b = readBias(s);
  const p = biasPositions(s);
  s.extra = {
    ...s.extra,
    bias_control: {
      triangle_bias: b.triangle,
      circle_bias: b.circle,
      triangle_position: p ? { x: p.triangle.x, y: p.triangle.y } : null,
      circle_position: p ? { x: p.circle.x, y: p.circle.y } : null,
    },
  };
}

// Write one bias. Always installs a FRESH bias_control object (never mutates the
// one in place) so an in-flight gesture's cloned undo baseline can't alias it.
export function setBias(s: StrandRecord, kind: BiasKind, value: number): void {
  const v = clamp01(value);
  const b = readBias(s);
  if (kind === 'triangle') b.triangle = v; else b.circle = v;
  s.extra = {
    ...s.extra,
    bias_control: { triangle_bias: b.triangle, circle_bias: b.circle },
  };
  refreshBiasPositions(s);   // a bias drag always re-places both squares
}

export function setBiases(s: StrandRecord, triangle: number, circle: number): void {
  setBias(s, 'triangle', triangle);
  setBias(s, 'circle', circle);
}

// Are this strand's bias squares shown/grabbable? Port of
// curvature_bias_control.py::should_show_controls:
//   * both General-page toggles on (bias requires the third control point);
//   * the centre is LOCKED (manually positioned). This gates only the SQUARES:
//     OSS keeps the stored biases and _build_curve_profile applies them to the
//     unlocked profile too (strand.py:1534-1560), as does strand-renderer.js;
//   * the triangle has moved (the same gate as the centre square itself);
//   * control points are shown — or the document holds a single strand, OSS's
//     "test mode" shortcut.
export function biasControlsVisible(s: StrandRecord, settings: Settings, doc: EditorDocument): boolean {
  if (!settings.enable_curvature_bias_control || !settings.enable_third_control_point) return false;
  if (!s.control_point_center_locked || !s.control_point_center) return false;
  if (!s.triangle_has_moved) return false;
  return !!doc.show_control_points || doc.order.length === 1;
}
