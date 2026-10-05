// Every mask above every strand (OSS 2.0, save_load_manager.keep_masks_on_top,
// commit 45d6f1f).
//
// A mask only says which of its two strands is on top where they cross; it
// works from anywhere above both of them and stops working once either is
// drawn over it. With masks in their own layer-panel tab their place among the
// strands must not matter, so the app keeps them as one block above all
// strands: strands keep their relative order, masks keep theirs, and the masks
// come after every strand.
//
// OSS remaps index-based state (locked_layers, multi-selection) along with the
// reorder. Here locks, the selection and the multi-selection are kept by layer
// NAME, so they follow their layers with no remapping.

import type { EditorDocument, LayerName, StrandRecord } from './types';

const isMask = (strands: Record<LayerName, StrandRecord>, name: LayerName): boolean =>
  strands[name]?.type === 'MaskedStrand';

// keep_masks_on_top(strands): the order with every mask moved above every
// strand. Returns the SAME array when nothing has to move.
export function keepMasksOnTop(order: LayerName[], strands: Record<LayerName, StrandRecord>): LayerName[] {
  const plain: LayerName[] = [];
  const masks: LayerName[] = [];
  for (const n of order) (isMask(strands, n) ? masks : plain).push(n);
  const ordered = plain.concat(masks);
  for (let i = 0; i < order.length; i++) if (ordered[i] !== order[i]) return ordered;
  return order;
}

// Whether `order` already has every mask above every strand.
export function masksAreOnTop(order: LayerName[], strands: Record<LayerName, StrandRecord>): boolean {
  return keepMasksOnTop(order, strands) === order;
}

// In-place variant for a document draft. True when the order changed.
export function putMasksOnTop(doc: EditorDocument): boolean {
  const next = keepMasksOnTop(doc.order, doc.strands);
  if (next === doc.order) return false;
  doc.order = next;
  return true;
}

// A copy of `doc` with the masks on top, or `doc` itself when already in order
// (so callers can keep identity when nothing changed).
export function withMasksOnTop(doc: EditorDocument): EditorDocument {
  const next = keepMasksOnTop(doc.order, doc.strands);
  return next === doc.order ? doc : { ...doc, order: next };
}
