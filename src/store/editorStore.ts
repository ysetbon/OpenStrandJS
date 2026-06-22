// The single shared editor store. Imperative pointer handlers (outside React)
// read/write synchronously via getState()/setState(); React chrome subscribes
// with selectors. Phase 1 keeps a trivial single-slot history (undo deferred to
// Phase 5).

import { create } from 'zustand';
import type {
  EditorDocument, HandleKind, ModeName, Point, Selection, Settings, StrandRecord, ViewState,
} from '../model/types';

// Transient new-strand / attach gesture (the rubber-band preview). Not part of
// the document and not undoable; committed to the doc on pointer-up.
export interface PendingStrand {
  kind: 'new' | 'attach';
  start: Point;
  end: Point;
  parent?: string;       // attach: parent layer_name
  side?: 0 | 1;          // attach: which parent endpoint
}
import {
  DEFAULT_STRAND_COLOR, DEFAULT_STROKE_COLOR,
  DEFAULT_STRAND_WIDTH, DEFAULT_STROKE_WIDTH,
} from '../model/factory';

export function emptyDocument(): EditorDocument {
  return {
    order: [],
    strands: {},
    groups: {},
    selected_strand_name: null,
    locked_layers: [],
    lock_mode: false,
    shadow_enabled: true,
    show_control_points: true,
    shadow_overrides: {},
  };
}

const DEFAULT_SETTINGS: Settings = {
  curve_params: { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 },
  grid_size: 28,
  show_grid: false,
  snap_to_grid_enabled: false,
  default_strand_color: DEFAULT_STRAND_COLOR,
  default_stroke_color: DEFAULT_STROKE_COLOR,
  default_strand_width: DEFAULT_STRAND_WIDTH,
  default_stroke_width: DEFAULT_STROKE_WIDTH,
};

const DEFAULT_VIEW: ViewState = {
  zoom: 1, panX: 0, panY: 0, width: 1000, height: 700, supersample: 2,
};

export interface EditorState {
  doc: EditorDocument;
  selection: Selection;
  mode: ModeName;
  view: ViewState;
  settings: Settings;
  dragging: boolean;
  hover: { layerName: string | null; handle: HandleKind | null };
  pending: PendingStrand | null;     // new-strand / attach rubber-band preview
  maskPending: string[];             // 0..2 strands picked for an over/under mask
  eraser: { layerName: string; rect: { minX: number; minY: number; maxX: number; maxY: number } } | null;
  // bumped whenever the document changes so subscribers can re-render the canvas
  docRevision: number;

  loadDocument: (doc: EditorDocument) => void;
  setDoc: (doc: EditorDocument) => void;
  mutateDoc: (fn: (draft: EditorDocument) => void) => void;
  setView: (patch: Partial<ViewState>) => void;
  setMode: (mode: ModeName) => void;
  setSelection: (sel: Selection) => void;
  setDragging: (b: boolean) => void;
  setHover: (hover: { layerName: string | null; handle: HandleKind | null }) => void;
  setPending: (pending: PendingStrand | null) => void;
  setMaskPending: (maskPending: string[]) => void;
  setEraser: (eraser: EditorState['eraser']) => void;
}

// Shallow structural clone of a document (snapshots stay JSON-serializable
// because StrandRecord holds no object cross-references).
export function cloneDoc(doc: EditorDocument): EditorDocument {
  return JSON.parse(JSON.stringify(doc)) as EditorDocument;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  doc: emptyDocument(),
  selection: { layerName: null, handle: null },
  mode: 'select',
  view: { ...DEFAULT_VIEW },
  settings: DEFAULT_SETTINGS,
  dragging: false,
  hover: { layerName: null, handle: null },
  pending: null,
  maskPending: [],
  eraser: null,
  docRevision: 0,

  loadDocument: (doc) => set((s) => ({
    doc,
    selection: { layerName: doc.selected_strand_name, handle: null },
    docRevision: s.docRevision + 1,
  })),

  setDoc: (doc) => set((s) => ({ doc, docRevision: s.docRevision + 1 })),

  mutateDoc: (fn) => set((s) => {
    const draft = cloneDoc(s.doc);
    fn(draft);
    return { doc: draft, docRevision: s.docRevision + 1 };
  }),

  setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),
  setMode: (mode) => set({ mode }),
  setSelection: (selection) => set({ selection }),
  setDragging: (dragging) => set({ dragging }),
  setHover: (hover) => set({ hover }),
  setPending: (pending) => set({ pending }),
  setMaskPending: (maskPending) => set({ maskPending }),
  setEraser: (eraser) => set({ eraser }),
}));

// Convenience accessor for imperative (non-React) code.
export const editorStore = useEditorStore;
export type { StrandRecord };

// Dev-only debug handle.
if (import.meta.env?.DEV) (globalThis as Record<string, unknown>).__store = useEditorStore;
