# OpenStrand Studio → OpenStrandJS — Settings Dialog Port Plan

Consolidated, implementation-ready plan for porting the PyQt5 `SettingsDialog` (11 categories) to the React/TypeScript web app. Authoritative reference distilled from 14 analysis specs (11 OSS panels + theming + apply-core + current JS infra).

Source of truth: `OpenStrandStudio/src/settings_dialog.py` + `translations.py`. Target infra: `OpenStrandJS/src/ui/SettingsDialog.tsx`, `store/editorStore.ts`, `model/types.ts`, `ui/translations.ts`, `ui/Modal.tsx`, `ui/theme.css`.

---

## 1. Overview

### 1.1 The 11 categories (left nav list → stacked page; row index === stacked index)

| Idx | Nav key | EN label | Page | Interactive? |
|----|---------|----------|------|---|
| 0 | `general_settings` | General Settings | General | YES |
| 1 | `layer_panel_title` | Layer Panel | Layer Panel | YES |
| 2 | `selected_strand_settings` | Selected Strand | Selected Strand | YES |
| 3 | `change_language` | Change Language | Language | YES |
| 4 | `save_load_settings_title` | Save/Load Settings | Save/Load | YES |
| 5 | `tutorial` | Tutorial | Tutorial | content (videos) |
| 6 | `button_explanations` | Button Guide | Button Guide | content (read-only) |
| 7 | `history` | History | History | YES (session recovery) |
| 8 | `whats_new` | What's New? | What's New | content (read-only) |
| 9 | `samples` | Samples | Samples | YES (loads project) |
| 10 | `about` | About | About | content (read-only) |

### 1.2 Dialog shell

- **NOT a fixed 800×600.** OSS dynamically sizes the dialog to fit the widest page + the sidebar. (The 800×600 / 600×400 numbers in the codebase belong to *other* dialogs — `VideoPlayerDialog`, the width sub-dialog — do not use them.)
- **Two-column flex layout:** category sidebar (left in LTR / right in RTL) + stacked page area. `padding: 20px 20px 20px 0` (left margin 0 so the sidebar reaches the edge), `gap: 20px` between sidebar and content.
- Sidebar width = widest category label (px) + 26 (13px each side). Content width = widest page. Total = sidebar + content + 40 (20 gap + 20 right pad). Height = natural.
- Non-resizable modal, no maximize/minimize/help chrome. Default selected row = General (index 0).
- **Web shell:** reuse the existing `<Modal>` component (`src/ui/Modal.tsx`) — it already handles Escape, Enter, backdrop-click, `dir` rtl/ltr, footer. Render a custom two-pane body inside it: a vertical nav `<ul>` + a content `<div>` switched by active index. Let CSS reflow handle dynamic sizing (`width: max-content` on pages, scroll on overflow); do not hardcode pixel dimensions.

### 1.3 Apply / OK model (CRITICAL — from apply-core spec)

- **One global "OK" = Apply + close.** Every page's OK button calls the *same* `apply_all_settings`, which reads **every control on every page** and pushes to canvas, then persists. There is no per-page commit and no separate Apply-vs-OK.
- **Apply-on-OK is the default**, with **two live-apply exceptions**: (a) all **color pickers** persist + apply to canvas immediately on pick; (b) the **curvature spinboxes** (base_fraction / distance / curve_response) apply live on every change. The width sub-dialog persists on its own OK.
- **Hide-first, apply-deferred:** OSS hides the dialog, then runs apply on the next event tick (avoids visible retranslate flicker). No `accept()` — the dialog instance is reused.
- **Web simplification (recommended):** The current JS store already persists every `setSettings(patch)` immediately to localStorage and bumps `docRevision` (auto re-render). The faithful-enough web model is: **bind every control to `setSettings` live** (immediate apply + persist), matching OSS's *effective* outcome while being simpler than the deferred batch. Keep an explicit OK/Close footer button for parity. The only place the OSS "deferred" timing matters is the canvas-flicker-on-retranslate concern, which the web `requestAnimationFrame` render loop handles for free. **Decision flagged in §6.**

### 1.4 Theming model

Three theme classes already exist on `<html>` in the web app: `.theme-default`, `.theme-light`, `.theme-dark` (`src/ui/theme.css`), driven by `settings.theme`. Language drives `<html dir>` (`he` = RTL). Both are already wired in `App.tsx`. The settings dialog must consume the theme CSS vars (§4) so it themes correctly, and add a few missing vars/classes for swatch buttons, checkboxes, and the category sidebar.

---

## 2. Per-Category Control Spec

Legend: **Live** = applies/persists on change; **OK** = applies on the global OK (web: treat as live via `setSettings`). State col uses the proposed extended `Settings` field names (§3).

### 2.0 General Settings (index 0)

| Control | Label key | Widget | Default | Range/Options | State field | Apply |
|---|---|---|---|---|---|---|
| Theme | `select_theme` | combobox + 22×22 swatch icons | `default` | default/light/dark | `theme` | OK |
| Shadow color | `shadow_color` | RGBA swatch button (64×27) | `0,0,0,150` | RGBA+alpha | `shadow_color` | **Live** |
| Draw only affected strand | `draw_only_affected_strand` | checkbox | `false` | bool | `draw_only_affected_strand` | OK |
| Enable third control point | `enable_third_control_point` | checkbox | `false` | bool | `enable_third_control_point` | OK (on change → reset masks) |
| Enable curvature bias | `enable_curvature_bias_control` | checkbox (disabled unless 3rd CP on) | `false` | bool | `enable_curvature_bias_control` | OK |
| Snap to grid (move) | `enable_snap_to_grid` | checkbox | **`true`** | bool | `snap_to_grid_enabled` | OK |
| Snap to grid (attach/create) | `enable_snap_to_grid_attach` | checkbox | **`true`** | bool | `snap_to_grid_attach_enabled` | OK |
| Show move highlights | `show_move_highlights` | checkbox | **`true`** | bool | `show_move_highlights` | OK |
| Show hover highlights | `show_hover_highlights` | checkbox | **`true`** | bool | `show_hover_highlights` | OK |
| Skip close-tab warning | `skip_close_tab_warning` | checkbox | `false` | bool | `skip_close_tab_warning` | OK |
| Skip quit warning | `skip_quit_warning` | checkbox | `false` | bool | `skip_quit_warning` | OK |
| Shadow blur steps | `shadow_blur_steps` | int spin | `2` | 1–100 step 1 | `num_steps` | OK |
| Shadow blur radius | `shadow_blur_radius` | float spin | `29.99` | 0.0–360.0 step .01 dec2 | `max_blur_radius` | OK |
| Control point influence | `base_fraction` | float spin | `1.0` | 0.25–10.0 step .05 dec2 | `curve_params.base_fraction` | **Live** |
| Distance boost | `distance_multiplier` | float spin | `2.0` | 1.0–10.0 step .1 dec1 | `curve_params.dist_multiplier` | **Live** |
| Curve shape | `curve_response` | float spin | `2.0` | 1.0–3.0 step .1 dec1 | `curve_params.exponent` | **Live** |
| Reset curvature | row `reset_curvature_settings` / btn `reset` | button | — | sets 1.0/2.0/2.0 | (the 3 above) | **Live** |
| OK | `ok` | button | — | — | global apply | — |

Notes: third-CP toggle, when it *changes*, must regenerate all MaskedStrands and force redraw. Curvature live-apply must propagate the 3 params to **every strand + attached subtree** (OSS stores them per-strand), then re-render. Web: thread into render meta / strand records; `setSettings` already bumps `docRevision`.

### 2.1 Layer Panel (index 1)

| Control | Label key | Widget | Default | Range | State field | Apply |
|---|---|---|---|---|---|---|
| Extension length | `extension_length` | float spin | `100` | 0–1000 | `extension_length` | OK |
| Dash count | `extension_dash_count` | int spin | `10` | 1–100 | `extension_dash_count` | OK |
| Dash width | `extension_dash_width` | float spin | `2` | 0.1–20 | `extension_dash_width` | OK |
| Dash gap length | `extension_dash_gap_length` | float spin | `5.0` | 0–1000 | `extension_dash_gap_length` | OK |
| Arrow head length | `arrow_head_length` | float spin | `20.0` | 0–500 | `arrow_head_length` | OK |
| Arrow head width | `arrow_head_width` | float spin | `10.0` | 0–500 | `arrow_head_width` | OK |
| Arrow head stroke width | `arrow_head_stroke_width` | int spin | `4` | 1–30 | `arrow_head_stroke_width` | OK |
| Arrow gap length | `arrow_gap_length` | float spin | `10` | 0–1000 | `arrow_gap_length` | OK |
| Arrow line length | `arrow_line_length` | float spin | `20` | 0–1000 | `arrow_line_length` | OK |
| Arrow line width | `arrow_line_width` | float spin | `10` | 0.1–100 | `arrow_line_width` | OK |
| Use default arrow color | `use_default_arrow_color` | checkbox (label-left/box-right in LTR) | `false` | bool | `use_default_arrow_color` | **Live** |
| Button (arrow) color | `button_color` | RGBA swatch | `0,0,0,255` | RGBA | `default_arrow_fill_color` | **Live** |
| Default strand color | `default_strand_color` | RGBA swatch | `200,170,230,255` | RGBA | `default_strand_color` | **Live** |
| Default stroke color | `default_stroke_color` | RGBA swatch | `0,0,0,255` | RGBA | `default_stroke_color` | **Live** (recolors ALL existing strands) |
| Default strand width | `default_strand_width` | button → sub-dialog | width 46 / stroke 4 / units 2 | see sub-dialog | `default_strand_width`/`default_stroke_width`/`default_width_grid_units` | **Live** (sub-dialog OK) |
| Hide control points in view mode | `view_hide_control_points` | checkbox | `false` | bool | `view_hide_control_points` | OK |
| Unfolded start edge by default | `default_transparent_start_circle` | checkbox | `false` | bool | `default_transparent_start_circle` | OK |
| OK | `ok` | button | — | — | global apply | — |

**Default-width sub-dialog** (`DefaultWidthConfigDialog`): modal. `grid_unit = 23 px`. Controls: (1) Total Thickness int spin `total_thickness_label` + suffix `grid_squares`, range 2–20 **step 2 (even only)**, initial `round((strand_width+2*stroke_width)/23)`; (2) Color-vs-stroke slider `color_vs_stroke_label`, range 10–90%, initial `round(strand_width/total*100)` clamped; percentage readout `percent_available_color`; (3) live preview `width_preview_label` = `"Total: {total}px | Color: {color}px | Stroke: {stroke}px each side"`; (4) OK/Cancel. **Math:** `total = squares*23`; `color = total*(slider/100)`; `stroke = (total-color)/2`. Returns `(int(color), int(stroke))` → strand_width / stroke_width. Replicate `23` and the split exactly.

### 2.2 Selected Strand (index 2) — page forced LTR; only label alignment flips in RTL

| Control | Label key | Widget | Default | State field | Apply |
|---|---|---|---|---|---|
| Move selected only | `move_selected_only` | checkbox (word-wrap) | `false` | `move_selected_only` | OK |
| Show CP selected only | `show_cp_selected_only` | checkbox (word-wrap) | `false` | `show_cp_selected_only` | OK |
| Shadow selected only | `shadow_selected_only` | checkbox (word-wrap) | `false` | `shadow_selected_only` | OK |
| View-mode hide highlight | `view_hide_highlight` | checkbox (word-wrap) | `false` | `view_hide_highlight` | OK |
| Highlight color | `highlight_color` | RGBA swatch | `255,0,0,255` | `highlight_color` | **Live** |
| OK | `ok` | button | — | global apply | — |

### 2.3 Change Language (index 3)

| Control | Label key | Widget | Default | Options | State | Apply |
|---|---|---|---|---|---|---|
| Select language | `select_language` | flag combobox | `en` | en/fr/de/it/es/pt/he | `language` | OK (live OK in web) |
| Info | `language_settings_info` | label | — | — | — | — |
| OK | `ok` | button | — | — | global apply | — |

Options order fixed: `en,fr,de,it,es,pt,he`. Flag asset mapping (gotcha): `en→us.png`, `he→il.png`; others match code. Flags: 40px tall, 1px themed border (black light / white dark), ~2px pad; option rows ≥48px. Option labels localized via active-language translation. Selecting `he` sets `<html dir="rtl">` (canvas stays LTR). Already partly handled by `App.tsx`.

### 2.4 Save/Load Settings (index 4)

| Control | Label key | Widget | Size | Action | Apply |
|---|---|---|---|---|---|
| Save Settings | `save_settings_button` | button | min 150×40 | export settings → JSON download | immediate (file) |
| Load Settings | `load_settings_button` | button | min 150×40 | import JSON → file input → hydrate controls | immediate (controls only; OK applies) |
| OK | `ok` | button | — | global apply + persist | — |

Toasts: `save_settings_success`, `load_settings_success`, `load_settings_error`. Save = Blob `<a download>`; Load = `<input type=file accept=".json">` + `FileReader`. **Import mutates draft state only**, does not auto-apply to canvas (in web's live model it does take effect since controls bind to setSettings — acceptable simplification). Export JSON shape uses **snake_case keys + nested `{r,g,b,a}` color objects** (§3.3).

### 2.5 Tutorial (index 5) — content

Header `tutorial_info` (centered, preserve `\n`). 4 entries (loop range 4): explanation `gif_explanation_1..4` + Play button `play_video` (180×40, padding 5px, centered). Click → open in-app HTML5 `<video controls autoplay>` modal (Close button). Assets: bundle `tutorial_1..4.mp4` as static web assets. Explanation alignment follows `dir`; header + buttons stay centered.

### 2.6 Button Guide (index 6) — content, read-only, NO state

Header `button_guide_info` (centered, preserve `\n\n`). Then a data-driven HTML document: sections via `<h2>` (theme-colored: `#000` light / `#fff` dark / `#333` default) and `<h3>`, lists, two tables. Section keys + the big `*_desc` key set: see button-guide spec §4.3–§4.11. Descriptions are `"Name - Description"` split on `" - "` into bold name + desc. Assets: `layer_panel_icons/*.png` (34×34) + `images/*.svg` (30/24px). **Use canonical 15-item General-Settings list** (fix OSS's duplicate bug). One React component re-derived from `(theme, language)`.

### 2.7 History (index 7) — session recovery

| Control | Label key | Widget | Notes |
|---|---|---|---|
| Explanation | `history_explanation` | label | preserve `\n` (2 lines incl. Warning) |
| Session list | (populated) | list, tooltip `history_list_tooltip` | newest-first; row = `YYYY-MM-DD HH:mm:ss (State N)` |
| Load Selected | `load_selected_history` | button | disabled until selection; loads final state, closes dialog |
| Clear All History | `clear_all_history` | button | no confirmation; deletes non-current sessions |

Other keys: `no_history_found`, `history_state_label` (`State`), `history_load_error_title`, `history_load_error_text`, `history_cleared_title` (+ add `history_files_removed` for the count message OSS hardcodes). **Web storage:** IndexedDB keyed by `{sessionId, step}`; snapshot full doc on each undo checkpoint; exclude current session; group by session, keep max step. Add a retention policy (keep last N sessions / prune older than X days) — web deviation for robustness.

### 2.8 What's New (index 8) — content, read-only

Nav `whats_new` (trailing "?"). Body `whats_new_info` = per-language HTML blob (v1.108: `<h2>` + 4 `<li style="font-size:14px">` + `<p>` copyright). **Wrap the bare `<li>` in a `<ul>`** for the bullet look. Theme styling per §4 (dark `#3D3D3D`/white/`#505050`/radius4/pad8; light white/black/`#CCCCCC`; default `#F5F5F5`/black/`#CCCCCC`). Hebrew body wrapped `<div dir="rtl">`. Render reactively from `(theme, language)`; flag-substitution is a Qt-only no-op — skip it.

### 2.9 Samples (index 9)

Header `samples_header` (centered) + subtitle `samples_sub` (centered, wrapped). 5 buttons (vertical column, 40px tall, min-width 120 growing to text+40):

| Order | Label key | File |
|---|---|---|
| 1 | `sample_closed_knot` | `closed_knot.json` |
| 2 | `sample_box_stitch` | `box_stitch.json` |
| 3 | `sample_overhand_knot` | `overhand_knot.json` |
| 4 | `sample_three_strand_braid` | `three_strand_braid.json` |
| 5 | `sample_interwoven_double_closed_knot` | `Interwoven_double_closed_knot.json` |

Click → **close settings modal**, then (next tick) load the project JSON into the active canvas via the existing fixture-load pipeline (clear strands+groups, apply loaded strands/groups/shadow_overrides, restore control-points/shadow toggles, refresh layer panel, reset undo). Bundle the 5 JSONs as static assets (copy `three_strand_braid.json` + `Interwoven_double_closed_knot.json` fresh from OSS `src/samples/`; the other 3 already exist in `fixtures/`).

### 2.10 About (index 10) — content, read-only

Single scrollable panel with localized `about_info` HTML (`<h2>` + paragraphs + links + `© 2026 OpenStrand Studio`). Links open new tab (`target="_blank" rel="noopener noreferrer"`); `mailto:` for email. One HTML blob per locale.

---

## 3. Settings Data Model

### 3.1 Current JS `Settings` (verified `src/model/types.ts`)

`curve_params{base_fraction,dist_multiplier,exponent}`, `grid_size`, `show_grid`, `snap_to_grid_enabled`, `default_strand_color`, `default_stroke_color`, `default_strand_width`, `default_stroke_width`, `theme`, `language`. `RGBA = {r,g,b,a}` (0–255). Persistence: `openstrandjs.settings` localStorage key; `loadSettings` spreads over `DEFAULT_SETTINGS` (auto-backfills new fields → no migration). `setSettings(patch)` merges + saves + bumps `docRevision`.

### 3.2 Full persisted-key map (OSS `.txt` PascalCase → JS field, EXISTS / NEEDS-NEW)

| OSS `.txt` key | Default | JS field | Status |
|---|---|---|---|
| `Theme` | default | `theme` | EXISTS |
| `Language` | en | `language` | EXISTS |
| `ShadowColor` | 0,0,0,150 | `shadow_color` | **NEEDS-NEW** |
| `DrawOnlyAffectedStrand` | false | `draw_only_affected_strand` | **NEEDS-NEW** |
| `EnableThirdControlPoint` | false | `enable_third_control_point` | **NEEDS-NEW** |
| `EnableCurvatureBiasControl` | false | `enable_curvature_bias_control` | **NEEDS-NEW** |
| `EnableSnapToGrid` | true | `snap_to_grid_enabled` | EXISTS |
| `EnableSnapToGridAttach` | true | `snap_to_grid_attach_enabled` | **NEEDS-NEW** |
| `ShowMoveHighlights` | true | `show_move_highlights` | **NEEDS-NEW** |
| `ShowHoverHighlights` | true | `show_hover_highlights` | **NEEDS-NEW** |
| `MoveSelectedOnly` | false | `move_selected_only` | **NEEDS-NEW** |
| `ShowCPSelectedOnly` | false | `show_cp_selected_only` | **NEEDS-NEW** |
| `ShadowSelectedOnly` | false | `shadow_selected_only` | **NEEDS-NEW** |
| `ViewHideHighlight` | false | `view_hide_highlight` | **NEEDS-NEW** |
| `ViewHideControlPoints` | false | `view_hide_control_points` | **NEEDS-NEW** |
| `DefaultTransparentStartCircle` | false | `default_transparent_start_circle` | **NEEDS-NEW** |
| `SkipCloseTabWarning` | false | `skip_close_tab_warning` | **NEEDS-NEW** |
| `SkipQuitWarning` | false | `skip_quit_warning` | **NEEDS-NEW** |
| `HighlightColor` | 255,0,0,255 | `highlight_color` | **NEEDS-NEW** |
| `NumSteps` | 2 | `num_steps` | **NEEDS-NEW** |
| `MaxBlurRadius` | 29.99 | `max_blur_radius` | **NEEDS-NEW** |
| `ControlPointBaseFraction` | 1.0 | `curve_params.base_fraction` | EXISTS |
| `DistanceMultiplier` | 2.0 | `curve_params.dist_multiplier` | EXISTS |
| `CurveResponseExponent` | 2.0 | `curve_params.exponent` | EXISTS |
| `ExtensionLength` | 100 | `extension_length` | **NEEDS-NEW** |
| `ExtensionDashCount` | 10 | `extension_dash_count` | **NEEDS-NEW** |
| `ExtensionDashWidth` | 2 | `extension_dash_width` | **NEEDS-NEW** |
| `ExtensionDashGapLength` | 5.0 | `extension_dash_gap_length` | **NEEDS-NEW** |
| `ExtensionLineWidth` (legacy alias) | 2 | (= `extension_dash_width`) | derived |
| `ArrowHeadLength` | 20.0 | `arrow_head_length` | **NEEDS-NEW** |
| `ArrowHeadWidth` | 10.0 | `arrow_head_width` | **NEEDS-NEW** |
| `ArrowHeadStrokeWidth` | 4 | `arrow_head_stroke_width` | **NEEDS-NEW** |
| `ArrowGapLength` | 10 | `arrow_gap_length` | **NEEDS-NEW** |
| `ArrowLineLength` | 20 | `arrow_line_length` | **NEEDS-NEW** |
| `ArrowLineWidth` | 10 | `arrow_line_width` | **NEEDS-NEW** |
| `UseDefaultArrowColor` | false | `use_default_arrow_color` | **NEEDS-NEW** |
| `DefaultArrowColor` | 0,0,0,255 | `default_arrow_fill_color` | **NEEDS-NEW** |
| `DefaultStrandColor` | 200,170,230,255 | `default_strand_color` | EXISTS (dead — wire into creation) |
| `DefaultStrokeColor` | 0,0,0,255 | `default_stroke_color` | EXISTS (dead — wire into creation) |
| `DefaultStrandWidth` | 46 | `default_strand_width` | EXISTS (dead — wire into creation) |
| `DefaultStrokeWidth` | 4 | `default_stroke_width` | EXISTS (dead — wire into creation) |
| `DefaultWidthGridUnits` | 2 | `default_width_grid_units` | **NEEDS-NEW** |
| `TabEdgePosition` | — | (foreign; preserve on rewrite) | n/a (web auto-preserves with structured store) |

`grid_size`/`show_grid` are JS-only (no OSS `.txt` equivalent) — keep as-is.

### 3.3 Export/Import JSON shape

Snake_case keys + nested `{r,g,b,a}` color objects (36 keys). Adds `enable_curvature_bias_control`; **omits** the 8 boolean "selected-only/view-hide/skip-warning/transparent-circle" keys + the `ExtensionLineWidth` legacy alias. Floats unrounded (e.g. `max_blur_radius: 29.99`). Provide `toJson()` / `fromJson()` adapters; treat all import keys as optional.

### 3.4 Proposed extended `Settings` interface

```ts
export interface Settings {
  // --- existing (keep) ---
  curve_params: { base_fraction: number; dist_multiplier: number; exponent: number };
  grid_size: number;                 // JS-only
  show_grid: boolean;                // JS-only
  snap_to_grid_enabled: boolean;
  default_strand_color: RGBA;
  default_stroke_color: RGBA;
  default_strand_width: number;
  default_stroke_width: number;
  theme: Theme;
  language: Language;

  // --- General ---
  shadow_color: RGBA;                // 0,0,0,150
  draw_only_affected_strand: boolean;
  enable_third_control_point: boolean;
  enable_curvature_bias_control: boolean;
  snap_to_grid_attach_enabled: boolean;
  show_move_highlights: boolean;     // true
  show_hover_highlights: boolean;    // true
  skip_close_tab_warning: boolean;
  skip_quit_warning: boolean;
  num_steps: number;                 // 2
  max_blur_radius: number;           // 29.99

  // --- Selected Strand ---
  move_selected_only: boolean;
  show_cp_selected_only: boolean;
  shadow_selected_only: boolean;
  view_hide_highlight: boolean;
  highlight_color: RGBA;             // 255,0,0,255

  // --- Layer Panel: extension ---
  extension_length: number;          // 100
  extension_dash_count: number;      // 10
  extension_dash_width: number;      // 2
  extension_dash_gap_length: number; // 5.0

  // --- Layer Panel: arrow ---
  arrow_head_length: number;         // 20
  arrow_head_width: number;          // 10
  arrow_head_stroke_width: number;   // 4
  arrow_gap_length: number;          // 10
  arrow_line_length: number;         // 20
  arrow_line_width: number;          // 10
  use_default_arrow_color: boolean;
  default_arrow_fill_color: RGBA;    // 0,0,0,255

  // --- Layer Panel: width units + view toggles ---
  default_width_grid_units: number;  // 2
  view_hide_control_points: boolean;
  default_transparent_start_circle: boolean;
}
```

Add matching defaults to `DEFAULT_SETTINGS`. `loadSettings` spread auto-migrates existing stored blobs. No new mutator needed — `setSettings(Partial<Settings>)` covers all (caller spreads nested objects).

---

## 4. Theming & CSS

### 4.1 Palettes (verbatim hex)

**Dark** (base `#2C2C2C`): dialog/widget bg `#2C2C2C` text white; button bg `#3D3D3D` border `#505050` hover `#4D4D4D` pressed `#2D2D2D` checked bg `#505050`/border `2px #808080`; combo/list/textbrowser bg `#3D3D3D` border `#505050`; list selected `#505050` hover `#4D4D4D`; scrollbar track `#2C2C2C` thumb `#505050` hover `#606060`.

**Light** (base white): button bg `#F0F0F0` border `#CCCCCC` hover `#E0E0E0` pressed `#D0D0D0` checked `#E0E0E0`/`2px #A0A0A0`; combo white; list white border `#CCCCCC`; text black; dialog bg white.

**Default** (base light-gray): button bg `#E8E8E8` border `#CCCCCC` hover `#DADADA` pressed `#C8C8C8` checked `#D0D0D0`/`2px #A0A0A0`; combo/list/textbrowser bg `#F5F5F5` border `#CCCCCC`; text black; dialog bg `#F0F0F0`.

Shared button metrics: height 32 (sample/history 40, save/load 37), min-width 120, padding `8px 16px`, radius 4. Combobox: radius 4, font 14, rows ≥48px, padding flips per dir (24px on arrow side); CSS-triangle arrow `#666`/`#333`/`#ccc` per theme; hover bg `#e0e0e0`/`#f0f0f0`/`#4d4d4d`.

### 4.2 Color swatch button (5 instances)

64×27, radius 3, 1px border, `cursor:pointer`, inner 22×22 color chip showing **alpha** (use checkerboard backing). Palette dark `#3D3D3D`/`#505050` hover `#4D4D4D`/`#7A7A7A` pressed `#2D2D2D`; light `#F0F0F0`/`#CCCCCC` hover `#E0E0E0`/`#AFAFAF` pressed `#D0D0D0`; default `#E8E8E8`/`#CCCCCC` hover `#DADADA`/`#A8A8A8` pressed `#C8C8C8`.

### 4.3 Checkbox (custom green check)

22×22 indicator, radius 3, border `2px` (`#666` dark / `#ccc` light), bg `#2d2d2d`/white. Checked: bg+border `#28a745` (hover `#218838`) all themes, white check ~48% size, 2.5px round-cap (SVG or `::after`). Label gap 5px, font 14px. The `default_arrow_color` checkbox uniquely renders label-left / box-right in LTR.

### 4.4 Theme-preview swatch (combobox icon)

22×22 rounded (radius 4) swatch + localized label per option: `default` fill `#E6E6E6` border `#C8C8C8`; `light` `#FFFFFF`/`#C8C8C8`; `dark` `#2C2C2C`/`#666666`.

### 4.5 New CSS vars/classes to add

Add to `theme.css` per-theme: `--swatch-bg/-border/-hover-bg/-hover-border/-pressed-bg`, `--list-sel-bg`, `--list-hover-bg`, `--combo-arrow`, `--combo-hover`, `--check-border`, `--check-bg`, `--check-on` (`#28a745`), `--check-on-hover` (`#218838`), `--scrollbar-track/-thumb/-thumb-hover`. Add `--accent`/`--danger` (referenced with fallbacks in `dialogs.css`). New classes: `.settings-dialog` (two-pane flex), `.settings-nav` / `.settings-nav-item[.active]`, `.settings-page`, `.swatch-btn` + `.swatch-chip`, `.settings-check`. Reuse existing `.mrow`, `.gd-row`, `.gd-swatch`, `.modal*`.

---

## 5. Web-Equivalent Decisions (Qt-only infra)

| OSS Qt infra | Faithful web behavior |
|---|---|
| `QColorDialog` (non-native, alpha) | Custom RGBA picker: `<input type=color>` + alpha `<input type=range>` (the existing `.cf` layer-panel pattern) OR a small popover with hue/sat + alpha. Must support alpha + checkerboard preview. Native `<input type=color>` alone is insufficient (no alpha). |
| `user_settings.txt` + OS settings dir | `localStorage` key `openstrandjs.settings` (already used). Drop the secondary root-dir copy. Structured store auto-preserves foreign keys. |
| `QFileDialog` save (export) | Blob + `<a download="settings.json">`. |
| `QFileDialog` open (import) | `<input type=file accept=".json">` + `FileReader`/`File.text()` + `JSON.parse`. |
| `QMessageBox` info/warning | App toast/snackbar with same translation keys. |
| Tutorial `mp4/mov` + external player launch | Bundle 4 `.mp4` as static assets; in-app modal `<video controls autoplay>` with Close (matches OSS's fallback `VideoPlayerDialog`). Drop `.mov`/QuickTime branch. |
| Button-guide `layer_panel_icons/*.png` + `images/*.svg` via `file://` + `svg_to_data_url` | Import PNGs/SVGs as static assets; reference directly at 34×34 / 30×30 / 24×24. Skip all rasterization/data-URL Qt machinery. |
| What's-New flag-emoji substitution | No-op for v1.108; render HTML as-is (browser renders emoji natively). |
| Samples bundled JSON via `_MEIPASS`/`__file__` | Bundle 5 sample JSONs as static assets; reuse existing fixture-load pipeline. |
| History `temp_states/*.json` on disk | IndexedDB snapshots keyed `{sessionId, step}`; add retention policy (web deviation). |
| `QPixmap`/`QPainter` icons, monkey-patched paintEvent, `QTimer.singleShot` re-style | CSS/SVG; not needed (CSS classes apply instantly). |
| `theme_changed`/`language_changed` signals + `set_language` cascade | Already handled: `setSettings` + `docRevision` re-render + `App.tsx` `<html>` class/`dir`. |
| `QLocale.setDefault` | Optional `Intl` mapping; usually no-op. |

---

## 6. SCOPE DECISION POINTS (user's call)

1. **Content-heavy pages (Tutorial, Button Guide, What's New, Samples, About, History).** These are large, mostly read-only or recovery pages with significant asset/translation work and little functional-settings value. **Recommended default: DEFER all 6 to a later phase** (Phase 4/5); ship the 5 functional pages first (General, Layer Panel, Selected Strand, Language, Save/Load). Samples and History are the highest-value of the deferred set (they touch the doc) and could be pulled forward if desired.

2. **Color picker fidelity: native-feeling RGBA popover vs. simple `<input type=color> + alpha slider`.** Recommended default: **simple** — reuse the existing `.cf` pattern (`<input type=color>` + alpha range). It is faithful to the *outcome* (RGBA + alpha) with minimal effort; upgrade to a richer popover only if the user wants screen-color-pick / custom swatches parity.

3. **Apply model: live-apply-on-change vs. OSS deferred batch-on-OK.** Recommended default: **live-apply** (bind every control to `setSettings`). It matches OSS's effective result, is simpler, and the store already persists + re-renders per change. Keep a visible OK/Close footer button for parity but make it a no-op commit + close.

4. **Save/Load = browser download/upload vs. File System Access API.** Recommended default: **Blob download + `<input type=file>` upload** — universally supported, no permissions prompt.

5. **`.txt` byte-compatibility with the desktop app.** Recommended default: **JSON-only** (export/import the snake_case JSON shape); do **not** implement the PascalCase `.txt` `toTxt()/fromTxt()` adapters unless cross-loading desktop `user_settings.txt` files is an explicit requirement. The internal store stays JSON in localStorage.

6. **Wire the 4 dead `default_*` strand fields into strand creation.** They exist in state but are unused (creation hard-codes factory constants). Recommended default: **YES, wire them** (thread `settings.default_*` into `addNewStrand`/`makeStrand`) since the Layer Panel page exposes them and users will expect them to take effect.

7. **History retention policy** (no OSS equivalent — browsers can't guarantee cleanup-on-exit). Recommended default: **keep last 10 sessions, prune sessions older than 14 days on app start.**

8. **Snap-to-grid (attach) as a separate setting.** OSS splits move-snap vs attach/create-snap; JS currently has one `snap_to_grid_enabled`. Recommended default: **add the separate `snap_to_grid_attach_enabled`** and wire it into the attach/create path (relevant to the recent free-angle new-strand work).

---

## 7. Recommended Implementation Phasing

1. **Phase 0 — Shell + theming.** Replace the `SettingsDialog` stub with a `<Modal>`-based two-pane shell (nav list + stacked pages). Add the theme CSS vars/classes (§4), swatch-button + custom-checkbox components, and the category nav. Wire index switching. No new settings yet. Discrete/buildable: renders all 11 nav rows, General page shows existing controls.

2. **Phase 1 — Data model.** Extend `Settings` (§3.4) + `DEFAULT_SETTINGS`; add the RGBA color-picker component; add JSON `toJson()/fromJson()` adapters. No UI consumers yet beyond storage. Buildable: old blobs auto-migrate, all keys persist.

3. **Phase 2 — General + Layer Panel + Selected Strand pages.** Full control sets (§2.0–2.2) incl. the default-width sub-dialog (grid_unit 23 + split math), all swatches, curvature live-apply, third-CP mask-reset. Wire renderer/creation consumers (curve propagation, default_* into creation, snap-attach, shadow/highlight colors). This is the functional core.

4. **Phase 3 — Language + Save/Load pages.** Flag combobox (en→us/he→il mapping, 48px rows), `<html dir>` flip (mostly exists). Save = download, Load = file-input import → hydrate. Add missing i18n keys to `translations.ts`.

5. **Phase 4 — Content pages (deferred set).** Build in value order: **Samples** (reuse fixture-load), **History** (IndexedDB snapshots + retention), then **About** / **What's New** / **Button Guide** / **Tutorial** (static HTML/asset-driven, theme+language reactive). Bundle sample JSONs, tutorial mp4s, guide icons/SVGs as static assets.

6. **Phase 5 — Polish.** RTL row-mirroring audit, tooltips for all spinboxes, toast wiring, the `default_arrow_color` checkbox label-left special case, dynamic-width parity, and a pixel/behavior diff pass vs OSS for the functional pages.
