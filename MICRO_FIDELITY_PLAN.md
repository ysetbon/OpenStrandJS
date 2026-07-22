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

### 1. Translations & hardcoded strings
### 2. Copy/paste (strand data) flow — AUDIT COMPLETE

Translation keys are at verbatim parity in all 7 languages (`translations.py:466-478`
vs `translations.ts:79-100`); every divergence is in composed strings and layout.

- [ ] P1 Copy confirm button says "Copy", OSS shows **"Copy (N)"** with live
      ticked-count, disabled at 0 (`strand_data_menu.py:255-256` vs
      `NumberedLayerButton.tsx:678-680`). ← most likely the user's "copy message".
- [ ] P1 Invented modal title "Copy Strand Data - {layerName}" — OSS copy panel
      is untitled (`strand_data_menu.py:174-287` vs `NumberedLayerButton.tsx:671`).
- [ ] P1 Invented "Close" button — OSS panel has only the "Copy (N)" button
      (`strand_data_menu.py:218-233` vs `NumberedLayerButton.tsx:677`).
- [ ] P1 Paste menu row lacks the gray clipboard hint "{count} properties from
      {source}" as first row of the expanded panel (`strand_data_menu.py:295,321-329`,
      key `strand_data_clipboard_hint`; OSSJS shows it only in the badge popup).
- [ ] P1 Menu labels miss the "  ▾"/"▴" expand arrows on Paste/Copy rows
      (`strand_data_menu.py:107,121,149-165` vs `NumberedLayerButton.tsx:296,309`).
- [ ] P1 Copy UI is a backdrop Modal; OSS uses an inline expandable QWidgetAction
      panel inside the same context menu, Copy closes the menu
      (`strand_data_menu.py:92-172,278-284` vs `NumberedLayerButton.tsx:631-702`).
- [ ] P1 Paste UI is an always-expanded compound row; OSS is a collapsed
      dropdown with indented (20px) full-width rows "Angle from Start/End Point"
      (`strand_data_menu.py:289-319` vs `NumberedLayerButton.tsx:294-301`).
- [ ] P1 Select All checkbox not tristate — OSS shows PartiallyChecked
      (`strand_data_menu.py:209-210,243-254` vs `NumberedLayerButton.tsx:659,685-692`).
- [ ] P1 Right-clicking a non-ticked layer: OSS adds it to the multi-selection
      (gold border, included in paste targets, `layer_panel.py:1935-1938`); OSSJS
      only builds a transient list for hide/shadow — paste excludes the layer
      (`NumberedLayerButton.tsx:228-233,267-269`).
- [ ] P1 Right-click on badge/chips: OSS shows an explanation QToolTip instead
      of the menu (`layer_panel.py:1925-1933`, `numbered_layer_button.py:1772-1789`);
      OSSJS opens the menu and adds hover title tooltips OSS deliberately removed
      (`NumberedLayerButton.tsx:507-515,573,580`).
- [ ] P2 bias_control data (triangle/circle bias + positions) not copied within
      Control Points (`strand_data_clipboard.py:104-111,213-219` vs
      `strandClipboard.ts:13-14`).
- [ ] P2 Disabled/hint row colors: OSS #909090 on #F0F0F0 panel (`strand_data_menu.py:84-90`);
      OSSJS #888 light / #777 dark transparent (`contextMenu.css:57-68`).
- [ ] P3 Indicator column edge offset 13px, OSS `_INDICATOR_EDGE_OFFSET = 15`
      (`numbered_layer_button.py:72-74` vs `layerButton.css:149,168,171,196`).
- [ ] P3 Badge chrome: OSS 1px border rgba(30,30,30,200), fill rgba(255,255,255,225),
      hover blue overlaid on fill (`numbered_layer_button.py:77-125`); OSSJS
      borderless, hover replaces fill (`layerButton.css:147-167`).
- [ ] P3 Paste chip stack ≈35px tall / 12px glyphs; OSS 26×32 stack, ~10px glyphs,
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

- [ ] P1 Port `AngleAdjustDialog.tsx` per the spec above (GroupRotateDialog
      pattern: snapshot on open, live mutateDoc preview + drag fast-path, one
      commit on OK, doc restore on Esc/close), wired from Toolbar with
      selection/mask gating + auto-unpress, return to previous mode.
- [ ] P1 Add missing translation key `adjust_angle_and_length` (all 7 langs:
      translations.py:351/890/1531/2062/2652/3242/3841).
- [ ] P1 CP rotation/scaling + attached-strand cp translation in the action
      (deltas vs `moveHandle`/`setStrandAngle` which only carry passive cp2).
- [ ] P2 Canvas overlay: faded strand + red arc + green line during dialog.
- [ ] P2 `draw_only_affected_strand` wiring while dialog open.
- [ ] P2 SizeAll cursor for the mode; Esc-revert quirk: OSS restores only the
      endpoints (not cps/children) — use full-doc restore instead (better and
      simpler; note divergence).
- [ ] P3 RTL: numeric inputs forced dir="ltr" inside mirrored rows.
- [ ] P3 Delete or mount-decision for orphaned `StrandProperties.tsx`.
### 4. Settings dialog
### 5. Layer panel & layer buttons
### 6. Canvas modes (move/attach/mask/rotate/select)
### 7. Main window, toolbar, shortcuts
### 8. Group panel & group/shadow dialogs
### 9. Theme (dark mode), RTL/Hebrew, tooltips, cursors, misc chrome

## Fix phases

1. **Phase A — wording/i18n (P1)**: all string mismatches + hardcoded strings.
2. **Phase B — dialogs (P1/P2)**: angle-adjust dialog, width dialog, shadow
   preview rows, copy/paste popups.
3. **Phase C — panels/modes (P2)**: layer panel details, mode cursors/feedback.
4. **Phase D — cosmetic (P3)**: spacing, minor colors, scrollbars.

Each fix: one commit per area, OSS file:line in the message, verified via
Playwright against the dev editor / Qt pixel oracle / `tsc` clean.
