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
import { areVisuallyEqual } from './visualEqual';

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
  theme: 'default',
  language: 'en',
};

const SETTINGS_KEY = 'openstrandjs.settings';

function loadSettings(): Settings {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

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
  // layer_names that move with the current endpoint drag (the drag fast-path's
  // "moving set"); empty when not dragging. Read by the renderer scheduler to bake
  // everything else and redraw only these per frame.
  dragMoving: string[];
  hover: { layerName: string | null; handle: HandleKind | null };
  pending: PendingStrand | null;     // new-strand / attach rubber-band preview
  maskPending: string[];             // 0..2 strands picked for an over/under mask
  eraser: { layerName: string; rect: { minX: number; minY: number; maxX: number; maxY: number } } | null;
  // bumped whenever the document changes so subscribers can re-render the canvas
  docRevision: number;

  // snapshot history (Phase 5). present == doc. One snapshot per gesture.
  past: EditorDocument[];
  future: EditorDocument[];
  gestureBase: EditorDocument | null;

  // multi-tab (Phase 6e). The active tab's doc IS the live `doc`; inactive tabs
  // hold their saved doc/view.
  tabs: { id: number; name: string; doc?: EditorDocument; view?: ViewState }[];
  activeTabId: number;
  nextTabId: number;
  newTab: () => void;
  switchTab: (id: number) => void;
  closeTab: (id: number) => void;

  loadDocument: (doc: EditorDocument) => void;
  setDoc: (doc: EditorDocument) => void;
  mutateDoc: (fn: (draft: EditorDocument) => void) => void;
  beginGesture: () => void;
  commit: () => void;
  commitEdit: (fn: (draft: EditorDocument) => void) => void;
  undo: () => void;
  redo: () => void;
  setView: (patch: Partial<ViewState>) => void;
  setSettings: (patch: Partial<Settings>) => void;
  setMode: (mode: ModeName) => void;
  setSelection: (sel: Selection) => void;
  setDragging: (b: boolean) => void;
  setDragMoving: (moving: string[]) => void;
  setHover: (hover: { layerName: string | null; handle: HandleKind | null }) => void;
  setPending: (pending: PendingStrand | null) => void;
  setMaskPending: (maskPending: string[]) => void;
  setEraser: (eraser: EditorState['eraser']) => void;
}

const HISTORY_CAP = 100;

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
  settings: loadSettings(),
  dragging: false,
  dragMoving: [],
  hover: { layerName: null, handle: null },
  pending: null,
  maskPending: [],
  eraser: null,
  docRevision: 0,
  past: [],
  future: [],
  gestureBase: null,
  tabs: [{ id: 1, name: 'Untitled 1' }],
  activeTabId: 1,
  nextTabId: 2,

  newTab: () => set((s) => {
    const tabs = s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, doc: s.doc, view: s.view } : t));
    const id = s.nextTabId;
    tabs.push({ id, name: `Untitled ${id}` });
    return {
      tabs, activeTabId: id, nextTabId: id + 1,
      doc: emptyDocument(), view: { ...DEFAULT_VIEW, width: s.view.width, height: s.view.height },
      past: [], future: [], gestureBase: null, selection: { layerName: null, handle: null },
      docRevision: s.docRevision + 1,
    };
  }),

  switchTab: (id) => set((s) => {
    if (id === s.activeTabId) return {};
    const tabs = s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, doc: s.doc, view: s.view } : t));
    const target = tabs.find((t) => t.id === id);
    if (!target) return {};
    const doc = target.doc ?? emptyDocument();
    return {
      tabs, activeTabId: id,
      doc, view: target.view ?? { ...DEFAULT_VIEW, width: s.view.width, height: s.view.height },
      past: [], future: [], gestureBase: null,
      selection: { layerName: doc.selected_strand_name ?? null, handle: null },
      docRevision: s.docRevision + 1,
    };
  }),

  closeTab: (id) => set((s) => {
    const remaining = s.tabs.filter((t) => t.id !== id);
    if (remaining.length === 0) {
      const nid = s.nextTabId;
      return {
        tabs: [{ id: nid, name: `Untitled ${nid}` }], activeTabId: nid, nextTabId: nid + 1,
        doc: emptyDocument(), view: { ...s.view }, past: [], future: [], gestureBase: null,
        selection: { layerName: null, handle: null }, docRevision: s.docRevision + 1,
      };
    }
    if (id !== s.activeTabId) return { tabs: remaining };
    const target = remaining[0];
    const doc = target.doc ?? emptyDocument();
    return {
      tabs: remaining, activeTabId: target.id,
      doc, view: target.view ?? { ...s.view }, past: [], future: [], gestureBase: null,
      selection: { layerName: doc.selected_strand_name ?? null, handle: null },
      docRevision: s.docRevision + 1,
    };
  }),

  loadDocument: (doc) => set((s) => ({
    doc,
    selection: { layerName: doc.selected_strand_name, handle: null },
    docRevision: s.docRevision + 1,
    past: [], future: [], gestureBase: null,    // a fresh load starts new history
  })),

  setDoc: (doc) => set((s) => ({ doc, docRevision: s.docRevision + 1 })),

  // Live edit: mutates present, NO history push (used during drags).
  mutateDoc: (fn) => set((s) => {
    const draft = cloneDoc(s.doc);
    fn(draft);
    return { doc: draft, docRevision: s.docRevision + 1 };
  }),

  // Snapshot present as the gesture baseline (first call of a gesture wins).
  beginGesture: () => set((s) => (s.gestureBase ? {} : { gestureBase: cloneDoc(s.doc) })),

  // End a gesture: push the baseline to `past` iff the document changed visibly.
  commit: () => set((s) => {
    if (!s.gestureBase) return {};
    if (areVisuallyEqual(s.gestureBase, s.doc)) return { gestureBase: null };
    const past = [...s.past, s.gestureBase];
    if (past.length > HISTORY_CAP) past.shift();
    return { past, future: [], gestureBase: null };
  }),

  // Discrete edit = one undo step (begin + mutate + commit).
  commitEdit: (fn) => { get().beginGesture(); get().mutateDoc(fn); get().commit(); },

  undo: () => set((s) => {
    if (!s.past.length) return {};
    const prev = s.past[s.past.length - 1];
    // shadow_enabled / show_control_points are canvas toggles -> carry current.
    const restored: EditorDocument = {
      ...prev,
      shadow_enabled: s.doc.shadow_enabled,
      show_control_points: s.doc.show_control_points,
    };
    const selLives = s.selection.layerName != null && restored.strands[s.selection.layerName];
    return {
      doc: restored,
      past: s.past.slice(0, -1),
      future: [...s.future, s.doc],
      gestureBase: null,
      docRevision: s.docRevision + 1,
      selection: selLives ? s.selection : { layerName: null, handle: null },
    };
  }),

  redo: () => set((s) => {
    if (!s.future.length) return {};
    const next = s.future[s.future.length - 1];
    const restored: EditorDocument = {
      ...next,
      shadow_enabled: s.doc.shadow_enabled,
      show_control_points: s.doc.show_control_points,
    };
    const selLives = s.selection.layerName != null && restored.strands[s.selection.layerName];
    return {
      doc: restored,
      future: s.future.slice(0, -1),
      past: [...s.past, s.doc],
      gestureBase: null,
      docRevision: s.docRevision + 1,
      selection: selLives ? s.selection : { layerName: null, handle: null },
    };
  }),

  setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),
  setSettings: (patch) => set((s) => {
    const settings = { ...s.settings, ...patch };
    saveSettings(settings);
    return { settings, docRevision: s.docRevision + 1 };
  }),
  setMode: (mode) => set({ mode }),
  setSelection: (selection) => set({ selection }),
  setDragging: (dragging) => set({ dragging }),
  setDragMoving: (dragMoving) => set({ dragMoving }),
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
