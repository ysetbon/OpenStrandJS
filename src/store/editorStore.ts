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

// Defaults mirror OpenStrand Studio's user_settings.txt (settings_dialog.py
// __init__). loadSettings spreads stored values over these, so new keys backfill.
const DEFAULT_SETTINGS: Settings = {
  curve_params: { base_fraction: 1.0, dist_multiplier: 2.0, exponent: 2.0 },
  grid_size: 28,
  show_grid: false,
  snap_to_grid_enabled: true,   // OSS default; new strands draw free-angle, endpoints quantized to grid_size
  default_strand_color: DEFAULT_STRAND_COLOR,   // 200,170,230,255
  default_stroke_color: DEFAULT_STROKE_COLOR,   // 0,0,0,255
  default_strand_width: DEFAULT_STRAND_WIDTH,   // 46
  default_stroke_width: DEFAULT_STROKE_WIDTH,   // 4
  theme: 'default',
  language: 'en',

  // General
  shadow_color: { r: 0, g: 0, b: 0, a: 150 },
  draw_only_affected_strand: false,
  enable_third_control_point: false,
  enable_curvature_bias_control: false,
  snap_to_grid_attach_enabled: true,
  show_move_highlights: true,
  show_hover_highlights: true,
  skip_close_tab_warning: false,
  skip_quit_warning: false,
  num_steps: 2,
  max_blur_radius: 29.99,

  // Selected Strand
  move_selected_only: false,
  show_cp_selected_only: false,
  shadow_selected_only: false,
  view_hide_highlight: false,
  highlight_color: { r: 255, g: 0, b: 0, a: 255 },

  // Layer Panel — extension
  extension_length: 100,
  extension_dash_count: 10,
  extension_dash_width: 2,
  extension_dash_gap_length: 5.0,

  // Layer Panel — arrow
  arrow_head_length: 20,
  arrow_head_width: 10,
  arrow_head_stroke_width: 4,
  arrow_gap_length: 10,
  arrow_line_length: 20,
  arrow_line_width: 10,
  use_default_arrow_color: false,
  default_arrow_fill_color: { r: 0, g: 0, b: 0, a: 255 },

  // Layer Panel — width units + view toggles
  default_width_grid_units: 2,
  view_hide_control_points: false,
  default_transparent_start_circle: false,
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

// view.zoom is pure-OSS 1.0 (= OSS zoom_factor default). The app's "65% default
// view" look is a uniform CSS page zoom on <html> (see styles.css), which scales
// the chrome AND the canvas DISPLAY together — it is NOT baked into view.zoom, so
// the model stays 1:1 (move-mode keeps full grid snap, screenToWorld is identity-
// scale). The in-app wheel / zoom buttons drive view.zoom on top of the page zoom.
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
  // Per-mask "Edit Mask" session (OSS canvas.mask_edit_mode + editing_masked_strand).
  // When set, the InteractionHost intercepts canvas drags as deletion-rectangle
  // erases on this mask (independent of the toolbar mode), the layer panel shows
  // the edit banner + disables every other layer button, and the edited button
  // gets the red border. null == not editing a mask.
  maskEditTarget: string | null;
  // Transient panel mask-CREATE mode (OSS layer_panel Ctrl-hold masked_mode):
  // every layer button goes flat gray, the first clicked layer darkens, the second
  // click creates the over/under mask. firstMaskedLayer is the first pick (or null).
  maskCreateMode: boolean;
  firstMaskedLayer: string | null;
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
  cancelGesture: () => void;
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
  // Enter/exit the per-mask edit session. enterMaskEdit selects the mask and arms
  // erase interception; exitMaskEdit clears the target + any in-progress eraser.
  enterMaskEdit: (name: string) => void;
  exitMaskEdit: () => void;
  // Panel mask-create mode (Ctrl-hold over the layer panel).
  enterMaskCreate: () => void;
  exitMaskCreate: () => void;
  setFirstMaskedLayer: (name: string | null) => void;

  // chrome UI flags (OSS main window). Not part of the document / undo history.
  panMode: boolean;            // hand tool: left-drag pans the canvas
  // OSS canvas.is_drawing_new_strand: armed by the "New Strand" button / 'N' key.
  // While set, the next attach-mode press-drag-release draws a NEW main strand
  // (never an attach) regardless of where it starts; AttachMode clears it on the
  // press, so the mode reverts to plain attach afterwards — exactly like OSS.
  newStrandArmed: boolean;
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
  // Enter attach mode and arm a one-shot new-strand draw (OSS start_new_strand_mode:
  // sets is_drawing_new_strand + CrossCursor). No-op while lock mode is active.
  armNewStrand: () => void;
  setNewStrandArmed: (b: boolean) => void;
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
  maskEditTarget: null,
  maskCreateMode: false,
  firstMaskedLayer: null,
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
    // Any in-flight mask edit/create session belongs to the old document — drop it.
    maskEditTarget: null, maskCreateMode: false, firstMaskedLayer: null, eraser: null,
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

  // Abort a gesture: revert the live doc to the baseline and drop it WITHOUT pushing
  // history (OSS cancel_movement makes no undo entry). Restores selection to the
  // reverted doc. No-op when no gesture is in flight.
  cancelGesture: () => set((s) => {
    if (!s.gestureBase) return {};
    const doc = s.gestureBase;
    return {
      doc,
      docRevision: s.docRevision + 1,
      gestureBase: null,
      selection: { layerName: doc.selected_strand_name ?? null, handle: null },
    };
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
  // Any explicit mode switch disarms a pending new-strand draw (matching OSS, where
  // choosing another tool exits new-strand mode). armNewStrand() sets the flag
  // separately so it survives the attach-mode switch it performs.
  setMode: (mode) => set({ mode, newStrandArmed: false }),
  // Selection is ONE thing in OSS (canvas.selected_strand): the canvas highlight
  // and the layer-panel button must agree. We mirror that by keeping
  // doc.selected_strand_name in lockstep with the live selection here — the canvas
  // + StrandProperties + LayerControlStack read store.selection.layerName, while
  // NumberedLayerButton + the panel's lock logic + save/load read
  // doc.selected_strand_name. Without this sync, selecting on the canvas highlighted
  // the strand but never its layer button (and vice-versa). The doc reference is
  // cloned shallowly but docRevision is NOT bumped (selection isn't a geometry edit;
  // CanvasStage re-renders off docRevision and the modes already requestRender), so
  // this adds no undo step and no extra canvas render.
  setSelection: (selection) => set((s) => (
    s.doc.selected_strand_name === selection.layerName
      ? { selection }
      : { selection, doc: { ...s.doc, selected_strand_name: selection.layerName } }
  )),
  setDragging: (dragging) => set({ dragging }),
  setDragMoving: (dragMoving) => set({ dragMoving }),
  setHover: (hover) => set({ hover }),
  setPending: (pending) => set({ pending }),
  setMaskPending: (maskPending) => set({ maskPending }),
  setEraser: (eraser) => set({ eraser }),

  // OSS request_edit_mask -> enter_mask_edit_mode: only masked layers are editable.
  // Selects the mask (so its red outline shows), clears any pending pick, and opens
  // ONE undo gesture for the whole session — every erased rectangle accumulates live
  // and the session commits as a single undo step on exit (OSS saves once on exit,
  // not per rectangle).
  enterMaskEdit: (name) => {
    const t = get().doc.strands[name];
    if (!t || t.type !== 'MaskedStrand') return;
    set((s) => ({
      maskEditTarget: name, maskPending: [], eraser: null,
      selection: { layerName: name, handle: null },
      doc: s.doc.selected_strand_name === name ? s.doc : { ...s.doc, selected_strand_name: name },
      docRevision: s.docRevision + 1,
    }));
    get().beginGesture();   // baseline = doc with the mask selected; erases commit on exit
  },
  // OSS exit_mask_edit_mode: commit the session as one undo step (no-op if nothing
  // was erased — areVisuallyEqual discards it), then drop the target + eraser preview.
  exitMaskEdit: () => {
    if (get().maskEditTarget == null) return;
    get().commit();
    set((s) => ({ maskEditTarget: null, eraser: null, docRevision: s.docRevision + 1 }));
  },

  // OSS enter_masked_mode/exit_masked_mode (Ctrl over the layer panel).
  enterMaskCreate: () => set((s) => (s.maskCreateMode ? {} : { maskCreateMode: true, firstMaskedLayer: null })),
  exitMaskCreate: () => set((s) => (!s.maskCreateMode ? {} : { maskCreateMode: false, firstMaskedLayer: null })),
  setFirstMaskedLayer: (firstMaskedLayer) => set({ firstMaskedLayer }),

  panMode: false,
  newStrandArmed: false,
  multiSelectMode: false,
  multiSelectedLayers: [],
  previouslyLockedLayers: [],
  showTabs: true,
  drawNames: false,
  setPanMode: (panMode) => set({ panMode }),
  togglePanMode: () => set((s) => ({ panMode: !s.panMode })),
  // Switch to attach mode and arm the next draw as a new main strand. Bypassed
  // during lock mode (the "New Strand" button is disabled there in OSS).
  armNewStrand: () => set((s) => (s.doc.lock_mode ? {} : { mode: 'attach', newStrandArmed: true })),
  setNewStrandArmed: (newStrandArmed) => set({ newStrandArmed }),
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
