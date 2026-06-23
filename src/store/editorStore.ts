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

// Floating tab-edge overlay position, persisted across sessions.
const TAB_EDGE_KEY = 'openstrandjs.tabEdgePosition';
const DEFAULT_TAB_EDGE: { anchor: string; dx: number; dy: number } = { anchor: 'bottom_center', dx: 0, dy: 0 };

function loadTabEdgePosition(): { anchor: string; dx: number; dy: number } {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(TAB_EDGE_KEY);
    if (raw) return { ...DEFAULT_TAB_EDGE, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_TAB_EDGE };
}

function saveTabEdgePosition(p: { anchor: string; dx: number; dy: number }): void {
  try { localStorage.setItem(TAB_EDGE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
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
  // hold their saved doc/view. Phase 5 adds session metadata: dirty (unsaved
  // edits since last save/load), filePath (last saved/loaded path), untitledIndex
  // (the "Untitled N" number for unsaved tabs).
  tabs: {
    id: number; name: string; doc?: EditorDocument; view?: ViewState;
    dirty?: boolean; filePath?: string; untitledIndex?: number;
  }[];
  activeTabId: number;
  nextTabId: number;
  newTab: () => void;
  switchTab: (id: number) => void;
  closeTab: (id: number) => void;
  // Phase 5 tab/session.
  duplicateTab: (id: number) => void;
  markActiveDirty: () => void;
  markTabSaved: (id: number, path: string) => void;
  setTabEdgeVisible: (b: boolean) => void;
  // Floating tab-edge overlay anchor/offset, persisted to localStorage.
  tabEdgePosition: { anchor: string; dx: number; dy: number };
  setTabEdgePosition: (pos: { anchor: string; dx?: number; dy?: number }) => void;

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

  // chrome UI flags (OSS main window). Not part of the document / undo history.
  panMode: boolean;            // hand tool: left-drag pans the canvas
  multiSelectMode: boolean;    // multi-select toggle (selection logic: Phase 4)
  // Layer names currently multi-selected (OSS panel.multi_selected_layers). UI
  // state only; drives the gold/blue multi border + the 2-item multi menu.
  multiSelectedLayers: string[];
  // Snapshot of locked_layers taken when LEAVING lock mode, restored on the next
  // entry (OSS previously_locked_layers). UI state only — not undoable.
  previouslyLockedLayers: string[];
  showTabs: boolean;           // tab strip visibility (Tabs toolbar toggle)
  drawNames: boolean;          // draw layer names on the canvas (renderer task: later)
  setPanMode: (b: boolean) => void;
  togglePanMode: () => void;
  toggleMultiSelect: () => void;
  toggleMultiSelectLayer: (name: string) => void;
  clearMultiSelectedLayers: () => void;
  // Enter/exit lock mode with OSS previously_locked_layers semantics: on enter
  // restore the snapshot into doc.locked_layers; on exit snapshot+clear them. The
  // doc mutation goes through commitEdit so undo captures it.
  enterExitLockMode: () => void;
  toggleTabs: () => void;
  toggleDrawNames: () => void;
  // Clear selection AND doc.selected_strand_name in one call (no history step).
  deselectAll: () => void;
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
  tabs: [{ id: 1, name: 'Untitled 1', untitledIndex: 1 }],
  activeTabId: 1,
  nextTabId: 2,
  tabEdgePosition: loadTabEdgePosition(),

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

  // Clone the active doc into a brand-new tab named "<name> copy". The new tab
  // becomes active and starts clean (no dirty flag, fresh history).
  duplicateTab: (id) => set((s) => {
    // Persist the active doc/view into its tab first so the source is current.
    const persisted = s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, doc: s.doc, view: s.view } : t));
    const src = persisted.find((t) => t.id === id);
    if (!src) return {};
    const srcDoc = src.doc ?? (id === s.activeTabId ? s.doc : emptyDocument());
    const nid = s.nextTabId;
    const copyDoc = cloneDoc(srcDoc);
    const tabs = [...persisted, { id: nid, name: `${src.name} copy`, doc: copyDoc, view: src.view }];
    return {
      tabs, activeTabId: nid, nextTabId: nid + 1,
      doc: copyDoc, view: src.view ? { ...src.view } : { ...DEFAULT_VIEW, width: s.view.width, height: s.view.height },
      past: [], future: [], gestureBase: null,
      selection: { layerName: copyDoc.selected_strand_name ?? null, handle: null },
      docRevision: s.docRevision + 1,
    };
  }),

  // Flag the active tab dirty (unsaved edits). Wired into commit(); also callable
  // directly by non-history mutators that should still mark the tab unsaved.
  markActiveDirty: () => set((s) => {
    if (s.tabs.find((t) => t.id === s.activeTabId)?.dirty) return {};
    return { tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, dirty: true } : t)) };
  }),

  // Record that a tab was saved to `path`: clears dirty, sets filePath and name.
  markTabSaved: (id, path) => set((s) => {
    const name = path.split(/[\\/]/).pop() || path;
    return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty: false, filePath: path, name } : t)) };
  }),

  // Tab-edge overlay visibility reuses the showTabs flag.
  setTabEdgeVisible: (b) => set({ showTabs: b }),

  setTabEdgePosition: (pos) => set((s) => {
    const next = { anchor: pos.anchor, dx: pos.dx ?? s.tabEdgePosition.dx, dy: pos.dy ?? s.tabEdgePosition.dy };
    saveTabEdgePosition(next);
    return { tabEdgePosition: next };
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
  // A real edit also flags the active tab dirty (Phase 5 session tracking).
  commit: () => set((s) => {
    if (!s.gestureBase) return {};
    if (areVisuallyEqual(s.gestureBase, s.doc)) return { gestureBase: null };
    const past = [...s.past, s.gestureBase];
    if (past.length > HISTORY_CAP) past.shift();
    const tabs = s.tabs.map((t) => (t.id === s.activeTabId && !t.dirty ? { ...t, dirty: true } : t));
    return { past, future: [], gestureBase: null, tabs };
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

  panMode: false,
  multiSelectMode: false,
  multiSelectedLayers: [],
  previouslyLockedLayers: [],
  showTabs: true,
  drawNames: false,
  setPanMode: (panMode) => set({ panMode }),
  togglePanMode: () => set((s) => ({ panMode: !s.panMode })),
  // Toggling multi-select mode (on or off) always clears the multi-selection set,
  // matching OSS which resets multi_selected_layers on both enter and exit.
  toggleMultiSelect: () => set((s) => ({ multiSelectMode: !s.multiSelectMode, multiSelectedLayers: [] })),
  // Set-membership toggle by layer name.
  toggleMultiSelectLayer: (name) => set((s) => ({
    multiSelectedLayers: s.multiSelectedLayers.includes(name)
      ? s.multiSelectedLayers.filter((n) => n !== name)
      : [...s.multiSelectedLayers, name],
  })),
  clearMultiSelectedLayers: () => set({ multiSelectedLayers: [] }),

  // OSS toggle_lock_mode: entering restores previously_locked_layers into
  // doc.locked_layers; exiting snapshots doc.locked_layers into
  // previously_locked_layers then clears them. The doc mutation runs through
  // commitEdit so undo captures the lock change; the snapshot is plain UI state.
  enterExitLockMode: () => {
    const s = get();
    const entering = !s.doc.lock_mode;
    if (entering) {
      const restore = [...s.previouslyLockedLayers];
      get().commitEdit((d) => { d.lock_mode = true; d.locked_layers = restore; });
    } else {
      set({ previouslyLockedLayers: [...s.doc.locked_layers] });
      get().commitEdit((d) => { d.lock_mode = false; d.locked_layers = []; });
    }
  },

  toggleTabs: () => set((s) => ({ showTabs: !s.showTabs })),
  toggleDrawNames: () => set((s) => ({ drawNames: !s.drawNames })),

  deselectAll: () => set((s) => {
    const doc = cloneDoc(s.doc);
    doc.selected_strand_name = null;
    return {
      doc, selection: { layerName: null, handle: null }, docRevision: s.docRevision + 1,
      multiSelectedLayers: [],
    };
  }),
}));

// Convenience accessor for imperative (non-React) code.
export const editorStore = useEditorStore;
export type { StrandRecord };

// Dev-only debug handle.
if (import.meta.env?.DEV) (globalThis as Record<string, unknown>).__store = useEditorStore;
