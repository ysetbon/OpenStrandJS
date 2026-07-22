# MICRO_FIDELITY_PLAN — every small OSS detail OSSJS misses

Ground truth: OpenStrand Studio v1.109 (`ysetbon/OpenStrandStudio` @ `0d751d90`),
cloned at `/workspace/openstrandstudio`. This plan catalogues every small
divergence found by a surface-by-surface audit (2026-07-22). One line per
finding: what OSS does, what OSSJS does, OSS file:line, priority.

Priorities: **P1** = user-visible wording/behavior wrong or missing on an
existing feature (fix first). **P2** = missing sub-feature/dialog fidelity.
**P3** = cosmetic (spacing, minor styling) — fix last.

Status legend: `[ ]` open · `[x]` fixed (commit ref) · `[-]` won't fix (reason).

## Already-known deferred tails (from OSS_1109_PORT_PLAN.md)

- [ ] P2 Arrow customization submenu: color / transparency / texture / shaft
      style / **Arrow Sizes** dropdown (all numeric dims), themed dropdowns,
      enlarged checkboxes. Renderer already honors color/transparency/head
      visibility; shaft patterns, head textures, `arrow_casts_shadow` are
      unrendered. (OSS `5e4fc9bd`, `a04b2a5c`; layer context menu.)
- [ ] P2 Hidden-strand full arrow (hidden strands should still show full arrow).
- [ ] P2 Button Guide page: arrow-details section, multi-selection section,
      lock-mode icons + fuller descriptions, canvas-indicator imagery + i18n.
- [ ] P2 `WidthConfigDialog`: OSSJS uses `prompt()` for per-strand width —
      port the real slider dialog.
- [ ] P2 Per-row "Show Current Shadow" path preview in shadow editor dialogs.
- [ ] P2 Mask hover highlight in select mode (no highlight drawn today).
- [ ] P3 Side-line bands in the selection footprint (covered only by 0.5px
      tolerance).
- [ ] P3 bias_control fields (renderer draws no bias controls).

## Findings by surface

(Audit in progress — sections below are filled from the per-surface sweeps.)

### 1. Translations & hardcoded strings — AUDIT COMPLETE

Counts: OSS en 488 keys; OSSJS 396 keys; shared 387; missing in OSSJS 101;
extra in OSSJS 9. Same 7 languages both sides.

**Hardcoded English where an OSS key exists (P1):**
- [x] P1 `tabs` (py:17) — `label: 'Tabs'` hardcoded `Toolbar.tsx:41`.
- [x] P1 `new_tab` (py:18) — hardcoded `TabEdge.tsx:172-173`, `TabBar.tsx:24`.
- [x] P1 `close_tab` (py:19 "Close tab") — hardcoded `title="Close"` `TabBar.tsx:21`.
- [x] P1 `duplicate_tab` (py:20) — hardcoded `TabChip.tsx:64-65`.
- [x] P1 Control-column tooltips fall back to English (keys absent, and OSS texts
      differ from the fallbacks — `ControlColumn.tsx:84-96`): `reset_tooltip`
      py:337 ('Reset:\nKeep only current state\nas first state'), `undo_tooltip`
      py:344, `redo_tooltip` py:345, `zoom_in_tooltip` py:341 ('Zoom In', JS says
      'Zoom in (coming soon)'), `zoom_out_tooltip` py:342, `pan_tooltip` py:343,
      `refresh_tooltip` py:338, `center_tooltip` py:339, `hide_mode_tooltip`
      py:340 (full multi-line 'Multi-Layer Select:…' text).
- [x] P1 `tab_copy_suffix` (py:26 'copy') — duplicate-tab title suffix untranslated.
- [ ] P1 `shadow_editor_info` (py:67 'Shadows cast by <b>{0}</b> onto layers
      below:') — info line absent from StrandShadowEditorDialog.tsx.

**English values that differ on shared keys:**
- [x] P1 `whats_new_info` — OSSJS still ships the v1.108 content; OSS py:289 is
      the v1.109 list (10 items: Lock Mode Redesigned … Copy & Paste Strand
      Data, © 2026 / Version 1.109). All 7 languages one version behind.
- [x] P1 `lock_layers_desc` (py:222) — OSS has the long 1.109 padlock text;
      OSSJS has pre-1.109 one-liner. All languages behind.
- [x] P1 `select_layers_to_lock` (py:334) — OSS 'Click a padlock to lock/unlock
      a layer; click a layer to select it'; OSSJS pre-1.109 wording.
- [x] P1 `shadow_editor_help_text` (py:79) — OSS 4-part <b>Visible/Full Shadow/
      Subtract Layers/Shadow Path</b> HTML; OSSJS invented one-liner.
- [x] P1 `gif_explanation_3` (py:369) + `gif_explanation_4` (py:370) — stale
      captions in OSSJS (all languages).
- [x] P1 `shadow_subtract_layers` fr 'Retirer Couches' / he 'הסר שכבות' —
      OSSJS fr/he differ (D-section of audit).
- [-] `shadow_hide_all`, `shadow_path_hide`, `shadow_visible_on/off` (he) —
      OSS values are duplicates/typos ('Show All' for hide-all etc.); OSSJS
      "fixed" them. DECISION: keep the OSSJS fix unless strict parity is wanted
      (flag to user).
- [x] P3 `x_grid_steps`/`y_grid_steps` case: OSS 'X Grid Steps' vs JS
      'X grid steps'; fr 'Pas Grille X' vs 'Pas de grille X'.
- [x] P3 fr nits: `group_shadow_editor_title`, `precise_angle` (nbsp before
      colon), `shadow_no_layers`; he `group_shadow_editor_title`.

**Missing key groups (port with features or as text-only):**
- [x] P1 `main_window_title` (py:5) — title not sourced from translations.
- [ ] P2 History clear-confirm flow missing entirely: `confirm_clear_history_title`
      py:559, `confirm_clear_history_text` py:560, `history_cleared_text` py:564 —
      HistoryPage.tsx:62 clears with no confirmation.
- [x] P2 Arrow submenu keys (16): `arrow_sizes` py:513, `adjust` py:514,
      `arrow_color/transparency/texture/shaft_style` py:537-540,
      `show_arrow_head` py:541, `arrow_casts_shadow` py:542, `texture_*`
      py:543-546, `shaft_*` py:547-550.
- [x] P2 Dash/extension menu items: `hide/show_start/end_extension` py:494-497.
- [x] P2 Width-dialog extras: `restore_default_closing_knot_stroke` py:455,
      `make_elliptical_end` py:460, `stroke_pixels_label` py:590.
- [x] P2 Button-guide 1.109 sections (~21 keys): multi-select batch menu
      py:196-199, copy/paste guide py:200-207, canvas indicators py:208-213,
      arrow guide py:189-195.
- [x] P2 Layer State Info panel: `layer_state_log_title` py:43,
      `layer_state_info_title/tooltip` py:44-45, `layer_state_info_text` py:99.
- [x] P2 Misc: `adjust_angle_and_length` py:351, `currently_unavailable` py:346,
      `groups` py:432, `newest_strand/layer` py:437-438, `group_replace_confirm`
      py:554, `error` py:555, `unsaved_tabs_on_exit` py:23 (quit guard flow
      missing), `gif_placeholder_1..4` py:371-374.
- [ ] P3 Hardcoded strings with no OSS key: 'Drag to move' TabEdge.tsx:161,
      load-failure alert Toolbar.tsx:74, '(missing)' LayerStateDialog.tsx:69,
      aria-labels controls.tsx:83,93 / NumberedLayerButton.tsx:563.
- [x] P3 D3 fallback omissions (fr/he/de/it/es/pt entries omitted where OSS
      value == English: `x`, `x_plus_180`, `angle` fr, `X_angle` fr,
      `attachable` fr, `shadow_visible_on/off` fr/es) — no visible effect;
      fill for strictness.
- [ ] P3 OSSJS-only keys: legacy camelCase `layers/theme/language/showGrid/
      gridSize/snap/curve` ts:126-132 (remove if unused);
      `mask_grid_no_crossings` ts:73 and `shadow_stored_only_note` ts:64 are
      justified JS-only additions — keep.
- Note: `tf()` handles only positional {N}; `group_replace_confirm` uses bare
  {} — adapt when porting. OSS dead keys (C9 list) — do not port.
### 2. Copy/paste (strand data) flow — AUDIT COMPLETE

Translation keys are at verbatim parity in all 7 languages (`translations.py:466-478`
vs `translations.ts:79-100`); every divergence is in composed strings and layout.

- [x] P1 Copy confirm button says "Copy", OSS shows **"Copy (N)"** with live
      ticked-count, disabled at 0 (`strand_data_menu.py:255-256` vs
      `NumberedLayerButton.tsx:678-680`). ← most likely the user's "copy message".
- [x] P1 Invented modal title "Copy Strand Data - {layerName}" — OSS copy panel
      is untitled (`strand_data_menu.py:174-287` vs `NumberedLayerButton.tsx:671`).
- [x] P1 Invented "Close" button — OSS panel has only the "Copy (N)" button
      (`strand_data_menu.py:218-233` vs `NumberedLayerButton.tsx:677`).
- [x] P1 Paste menu row lacks the gray clipboard hint "{count} properties from
      {source}" as first row of the expanded panel (`strand_data_menu.py:295,321-329`,
      key `strand_data_clipboard_hint`; OSSJS shows it only in the badge popup).
- [x] P1 Menu labels miss the "  ▾"/"▴" expand arrows on Paste/Copy rows
      (`strand_data_menu.py:107,121,149-165` vs `NumberedLayerButton.tsx:296,309`).
- [x] P1 Copy UI is a backdrop Modal; OSS uses an inline expandable QWidgetAction
      panel inside the same context menu, Copy closes the menu
      (`strand_data_menu.py:92-172,278-284` vs `NumberedLayerButton.tsx:631-702`).
- [x] P1 Paste UI is an always-expanded compound row; OSS is a collapsed
      dropdown with indented (20px) full-width rows "Angle from Start/End Point"
      (`strand_data_menu.py:289-319` vs `NumberedLayerButton.tsx:294-301`).
- [x] P1 Select All checkbox not tristate — OSS shows PartiallyChecked
      (`strand_data_menu.py:209-210,243-254` vs `NumberedLayerButton.tsx:659,685-692`).
- [x] P1 Right-clicking a non-ticked layer: OSS adds it to the multi-selection
      (gold border, included in paste targets, `layer_panel.py:1935-1938`); OSSJS
      only builds a transient list for hide/shadow — paste excludes the layer
      (`NumberedLayerButton.tsx:228-233,267-269`).
- [x] P1 Right-click on badge/chips: OSS shows an explanation QToolTip instead
      of the menu (`layer_panel.py:1925-1933`, `numbered_layer_button.py:1772-1789`);
      OSSJS opens the menu and adds hover title tooltips OSS deliberately removed
      (`NumberedLayerButton.tsx:507-515,573,580`).
- [ ] P2 bias_control data (triangle/circle bias + positions) not copied within
      Control Points (`strand_data_clipboard.py:104-111,213-219` vs
      `strandClipboard.ts:13-14`).
- [x] P2 Disabled/hint row colors: OSS #909090 on #F0F0F0 panel (`strand_data_menu.py:84-90`);
      OSSJS #888 light / #777 dark transparent (`contextMenu.css:57-68`).
- [x] P3 Indicator column edge offset 13px, OSS `_INDICATOR_EDGE_OFFSET = 15`
      (`numbered_layer_button.py:72-74` vs `layerButton.css:149,168,171,196`).
- [x] P3 Badge chrome: OSS 1px border rgba(30,30,30,200), fill rgba(255,255,255,225),
      hover blue overlaid on fill (`numbered_layer_button.py:77-125`); OSSJS
      borderless, hover replaces fill (`layerButton.css:147-167`).
- [x] P3 Paste chip stack ≈35px tall / 12px glyphs; OSS 26×32 stack, ~10px glyphs,
      ● drawn as filled ellipse (`numbered_layer_button.py:128-182,1757-1770`).
- [ ] P3 Badge popup lacks OSS `_keep_menu_on_screen` grow-reposition nuance
      (`strand_data_menu.py:20-37`; OSSJS viewport clamp is close enough — verify).

Parity confirmed (do not touch): menu order/separators, copy/paste gating,
snapshot fields + paste semantics (translation re-anchor, child glue, 1/3-2/3 CP
rebuild), one-undo-per-paste, session copy-options memory, chip hover tint.
### 3. Angle-adjust dialog/mode — AUDIT COMPLETE (port the real dialog)

OSS: toolbar "Angle" button (checkable, #B89EE6/#D4C2F2/#9B84C9 — OSSJS colors
already match) opens a **modal dialog immediately** on click when a non-mask
strand is selected (`main_window.py:1245-1262`; `angle_adjust_mode.py:43-71`).
Dialog (`angle_adjust_mode.py:127-263`): title key `adjust_angle_and_length`
("Adjust Angle and Length" / he "התאם זווית ואורך"), two rows of
label + slider + double-spinbox — Angle −360..360 step 1; Length 10..max(10,
2×original) step 5, ticks every 5, **all length values quantized round(v/5)*5** —
plus a single **OK** button (no Cancel; Esc/X = revert endpoints). Live preview
on every tick; `_skip_save` suppresses undo during preview; exactly one undo
state on OK, none on cancel; OK deselects all + returns to previous mode.
Geometry: rotate about fixed start (0°=east, clockwise, y-down); cp1/cp2/center
**rigidly rotated by Δangle and scaled by newLen/initialLen** from initial
vectors (`:336-388,503-539`); attached strands whose start ≈ old end: start
snaps to new end, end fixed, cps translated by the delta, recursive
(`:419-492`). Canvas overlay while open: active strand at 50% opacity, red
angle arc at start (radius min(50, 2×width), 2px, sweep=Δangle), green 2px
start→end line (`:641-676`). `draw_only_affected_strand` hides other strands
while dialog open (`strand_drawing_canvas.py:1935-1938,2132-2137`). Cursor:
SizeAll. RTL: rows mirrored, labels right-aligned, spinboxes forced LTR.
`handle_key_press` (±1°/±5px/X-combos) is dead code in 1.109 — omit.

OSSJS today: mode `'angle'` is a passive stub (`src/modes/index.ts:16`);
`StrandProperties.tsx` (inline angle/length inputs) is **orphaned — mounted
nowhere**; building blocks exist (`setStrandAngle` actions.ts:267-282,
GroupRotateDialog gesture pattern, Modal Esc/Enter/RTL, theme tokens).

- [x] P1 Port `AngleAdjustDialog.tsx` per the spec above (GroupRotateDialog
      pattern: snapshot on open, live mutateDoc preview + drag fast-path, one
      commit on OK, doc restore on Esc/close), wired from Toolbar with
      selection/mask gating + auto-unpress, return to previous mode.
- [x] P1 Add missing translation key `adjust_angle_and_length` (all 7 langs:
      translations.py:351/890/1531/2062/2652/3242/3841).
- [x] P1 CP rotation/scaling + attached-strand cp translation in the action
      (deltas vs `moveHandle`/`setStrandAngle` which only carry passive cp2).
- [x] P2 Canvas overlay: red arc + green line during dialog (50%-faded
      strand redraw skipped — renderer approximation, revisit if noticed).
- [ ] P2 `draw_only_affected_strand` wiring while dialog open.
- [x] P2 SizeAll cursor for the mode; Esc-revert quirk: OSS restores only the
      endpoints (not cps/children) — use full-doc restore instead (better and
      simpler; note divergence).
- [x] P3 RTL: numeric inputs forced dir="ltr" inside mirrored rows.
- [ ] P3 Delete or mount-decision for orphaned `StrandProperties.tsx`.
### 4. Settings dialog — AUDIT COMPLETE

Parity confirmed (extensive): category list order/keys, General page controls/
ranges/defaults/gating, Layer Panel page rows, Selected Strand page (+forced
LTR), language list+flags (en→us, he→il), Save/Load 33-key JSON schema incl.
OSS's field omissions, DefaultWidthDialog math, Samples (5 files incl.
capital-I), About HTML verbatim, dark palette tokens, checkbox styling,
persistence coverage (no dropped fields).

- [ ] P1 What's New still ships 1.108 content — replace `whats_new_info` with
      the 1.109 10-item HTML in all 7 languages (`translations.py:289-305`).
- [ ] P1 Button Guide: multi-select/copy-paste section missing
      (`settings_dialog.py:3161-3182`, keys py:196-207 + rendered badge/chip
      indicator images `:5929-5955`).
- [ ] P1 Button Guide: arrow customization submenu docs missing
      (`settings_dialog.py:3108-3145`, 7-item ul + sizes).
- [ ] P1 Button Guide: selection-indicators section shows pre-1.109 set; OSS
      1.109 = red circle (in user's highlight color @alpha 60!), blue circle,
      `yellow_circle`, `start_end_squares`, `control_point_squares` with
      rendered icons (`settings_dialog.py:3265-3287,5906-5927`).
- [ ] P2 History Clear All: no confirm dialog / no "cleared" info box / not
      disabled when empty (`settings_dialog.py:6730,6766,6890-6895`, keys
      py:559-564).
- [ ] P2 Lock-mode icons (lock_open/lock_closed PNGs) missing from Button
      Guide lock row (`settings_dialog.py:3049` vs ButtonGuidePage.tsx:139).
- [-] P2 Live-apply vs OSS apply-on-OK — deliberate web deviation; keep
      (flag to user in summary).
- [ ] P3 Nav items not center-aligned (`settings_dialog.py:1776`).
- [ ] P3 Theme combo lacks 26×26 rounded swatch icons (`:5814-5851`;
      default 230,230,230 / light 255,255,255 / dark 44,44,44).
- [ ] P3 Guide tables have 1px borders; OSS borderless (`settingsDialog.css:279`).
- [ ] P3 Hebrew history row format `(State N) hh:mm:ss dd-MM-yyyy` right-
      aligned, list forced LTR (`settings_dialog.py:6780-6794,3342-3343`).
- [ ] P3 History load error shown without title (OSS `history_load_error_title`).
- [ ] P3 DefaultWidthDialog thickness input: native spinner, should be
      segmented stepper like the rest.
- [-] P3 pt width-dialog labels are French — verified to be OSS's OWN bug
      (translations.py pt locale carries French for these 5 keys); verbatim
      parity kept.
- [ ] P3 ButtonGuide heading color reads DOM class non-reactively.
- [ ] P3 settingsJson.ts "36-key" comment → 33.
- [ ] P3 Language combo cosmetics (flag 40px w/ theme border, item h48,
      arrow on LEFT in OSS `:196-239`; OSSJS 28px/h40/trailing ▾).
- [ ] P3 Tutorial entries: OSSJS adds divider borders; modal title "Tutorial N"
      invented (harmless).
### 5. Layer panel & layer buttons — AUDIT COMPLETE

Parity confirmed (extensive): button size/colors/text (Qt lighter/darker
reimplemented exactly), shadow-only + masked + lock-mode visuals, padlock
geometry/gating, mask-edit visuals, menu chrome/width formula, compound-row
styling, circular-button rows + palettes, bottom six-button stack colors/
labels incl. lock-mode swaps, drag-reorder midpoint rule + drop line, click/
lock/multi-select semantics, delete-all confirm (No default), chip-paste
targeting, new-strand + group-creation flows.

- [ ] P1 Arrow customization panel (known-deferred; full spec now captured in
      audit — `numbered_layer_button.py:1070-1345`: panel bg #333/#F0F0F0 r5,
      Arrow Color 30×20 swatch default=stroke_color, Transparency slider
      0-100 live %, Head Texture combo none/stripes/dots/crosshatch, Shaft
      combo solid/tiles/stripes/dots, Show Arrow Head + Arrow Casts Shadow
      checkboxes, Arrow Sizes → Adjust submenu of six segmented spinboxes
      (head len 0-500 d20, head w 0-500 d10, head stroke 1-30 d4, gap 0-1000
      d10, line len 0-1000 d20, line w 0.1-100 d10) persisted on close; menu-
      close diff force-saves undo `:1613-1645`).
- [ ] P2 Missing menu items: `transparent_closing_knot_side` /
      `restore_default_closing_knot_stroke` (alpha-gated, after Close-the-Knot,
      `numbered_layer_button.py:1388-1432`).
- [ ] P2 Missing Dash compound row: `extension` + show/hide start/end dash
      (`numbered_layer_button.py:1435-1486`).
- [ ] P2 Notification label missing entirely (`layer_panel.py:1048-1052`,
      `show_notification` 2000ms `:2672-2681`): messages = persistent
      `select_layers_to_lock` in lock mode, `exited_lock_mode`, "Please exit
      mask edit mode first (Press ESC)" (hardcoded EN in OSS), and
      `mask_edit_mode_exited`.
- [ ] P2 Reset 🏠 button: OSS clears undo history keeping current state
      (`layer_panel.py:1831-1834`); OSSJS resets view. Refresh must also
      `reset_zoom` (`:1082-1090`).
- [ ] P2 Right-click-and-hold CustomTooltip system (transparent, centered at
      panel-row-4 +190px, `layer_panel.py:47-364`) vs native hover titles.
- [ ] P2 Ctrl mask-create: OSS exits masked mode after each pair (even
      same-layer double-click) (`layer_panel.py:2408-2418`); OSSJS stays armed.
- [ ] P2 Attachable green strip condition: OSS `knot_connections OR not all
      circles` (`layer_panel.py:2611-2627`); OSSJS only circle test
      (`LayerPanel.tsx:261`).
- [ ] P2 Bottom stack + create-group not disabled during Edit-Mask
      (`layer_panel.py:2592-2600`).
- [ ] P2 Multi-selected border: OSS 2px gold, no glow (`layer_panel.py:1891-1901`);
      OSSJS 3px + box-shadow.
- [ ] P3 Hidden-state diagonal hatch: dashed gray 2px @10px pitch, persists
      while checked (`numbered_layer_button.py:2040-2048`); OSSJS solid
      stripes, dropped when checked.
- [ ] P3 Creating a new layer should exit multi-select mode
      (`layer_panel.py:2961-2971`).
- [ ] P3 Circle row placed before Arrow (OSS order: Line → Arrow → Full →
      custom → Close Knot → knot-stroke → Dash → Circle).
- [ ] P3 Undo/redo button palettes are per-theme in OSS (default green
      #4d9958…, dark green #3d7846…, light blue #4387c2…,
      `undo_redo_manager.py:38-126`); OSSJS hardcodes light-blue.
- [ ] P3 Icon sizes: OSS 27/26/24px scales (`layer_panel.py:452-745`);
      OSSJS 20/24px.
- [ ] P3 Lock button shows pressed color when checked; OSS stays orange.
- [ ] P3 Whole button `cursor:pointer`; OSS pointer only on padlock/badge/chips.
- [ ] P3 Color pickers: OSS themed+translated QColorDialog with alpha; OSSJS
      native input, no alpha edit.
- [x] P3 Delete dead `TabBar.tsx` (imported nowhere).
- [ ] P3 Colors section key unused in LayerStateDialog.
(Copy/paste-specific items live in §2; width dialog in §8.)
### 6. Canvas modes (move/attach/mask/rotate/select) — AUDIT COMPLETE

Parity confirmed (extensive; MOVE_MODE_OSS_SPEC.md §7 gaps since fixed):
move grab/drag/release passes + square geometry/colors + snap gating + abort;
attach eligibility/hover colors/viewport clamp; mask two-pick flow + hover +
banner; select click semantics + select→attach promotion; pan gestures.
Note: OSS Ctrl-snap no-ops when setting disabled — port already matches.

- [ ] P1 ROTATE MODE missing entirely (`rotate_mode.py`, full spec in audit):
      SizeAll cursor; square grab areas side 2×strand.width per FREE endpoint
      only (`!has_circles[side]`, masks skipped, hidden NOT skipped); pivot =
      opposite endpoint; length-preserving chord rotation; cps rotated about
      pivot by Δangle; attached strands rigidly translated by delta; eased
      16ms/0.3 interpolation; one undo on release; NO visual overlay.
- [ ] P1 `show_move_highlights`/`show_hover_highlights` settings are dead —
      overlayRenderer never reads them (OSS gates all squares/circles/hover:
      `strand_drawing_canvas.py:2311,2320,2706,2893,2920`, `select_mode.py:80-82`).
- [ ] P1 Attach: unarmed empty-space press must be a NO-OP (OSS draws only
      when armed via New Strand/N — `attach_mode.py:603-681`; canvas branch
      `:4255-4269` is dead code); OSSJS starts drawing on any empty press.
- [x] P1 Esc must NOT clear selection (OSS: Esc only exits mask edit,
      `main_window.py:2272-2280`; deselect is `A`/button). Keep mid-drag abort.
- [ ] P1 Select-mode mask hover highlight (spec: fill mask's rendered region
      rgba(255,230,160,0.667) + 2px black silhouette — same geometry as
      `maskFootprintHit`; OSS `select_mode.py:70-105`).
- [ ] P1 Side-line bands in hit/hover footprint: oriented rect per circle-less
      end (center = endpoint + (stroke/2)·tangent, len width+2·stroke across,
      thickness stroke) in `strandFootprintHit` + highlight polygon
      (HIT_TOL 0.5 doesn't cover the ~4-8px bar).
- [x] P2 Move-mode cursor: OSS OpenHand ('grab'), never changes on hover/drag
      (`strand_drawing_canvas.py:4985-4987`); OSSJS crosshair + hover 'grab'.
- [x] P2 Rotate/angle mode cursors 'move' (SizeAll); view mode OpenHand.
- [ ] P2 Move hover must use OSS hover rules, not full moveGrab: cp1 always
      hoverable; cp2/center only when `triangle_has_moved`; plain forward
      endpoint scan, no connection pref/reverse pass (`move_mode.py:2234-2338`).
- [ ] P2 Mask picked-strand border width = strand.stroke_width × 2 (not fixed
      2px) (`mask_mode.py:264-272`).
- [ ] P2 `maskPending`/hover must clear on mode switch (OSS activate/
      deactivate reset; `editorStore.ts:480` keeps them).
- [ ] P2 Attach: create AttachedStrand at PRESS (live during drag, layer
      appears in panel; `attach_mode.py:1111-1241`) not at release.
- [ ] P2 Attach target: first-fit in forward z-order, start before end,
      recursing children (`attach_mode.py:989-1107`); OSSJS picks nearest.
- [ ] P2 Select mode should block locked layers in THIS baseline
      (`strand_drawing_canvas.py:6534-6539`) — OSSJS cites a newer rework;
      ASK USER which baseline wins before changing.
- [ ] P3 Armed new-strand timer path rounds direction to 45° steps + gradual
      catch-up + cursor warp (`attach_mode.py:778-880`) — web can't warp;
      decide whether to implement 45° quantization. Flag to user.
- [ ] P3 Attach-child end should grid-snap via `_get_snapped_attachment_position`
      (axis-preferred one-grid-unit anti-collapse) vs 40px min-len clamp.
- [ ] P3 Wheel zoom center-anchored + zoom_out resets pan in OSS; pan clamp
      to content∪8000² box; ClosedHand cursor while panning.
- [ ] P3 cp2 idle square gate: only `control_point2_shown` (not sep>6).
- [ ] P3 Attach: while dragging, keep the affected parent circle highlighted
      (OSS hides others only); eraser dash pattern; banner placement in-panel.
- [ ] P3 New-strand <8px cancel is JS-only (OSS cancels only zero-length).
### 7. Main window, toolbar, shortcuts — AUDIT COMPLETE

Parity confirmed: button inventory/order/colors (all 14 hex triples exact),
zoom limits 0.1–5, grid size 28, pan/center/reset behaviors, mask-edit banner,
RTL core mirroring, translation keys of buttons.

- [x] P1 Startup defaults inverted: OSS grid ON (`strand_drawing_canvas.py:184`),
      shadow OFF (`:1320`, `main_window.py:336`); OSSJS `show_grid: false`,
      `shadow_enabled: true` (`editorStore.ts:45,34`). Flip both.
- [ ] P2 Active mode's toolbar button should be disabled (`main_window.py:2104-2167`);
      angle button always stays enabled (`:2172-2173`). OSSJS never disables.
- [ ] P2 Edit Mask session must disable all toolbar buttons
      (`main_window.py:2757-2793`); OSSJS only swallows shortcuts.
- [x] P2 Angle button preconditions + previous-mode restore
      (`main_window.py:1245-1262,1209-1243`) — covered by §3 port.
- [ ] P2 Checked button fill: OSS swaps bg to the pressed shade + 4px black
      border (`main_window.py:1284-1289`); OSSJS only adds the border
      (`toolbar.css:38`).
- [ ] P2 Layer State button is checkable in OSS, stays checked while dialog
      open, restores previous mode on close (`main_window.py:372,1691-1824`).
- [x] P2 Shortcuts missing: `1` draw names, `L` lock layers, `D` delete strand,
      `A` deselect all (`main_window.py:2240-2270`); Space is a pan **toggle**
      in OSS, hold-to-pan in OSSJS (`:2211-2221` vs `InteractionHost.ts:221-223`);
      Ctrl-release exits masked mode (`layer_panel.py:2184-2187`).
- [x] P3 Auto-repeat guard on Z/X/N/1/L/D/A (`main_window.py:2188,2230` vs no
      `e.repeat` check). Keep OSSJS's Ctrl+Z/Y additions (web convention).
- [ ] P2 Save doesn't export undo history (`export_history` main_window.py:2593),
      Load extracts only current step (`saveLoad.ts:46-53` vs `import_history`
      `:1604-1624`) — round-trip the history format.
- [ ] P2 No dirty-doc prompt before Load (`main_window.py:1567-1596`) and no
      `beforeunload` quit guard (`:2795-2862`, keys `unsaved_tabs_on_exit`,
      `quit_anyway`, `skip_quit_warning` opt-out; RTL-mirrored for he).
- [ ] P2 Export image framing: OSS = current viewport × 4, transparent, with
      selection highlight + in-progress strand + names overlays
      (`main_window.py:1951-2026`); OSSJS = content-fit × 2, no overlays.
- [ ] P2 Zoom in/out buttons are disabled stubs in OSSJS; OSS steps ±10% about
      canvas center (`layer_panel.py:481-560`, canvas `:1560-1577`).
- [ ] P3 Wheel zoom anchored at cursor in OSSJS vs canvas center in OSS.
- [x] P3 Grid color: OSS opaque rgb(200,200,200) w1, thickens 1.5/rgb(180,180,180)
      below zoom 0.5 (`strand_drawing_canvas.py:3256-3276`); OSSJS
      rgba(0,0,0,0.08) (`web/strand-renderer.js:1631-1634`, export `:1308`).
- [ ] P3 Toolbar geometry: bar 40px/btn 32px/maxw 90/font bold 14px/radius 6/
      spacing 10 (`main_window.py:270-293,1266-1295`) vs OSSJS 46/38/110/18px/7.
      Gear 32×32 r18 hover rgba(200,200,200,50) vs 38×38 r19 0.55. Layer State
      padding 8px 4px r0 (`:1447-1463`).
- [ ] P3 Toggle Shadow tooltip "Enable/disable shadow effects for overlapping
      strands" (`main_window.py:337`).
- [ ] P3 Initial layer-panel width 350px min (`main_window.py:524-539,422`) vs
      OSSJS 490 clamp 460-860. Splitter handle transparent in OSS.
- [ ] P3 Title 'OpenStrandJS — editor' vs OSS `main_window_title`.
- [ ] P3 Ctrl+Shift+D debug clear-suppression — skip.
### 8. Group panel & group/shadow dialogs — AUDIT COMPLETE

Parity confirmed: group context-menu content/order, collapse tree ▼/▶ +
Hebrew RLE wrap, member auto-check of masked partners, GroupMove rows/ranges/
grid-apply, GroupRotate rows/pivot, angle-editor table (9 cols, hold-repeat
timings 500ms/10ms, ±1/±5 and ±0.025/±0.4), shadow receiver enumeration +
mask-proxy rows + auto/pinned interplay, DefaultWidthDialog, mask-grid matrix
mechanics, rename flow strings.

- [ ] P1 Group creation: missing "Group Exists — replace?" confirm between
      name and select steps (`group_layers.py:5125-5144`, key
      `group_replace_confirm`).
- [ ] P1 GroupMove Cancel: OSS keeps moved geometry (cancel ≈ close); OSSJS
      reverts. Snap-to-grid: OSS snaps each strand's points to grid then
      CLOSES (`group_layers.py:4256-4266`); OSSJS rounds the offset and stays
      open. Also OSS lets totals exceed ±600 after grid Apply; OSSJS clamps.
- [ ] P1 GroupRotate Esc/close: OSS ALWAYS keeps rotation + saves undo
      (`group_layers.py:6002-6032`); OSSJS Esc reverts — destroys work.
- [ ] P1 Angle editor: direct angle edits must re-sync all x/180+x-checked
      rows (`update_linked_strands` `group_layers.py:7312-7338`); main-strand
      edits back-feed the X field (`:7297-7300`).
- [ ] P1 Shadow Path preview (both shadow editors): checkable "Shadow Path"
      button per row (+ section/global Show All in group dialog), draws the
      REAL clipped shadow geometry filled rgba(0,120,255,100) + 2px stroke
      rgba(0,120,255,200) inside the canvas transform, multi-pair set,
      cleared on dialog close (`shadow_editor_dialog.py:181-188,1199-1215`,
      `strand_drawing_canvas.py:2788-2817,1317`; checked style #4A6FA5/#6A9FD5
      dark, #A0C0E0/#7090C0 light; min 80×36). Also selection-driven
      `set_highlighted_shadow` on row click (`:1139-1148`).
- [ ] P1 Per-strand shadow editor: missing info label `shadow_editor_info` and
      the strand-level batch toggle row (color box + bold name + Visible/Full/
      Subtract/Show All, `shadow_editor_dialog.py:654-659,766-849`).
- [ ] P1 Per-strand WidthConfigDialog replaces `window.prompt`
      (`NumberedLayerButton.tsx:197-222`): title "Change Width", min 400×220,
      grid_unit 27; thickness QDoubleSpinBox 0.5–100.0 step 1.0 1-dec +
      "squares"; stroke-px slider 1..max(1,total//2) recalc on total change;
      readout `stroke_pixels_label`; preview "Total {t}px | Color {c}px |
      Stroke {s}px each side"; per-layer variant adds `make_elliptical_end`
      checkbox → `elliptical_end_caps`; propagate whole-set; refresh dependent
      masks (`numbered_layer_button.py:3750-4244,3546-3669`).
- [ ] P2 Group panel drag-strand-to-group drop flow (`group_layers.py:1561-1572`).
- [ ] P2 Group shadow dialog: global row label literally "{group} - All"
      (`group_shadow_editor_dialog.py:200`) not "- Select All"; masks should
      appear as casting sections; empty sections skipped not rendered
      (`:507`); pixel-aligned toggle columns (`_sync_column_widths` `:106-163`).
- [ ] P2 `shadow_editor_help_text` — full 4-part text (also in §1).
- [ ] P2 Subtract candidates should include mask layers
      (`shadow_editor_dialog.py:1015-1018` vs filter in tsx:77).
- [ ] P2 Group/child row backgrounds: children use tree bg + lighter hover
      (#3A3A3A/#F0F0F0/#E0E0E0), only group rows use group_bg
      (`group_layers.py:827-878`); OSSJS paints both with --group-bg.
- [ ] P2 Mask grid rows/cols sorted alphabetically by layer name in OSS
      (`mask_grid_dialog.py:93-115`); OSSJS uses z-order.
- [ ] P2 Rename: OSS input starts EMPTY, duplicate error is a separate modal
      titled "Error" (`group_layers.py:2421-2447`); OSSJS pre-fills + inline.
- [ ] P3 Angle-editor non-editable rows: distinct cell bgs (#252525/#F5F5F5)
      not opacity 0.5; dialog 80% screen max 1000×700 min 800×400.
- [ ] P3 GroupMove NaN guard on grid-step field; checkbox custom styling
      (20px blue #4A6FA5/#A0C0E0 + painted checkmark) vs native accent.
- [ ] P3 Delete dead FallbackSelectDialog/FallbackRenameDialog code paths.
- [ ] FOLLOW-UP: verify auto-delete of groups when a member gets masked
      (`update_groups_with_new_strand` `group_layers.py:4540-4576`).
### 9. Theme (dark mode), RTL/Hebrew, tooltips, cursors, misc chrome — AUDIT COMPLETE

Parity confirmed: theme token transcription hex-for-hex, RTL core (dir flip,
canvas LTR, splitter, layer-button mirror, group tree, HtmlBlock), fonts,
samples, About page, app icon, mask-edit banner, drop line, canvas constants.

- [x] P1 Canvas background ignores theme: renderer fills opaque 'white' every
      frame (`web/strand-renderer.js:1290-1291,1523,1621-1622`); OSS canvas bg
      = window bg per theme — default #ECECEC / light #FFFFFF / dark #2C2C2C
      (`main_window.py:712/871/1034`). Also `--canvas-bg` for .theme-default
      must be #ECECEC. (OSS's own `set_theme` "Dark" branch is dead code —
      match observed behavior.)
- [x] P1 Scrollbars unthemed: `--scrollbar-*` tokens defined but consumed
      nowhere — style WebKit scrollbars for .lp-list, .gp-tree, modal bodies,
      settings pages per theme (dark track #1A1A1A handle #2D2D2D hover
      #4A4A4A pressed #606060; light #F5F5F5/#D4D4D4/#B0B0B0/#909090;
      default #DADADA/#BFBFBF/#A0A0A0/#808080, `main_window.py:776-1144`).
- [x] P2 `color-scheme: dark` missing — native inputs/checkboxes/selects
      render light chrome in dark theme.
- [x] P2 Modal footer buttons unthemed: wire dead `--dialog-btn-*` tokens
      (dark #252525 bg / 2px #000 border / white text, hover #505050,
      pressed #151515; min-width 80, `main_window.py:751-766,932-947,1074-1089`).
- [ ] P2 Tab edge never mirrors for Hebrew (grip right, + left, chips RTL,
      `tab_bar_widget.py:189-247,436-469`); mounted inside dir="ltr" wrapper.
- [x] P2 Dialogs missing `lang` → don't flip in Hebrew: LayerStateDialog.tsx:46,
      TabChip.tsx:82 (unsaved confirm), LayerControlStack.tsx:129 (delete-all).
- [x] P2 Grid: color rgb(200,200,200) w1, thicken 1.5/rgb(180,180,180) below
      zoom 0.5, never auto-hide (OSSJS skips when grid_size×zoom < 4).
      (Duplicate of §7 item — fix once in renderer.)
- [ ] P2 beforeunload dirty-tab guard (dup of §7).
- [x] P3 Pan tool active should show grab/grabbing cursor on canvas.
- [x] P3 Create Group button hover/pressed states (default #A8A5A1/#7E7B77,
      light #B6B1AA/#86817A, dark #505050/#606060, `main_window.py:841-1171`).
- [ ] P3 document.title from `main_window_title` + `<html lang>` update +
      theme-color meta per theme.
- [ ] P3 Undo/redo tooltips append "(unavailable)" when disabled
      (`undo_redo_manager.py:2510-2537`).
- [ ] P3 Main splitter handle transparent in OSS; OSSJS shows --panel-border.
- [ ] P3 Dark h-scrollbar handle #181818 distinct from v #2D2D2D (token can't
      express; optional).

## Fix phases

1. **Phase A — wording/i18n (P1)**: all string mismatches + hardcoded strings.
2. **Phase B — dialogs (P1/P2)**: angle-adjust dialog, width dialog, shadow
   preview rows, copy/paste popups.
3. **Phase C — panels/modes (P2)**: layer panel details, mode cursors/feedback.
4. **Phase D — cosmetic (P3)**: spacing, minor colors, scrollbars.

Each fix: one commit per area, OSS file:line in the message, verified via
Playwright against the dev editor / Qt pixel oracle / `tsc` clean.
