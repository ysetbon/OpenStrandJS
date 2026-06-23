// Group membership resolution — the OSS-faithful model.
//
// OpenStrand Studio stores a group's `main_strands` as the chosen branches and
// resolves the full membership dynamically (group_layers.py:resolve_group_data):
// a group owns every strand in the branches of its main strands. In this port a
// "branch" is a set_number — an attached child inherits its parent's set_number
// (see attachChild in store/actions.ts) — so a group owns:
//   * every non-masked strand sharing a main strand's set_number, plus
//   * every MaskedStrand whose BOTH components fall in that resolved set.
//
// Resolving on demand (rather than storing a flat member list) keeps groups
// correct when strands are attached/added after the group is created, and matches
// the desktop's whole-branch grouping.

import type { EditorDocument, GroupRecord, LayerName } from './types';
import { maskComponents } from './layerName';

export interface GroupMembers {
  /** Non-masked strands in the group's branches. */
  regular: LayerName[];
  /** Masks whose both components are in `regular`. */
  masks: LayerName[];
}

// The set_numbers named by a group's existing, non-masked main strands.
export function groupSetNumbers(doc: EditorDocument, name: string): Set<number> {
  const sets = new Set<number>();
  const g = (doc.groups as Record<string, GroupRecord>)[name];
  if (!g) return sets;
  for (const n of g.main_strands || []) {
    const s = doc.strands[n];
    if (s && s.type !== 'MaskedStrand') sets.add(s.set_number);
  }
  return sets;
}

// Resolve a group to its full, current membership (whole branches).
export function resolveGroupMembers(doc: EditorDocument, name: string): GroupMembers {
  const sets = groupSetNumbers(doc, name);
  if (!sets.size) return { regular: [], masks: [] };

  const regular: LayerName[] = [];
  for (const k of Object.keys(doc.strands)) {
    const s = doc.strands[k];
    if (s.type !== 'MaskedStrand' && sets.has(s.set_number)) regular.push(k);
  }
  const regSet = new Set(regular);

  const masks: LayerName[] = [];
  for (const k of Object.keys(doc.strands)) {
    if (doc.strands[k].type !== 'MaskedStrand') continue;
    const comp = maskComponents(k);
    if (comp && regSet.has(comp.first) && regSet.has(comp.second)) masks.push(k);
  }
  return { regular, masks };
}
