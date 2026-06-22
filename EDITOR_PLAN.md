# OpenStrandJS — Interactive Editor Implementation Plan

Status of the world: the **renderer is done and pixel-verified** (97.85–99.68% vs Qt).
It lives in `web/strand-renderer.js` and exposes exactly two globals:

```js
window.renderFixture(strands /* flat array */, meta);   // draws onto canvas #c
window.extractStrands(fixtureJson, step?);              // pulls strands[] out of a save file
```

`renderFixture` is **stateless and idempotent**: it tears down paper, re-reads
`meta.curve_params`, redraws an offscreen `W*ss × H*ss` canvas, then downscales
into the visible `#c`. That is the entire contract the editor must honor. The
editor's whole job is to **own a live, mutable `strands` array + `meta`, mutate
it in response to pointer/keyboard input, and call `renderFixture` again** —
plus draw an interaction overlay (handles, control points, hover, selection).

The renderer reads these per-strand fields (confirmed from `fixtures/single_strand.json`
and `strand-renderer.js`): `type`, `start{x,y}`, `end{x,y}`, `width`,
`color{r,g,b,a}`, `stroke_color`, `stroke_width`, `has_circles[2]`, `layer_name`,
`control_points[cp1,cp2]`, `control_point_center`, `control_point_center_locked`,
and for `MaskedStrand`: `layer_name` `"a_b_c_d"` + `deletion_rectangles[]`.
It reads from `meta`: `curve_params{base_fraction,dist_multiplier,exponent}`,
`image_width`, `image_height`, `x_offset`, `y_offset`, `supersample`,
`shadow_enabled`. **Curve params and shadow are canvas-level, never per-strand.**

---

## 1. Target stack & architecture

**Stack: TypeScript + React + Vite, reusing `web/strand-renderer.js` (paper.js) unchanged.**

- **Vite** dev server + build. Add `index.html` (editor) alongside the existing
  `web/viewer.html` (keep the viewer as the renderer regression harness). Vite
  gives HMR, native ESM, and trivial static hosting — no webpack config to babysit.
- **React 18** for the *chrome* only: toolbar, layer panel, tab bar, dialogs,
  context menus, settings. React renders **zero strands** — strands are pixels on
  a `<canvas>`, never DOM nodes (per the canvas-core spec: "Model it as a
  CanvasController/store, NOT a React component tree per strand").
- **Zustand** for the single shared editor store (the spec repeatedly recommends
  "a single `useCanvasStore` … or `useReducer`"). Zustand is chosen over
  `useReducer`+context because (a) imperative pointer handlers outside React need
  to read/write store state synchronously via `store.getState()` without a
  re-render, and (b) we want fine-grained subscriptions so the layer panel
  re-renders without forcing a canvas repaint and vice-versa.
- **The renderer stays vanilla JS.** Do **not** rewrite it in TS or React. It is
  the proven oracle. We load it as a side-effecting script that defines
  `window.renderFixture`. A thin typed wrapper (`renderer/rendererBridge.ts`)
  declares the globals and calls them.

### How live state drives the renderer (the adapter)

The store holds rich editable strand objects (with object references for parent/
attached/knot links, transient drag state, etc.). The renderer wants a **flat
plain array** of exactly the fields above. A pure adapter bridges them:

```
store.strands (Map<layer_name, Strand>, draw-order list)  ──toRenderArray()──▶  RenderStrand[]
                                                          ──buildMeta()──────▶  RenderMeta
                                                                    │
                                                          window.renderFixture(arr, meta)
```

- `toRenderArray(doc)`: iterate `doc.order` (the z-order list of layer_names),
  emit each strand as the flat shape the renderer consumes. Strips object
  references; serializes `control_points` as `[cp1,cp2]`; for `MaskedStrand`
  emits `layer_name` + `deletion_rectangles` (the renderer re-resolves components
  by splitting the 4-part name, so we just need the name + rects right).
- `buildMeta(doc, view, settings)`: compute `image_width/image_height` from the
  canvas client size × `devicePixelRatio`; compute `x_offset/y_offset/supersample`
  to embed **zoom/pan** into the render (see below); pass `curve_params` and
  `shadow_enabled` from settings.

**Coordinate handling is the one subtle part.** The renderer maps world→pixel via
`P(pt) = (pt + offset) * ss`. The static fixtures used `offset` purely to center
content and `ss` purely to supersample. For the editor we **fold zoom/pan into
`x_offset`, `y_offset`, and `supersample`** so the renderer needs no changes:

- Effective device scale `sd = devicePixelRatio`. Render at `ss = sd` (so 1 CSS px
  = `sd` device px; the renderer already downscales `hi → #c`, so set `#c` backing
  store appropriately — Phase 1 may simply render at `ss = sd` and skip extra
  supersample).
- The view transform from `viewTransform.ts` is `screen = (world - center)*zoom +
  center + pan`. Since the renderer only offers `(world + offset) * ss`, we
  **pre-bake zoom into world coordinates is NOT acceptable** (it would corrupt the
  document). Instead, Phase 1 ships **zoom = 1, pan via offset only** (offset =
  pan/ss in world units), which the renderer supports directly. **Full zoom**
  (Phase 6) is delivered by a tiny renderer extension: pass `meta.zoom` +
  `meta.pan` and change the single `P()` line to the center-anchored affine. This
  is the *only* renderer edit in the whole plan, it is additive (defaults to the
  current behavior when `zoom` is absent), and it keeps fixture parity.

### The interaction overlay (handles / control points / hover)

Strand bodies are drawn by `renderFixture` onto `#c`. **Handles, control-point
triangles/circles, hover highlights, selection rings, the rubber-band new-strand
preview, the eraser rectangle, and grid** are drawn on a **second transparent
`<canvas id="overlay">` stacked on top** (same size/position, `pointer-events:none`
so all pointer events hit the interaction layer). The overlay is redrawn every
frame by `overlayRenderer.ts` using the **same `viewTransform` world→screen math**
as hit-testing — never the renderer's internal transform — so handles always sit
exactly where hit-tests fire (the canvas-core spec calls this desync the #1 risk).

### Render scheduling

A single `requestRender()` coalesces store changes into one rAF tick
(`renderScheduler.ts`). On tick: if `doc` changed → `renderFixture(toRenderArray,
buildMeta)`; always → redraw overlay. This replaces the Qt
`_suppress_repaint/_painting_in_progress/setUpdatesEnabled` flag soup with one
boolean `dragging` gate whose only job is **"don't recompute attachment statuses
mid-drag"** (preserve the *intent*, drop the machinery).

---

## 2. The core editable STATE MODEL (concrete TypeScript)

`src/model/types.ts` — start implementing from this verbatim.

```ts
// ---------- primitives ----------
export interface Point { x: number; y: number; }
export interface RGBA  { r: number; g: number; b: number; a: number; } // 0..255, a default 255

export type StrandType = 'Strand' | 'AttachedStrand' | 'MaskedStrand';
export type LayerName = string;                 // "1_2"  (masked: "1_2_3_1")
export type EndSide = 0 | 1;                     // 0 = start, 1 = end

// Which draggable handle a hit/selection refers to.
export type HandleKind =
  | 'start' | 'end'
  | 'control_point1' | 'control_point2' | 'control_point_center'
  | 'bias_triangle' | 'bias_circle';

// ---------- strands ----------
export interface StrandBase {
  type: StrandType;
  layer_name: LayerName;       // identity + z-order key; parsed for set/index/mask
  set_number: number;

  start: Point;
  end: Point;
  control_points: [Point, Point];      // [cp1, cp2]; collapsed onto start == straight line
  control_point_center: Point | null;
  control_point_center_locked: boolean;
  control_point2_shown: boolean;       // cp2 handle visible (after cp1 first moved)
  control_point2_activated: boolean;   // cp2 independent of endpoint
  triangle_has_moved: boolean;         // unlocks cp2/cp3 selectability

  width: number;                       // fill width (default 46; fixtures use 36)
  stroke_width: number;                // border (default 4)
  color: RGBA;
  stroke_color: RGBA;

  has_circles: [boolean, boolean];     // circle cap at [start,end]; attachable = !has_circles.every(Boolean)
  is_hidden: boolean;
  shadow_only: boolean;
  is_selected: boolean;

  // visibility / decoration flags (Phase 4+; carried verbatim through save/load)
  start_line_visible: boolean; end_line_visible: boolean;
  start_extension_visible: boolean; end_extension_visible: boolean;
  start_arrow_visible: boolean; end_arrow_visible: boolean;
  full_arrow_visible: boolean;
  closed_connections: [boolean, boolean];
  circle_stroke_color: RGBA | null;        // alpha 0 == transparent/unfolded start outline
  end_circle_stroke_color: RGBA | null;
  manual_circle_visibility: [boolean | null, boolean | null];

  // connectivity (object refs; NOT serialized as objects)
  knot_connections: Partial<Record<'start' | 'end', KnotConnection>>;
}

export interface Strand extends StrandBase {
  type: 'Strand';
  is_first_strand: boolean;
  is_start_side: boolean;
  attached_strands: AttachedStrand[];  // children
}

export interface AttachedStrand extends StrandBase {
  type: 'AttachedStrand';
  parent: Strand | AttachedStrand;     // back-ref
  attachment_side: EndSide;            // which parent endpoint we hang off
  attached_strands: AttachedStrand[];
}

export interface MaskedStrand {
  type: 'MaskedStrand';
  layer_name: LayerName;               // "a_b_c_d": first="a_b" (OVER), second="c_d" (UNDER)
  set_number: number;
  first_layer_name: LayerName;         // resolved by splitting layer_name (NOT object refs)
  second_layer_name: LayerName;
  deletion_rectangles: DeletionRect[];
  control_point_center: Point | null;  // edited/base center; keeps rects absolute on load
  using_absolute_coords: boolean;      // true right after load → don't re-translate rects
  is_hidden: boolean;
  shadow_only: boolean;
  is_selected: boolean;
}

export type AnyStrand = Strand | AttachedStrand | MaskedStrand;

export interface KnotConnection {
  connected_strand_name: LayerName;
  connected_end: 'start' | 'end';
  is_closing_strand?: boolean;
}

// corner schema is what the desktop app writes; renderer also accepts {x,y,width,height}
export interface DeletionRect {
  top_left: [number, number]; top_right: [number, number];
  bottom_left: [number, number]; bottom_right: [number, number];
}

// ---------- groups ----------
export interface Group {
  name: string;
  layers: LayerName[];          // resolved membership snapshot
  main_strands: LayerName[];    // stored roots ("x_1"); full membership resolved by branch prefix
  control_points: Record<LayerName, { cp1: Point; cp2: Point; center: Point | null; center_locked: boolean }>;
}

// ---------- the document (one tab / one undo snapshot) ----------
export interface Document {
  order: LayerName[];                         // draw order == z-order (last = topmost)
  strands: Record<LayerName, AnyStrand>;      // keyed by layer_name
  groups: Record<string, Group>;
  selected_strand_name: LayerName | null;
  locked_layers: LayerName[];
  lock_mode: boolean;
  shadow_enabled: boolean;                    // EXCLUDED from undo dedup; preserved across undo
  show_control_points: boolean;               // EXCLUDED from undo dedup
  shadow_overrides: Record<string, unknown>;  // INCLUDED in undo
}

// ---------- selection ----------
export interface Selection {
  index: number | null;            // index into doc.order
  layerName: LayerName | null;
  controlPoint: HandleKind | null; // which handle, if a handle is the active selection
  multi: Set<LayerName>;           // multi-select set (layer panel)
}

// ---------- modes ----------
export type ModeName =
  | 'view' | 'attach' | 'move' | 'select' | 'mask'
  | 'rotate' | 'angle_adjust' | 'new_strand';

// ---------- view / camera ----------
export interface ViewState {
  zoom: number;     // 0.1 .. 5.0  (Phase 1 pins to 1.0)
  panX: number; panY: number;
  width: number; height: number;     // canvas CLIENT size in CSS px
  dpr: number;                        // devicePixelRatio
}

// ---------- settings ----------
export interface Settings {
  curve_params: { base_fraction: number; dist_multiplier: number; exponent: number }; // 1.0/2.0/2.0
  grid_size: number;                  // 28
  show_grid: boolean;
  snap_to_grid_enabled: boolean;
  snap_to_grid_attach_enabled: boolean;
  enable_third_control_point: boolean;
  enable_curvature_bias_control: boolean;
  default_strand_color: RGBA;         // purple 200,170,230,255
  default_stroke_color: RGBA;         // black
  default_strand_width: number;       // 46
  default_stroke_width: number;       // 4
  theme: 'default' | 'light' | 'dark';
  language: 'en' | 'fr' | 'it' | 'es' | 'pt' | 'he';
}

// ---------- history (snapshot-based, matches undo_redo spec) ----------
export interface HistoryState {
  past: Document[];      // immutable snapshots
  present: Document;
  future: Document[];
}
```

### The full editor store (`src/store/editorStore.ts`)

```ts
interface EditorStore {
  history: HistoryState;     // .present is THE document
  selection: Selection;
  mode: ModeName;
  previousMode: ModeName;    // restored after angle_adjust / dialogs
  view: ViewState;
  settings: Settings;
  dragging: boolean;         // true during a pointer drag → skip attachment recompute
  // transient sub-states (not in the document, not undone):
  newStrand: { active: boolean; start: Point | null; end: Point | null; setNumber: number } | null;
  maskPending: LayerName[];          // 0..2 picked strands for mask creation
  maskEdit: { layerName: LayerName | null; eraseStart: Point | null; eraseRect: Rect | null };
  hover: { layerName: LayerName | null; handle: HandleKind | null };

  // actions (each mutating one pushes an undo snapshot at gesture END, not per-change)
  dispatch(action: Action): void;     // or discrete action methods
  commit(): void;                     // push history.present → past, dedup via areVisuallyEqual
  undo(): void; redo(): void;
}
```

**Document is treated as immutable for history**; live editing mutates a *draft*
(Immer-style or structural clone of `present`), and `commit()` snapshots it.
Object-reference links (`parent`, `attached_strands`, `knot_connections`) are
**rebuilt from `attached_to`/names after every load and after every structural
clone** by `model/linkResolver.ts`, so snapshots stay serializable.

---

## 3. React component tree + canvas interaction/mode system

### Component tree (chrome only — never strands)

```
<App>                                  app shell: layout, theme, language(dir=rtl for he)
├─ <Toolbar>                           mode buttons + toggles (grid/shadow/control-points) + save/load/export
├─ <CanvasStage>                       owns BOTH <canvas id="c"> and <canvas id="overlay">
│    └─ (imperative) InteractionHost   attaches pointer/wheel/key listeners; routes to active Mode
├─ <LayerPanel>                        reversed list of layer rows + group tree (Phase 3)
│    ├─ <LayerRow>* (one per strand, rendered [...order].reverse())
│    ├─ <LayerContextMenu>             per-layer right-click menu (Phase 4)
│    └─ <GroupPanel>                   groups tree (Phase 6)
├─ <TabBar>                            multi-tab sessions (Phase 6)
├─ <SettingsDialog> / <AngleAdjustDialog> / <ColorPicker>   modals (Phase 5/6)
```

`<CanvasStage>` is the only component touching `<canvas>`. It subscribes to the
store, and on every relevant change calls `requestRender()`. It mounts an
`InteractionHost` (plain TS class, not React) that owns the DOM listeners so
high-frequency `pointermove` never triggers React re-renders.

### Mode system

```ts
// src/modes/Mode.ts
export interface ModeContext {
  store: EditorStore;                 // read/write via getState()/setState()
  screenToWorld(p: Point): Point;     // viewTransform inverse, dpr-aware
  worldToScreen(p: Point): Point;
  hitTest(world: Point): HitResult;   // shared topmost-strand / handle hit-test
  requestRender(): void;
}
export interface PointerInfo {
  world: Point; screen: Point;
  button: number; buttons: number;    // map middle/right via e.button/e.buttons
  ctrl: boolean; shift: boolean; alt: boolean;
}
export interface Mode {
  readonly name: ModeName;
  readonly cursor: string;            // CSS cursor for the canvas element
  activate(ctx: ModeContext): void;
  deactivate(ctx: ModeContext): void;
  onPointerDown(p: PointerInfo, ctx: ModeContext): void;
  onPointerMove(p: PointerInfo, ctx: ModeContext): void;
  onPointerUp(p: PointerInfo, ctx: ModeContext): void;
  onKeyDown?(e: KeyboardEvent, ctx: ModeContext): void;
}
```

### Event routing (in `InteractionHost`)

1. Listen for `pointerdown/move/up`, `wheel`, `contextmenu`, and a single
   top-level `keydown` on `window`.
2. On `pointerdown`: `setPointerCapture` so drags continue outside the canvas.
3. Convert `clientX/Y → world` via `screenToWorld` (center-anchored, dpr-aware) —
   **this exact math must match the overlay and the renderer's `P()`** or handles
   drift.
4. **Intercept FIRST, before the mode** (canvas-core spec — these are inline in Qt
   and should become real handlers, but routing precedence is preserved):
   - middle-drag, right-drag, or `pan` toggle → **pan** (clamped to content bbox +
     8000px fallback rect; port `get_bounding_rect`).
   - `wheel` → zoom `×1.1 / ×0.9`, clamp `[0.1, 5]`, about canvas center.
   - active **mask-edit** eraser drag → overlay rect, commit deletion rect on up.
   - active **group move/rotate** → group transform.
5. Otherwise delegate to `modes[store.mode].onPointer*`.
6. `keydown`: top-level dispatch (swallow Space so focused buttons don't activate;
   guard autorepeat). Map `Z/X` undo/redo, `Esc` exit sub-modes, mode hotkeys.

`modes` is a registry `Record<ModeName, Mode>`. `setMode(name)` calls
`deactivate` on the old, `activate` on the new, sets `canvas.style.cursor`, and
updates the toolbar checked/disabled matrix (active mode's button disabled).

### Shared hit-testing (`src/interaction/hitTest.ts`)

Priority order (move-mode spec): **bias controls → cp1 → cp2(if shown) →
cp3(if enabled & triangle_has_moved) → endpoints → topmost strand body**.
- Endpoint/handle zones are **axis-aligned squares** in world space: endpoints
  `120×120` (move) / `~120px circle` (attach), control points `50×50`. Not circles
  for move. Attach uses a **120px-diameter circle** around free endpoints.
- Body hit-test reuses the renderer's geometry: build each strand's stroked body
  as a `paper.Path` (via the renderer's `strokedBodyAtWidth`, exposed for reuse)
  and call `path.contains(worldPt)`; iterate `order` **reversed** → first hit is
  topmost. Skip `is_hidden`, `MaskedStrand` (not body-selectable in most modes),
  and locked layers.

---

## 4. Dependency-ordered PHASED roadmap

Each phase is a **shippable increment** described by what the **user can DO**.
Phases 1–2 must be **coherent single-author** work (the model, store, transform,
mode plumbing, and the renderer adapter are deeply interdependent and define the
contracts everything else builds on). Phases 3+ are **parallelizable / map cleanly
to a future build-workflow**, since each is a fairly self-contained subsystem that
talks to the store through stable actions.

### Phase 1 — MVP: open, select, move, draw, attach, mask-toggle, save/load
**Author: single, coherent.** This phase defines all the load-bearing contracts.

After this phase the user can:
- **Load** a real OpenStrandStudio save (`.json`, both the bare `{strands,groups}`
  and the `OpenStrandStudioHistory` wrapper) and see it render pixel-faithfully.
- **Select** the topmost strand by clicking its body; click empty space to deselect.
- **Move** an endpoint or a control point by dragging (with connected/attached
  strands following rigidly via the connection graph); grid-snap respected.
- **Draw a new strand** (arm "new strand", press-drag-release; 45° lock on the
  first strand of a set) and **attach a child** by dragging out of a free
  endpoint's 120px circle.
- **Toggle over/under**: enter mask mode, click two strands → a `MaskedStrand`
  appears on top (correct OVER/UNDER order).
- **Save** the document back to the authentic Python JSON format and re-open it.

Scope notes / must-get-right:
- `viewTransform` + dpr correctness (no handle drift).
- The **save/load multi-pass loader** (pass1 Strands → pass2 AttachedStrand
  fixpoint by `attached_to` → pass3 MaskedStrand 4-part split → pass4 has_circles
  recompute w/ `manual_circle_visibility` → pass5 knot_connections relink). Build a
  **format normalizer** so we read the *real* `attached_to` format, not the
  fixture's `parent_layer_name` shorthand.
- `layer_name` allocator = **lowest free integer** within a set, not count+1.
- The **connection graph** (`layerStateManager.ts` → `getConnections()`):
  move-mode is meaningless without it; derive from `attached_strands` +
  `attachment_side` + `knot_connections`.
- Zoom pinned at 1.0; pan via offset only (full zoom deferred to Phase 6).
- Undo deferred: each gesture just `commit()`s into a trivial single-slot history;
  no dedup yet.

### Phase 2 — Robust move/attach + control-point editing + curve handles
**Author: single, coherent** (extends Phase 1 mode internals).

After this phase the user can:
- Drag control-point handles to **curve** a strand; cp2 passive→active state
  machine works (cp1-first-move reveals cp2; dragging cp2 off the endpoint
  activates it; third control point when enabled in settings).
- See **hover highlights** on endpoints/handles and **selection rings** on the
  overlay; cursor changes per mode.
- Chain attachments off any free end; `has_circles` correctly marks occupied ends
  and is **rolled back** if a drag is cancelled/zero-length.
- Mask-edit eraser: right-click a mask → "Edit mask" → drag eraser rectangles that
  subtract from the overlap; "Reset mask" restores the full intersection.

### Phase 3 — Layer panel (list, selection sync, reorder, visibility)
**Author: parallelizable subsystem.** Talks to store via actions only.

After this phase the user can:
- See one **row per strand** (rendered `[...order].reverse()` so visual top =
  z-top), label = `layer_name`, background = strand color, masked rows bordered in
  the second component's color.
- **Click a row** to select (selection stays in sync both directions with canvas).
- **Drag-and-drop reorder** z-order (blue insertion line; restore selection by
  identity).
- **Hide/Show**, **Delete**, **Delete All**, **Deselect All**, **Add New Strand**,
  **Draw Names** toggle, **Lock Layers** mode (locked layers unselectable/unmovable).

### Phase 4 — Per-layer state + color + masked-mode in panel
**Author: parallelizable subsystem** (extends Phase 3; many small toggles).

After this phase the user can:
- Right-click a layer → context menu: change **color/stroke/width** (custom RGBA
  picker with alpha — native `<input type=color>` has no alpha), **hide/shadow-only**,
  line/extension/arrow/circle toggles (conditionally shown per the Qt rules:
  circle toggles only when an attached strand sits on that endpoint; close-the-knot
  only at exactly one free end), masked rows get **Edit/Reset mask**.
- **Color propagation**: changing a set's color recolors every strand+row in that
  set and masked borders.
- Create a mask from the panel in **masked mode** (Ctrl + click two rows).

### Phase 5 — Undo/redo (snapshot history + visual-difference dedup)
**Author: single, coherent** (cross-cuts every mutating action; the dedup is exact).

After this phase the user can:
- **Undo/redo** every meaningful edit; one snapshot per *gesture* (not per
  intermediate move), linear history (a new edit after undo drops the redo branch).
- Trivial toggles that change nothing visible **don't** create dead undo steps;
  undo/redo **skip visually-identical** states.

Must-get-right: port `areVisuallyEqual` (~30 fields, exact tolerances: 0.1px
positions, 1e-3 bias, exact int RGBA, order-independent rect signatures,
`null↔value` circle-stroke transitions). **`shadow_enabled` and
`show_control_points` are EXCLUDED from dedup and preserved across undo;
`shadow_overrides` IS undoable** (easy to get backwards). Commit at gesture end,
never per store change. Freeze connection recompute while `dragging`.

### Phase 6 — Rotate/angle tools, settings, zoom/pan, tabs, groups, image export
**Author: mostly parallelizable** (each is a discrete subsystem); zoom is the one
piece that touches the renderer.

After this phase the user can:
- **Rotate** a strand endpoint around the opposite (length-preserved, rAF easing,
  no OS-cursor warp) and **angle-adjust** via a modal (Angle/Length sliders +
  spinboxes, keyboard nudges, X-chord; one undo per dialog session).
- **Zoom/pan** fully (wheel zoom `[0.1,5]`, clamped pan) — delivered by the single
  additive `meta.zoom`/`meta.pan` extension to the renderer's `P()`.
- Edit **settings** (theme, language incl. Hebrew RTL, curve params, grid, default
  colors) persisted to `localStorage`.
- Work in **multiple tabs** (capture/restore document per tab, dirty flags,
  Untitled N, Save/Discard/Cancel close flow; persisted to IndexedDB).
- Use **groups** (create/move/rotate with absolute-angle snapshot, branch-prefix
  membership), and **export the canvas as a PNG** (offscreen high-DPI `toDataURL`).

### Workflow mapping summary
| Phase | Nature | Build-workflow friendly? |
|---|---|---|
| 1 MVP | model + store + transform + adapter + loader + core modes | **No** — single coherent author; defines all contracts |
| 2 move/curve/mask-edit | mode internals | **No** — tightly coupled to Phase 1 internals |
| 3 layer panel | self-contained React subsystem over store actions | **Yes** |
| 4 per-layer toggles/color | self-contained, additive | **Yes** |
| 5 undo/redo | cross-cutting + exact dedup port | **No** — single author, must be coherent |
| 6 rotate/settings/tabs/groups/zoom/export | discrete subsystems | **Mostly yes** (zoom touches renderer once) |

---

## 5. Phase 1 file/module list (the MVP)

Create under `src/` (TS) and root (Vite config / html). One-line responsibilities:

**Build / entry**
- `vite.config.ts` — Vite config; root html = editor `index.html`; copies
  `web/strand-renderer.js` + paper.js as static assets.
- `index.html` — editor page; loads paper.js then `strand-renderer.js` (defines
  `window.renderFixture`), then the React bundle; has `#c` + `#overlay` + `#root`.
- `src/main.tsx` — React entry; mounts `<App>`.

**Model**
- `src/model/types.ts` — all the types from §2 (Strand/AttachedStrand/MaskedStrand,
  Document, Selection, ViewState, Settings, HistoryState, etc.).
- `src/model/factory.ts` — `makeStrand()/makeAttachedStrand()/makeMaskedStrand()`
  with correct defaults (width 46, stroke 4, purple default color, has_circles).
- `src/model/layerName.ts` — parse/format `layer_name`; **lowest-free-integer**
  set/index allocator; masked 4-part split.
- `src/model/linkResolver.ts` — rebuild object refs (parent / attached_strands /
  knot_connections) from names after load/clone; resolve mask components by name.
- `src/model/curveProfile.ts` — *(optional in P1)* TS mirror of `buildProfile` for
  hit-testing tangents; otherwise reuse the renderer's exported geometry.

**Store**
- `src/store/editorStore.ts` — the Zustand store (§2): document/selection/mode/
  view/settings/transients + actions + trivial single-slot history.
- `src/store/actions.ts` — pure document mutators (addStrand, moveHandle,
  attachChild, createMask, deleteStrand, reorder) used by modes and panel.

**Renderer bridge / adapter**
- `src/renderer/rendererBridge.ts` — typed `declare` of `window.renderFixture` /
  `window.extractStrands`; `callRender(arr, meta)`.
- `src/renderer/toRenderArray.ts` — adapter: `Document → RenderStrand[]` (flat,
  draw-order) and `buildMeta(doc, view, settings) → RenderMeta`.
- `src/renderer/renderScheduler.ts` — rAF-coalesced `requestRender()`; calls
  renderFixture + overlay redraw; holds the `dragging` gate.

**Coordinate / view**
- `src/interaction/viewTransform.ts` — `screenToWorld` / `worldToScreen`
  (center-anchored, dpr-aware); pan clamp helper (`get_bounding_rect` + 8000px
  fallback). **Single source of truth shared by hit-test, overlay, adapter.**

**Interaction / modes**
- `src/interaction/InteractionHost.ts` — attaches pointer/wheel/key listeners,
  pointer capture, the pan/zoom/intercepts, delegates to active mode.
- `src/interaction/hitTest.ts` — shared topmost-strand + handle hit-test
  (priority order, square/circle zones, reversed-order body containment).
- `src/modes/Mode.ts` — the `Mode` interface + `ModeContext`/`PointerInfo` (§3).
- `src/modes/index.ts` — `modes` registry + `setMode()`.
- `src/modes/SelectMode.ts` — click→select topmost / deselect.
- `src/modes/MoveMode.ts` — drag endpoints + control points; connection
  propagation via the connection graph; grid snap; mouse-offset capture.
- `src/modes/AttachMode.ts` — new-strand (45° lock) + attach-to-endpoint (120px
  circle, has_circles toggle + rollback, lowest-free layer_name).
- `src/modes/MaskMode.ts` — two-click ordered over/under → create MaskedStrand
  appended last; skip masks/duplicates.
- `src/interaction/layerStateManager.ts` — derive the connection graph
  `getConnections()` from attachments + knot_connections (move-mode depends on it).

**Overlay**
- `src/overlay/overlayRenderer.ts` — draw grid, selection ring, hover, control-
  point triangles/circles, new-strand rubber-band, eraser rect, using
  `viewTransform` (never the renderer's transform).

**Save / load**
- `src/io/saveLoad.ts` — `serializeProject(doc) → ProjectJSON` and
  `loadProject(json) → Document` via the **multi-pass loader** (pass1..pass5);
  format normalizer (`attached_to` ↔ fixture shorthand); preserve circle-stroke
  alpha 0 and masked `using_absolute_coords` round-trip.
- `src/io/fileDialog.ts` — browser Save (Blob download / File System Access) +
  Open (file input → parse → `loadProject`).

**Chrome (minimal React for P1)**
- `src/ui/App.tsx` — layout (canvas region + a thin toolbar); theme/dir.
- `src/ui/CanvasStage.tsx` — owns `#c` + `#overlay`, mounts `InteractionHost`,
  wires `requestRender`.
- `src/ui/Toolbar.tsx` — mode buttons (select/move/attach/mask), New Strand,
  Save, Load, grid/shadow toggles.

This is enough to ship the MVP: load a real file, select/move/draw/attach/mask,
save it back — all rendered by the unchanged, pixel-verified `strand-renderer.js`.
