// Pure document mutators used by interaction modes. They mutate a DRAFT document
// (a structural clone owned by the store), so callers wrap them in
// store.mutateDoc(draft => ...). No object cross-references, so drafts stay
// JSON-serializable for future snapshot history.

import type { EditorDocument, HandleKind, Point, Settings } from '../model/types';
import { weldedEndpoints } from '../interaction/connections';

export function snapPoint(p: Point, settings: Settings): Point {
  if (!settings.snap_to_grid_enabled || settings.grid_size <= 0) return p;
  const g = settings.grid_size;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

// Move a handle to a new world position. Endpoints drag their welded peers (and
// each strand's associated control point) rigidly; control points move alone.
export function moveHandle(
  draft: EditorDocument,
  layerName: string,
  handle: HandleKind,
  pos: Point,
): void {
  const s = draft.strands[layerName];
  if (!s) return;

  if (handle === 'control_point1') { s.control_points[0] = pos; s.triangle_has_moved = true; return; }
  if (handle === 'control_point2') { s.control_points[1] = pos; s.control_point2_activated = true; return; }
  if (handle === 'control_point_center') { s.control_point_center = pos; return; }

  // Endpoint move: rigid propagation across the weld group.
  const cur = handle === 'start' ? s.start : s.end;
  const delta = { x: pos.x - cur.x, y: pos.y - cur.y };
  if (delta.x === 0 && delta.y === 0) return;

  for (const ep of weldedEndpoints(draft, layerName, handle)) {
    const t = draft.strands[ep.layer];
    if (!t) continue;
    const pt = ep.end === 'start' ? t.start : t.end;
    pt.x += delta.x; pt.y += delta.y;
    // Carry the associated control point so straight strands stay straight and
    // curves keep their shape relative to the moved end.
    const cpIdx = ep.end === 'start' ? 0 : 1;
    t.control_points[cpIdx] = { x: t.control_points[cpIdx].x + delta.x, y: t.control_points[cpIdx].y + delta.y };
    if (t.control_point_center) {
      t.control_point_center = { x: t.control_point_center.x + delta.x * 0.5, y: t.control_point_center.y + delta.y * 0.5 };
    }
  }
}
