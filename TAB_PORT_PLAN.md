# Tab feature fidelity port — OSSJS → OSS parity

Goal: make the floating **Tabs** feature in OpenStrandJS behave **exactly** like OpenStrand Studio
(Qt). Ground truth: `../OpenStrandStudio/src/tab_bar_widget.py` (DraggableTabEdge + chips),
`../OpenStrandStudio/src/tab_manager.py` (TabManager lifecycle), and `main_window.py` integration.
JS: `src/ui/TabEdge.tsx`, `src/ui/TabChip.tsx`, `src/ui/tabEdge.css`, `src/store/editorStore.ts`,
`src/ui/App.tsx`, `src/ui/Toolbar.tsx`, `src/ui/translations.ts`.

Derived from a direct read of both code bases + a multi-agent audit (adversarial verify pass).
Severity: **H**igh = wrong/observably different behavior, **M**edium = visible divergence, **L**ow = cosmetic.

## A. Lifecycle & data model (editorStore.ts vs tab_manager.py)

- **A1 (H) Default visibility.** OSS hides the tab edge at startup (`tab_edge.hide()`, `tabs_button`
  unchecked) — it appears only when the Tabs button is toggled. JS `showTabs` defaults to **true**
  (`editorStore.ts:573`), so the edge is always visible. → default `showTabs: false`.
- **A2 (H) Per-tab undo history.** OSS captures/restores each tab's full undo stack
  (`history_payload`, tab_manager.py:103-181). JS `switchTab`/`newTab`/`closeTab` reset
  `past:[]/future:[]` and never store them per tab (editorStore.ts:300-345) → switching tabs
  destroys undo history. → persist `past/future` into the leaving tab, restore on enter.
- **A3 (M) "Untitled N" numbering + retranslation.** OSS uses a dedicated monotonic
  `_untitled_counter` (separate from the id seq) and stores `untitled_index`, re-resolving the title
  through `title_for()` so it **re-translates** when the language changes (tab_manager.py:64-78).
  JS hardcodes the English string `Untitled ${id}` using the tab **id** (editorStore.ts:302,331) and
  never retranslates; new tabs omit `untitledIndex`. → add `untitledIndex` counter + derive the
  display title from i18n `untitled` at render time.
- **A4 (M) Close-tab neighbor.** OSS falls back to the `idx`-neighbor `tabs[min(idx, len-1)]`
  (tab_manager.py:382-386). JS always jumps to `remaining[0]` (editorStore.ts:337). → pick the
  neighbor at the closed index.
- **A5 (M) Duplicate insertion + dirty + name.** OSS inserts the copy at `idx+1` (right after the
  source), marks it **dirty**, and names it `"<title_for(src)> <tab_copy_suffix>"` (translated)
  (tab_manager.py:282-303). JS appends at the **end**, starts **clean**, and hardcodes `"copy"`
  (editorStore.ts:349-365). → insert after source, set `dirty:true`, translate the suffix.
- **A6 (L) markTabSaved title.** OSS strips the extension (`os.path.splitext`, tab_manager.py:412)
  and clears `untitled_index`. JS keeps the full filename (editorStore.ts:376). → strip extension,
  clear untitledIndex.

## B. Edge geometry, drag & snap (tab_bar_widget.py vs TabEdge.tsx + tabEdge.css)

- **B1 (H) Magnet grab during drag.** OSS *moves the edge to the anchor* while dragging when within
  `SNAP_THRESHOLD` (tab_bar_widget.py:646-649) — the panel visibly locks to the anchor. JS keeps the
  panel under the cursor and only shows a hint pill (TabEdge.tsx:101-108). → when snapping, render
  the panel **at the anchor**, not at the free cursor point.
- **B2 (M) Six-anchor ghost overlay.** OSS shows a `SnapOverlay` during drag visualizing **all six**
  anchors as themed ghost target pills (layered shadow/glow/fill/outer + inner dashed), highlighting
  the active one (tab_bar_widget.py:290-374). JS draws a single plain pill only at the active
  candidate (TabEdge.tsx:150-152, tabEdge.css:151-162). → render all six target pills + active state.
- **B3 (M) Free-position model = center ratio.** OSS stores a resolution-independent center ratio
  `(cx,cy)` and re-derives position on resize (tab_bar_widget.py:583-588, 543-546). JS stores a
  fixed pixel `dx/dy` offset from the anchor (editorStore.ts:383-387, TabEdge.tsx:122-125). → store
  `{anchor}` OR `{ratio:[cx,cy]}` like OSS; on resize a free edge scales with the canvas.
- **B4 (L) Persistence string format.** OSS serializes `"anchor:NAME"` / `"ratio:cx,cy"`
  (tab_bar_widget.py:555-579). JS stores JSON `{anchor,dx,dy}`. Acceptable for web localStorage but
  the *model* (B3) should match; keep JSON but switch to anchor|ratio shape.
- **B5 (M) Plus-button position.** OSS places `+` **after** the chips (trailing), grip strip leads
  (tab_bar_widget.py:469-472). JS renders `+` **before** the chips (TabEdge.tsx:169-191). → move `+`
  to the trailing side.
- **B6 (M) Drag anywhere on panel.** OSS starts a drag on any empty panel area
  (mousePressEvent, tab_bar_widget.py:621); the grip is only a cursor hint. JS only drags from the
  grip element (TabEdge.tsx:159-167). → allow drag from panel background (chips/buttons stop-prop).
- **B7 (L) Width sizing.** OSS sizes to layout hint × `TAB_WIDTH_SCALE=1.1`, clamped to
  `[120, canvas-20]` (tab_bar_widget.py:482-492). JS uses CSS content sizing + `max-width:70vw`.
  Visual only.

## C. Chip rendering & confirm dialogs (TabChip.tsx vs tab_bar_widget.py TabChip)

- **C1 (H) skip_close_tab_warning ignored.** OSS skips the dirty-close confirm when the setting is on
  (tab_manager.py:333-335). JS TabChip always prompts (TabChip.tsx:26-30) and never reads
  `settings.skip_close_tab_warning` (the setting exists, GeneralPage.tsx:58). → honor the setting.
- **C2 (M) Save button actually saves.** OSS "Save" makes the tab live, calls `save_project()`, and
  only closes if the save succeeded; cancel/failed save aborts the close (tab_manager.py:354-368).
  JS `doSave` just marks saved in memory and closes (TabChip.tsx:39-43). → wire to real save/export,
  abort on cancel.
- **C3 (M) Title font / chip metrics.** OSS title is **9pt** bold-when-active (tab_bar_widget.py:215-
  217). JS CSS sets `font-size:18px` (tabEdge.css:120). Verify against the 0.65 global zoom; the
  grip dots (3px) are scaled but the title looks oversized → reconcile to the OSS-equivalent size.
- **C4 (L) Confirm body text.** OSS body is `"<title>\n\n<unsaved_tab_title>"` (tab_manager.py:339).
  JS body shows only the name (TabChip.tsx:93). → match the two-line message.

## D. Integration, theme, session & i18n (App.tsx / main_window.py / translations)

- **D1 (H) Load-into-active-tab confirm.** OSS `load_project` replaces the active tab and, if it is
  dirty, prompts unsaved_tab_title (Save/Discard/Cancel) before replacing; cancel aborts the load
  (main_window.py:1544-1571). JS `loadDocument` (HistoryPage/SamplesPage/Toolbar) replaces silently
  and wipes history (editorStore.ts:389-396). → guard with the dirty confirm.
- **D2 (M) Quit warning.** OSS `closeEvent` warns `unsaved_tabs_on_exit` when any tab is dirty
  (main_window.py:2765-2822). JS has no `beforeunload` guard. → add a `beforeunload` warning when any
  tab is dirty.
- **D3 (M) Theme parity.** OSS themes the edge per `default/dark/light` table
  (tab_bar_widget.py:17-49); `set_theme` re-applies on theme change (main_window.py:1166-1170). JS
  uses `--tab-*` CSS vars (tabEdge.css). → verify each theme's panel/active/inactive/text/snap colors
  match the OSS tables and update on theme switch.
- **D4 (M) RTL (Hebrew).** OSS mirrors the whole edge for `he`: grip on the right, `+` on the left,
  chips reversed, label AlignAbsolute, confirm dialog RightToLeft (tab_bar_widget.py:199-252,469-471;
  tab_manager.py:350-351). JS TabEdge/TabChip have **no** RTL handling. → mirror under `lang==='he'`.
- **D5 (M) i18n coverage.** JS is missing/hardcodes tab keys. Present: `untitled`, `discard`,
  `unsaved_tab_title`, `skip_close_tab_warning`. Missing or hardcoded English: `tabs`, `new_tab`,
  `close_tab`, `duplicate_tab`, `tab_copy_suffix`, `unsaved_tabs_on_exit` (TabEdge "New tab"/"Drag to
  move"; TabChip "Duplicate"/"Duplicate tab"). → add keys (7 langs) + replace hardcoded strings.
- **D6 (L) Tab edge position persistence on exit.** OSS writes `TabEdgePosition:` to settings on exit
  and restores on launch (main_window.py:2841-2863, 226-240). JS persists to localStorage live
  (editorStore.ts:123-124) — functionally equivalent; keep, but align the model with B3/B4.

## Implementation order
1. Behavior-critical: A1, A2, B1, C1, D1 (Highs).
2. Lifecycle correctness: A3, A4, A5, A6, C2.
3. Visual/geometry: B2, B3/B4, B5, B6, C3, C4.
4. Integration/i18n/theme/RTL: D2, D3, D4, D5, D6.

Each change must keep the oracle/export byte-identical (tab chrome is UI-only, not on the render
canvas, so this is automatic — no `meta.*` gating needed).

---

## STATUS — IMPLEMENTED & VERIFIED (2026-06-29)

Audit: multi-agent workflow `tab-fidelity-audit` (48 findings → 45 confirmed, 3 correctly rejected).
All confirmed items implemented; `tsc --noEmit` clean; render oracle unchanged (single_strand 0% diff);
behaviors proven live in-browser via DOM assertions.

Files changed: `src/store/editorStore.ts`, `src/ui/TabEdge.tsx`, `src/ui/TabChip.tsx`,
`src/ui/Toolbar.tsx`, `src/ui/App.tsx`, `src/ui/tabEdge.css`, `src/ui/theme.css`, `src/ui/translations.ts`.

DONE (live-verified): A1 default-hidden · A2 per-tab undo history (snapshot/restore on switch) ·
A3 untitled counter + Hebrew re-translation ("ללא שם N") · A4 close→closed-index neighbor ·
A5 duplicate idx+1 + dirty + translated suffix · A6 markTabSaved strips ext/clears untitledIndex ·
B1 magnet locks panel to anchor mid-drag · B2 all-six ghost pills + active highlight ·
B3/B4 free=center-ratio model · B5 plus trailing · B6 drag from whole panel · C1 skip_close_tab_warning
honored (silent discard) · C2 Save actually downloads · C-confirm Save/Discard/Cancel + Enter=Save +
2-line body · D1 load-confirm on dirty active tab + mark saved · D2 beforeunload quit warning (gated by
skip_quit_warning) · D3 theme parity (+ `--tab-snap`) · D4 RTL mirroring via `dir` · D5 i18n (6 keys ×7 langs + wired).
Plus a real fix: drag math now converts pointer coords to layout px via the CSS-`zoom` factor
(getBoundingClientRect vs clientWidth mismatch) — was a latent bug that broke snapping.

DEFERRED (LOW / browser-limited, judgment calls):
- B7 `TAB_WIDTH_SCALE=1.1` + canvas-relative max-width — kept CSS content sizing (cosmetic).
- C3 title font 18px vs OSS 9pt — left as-is; the global `zoom:0.65` already brings it to ~9pt-equivalent
  and the audit did not flag it.
- C2 cancel-abort — browser `downloadJSON` gives no cancel signal, so "Save" always proceeds to close.
- "Centralize close in a store action (requestCloseTab)" — kept the confirm in TabChip; behavior matches.
- Capture-failure abort/warn — N/A for JS (ref-copy can't fail); intentionally omitted (audit-rejected).
