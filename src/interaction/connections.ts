// Derive the endpoint connection graph (the move-mode "weld" relation) from the
// document. Two endpoints are welded when moving one must move the other:
//   - an AttachedStrand's start is welded to its parent endpoint
//     (attachment_side 0 -> parent.start, 1 -> parent.end)
//   - a knot_connection welds the two named endpoints
// Endpoints are identified as "layer_name@start" / "layer_name@end".

import { maskComponents } from '../model/layerName';
import type { EditorDocument, EndKey, HandleKind } from '../model/types';

export interface EndpointId { layer: string; end: EndKey; }

const key = (layer: string, end: EndKey) => `${layer}@${end}`;
const parseKey = (k: string): EndpointId => {
  const at = k.lastIndexOf('@');
  return { layer: k.slice(0, at), end: k.slice(at + 1) as EndKey };
};

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) { this.parent.set(x, x); return x; }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) { const n = this.parent.get(cur)!; this.parent.set(cur, root); cur = n; }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function buildWeldGraph(doc: EditorDocument): UnionFind {
  const uf = new UnionFind();
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s) continue;
    if (s.type === 'AttachedStrand' && s.attached_to && doc.strands[s.attached_to]) {
      const parentEnd: EndKey = s.attachment_side === 1 ? 'end' : 'start';
      uf.union(key(s.layer_name, 'start'), key(s.attached_to, parentEnd));
    }
    for (const [end, conn] of Object.entries(s.knot_connections || {})) {
      if (conn && conn.connected_strand_name && doc.strands[conn.connected_strand_name]) {
        uf.union(key(s.layer_name, end as EndKey), key(conn.connected_strand_name, conn.connected_end));
      }
    }
  }
  return uf;
}

// All endpoints welded to (layer,end) — including itself.
export function weldedEndpoints(doc: EditorDocument, layer: string, end: EndKey): EndpointId[] {
  const uf = buildWeldGraph(doc);
  const target = uf.find(key(layer, end));
  const out: EndpointId[] = [];
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s) continue;
    for (const e of ['start', 'end'] as EndKey[]) {
      if (uf.find(key(name, e)) === target) out.push({ layer: name, end: e });
    }
  }
  // Ensure the dragged endpoint itself is present even if isolated.
  if (!out.some((o) => o.layer === layer && o.end === end)) out.push({ layer, end });
  return out;
}

// The set of strand layer_names whose geometry changes when `handle` of `layer`
// is dragged — i.e. exactly what actions.moveHandle mutates. For an ENDPOINT that
// is every strand owning an endpoint welded to the dragged one (welded peers +
// attached children); for a CONTROL POINT it is just the strand itself. Any
// MaskedStrand whose components are in the set is added too, since a mask
// re-derives its crossing from its components' live geometry and so must redraw
// with them. The drag fast-path bakes everything NOT in this set as a static
// background and redraws only this set per frame.
export function movingStrandSet(doc: EditorDocument, layer: string, handle: HandleKind): Set<string> {
  const moving = new Set<string>();
  if (handle === 'start' || handle === 'end') {
    for (const ep of weldedEndpoints(doc, layer, handle)) moving.add(ep.layer);
  } else {
    moving.add(layer); // control points move their own strand alone
  }
  for (const name of doc.order) {
    const s = doc.strands[name];
    if (!s || s.type !== 'MaskedStrand') continue;
    const comp = maskComponents(name);
    if (comp && (moving.has(comp.first) || moving.has(comp.second))) moving.add(name);
  }
  return moving;
}
