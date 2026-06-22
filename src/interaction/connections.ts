// Derive the endpoint connection graph (the move-mode "weld" relation) from the
// document. Two endpoints are welded when moving one must move the other:
//   - an AttachedStrand's start is welded to its parent endpoint
//     (attachment_side 0 -> parent.start, 1 -> parent.end)
//   - a knot_connection welds the two named endpoints
// Endpoints are identified as "layer_name@start" / "layer_name@end".

import type { EditorDocument, EndKey } from '../model/types';

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
