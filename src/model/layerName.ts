// layer_name parsing/formatting and the set/index allocator.
//
// A regular strand's layer_name is "<set>_<index>" (e.g. "1_2"). A MaskedStrand
// concatenates the two component names: "a_b_c_d" where "a_b" is OVER and
// "c_d" is UNDER. The allocator picks the LOWEST FREE integer within a set
// (not count+1), matching the desktop app — so deleting "1_2" then adding makes
// "1_2" again, not "1_4".

import type { EditorDocument, LayerName } from './types';

export function parseLayerName(name: LayerName): { set: number; index: number } | null {
  const parts = name.split('_');
  if (parts.length !== 2) return null;
  const set = Number(parts[0]);
  const index = Number(parts[1]);
  if (!Number.isFinite(set) || !Number.isFinite(index)) return null;
  return { set, index };
}

export function isMaskedName(name: LayerName): boolean {
  return name.split('_').length >= 4;
}

export function maskComponents(name: LayerName): { first: LayerName; second: LayerName } | null {
  const p = name.split('_');
  if (p.length < 4) return null;
  return { first: `${p[0]}_${p[1]}`, second: `${p[2]}_${p[3]}` };
}

// Lowest free integer index within `set`, considering only non-masked strands.
export function nextIndexInSet(doc: EditorDocument, set: number): number {
  const used = new Set<number>();
  for (const name of Object.keys(doc.strands)) {
    const parsed = parseLayerName(name);
    if (parsed && parsed.set === set) used.add(parsed.index);
  }
  let i = 1;
  while (used.has(i)) i++;
  return i;
}

// Lowest free set number (a new top-level strand starts a new set).
export function nextFreeSet(doc: EditorDocument): number {
  const used = new Set<number>();
  for (const name of Object.keys(doc.strands)) {
    const parsed = parseLayerName(name);
    if (parsed) used.add(parsed.set);
  }
  let s = 1;
  while (used.has(s)) s++;
  return s;
}

export function formatLayerName(set: number, index: number): LayerName {
  return `${set}_${index}`;
}
