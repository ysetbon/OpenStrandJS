# OSS UI Port — Gap Analysis & Implementation Plan

> Canonical reference for porting the OpenStrandJS chrome (main window, layer panel, groups)
> to match OpenStrand Studio (PyQt). Produced from a full read of `OpenStrandStudio/src`
> (`main_window.py`, `layer_panel.py`, `group_layers.py`, `tab_*.py`, `translations.py`,
> `settings_dialog.py`, `numbered_layer_button.py`) vs the current `OpenStrandJS/src` UI.
> Section 2 is the constant-exact visual spec handed to each implementer.

## 0. Progress log

**Scope decisions (user, 2026-06-22):** all 3 themes now · full OSS group ops · zoom
buttons = disabled placeholders (pan + center functional) · hide samples behind a dev flag ·
pixel-exact. **Revised:** the inline `StrandProperties` editor was REMOVED from the layer
panel (it appeared on select/create and OSS has no such panel) — strand color/stroke/width
are edited via the OSS layer right-click menu. `StrandProperties.tsx` stays on disk, unmounted.

**DONE — Phases 0–3 (main-window chrome):**
- **0.1 theme tokens** — `src/ui/theme.css` (default/light/dark token sets, §2.6); `styles.css`
  rewritten to consume `var(--…)`; theme-independent button colors stay literal.
- **0.2 i18n** — `src/ui/translations.ts` (75 keys × 7 langs incl. `de`, from `translations.py`);
  `i18n.ts` now wraps it + adds `tt()`. SettingsDialog gained the `de` option.
- **0.3 RTL** — `App.tsx` sets `dir`/theme class on `<html>`; canvas wrapper forced `dir=ltr`.
  Verified: Hebrew flips panel→left, toolbar reverses, canvas un-mirrored.
- **1.1 splitter shell** — `App.tsx` + `Splitter.tsx`; left_widget (Toolbar over Canvas) | 1px
  handle | LayerPanel (min 350, draggable). TabBar moved to a floating placeholder over canvas.
- **2.1 mode enum** — `ModeName` += view/rotate/angle; `Language` += de; `modes/index.ts`
  registers passive stubs (`PassiveMode.ts`).
- **2.2 OSS toolbar** — `Toolbar.tsx` + `toolbar.css`: all 16 buttons, exact §2.2 colors,
  checked=4px black border, Points checked-by-default; samples hidden behind `import.meta.env.DEV`;
  Tabs button toggles `showTabs`. (State button is a visual stub — Phase 7.)
- **3.x control column** — `ControlColumn.tsx` + `controlColumn.css`: 4 rows of 40×40 round
  buttons (§2.3). Undo/redo/refresh/center/reset functional; pan = hand-tool (wired into
  `InteractionHost`); zoom in/out = disabled placeholders; multi-select toggles a store flag.
  Store gained `panMode/multiSelectMode/showTabs` + toggles.
- Build: `npm run build` (tsc) clean. Verified live (5175) in default + dark + Hebrew-RTL.

**DONE — Phases 4–7 (layer panel, tabs, groups, polish) — via the `oss-ui-phases-4-7` workflow:**
- **Backend** (`actions.ts`/`editorStore.ts`/`types.ts`): lock-mode (`toggleLockMode`/`clearAllLocks`),
  `renameLayer` (rewrites order/key/locks/selection/attached_to/mask names), `drawNames`+toggle,
  `deselectAll`; groups gained `createGroup`(arbitrary)/`renameGroup`/`duplicateGroup`/`rotateGroup`
  (about centroid)/`setGroupShadowOnly`/`createMaskGrid`; tabs gained `dirty`/`filePath`/`untitledIndex`,
  `duplicateTab`/`markActiveDirty`(wired into `commit()`)/`markTabSaved`/`tabEdgePosition` persistence.
- **Phase 4** — `NumberedLayerButton.tsx` (146×40, strand fill, 1px #888 border, all states incl.
  masked 5px second-color border, hidden hatch, locked overlay, shadow-only dashed, multi-select gold/blue),
  `LayerControlStack.tsx` (6 buttons, exact colors, lock-mode relabel Lock→Exit Lock / Deselect→Clear
  Locks + disables New/Delete), layer right-click menu (Hide/Shadow Only/Edit Shadows/Change Color/Stroke/Width
  or Edit/Reset Mask). `ContextMenu.tsx` + `Modal.tsx` shared primitives.
- **Phase 5** — `TabEdge.tsx`/`TabChip.tsx`: floating draggable tab edge (grip, magnet snap, +新tab,
  dirty dot, duplicate, close-with-unsaved-prompt). Replaced the placeholder `.tabbar`.
- **Phase 6** — `GroupPanel.tsx` (themed Create Group button + ▼/▶ tree + members) + the 5 dialogs
  (`GroupMoveDialog` X/Y −600..600, `GroupRotateDialog` −180..180, `GroupShadowEditorDialog`,
  `RenameDialog`, `MainStrandSelectDialog`) + the exact 9-item group context menu.
- **Phase 7** — State button → `LayerStateDialog`; SettingsDialog parity (select_theme/select_language,
  localized theme labels). Build tsc-clean; live-verified: numbered buttons, control stack + lock-mode,
  layer & group context menus (exact OSS order), Create-Group + Move dialog, tab dirty-tracking.

**UI parity comparison (2026-06-23):** added a chrome side-by-side harness —
`tools/grab_main_window.py` renders the REAL OSS `MainWindow` offscreen via `widget.grab()`
(note: Qt offscreen omits button *text*; colors/sizes/layout are accurate), and
`tools/ui_compare.mjs` captures the JS app at 1400×860 (headless Chromium) and composites
`artifacts/ui_compare/{oss_main,js_main,ui_sidebyside,ui_diff}.png`. The diff % is font/AA/
engine noise, not renderer fidelity. The comparison found + FIXED three layout gaps:
(1) group panel is now a side-by-side **fixed 270px right column** (`layer-panel` → row with
`.lp-left`/`.lp-right`), matching OSS `layer_panel.py` QHBoxLayout; (2) the control column is
now a **3×3 grid** (home+undo+redo on row 1); (3) the toolbar was tightened (38px/14px/4px
padding, gap 5, panel 490) so all 14 labels + State + gear fit at 1400px without truncation.
Colors/order/button-set already matched.

**Remaining / known gaps:**
- **Canvas interior stays white in dark theme** — pixel-faithful renderer paints white; OSS dark canvas
  is #2C2C2C. Theming the renderer clear color affects the fidelity harness — deferred, decide separately.
- **`createMaskGrid`** is best-effort pairwise (not the faithful crossing/ordering logic) — has a TODO.
- **`edit_strand_angles`** menu item is a placeholder (no dialog yet).
- **Draw Names** toggles a store flag but canvas name-drawing is a later renderer task.
- Multiline tooltips + full RTL audit of the new dialogs/menus not yet done.

---

## 1. Summary

OpenStrandJS today has a **functionally complete but visually generic** editor UI. The renderer is pixel-faithful to OpenStrand Studio (OSS), and the Zustand store + pure mutators already cover the core editing operations (move/attach/mask, color/width, per-layer hide/lock, minimal groups, tabs, undo/redo, save/load). What is missing is essentially the entire **OSS "look and feel" layer**: the colored toolbar mode buttons, the round left control column, the OSS layer-panel chrome (146×40 numbered layer buttons, the 6-button colored control stack), the QTreeWidget-style groups panel with its context menu and dialogs, the floating draggable tab edge, a real **theme system** (default/light/dark), and a real **i18n table** (7 languages incl. Hebrew RTL). The current chrome is a single flat light bar with English-only literal labels; only `theme-dark` has any CSS, and `theme-default`/`theme-light` are identical bare-light.

The effort is **large but well-bounded**, because the data/operation layer mostly exists. Roughly 70–80% of the work is **presentational** (CSS + component restructuring driven by exact OSS constants already captured in the spec) and the remaining 20–30% is **net-new behavior/state**: a theme→color mapping, a full i18n string table, lock-mode, layer rename, group rename/duplicate/move/rotate/shadow dialogs, the floating tab-edge overlay with magnet anchors, and a few missing store actions (`lock_mode` toggle, rename, group ops, selection→doc sync).

**Key architectural decisions:**
1. **Introduce a centralized theme system.** OSS applies one big app-wide QSS string per theme plus widget-level overrides. The JS equivalent is a **CSS variables (custom properties) layer** defined per `.theme-default` / `.theme-light` / `.theme-dark` on `<html>`, with all chrome CSS rewritten to consume the variables. Hard-coded OSS toolbar/column/layer-button colors that are **theme-independent in OSS** (the colored mode buttons, the round column buttons, the 6 layer-control buttons) should stay literal — only window/panel/scrollbar/dialog/group colors are theme-driven.
2. **Build a full i18n table** mirroring `translations.py` (7 languages: en, fr, de, it, es, pt, he), replacing the current 11-key stub. Drive RTL off `language==='he'` exactly as OSS does (`is_rtl_language`), flipping the splitter order, toolbar order, panel side, and the tab edge.
3. **Reuse the existing store wherever possible**; extend it only for: `lock_mode` toggle + lock-mode UI behavior, layer/group rename, the richer group operations (move/rotate/duplicate, shadow overrides), and the tab-edge position persistence. Most presentational items need **no** store changes.
4. **Restructure the layout shell** from the current flat `column(Toolbar, TabBar, workarea)` into the OSS shape: a horizontal splitter with `left_widget` (toolbar-over-canvas) on one side and the layer panel on the other; the tab UI becomes a **floating overlay on the canvas**, not a docked strip.

---

## 2. Target visual spec (condensed, constant-accurate)

### 2.1 Window shell & layout

| Property | Value |
|---|---|
| Title | "OpenStrand Studio" (translated key `main_window_title`) |
| Default state | **Maximized** (web: fill viewport; no fixed size) |
| Shell | Horizontal splitter. **Index 0** = `left_widget` (toolbar on top, canvas below; vbox margins 0, spacing 0). **Index 1** = layer panel (RIGHT in LTR). |
| Splitter handle | width **1px**, transparent, no border |
| left_widget min width | **300px** |
| layer_panel min width | **350px** (current JS panel is only 230px — must widen) |
| Stretch | index 0 → 1 (grows); index 1 → 0 (fixed) |
| RTL (`he`) | whole splitter reverses: layer panel LEFT, canvas/toolbar RIGHT; toolbar order flips; **canvas painting forced LTR** |

### 2.2 Toolbar (mode-button row)

Container: hbox, **spacing 10px**, margins **4,2,4,2**, fixed height **40px**. Per-button: max-width **90px**, fixed height **32px**, border-radius **6px**, bold **14px**, **black** text, padding `0 4px`. **Checked/active = same fill + 4px solid black border.** Hover = lighter; pressed = darker + 1px inset.

Order left→right, then a stretch, then State + Settings:

| # | Object | EN label | key | normal / hover / pressed | checkable | action |
|---|---|---|---|---|---|---|
|1|view|View|`view_mode`|`#ccbaba` / `#E2C4C4` / `#B88A8A`|excl|setMode('view')|
|2|mask|Mask|`mask_mode`|`#199693` / `#4CCBC8` / `#0F625F`|excl|setMode('mask')|
|3|select|Select|`select_mode`|`#F1C40F` / `#F9E287` / `#BB9A0C`|excl|setMode('select')|
|4|attach|Attach|`attach_mode`|`#9B59B6` / `#D5A6E6` / `#703D80`|excl|setMode('attach')|
|5|move|Move|`move_mode`|`#D35400` / `#FFA366` / `#A84300`|excl|setMode('move')|
|6|rotate|Rotate|`rotate_mode`|`#3498DB` / `#92C9F0` / `#216B97`|excl|(rotate — **missing mode**)|
|7|toggle_grid|Grid|`toggle_grid`|`#E93E3E` / `#FF7070` / `#ab2e2e`|yes|toggle `settings.show_grid`|
|8|angle_adjust|Angle|`angle_adjust_mode`|`#B89EE6` / `#D4C2F2` / `#9B84C9` (disabled `#7D6AA6`)|excl|(angle — **missing**)|
|9|save|Save|`save`|`#E75480` / `#FF9FBB` / `#B64064`|**no**|save_project|
|10|load|Load|`load`|`#8D6E63` / `#BEA499` / `#8D6E63`|**no**|load_project|
|11|save_image|Image|`save_image`|`#7D344D` / `#B36E89` / `#7D344D`|**no**|exportPng|
|12|toggle_control_points|Points|`toggle_control_points`|`#4CAF50` / `#81C784` / `#388E3C`|yes, **checked by default**|toggle `show_control_points`|
|13|toggle_shadow|Shadow|`toggle_shadow`|`rgba(176,190,197,.7)` / `rgba(196,207,212,.7)` / `rgba(156,173,182,.7)` (disabled `rgba(136,156,167,.7)`)|yes, unchecked|toggle `shadow_enabled`|
|14|tabs|Tabs|`tabs`|`#a34d92` / `#b85baa` / `#833a75`|yes, unchecked|toggle tab-edge visibility|
| — stretch — |
|15|layer_state|State|`layer_state`|`#FFD700` / `#FFC200` / `#FFB700`; **border:none; border-radius:0; padding 8px 4px**|yes|show layer-state log|
|16|settings|(gear `⚙`)|`settings`|`rgba(150,150,150,255)`; border:none; **border-radius:18px**; hover `rgba(200,200,200,50)`; **32×32**, icon 24|—|open settings|

Exclusive group = {view, mask, select, attach, move, rotate, angle_adjust}: `setChecked(mode==active)`. Grid/Points/Shadow/Tabs/State are independent toggles.

### 2.3 Left vertical control column (top of layer panel)

All buttons **40×40**, `border-radius:20px` (circular), PNG icon with emoji fallback. Rows centered (HCenter). Shared disabled style: bg `#D3D3D3`, text `#808080`, border `1px #A9A9A9`.

| Row | Button | emoji | normal / hover / pressed / border | checkable |
|---|---|---|---|---|
|A|reset_states|🏠|`#8A2BE2` / `#DA70D6` / `#663399`; border `1px #6A1B9A`, white 20px|—|
|B|undo|⮌|blue `#4387c2` / `#2c5c8a` / `#10253a`; border `#3c77a5`/`#1d4168`/`#ffffff`; glyph 30px; **starts disabled** (`#8a8a8a`/`#696969`)|—|
|B|redo|⮎|same blue set|—|
|C|zoom_in|🔍|`#FFD700` / `#FFA500` / `#FF8C00`; border `1px #B8860B`, black 20px|—|
|C|zoom_out|🔎|same gold set|—|
|C|pan|🖐|`#8B0000` / `#DC143C` / `#400000`; **checked `#400000`**; border `1px #4B0000`, white 24px|**yes**|
|D|refresh|🔄|`#32CD32` / `#00FF00` / `#228B22`; border `1px #228B22`, white 20px|—|
|D|center|🎯|`#D2B48C` / `#CD853F` / `#654321`; border `1px #BC9A6A`→`#A0522D`; black→white 20px|—|
|D|multi_select|📄|tan, same as center; **checked `#654321`**|**yes**|

Row layouts: top_panel margins `5,5,5,5`; zoom/refresh panels `5,0,5,5`.

### 2.4 Layer panel

**Panel structure (top→bottom):** transparent SplitterHandle (height 10px), top_panel (row A+B), zoom_panel (row C), refresh_panel (row D), scroll list (`AlignHCenter|AlignBottom`, spacing 2, newest inserted at index 0 = top), bottom control stack. Right group panel fixed **270px**.

**NumberedLayerButton:** **146×40px**, border-radius **4px**, border **1px #888**, fill = strand color (`rgba`), checkable (checked == selected). Text = layer name (`"1_1"`, `"2_1"`), bold pointSize **12**, white fill + black outline, centered. Hover `#E0E0E0`, pressed `#C0C0C0`, checked keeps strand color.

Layer-button STATES:
- **hidden**: bg gray, diagonal dashed hatch `QColor(160,160,160)` width 2, every 10px; checked border `2px #0066CC`.
- **shadow_only**: border `2px dashed rgba(128,128,128,.8)`.
- **locked**: orange overlay `rgba(255,165,0,200)` on inner rect + 🔒 icon.
- **attachable**: right-edge green strip `#3BA424` (rect w-8,1,7,h-2) with black 2px outline.
- **selectable**: border `2px solid blue`.
- **masked**: fill = first strand color, border **5px solid** = second strand color.
- **multi-selected**: border `3px solid #FFD700` (gold); if also checked `3px solid #0066FF`.

**Bottom control stack** (6 buttons, shared: bold 14px black, border `1px #888`, radius 4px, padding `5px 10px`, Expanding width, 2px gap):

| # | key | EN | bg / hover / pressed | checkable | notes |
|---|---|---|---|---|---|
|1|`draw_names`|Draw Names|`#e07bdb` / `#e694e2` / `#ba62b5`|no| |
|2|`lock_layers`|Lock Layers|`#FFA500` / `#FFB84D` / `#E69500`|**yes**|checked→"Exit Lock"; deselect→"Clear Locks"; disables New/Delete|
|3|`add_new_strand`|New Strand|`#90EE90` / `#BFFFBF` / `#7BBF7B`; disabled `#D3D3D3`/`#666`|no| |
|4|`delete_strand`|Delete Strand|`#FF6B6B` / `#FF4C4C` / `#FF0000`; disabled `#D3D3D3`/`#666`|no|**starts disabled** |
|5|`deselect_all`|Deselect All|`#76acdc` / `#9bc2e6` / `#5890c0`|no|lock-mode→"Clear Locks"|
|6|`delete_all`|Delete All|`#a1a1a1` / `#b5b5b5` / `#8a8a8a`|no| |

**Layer right-click menu** (font 8pt, item padding `3px 30px 3px 3px`, min-height 35px): Hide/Show Layer, Shadow Only (✓ when active), Edit Shadows, [sep], then mask→{Edit Mask, Reset Mask} or regular→{Change Color, Change Stroke Color, Change Width, …}.

**Drag-reorder:** MIME `application/x-layerbutton-index`; blue insertion line `QColor(0,120,215)` width 2.

### 2.5 Groups UI (right panel)

**Create Group button:** fixed **140×50px**, label `create_group`. Theme-specific (dark `#2A2A2A` white border 2px `#000` radius 4 / light `#A6A19A` black border none radius 0 / default `#96938F` white border none radius 0).

**GroupPanel:** min-width 220, layout margins `0,5,0,5`, spacing 4. A QTreeWidget (indentation 16, no native triangles, `setRootIsDecorated(False)`). Each group = bold top-level item, text = arrow + name (**▼** expanded / **▶** collapsed). Children = one row per unique main-strand id. Click group row toggles expand. Item padding LTR `2px 4px 2px 14px`.

**Group context menu** (order): Move Strands, Rotate Strands, Edit Strand Angles, Edit Shadows, Create Mask Grid, Duplicate Group, Rename Group, [sep], Delete Group. Keys: `move_group_strands`, `rotate_group_strands`, `edit_strand_angles`, `edit_shadows`, `create_mask_grid`, `duplicate_group`, `rename_group`, `delete_group`.

**Dialogs:** GroupMove (X/Y sliders −600..600, grid-step inputs −50..50, OK/Cancel/Snap), GroupRotate (angle slider −180..180 + precise input), GroupShadowEditor (750×450 min, per-strand toggle rows), Rename (line edit + OK/Cancel), Create-group input dialog + main-strand checkbox selection dialog (20×20 indicators).

### 2.6 Theme palettes (exact)

**Theme-independent:** grid `#C8C8C8` (zoom≥0.5) / `#B4B4B4` (<0.5), grid size 28px; default strand `#C8AAE6`; default stroke `#000`; shadow `rgba(0,0,0,150)`; highlight red `#FF0000`; global font-size **14px**; family = system default. `delete_strand_button` same all themes (`#FF6B6B`).

| token | default | light | dark |
|---|---|---|---|
| window_bg | `#ECECEC` | `#FFFFFF` | `#2C2C2C` |
| text | black | black | white |
| canvas_bg | `#FFFFFF` | `#FFFFFF` | `#2C2C2C` |
| button_bg | `#E8E8E8` | `#F0F0F0` | `#2C2C2C` |
| button_hover | `#DADADA` | `#E0E0E0` | `#3D3D3D` |
| button_pressed | `#C8C8C8` | `#D0D0D0` | `#2D2D2D` |
| dialog_btn_bg | `#E8E8E8` | `#F0F0F0` | `#252525` |
| dialog_btn_border | `#B0B0B0` | `#CCCCCC` | `#000000` |
| scrollbar_track | `#DADADA` | `#F5F5F5` | `#1A1A1A` |
| scrollbar_handle | `#BFBFBF` | `#D4D4D4` | `#181818`(h)/`#2D2D2D`(v) |
| scrollbar_handle_hover | `#A0A0A0` | `#B0B0B0` | `#4A4A4A` |
| scrollbar_handle_pressed | `#808080` | `#909090` | `#606060` |
| panel_bg (layer/group) | `#ECECEC` | `#FFFFFF` | `#2C2C2C` |
| group_bg | `#B9B4AE` | `#D5CEC6` | `#4D4D4D` |
| group_hover_bg | `#A29E99` | `#C4BDB5` | `#666666` |
| menu_bg | `#ECECEC` | `#F0F0F0` | `#333333` |
| menu_border | `#B0B0B0` | `#B8B8B8` | `#1A1A1A` |
| menu_selected_bg | `#96938F` | `#333333` | `#F0F0F0` |
| menu_selected_text | white | white | black |
| create_group_bg | `#96938F` | `#A6A19A` | `#2A2A2A` |

### 2.7 Tab edge (floating overlay)

Parented to canvas, **not docked**. Height **53px**, panel radius **13px**, border pen 1.2px, `WA_TranslucentBackground`. Grip strip width **26px** (3×2 dot matrix). Plus button = IconButton('plus') 22×22. **TabChip** height **40px**, radius **9px**, contents `[dirty dot][title (9pt, bold when active)][dup][close]`; active vs inactive bg/text from theme. IconButtons 18×18 (close=X, duplicate=overlapping squares), hover backdrop alpha 45 radius 4. Six magnet anchors (margin 24px, snap threshold 75px), snap pills 128×38. Default dock `bottom_center`. Theme table:

| key | default | dark | light |
|---|---|---|---|
| panel_bg | rgba(25,25,25,135) | rgba(15,15,15,165) | rgba(255,255,255,190) |
| border | rgba(210,210,210,120) | rgba(230,230,230,85) | rgba(80,80,80,100) |
| active_bg | `#E8E8E8` | `#4A4A4A` | `#FFFFFF` |
| inactive_bg | rgba(45,45,45,170) | rgba(35,35,35,180) | rgba(225,225,225,180) |
| active_text | `#111111` | `#FFFFFF` | `#111111` |
| inactive_text | `#F0F0F0` | `#DADADA` | `#333333` |

---

## 3. Gap analysis (OSS vs current JS), by area

### 3.1 Main window / shell
- **Exists:** flat column layout (`App.tsx`): Toolbar, TabBar, workarea(CanvasStage + LayerPanel 230px). Theme/dir wiring on `<html>`.
- **Missing:** splitter shell (left_widget with toolbar-over-canvas), 300/350px min widths, maximized default, RTL splitter reversal, canvas-forced-LTR. The current TabBar is a docked strip, not a floating overlay.
- **Wrong:** layer panel is 230px (target 350 min + 270 group sub-panel). No splitter handle. Toolbar wraps instead of fixed 40px row.

### 3.2 Toolbar
- **Exists:** 4 mode buttons (`select/move/attach/mask`) green-when-active, undo/redo, shadows checkbox, samples buttons, Load/Save/Export PNG/settings gear.
- **Missing:** view, rotate, grid, angle, Points, State buttons; all OSS colors; checked=4px-black-border styling; non-checkable styling for Save/Load/Image; translated labels; the exclusive-group visual. "Samples" group is a JS-only dev affordance with no OSS equivalent (decide: hide behind a dev flag).
- **Store gaps:** `mode` enum lacks `'view'`, `'rotate'`, `'angle'` (`types.ts` is `select|move|attach|mask`). Grid/Points already in `settings.show_grid` / `doc.show_control_points`. No `layer_state` log feature.

### 3.3 Left control column
- **Exists:** nothing — current panel header has only `＋ / ▢ / 🗑` text-icon buttons.
- **Missing:** entire 4-row round-button column (reset, undo/redo, zoom in/out/pan, refresh/center/multi-select). Zoom/pan need view actions (zoom is **pinned to 1.0**). Pan/multi-select are checkable modes with no store backing. Reset-states / refresh / center / multi-select have **no store actions**.

### 3.4 Layer panel
- **Exists:** `.lp-row` list (drag-reorder, hide/lock/delete per row, select, mask styling), header actions, StrandProperties, GroupsSection. Store wired: `order/strands/locked_layers/selection`, `addNewStrand/deleteStrand/deleteAllStrands/toggleHidden/toggleLock/reorderLayer`.
- **Missing/Wrong:** rows are flat `.lp-row`, not 146×40 numbered buttons. No bottom 6-button colored control stack. No lock-mode toggle action. No layer-button states beyond sel/hidden/locked. No right-click context menu. No layer rename. Draw Names / Center / Refresh / Reset states actions missing.

### 3.5 Groups
- **Exists:** `.groups` block: header + "Group set" button (`createGroupFromSet`), per-group row with ←→↑↓ nudge + delete. Store: `createGroupFromSet/deleteGroup/translateGroup`.
- **Missing:** Create Group 140×50 themed button; QTreeWidget-style tree; group context menu; Move/Rotate/Shadow/Rename dialogs; main-strand checkbox selection dialog; arbitrary-membership groups. `rotate/duplicate/rename/shadow-override/mask-grid actions missing`.

### 3.6 Tabs
- **Exists:** docked `.tabbar` strip, wired (`tabs/activeTabId/switchTab/closeTab/newTab`).
- **Missing:** floating draggable overlay; rounded panel + grip + chips with dirty/dup/close; magnet anchors + snap; position persistence; per-theme translucent palette; Tabs toolbar toggle; unsaved-changes dialog; duplicate-tab. Store `tabs[]` lacks `dirty`/`file_path`/`untitled_index` and `duplicateTab`.

### 3.7 Theming
- **Exists:** only `theme-dark` CSS; `theme-default`/`theme-light` identical bare-light.
- **Missing:** real default & light palettes; CSS-variable token layer; theme-driven scrollbars/dialogs/menus/group panel/tab edge.

### 3.8 i18n / RTL
- **Exists:** 11-key stub (en, he, fr, es, it, pt), `isRTL('he')`, `t()`.
- **Missing:** German; all chrome keys; multiline tooltips; RTL mirroring beyond `dir`. Most labels hard-coded English.

---

## 4. Implementation plan — phased

Each item lists **files**, **constants**, **store hooks/additions**, **acceptance**. **[STORE]** = needs a store/model extension (dependency).

### PHASE 0 — Foundations (theme tokens + i18n + RTL)
- **0.1 CSS variable theme layer** — `styles.css` rewrite + `theme.css`; full token set from §2.6 per `.theme-*`; theme-independent button colors stay literal. *Acceptance:* default ≠ light ≠ dark; toolbar colors unchanged across themes.
- **0.2 Full i18n table** — `i18n.ts` + `translations.ts` from `translations.py` (en/fr/de/it/es/pt/he); add `tt()` multiline tooltips. *Acceptance:* every chrome label via `t()`; `de` present.
- **0.3 RTL plumbing** — `.rtl` class + `dir`; splitter/toolbar reverse; canvas stays LTR. *Acceptance:* Hebrew flips panel left, toolbar reverses; canvas unaffected.

### PHASE 1 — Layout shell
- **1.1 Splitter shell** — `App.tsx` + `Splitter.tsx`; index0 left_widget(Toolbar over Canvas), index1 LayerPanel; handle 1px; left min 300, panel min 350; TabBar moves into canvas stage. *Acceptance:* draggable handle; OSS shape.

### PHASE 2 — Toolbar
- **2.1 [STORE] Mode enum** — `types.ts` `ModeName` += view/rotate/angle; register `view` (read-only), stub rotate/angle.
- **2.2 OSS toolbar** — `Toolbar.tsx` rewrite + `toolbar.css`; 16 buttons §2.2 exact; checked=4px black border; Points checked-by-default; hide samples behind `import.meta.env.DEV`. *Acceptance:* colors pixel-match; exclusive group border; toggles independent.

### PHASE 3 — Left control column
- **3.1 [STORE] View/zoom/pan actions** — `editorStore.ts`/`actions.ts`: zoomIn/zoomOut/resetStates/refreshLayers/centerStrands/panMode+togglePan/multiSelectMode+toggleMultiSelect. (If zoom stays pinned, zoom buttons are disabled stubs.)
- **3.2 Control column** — `ControlColumn.tsx` + css; 4 rows §2.3; mount atop LayerPanel. *Acceptance:* OSS row order/colors; undo/redo disable; pan/multi-select checked state.

### PHASE 4 — Layer panel
- **4.1 [STORE] Lock-mode + rename** — `actions.ts`: toggleLockMode/clearAllLocks/renameLayer/drawNames toggle/deselectAll. *Acceptance:* lock-mode toggles; rename round-trips save/load.
- **4.2 NumberedLayerButton** — `NumberedLayerButton.tsx` + css; 146×40 §2.4 incl. all states; right-click menu. *Acceptance:* each state per spec; masked two-color box.
- **4.3 Bottom control stack + scroll list** — `LayerPanel.tsx` rewrite; 6-button stack §2.4 with lock-mode relabel/disable; widen panel ≥350px. *Acceptance:* 6 buttons match; drag-reorder blue line.

### PHASE 5 — Tabs (floating edge)
- **5.1 [STORE] Tab session model** — extend `tabs[]` dirty/file_path/untitled_index; duplicateTab/markTabSaved/setTabEdgeVisible/tabEdgePosition + persistence.
- **5.2 DraggableTabEdge** — `TabEdge/TabChip/IconButton/SnapOverlay` in CanvasStage; §2.7 constants; remove docked `.tabbar`. *Acceptance:* floats over canvas, magnet snap, theme palettes.
- **5.3 Unsaved-changes dialog** — Save/Discard/Cancel; RTL flips order.

### PHASE 6 — Groups
- **6.1 [STORE] Group actions** — createGroup(arbitrary members)/renameGroup/duplicateGroup/rotateGroup/shadow-override/createMaskGrid; keep translateGroup.
- **6.2 GroupPanel tree + Create Group button** — `GroupPanel.tsx`; 140×50 themed button; tree ▼/▶ expand; context menu. *Acceptance:* tree matches; expand/collapse; menu present.
- **6.3 Group dialogs** — Move/Rotate/ShadowEditor/Rename/MainStrandSelect §2.5; live preview + single undo step.

### PHASE 7 — Polish & parity
- 7.1 layer-state log; 7.2 settings dialog parity; 7.3 multiline tooltips; 7.4 RTL audit; 7.5 Save-Image/Load flow; 7.6 visual diff vs OSS screenshots per theme.

### Dependency summary (do first within each phase)
- `ModeName` += view/rotate/angle (2.1) → blocks 2.2.
- View/zoom/pan actions (3.1) → blocks 3.2.
- Lock-mode/rename actions (4.1) → blocks 4.2/4.3.
- Tab session fields (5.1) → blocks 5.2/5.3.
- Group actions (6.1) → blocks 6.2/6.3.
- i18n (0.2) + theme tokens (0.1) → block everything visual.

---

## 5. Open scope decisions
1. **Theme parity:** all three (default/light/dark) now, or default+dark first with light as fast-follow?
2. **Group depth:** full OSS group ops (Move/Rotate/Edit Angles/Edit Shadows/Mask Grid/Duplicate/Rename/arbitrary membership) or visual-tree + delete/rename + set-based create for v1?
3. **Zoom/pan:** unpin zoom now (renderer+interaction work) so zoom/pan/center are functional, or render those column buttons as disabled placeholders until zoom lands?
4. **JS-only affordances:** keep "samples" loader (behind dev flag) + inline StrandProperties, or remove for strict OSS fidelity?
5. **Pixel-exact vs close-enough:** exact hex/px reproduction vs visually-equivalent CSS approximations of Qt paint behavior.
