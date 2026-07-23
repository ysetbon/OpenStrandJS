// OSS AngleAdjustMode geometry (angle_adjust_mode.py) — the modal "Adjust Angle
// and Length" dialog's live preview. All updates are ABSOLUTE from a snapshot
// taken at activate() (:43-71): the start point is the fixed pivot; the end is
// re-derived from (angle, length); control points are the INITIAL cp vectors
// (relative to start) scaled by length/initial_length and rotated by the angle
// delta (:336-388, 503-539); attached strands whose start sat on the old end
// are re-glued — start snaps to the new end, the end stays fixed, and both
// control points translate by the same delta (:419-492).
import type { EditorDocument, Point } from '../model/types';

interface ChildSnap {
  name: string;
  start: Point;
  cp1: Point;
  cp2: Point;
  cpCenter: Point | null;
}

export interface AngleAdjustSnapshot {
  name: string;
  start: Point;
  end: Point;
  cp1Vec: Point;               // cp - start, at activate()
  cp2Vec: Point;
  cpCenterVec: Point | null;
  initialAngle: number;        // degrees, atan2(dy,dx) — 0° = +x, clockwise (y-down)
  initialLength: number;
  maxLength: number;           // max(10, int(initial*2)) (:68)
  children: ChildSnap[];       // strands glued to the old end (manhattan ≤ 1, :430)
}

export function snapshotAngleAdjust(doc: EditorDocument, name: string): AngleAdjustSnapshot | null {
  const s = doc.strands[name];
  if (!s) return null;
  const dx = s.end.x - s.start.x;
  const dy = s.end.y - s.start.y;
  const len = Math.hypot(dx, dy);
  const children: ChildSnap[] = [];
  for (const other of Object.keys(doc.strands)) {
    if (other === name) continue;
    const o = doc.strands[other];
    if (!o || o.type === 'MaskedStrand') continue;
    if (Math.abs(o.start.x - s.end.x) + Math.abs(o.start.y - s.end.y) <= 1) {
      children.push({
        name: other,
        start: { ...o.start },
        cp1: { ...o.control_points[0] },
        cp2: { ...o.control_points[1] },
        cpCenter: o.control_point_center ? { ...o.control_point_center } : null,
      });
    }
  }
  return {
    name,
    start: { ...s.start },
    end: { ...s.end },
    cp1Vec: { x: s.control_points[0].x - s.start.x, y: s.control_points[0].y - s.start.y },
    cp2Vec: { x: s.control_points[1].x - s.start.x, y: s.control_points[1].y - s.start.y },
    cpCenterVec: s.control_point_center
      ? { x: s.control_point_center.x - s.start.x, y: s.control_point_center.y - s.start.y }
      : null,
    initialAngle: (Math.atan2(dy, dx) * 180) / Math.PI,
    initialLength: len,
    maxLength: Math.max(10, Math.trunc(len * 2)),
    children,
  };
}

// Apply (angleDeg, length) absolutely from the snapshot. Safe to call every tick.
export function applyAngleAdjustSnapshot(
  draft: EditorDocument,
  snap: AngleAdjustSnapshot,
  angleDeg: number,
  length: number,
): void {
  const s = draft.strands[snap.name];
  if (!s) return;
  const rad = (angleDeg * Math.PI) / 180;
  const newEnd: Point = {
    x: snap.start.x + Math.cos(rad) * length,
    y: snap.start.y + Math.sin(rad) * length,
  };
  s.end = newEnd;
  // Initial cp vectors, scaled then rotated rigidly by the angle delta about start.
  const scale = snap.initialLength > 0 ? length / snap.initialLength : 1;
  const dRad = ((angleDeg - snap.initialAngle) * Math.PI) / 180;
  const cos = Math.cos(dRad), sin = Math.sin(dRad);
  const place = (v: Point): Point => {
    const sx = v.x * scale, sy = v.y * scale;
    return {
      x: snap.start.x + sx * cos - sy * sin,
      y: snap.start.y + sx * sin + sy * cos,
    };
  };
  s.control_points = [place(snap.cp1Vec), place(snap.cp2Vec)];
  if (snap.cpCenterVec && s.control_point_center) s.control_point_center = place(snap.cpCenterVec);
  // Re-glue attached children: start -> new end; cps translated by the delta
  // from THEIR snapshot; the far end never moves (angle_adjust_mode.py:419-456).
  const ddx = newEnd.x - snap.end.x;
  const ddy = newEnd.y - snap.end.y;
  for (const c of snap.children) {
    const cs = draft.strands[c.name];
    if (!cs) continue;
    cs.start = { x: newEnd.x, y: newEnd.y };
    cs.control_points = [
      { x: c.cp1.x + ddx, y: c.cp1.y + ddy },
      { x: c.cp2.x + ddx, y: c.cp2.y + ddy },
    ];
    if (c.cpCenter && cs.control_point_center) {
      cs.control_point_center = { x: c.cpCenter.x + ddx, y: c.cpCenter.y + ddy };
    }
  }
}
