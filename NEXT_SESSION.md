# Next session — start here

**Read this file, then begin the task below.** This is the auto-start handoff: when you
open a fresh session in this repo, do the task in "The task" verbatim.

## The task — MICRO-FIDELITY AUDIT: find every small OSS detail OSSJS misses

The v1.109 feature port is **complete and deployed** (see `OSS_1109_PORT_PLAN.md` —
§1–§8 all done, PRs #2–#6 merged, live at https://ysetbon.github.io/OpenStrandJS/).
The features exist; what remains is the long tail of SMALL divergences: wording,
dialog layouts, exact colors/sizes/spacing, popups, cursors, tooltips, timings.

**Your mission: make as much effort as possible to find ALL the small details that
exist in OpenStrand Studio (the Qt app) but are missing or different in OpenStrandJS —
then write `MICRO_FIDELITY_PLAN.md` cataloguing every finding, and start fixing them
in priority order.** Known examples straight from the user:

- **Copy message is not the same as OSS** — check every user-facing string of the
  copy/paste flow against `strand_data_menu.py` / `translations.py`: the badge popup
  hint, panel labels, menu wording, in all 7 languages. Do this class of check for
  EVERY feature: notifications (`show_notification` texts), confirmations, tooltips.
- **The angle-adjust window is not the same** — OSS has a dedicated angle adjust
  dialog/mode (`angle_adjust_mode.py`); OSSJS folded Angle/Length into
  StrandProperties inline. Port the real dialog: layout, fields, buttons, live
  preview behavior, ok/cancel semantics.
- "etc." — assume EVERY surface has some of these. Be systematic, not sampled.

### Method (be exhaustive — surface-by-surface sweep)

1. **Get the spec.** Clone the Qt app: `add_repo ysetbon/OpenStrandStudio`, clone to
   `/workspace/openstrandstudio` (release 1.109, `0d751d90`). It is the ground truth.
2. **Enumerate every OSS surface** and diff each against OSSJS, file by file:
   dialogs (`settings_dialog.py`, `shadow_editor_dialog.py`, group dialogs,
   `angle_adjust_mode.py`, width dialog, rename, save/load dialogs), the layer panel
   (`layer_panel.py`, `numbered_layer_button.py` — context menus, indicators,
   notification label), canvas modes (`move_mode.py`, `attach_mode.py`,
   `select_mode.py`, `mask_mode.py`, `rotate_mode.py` — cursors, banners, snapping,
   Esc/keyboard handling), main window (`main_window.py` — toolbar order, shortcuts,
   window title), `translations.py` (grep for keys OSSJS's `translations.ts` lacks —
   the delta IS a findings list), themes (dark mode parity!), RTL/Hebrew layout.
3. **Look with your eyes, not just the code.** The Qt app runs headless in this
   container: `pip install PyQt5 Pillow`, `apt-get install -y libpulse-mainloop-glib0`,
   `QT_QPA_PLATFORM=offscreen`. You can instantiate real OSS dialogs offscreen and
   `QWidget.grab()` them to PNGs, then screenshot the same OSSJS surface via
   Playwright (`executablePath: '/opt/pw-browsers/chromium'` or `OSS_CHROMIUM` env for
   `tools/js_render.mjs`) and compare side by side. Pixel renders: the real oracle
   works — `OSS_ROOT=/workspace/openstrandstudio python3 tools/reference_render.py
   fixtures/<f>.json out.png out.meta.json`.
4. **Write the plan first** (`MICRO_FIDELITY_PLAN.md`): one line per finding —
   surface, what OSS does, what OSSJS does, OSS file:line, priority (user-visible
   wording/dialogs first; cosmetic spacing last). Include the ALREADY-KNOWN deferred
   tails from `OSS_1109_PORT_PLAN.md`: arrow customization submenu (color/
   transparency/texture/shaft/Arrow Sizes — renderer already honors color/
   transparency/head), arrow shaft patterns + head textures + arrow_casts_shadow,
   hidden-strand full arrow, button-guide arrow/multi-select sections + guide i18n,
   `WidthConfigDialog` slider (OSSJS uses a prompt() — port the real dialog),
   per-row "Show Current Shadow" path preview in the shadow editors, mask hover
   highlight in select mode, side-line bands in the selection footprint.
5. **Fix in phases, verify every fix** the way this repo always has: deterministic
   Playwright checks against the live dev editor (`npm run dev`, debug handles
   `window.__store/__io/__actions/__clipboard/__hit/__requestRender`), pixel diffs
   via the Qt oracle for anything rendered, `tsc` clean. One commit per area with
   OSS file:line references in the message.
6. **Workflow:** branch `claude/...` → commit → PR to `main` → (user approves) merge
   → `npm run deploy` publishes to GitHub Pages. The user merges fast — keep PRs
   scoped. Never touch the Python repo.

### Gotchas carried over

- `toRenderArray` forwards only a subset of model fields — any renderer-read field
  must be surfaced there (this has bitten twice).
- Undo dedup (`visualEqual.ts`) must learn any NEW visual field you add, or edits to
  it create no undo step (bit us for locks and arrows).
- Unknown strand JSON keys ride the `extra` passthrough bag — round-trip is safe by
  construction; check `MODELED_KEYS` when promoting a field.
- Run js_render/diff strictly serially; kill stale vite instances (ports 5173/5199);
  hard-reload after edits. `mxn_lh_1x1` fixture note in git history no longer applies
  — it renders and diffs clean now.
- Icons: all button PNGs live in `public/layer_panel_icons/` (verbatim OSS assets) —
  never use unicode emoji for UI glyphs (macOS renders them differently).
- Deploy artifacts: `dist-editor/` via `npm run deploy`; app icon = the OSS
  box-stitch knot (`public/icons/`).

## Status ledger (do not re-do)

- v1.109 port §1–§8: DONE (`OSS_1109_PORT_PLAN.md` has the per-phase log + commits).
- Mobile: fit-to-width viewport + dvh + standalone manifest (PR #3).
- OSS PNG icons everywhere + OSS copy/paste indicator geometry & gating (PRs #4–#5).
- Tab favicon = real OSS app icon (PR #6).
