// Seed a representative document + group into the live store so every window in
// the dark-mode gallery renders with real content (canvas strands, a group tree,
// a selected layer). Reuses the real load path (loadProject) and the real group
// action (createGroup) so the seed is faithful to how the app builds state.
//
// Pure data + store writes — no React. Called once by the gallery App before it
// mounts the selected window.

import boxStitch from '../../fixtures/box_stitch.json';
import { loadProject } from '../io/saveLoad';
import { createGroup } from '../store/actions';
import { useEditorStore } from '../store/editorStore';
import { fitPan } from '../interaction/viewTransform';
import type { EditorDocument, Theme, Language } from '../model/types';

export interface SeedInfo {
  /** Name of the seeded group (targets the group dialogs). */
  group: string;
  /** A representative non-masked layer for the per-strand shadow editor. */
  strandLayer: string;
  /** A masked layer if the fixture has one (targets mask-aware windows). */
  maskLayer: string | null;
}

// One representative main strand per set_number (prefer the "_N_1" main), mirroring
// MainStrandSelectDialog's set-representative logic.
function mainStrandsOf(doc: EditorDocument): string[] {
  const bySet = new Map<number, string>();
  for (const n of doc.order) {
    const s = doc.strands[n];
    if (!s || s.type === 'MaskedStrand') continue;
    const cur = bySet.get(s.set_number);
    if (cur === undefined || (n.endsWith('_1') && !cur.endsWith('_1'))) bySet.set(s.set_number, n);
  }
  return [...bySet.keys()].sort((a, b) => a - b).map((k) => bySet.get(k)!);
}

export function seedGallery(theme: Theme, language: Language): SeedInfo {
  const doc = loadProject(boxStitch as unknown);
  const mains = mainStrandsOf(doc);
  const group = 'Group 1';
  // Build the group directly on the doc before loading (one clean initial state).
  createGroup(doc, group, mains);

  const strandLayer = mains[0] ?? doc.order[0] ?? '';
  const maskLayer = doc.order.find((n) => doc.strands[n]?.type === 'MaskedStrand') ?? null;

  // Select a representative strand so selected-state chrome (layer button, props,
  // selected-strand settings) renders in its active look.
  doc.selected_strand_name = strandLayer || null;

  const st = useEditorStore.getState();
  // Theme + language first (App's effect reads settings.theme to class <html>).
  st.setSettings({ theme, language, show_grid: true });
  st.loadDocument(doc);
  st.setSelection({ layerName: strandLayer || null, handle: null });
  // Center the weave in the view so the canvas shot is framed.
  const { panX, panY } = fitPan(doc, st.view);
  st.setView({ panX, panY });

  return { group, strandLayer, maskLayer };
}
