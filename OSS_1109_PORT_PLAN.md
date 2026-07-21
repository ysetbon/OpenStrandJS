# OSS v1.109 → OpenStrandJS port plan

OpenStrand Studio shipped **v1.109 on 2026-07-21** (OSS range `d3f07781..0d751d90`,
~54 commits). The last OpenStrandJS sync is **2026-06-27** (`c9c4a32`), so *every*
1.109 feature commit (July 2 onward, plus one June 11 shadow fix) is unported.
This doc maps each OSS change to the JS gap and the files to touch, in suggested
order. OSS refs are commits in `ysetbon/OpenStrandStudio`.

## What needs NO action (verified)

- **Save/load round-trip is already safe.** `src/io/saveLoad.ts` routes unmodeled
  strand keys through the `StrandRecord.extra` passthrough bag and serializes
  `shadow_overrides` verbatim, so 1.109 files (with `hide_shadow`, arrow props,
  `auto`/`pinned` override bookkeeping) load and re-save without data loss today —
  they just aren't *rendered or editable* yet. `locked_layers`/`lock_mode` already
  round-trip at project level.
- **Painter save/restore try/finally guards** (OSS `987fe78c`, `7a82a7e4` menu
  leak fix) — Qt-specific crash fixes; no JS equivalent needed.
- **Installers, tutorial videos, READMEs, mac install guide** — N/A.
- **Elliptical-cap shadow receiver clipping** (OSS `dfe62808`) — JS doesn't render
  elliptical caps at all (known deferred residual); becomes relevant only if caps
  are ever ported.

## 1. Quick rendering-correctness wins (do first)

### 1.1 Per-strand `hide_shadow` — render + menu (OSS `d39f5bb6`, `79016fd5`)
The one-line render rule is `shader_utils.py:466`: if `strand.hide_shadow`, the
strand casts no shadow (it still receives).
- `web/strand-renderer.js`: skip the casting pass for strands with `hide_shadow`.
- `src/model/types.ts` + `factory.ts`: typed `hide_shadow: boolean` (default false);
  add to `MODELED_KEYS` + `serializeStrand` in `saveLoad.ts` (OSS now always writes it).
- `src/renderer/toRenderArray.ts`: pass it through.
- `src/ui/NumberedLayerButton.tsx`: context-menu toggle "Hide Shadow" (✓-prefixed
  like Shadow Only), for regular/attached/masked strands.
- Undo/redo is free (doc snapshots); verify group duplicate/move copies it
  (OSS `79016fd5` fixed exactly this) — JS group ops must not drop `extra`/typed
  fields when cloning strands.

### 1.2 Circle visibility on load for AttachedStrand starts (OSS `e9d31184` + save_load fix)
1.109 lets an explicit layer-menu circle choice survive reload: on load,
`has_circles[0]` of an AttachedStrand uses `manual_circle_visibility[0]` when set
(previously forced `true`).
- `web/strand-renderer.js::computeHasCircles` currently returns
  `[true, …]` for AttachedStrand unconditionally → respect `mcv[0]` when non-null.
- Mirror in any store-side recompute (`src/store/actions.ts` circle toggles already
  write `manual_circle_visibility`).

### 1.3 Widen the shadow-override type (OSS `92c6f8e2`)
Overrides now carry bookkeeping keys: `{visibility, auto?, pinned?}`. The renderer
correctly reads only `visibility`, and serialization is verbatim — just widen
`types.ts::shadow_overrides` so the extra keys are modeled, and make sure any JS
override-editing UI preserves `auto`/`pinned` (see §4).

## 2. Lock mode redesign (OSS `0ee55706`, `f5a25d56`, `61817dcb`)

JS still has the OLD UX: in lock mode, clicking a layer toggles its lock
(`LayerPanel.tsx:162`) and locked layers are inert to selection
(`LayerPanel.tsx:175`). The 1.109 UX:
- Each layer button shows a small **padlock toggle** in lock mode (edge opposite
  the green attachable strip, mirrored for RTL, hover tint). Clicking the padlock
  locks/unlocks; clicking anywhere else **selects normally**.
- Selecting in lock mode no longer forces attach mode; locked strands are
  selectable but not movable.
- Locked strands excluded from attach mode (attachment, hover, attach circles) —
  JS `AttachMode.ts:64` already skips them ✓ — and hide their moving squares and
  CP handles — `overlayRenderer.ts:69` already skips them ✓.
- New Strand / Delete Strand stay available in lock mode; **delete is blocked only
  for locked layers** (check JS delete path), locked indices remap after deletions
  (JS keys by layer_name, so mostly free — verify cascade delete filter ✓
  `actions.ts:384`).
- Buttons created during lock mode (attach/mask) get the padlock too.
- Layer name centers in the free span beside the padlock (long masked names).

Files: `LayerPanel.tsx` (remove toggle-on-click + inert-selection), 
`NumberedLayerButton.tsx` + `layerButton.css` (padlock chip), `hitTest.ts`
(locked = selectable, not movable — today `strandBodyVisible` excludes locked
layers entirely, which blocks selection; split "selectable" from "movable").

## 3. Selection hit-testing parity (OSS `96448f0c`, `e9d31184`, new `selection_utils.py`)

OSS unified select+mask-mode hit-testing against the *exact rendered geometry*,
topmost first. Port into `src/interaction/hitTest.ts`/`hitGeometry.ts`:
- Body hit = centerline stroked to `width + 2*stroke_width`, FlatCap (stroke edge
  clickable).
- Footprint unions the end decorations as rendered: junction cap circles (incl.
  partner-scaled), closed-connection circles, side-line bands, unfolded-start fill
  circle; hidden/transparent variants excluded.
- **Masked strands are body-selectable** via the drawn mask (stroke ∪ fill layers).
  JS currently skips MaskedStrand bodies in select mode (`hitTest.ts:5`) — change.
- Remove any invisible grab square around attached-strand starts that steals
  clicks (OSS removed its 120×120 one).
- Mask mode: pick the **topmost** strand instead of the "exactly 1 overlap" cancel
  rule; skip hidden; hover highlight must draw the same footprint as the hit-test.
- Sub-pixel robustness: sample a 3×3 grid of ±0.5px offsets (OSS works around
  contains() failing on the centerline seam of straight strands; paper.js is
  saner but keep the tolerance for parity).

## 4. Shadow editor: per-strand dialog, mask rows, auto-hide (OSS `77cd95ee`, `92c6f8e2`)

- The per-strand **Edit Shadows** menu item is a disabled TODO in
  `NumberedLayerButton.tsx:258`. Port `shadow_editor_dialog.py` (JS already has the
  group-scoped `GroupShadowEditorDialog.tsx` to crib from).
- **Mask-proxy rows** (`77cd95ee`): when strand X is the over-strand of mask X_Y,
  its dialog shows "via mask X_Y → layer" rows for layers below the mask; edits
  write overrides keyed under the *mask's* layer name.
- **Auto-hide weave-contradicting shadows** (`92c6f8e2`, new `src/auto_shadow.py`,
  259 lines): whenever masks change, measure each candidate casting→receiving
  pair (mask second-components casting into their mask's fabric); if surviving
  shadow area / raw overlap < **0.45** (min raw area **150** wu²), write
  `shadow_overrides[caster][receiver] = {visibility:false, auto:true}`. `pinned:
  true` (user re-enabled in the dialog) is never touched; non-`auto` entries never
  modified. Its docstring explicitly notes the data flows to OpenStrandJS — so
  *rendering* OSS-saved files already works; the port is only needed so **editing
  masks in JS** produces the same overrides. Pure geometry: paper.js path booleans
  + area. Trigger on mask create/delete/reset/deletion-rect edit and z-reorder.
  Port the weld-chain union-find from `auto_shadow._weld_chain_ids`.

## 5. Control-point visibility fixes (OSS `a1ccbf0e`, `ab5f5597`)

`show_cp_selected_only` exists in JS settings UI but is honored **nowhere**
(grep: only stored). Implement it with the corrected 1.109 semantics directly:
- It filters **only control points** (cp1/cp2/center + bias), for both drawing
  (`overlayRenderer.ts`) and grabbing (`hitTest.ts` CP pass). Non-selected strands
  keep endpoint squares and stay movable.
- `move_selected_only` stays the blunt filter (hides/blocks everything for
  non-selected strands) — also currently unimplemented in JS; do both while there.
- While dragging an endpoint, gate the cp1 triangle on `triangle_has_moved`
  (`ab5f5597`): a never-shaped strand shows no phantom triangle mid-drag.

## 6. Copy & Paste Strand Data (OSS `93c4565b`, `75f8e8e5`; spec in OSS `docs/copy_paste_feature/`)

New multi-select-mode feature. Port `strand_data_clipboard.py` (247 lines) into
store actions + `strand_data_menu.py` (455 lines) into the multi-select menu:
- **Copy panel** on a source layer: checkbox per property — start point, end
  point, control points, width, strand color, stroke color — plus toggle-all;
  snapshot is value-copied (later edits to the source don't mutate it).
- **Paste** onto one or many target layers, anchored from **start or end**: copied
  points move by pure translation so the source anchor lands on the target anchor
  (`_map_point` — never rotates). Attached children follow
  (`_move_attached_children`), attached geometry refreshes. One undo step.
- **UI chrome**: copy badge on the source button, one-click paste chips on target
  buttons (redesigned in `75f8e8e5`), Hebrew RTL handling for the panel.
- JS files: `NumberedLayerButton.tsx` (multi-select menu grows beyond its current
  2 items), new `src/store/strandDataClipboard.ts`, `editorStore.ts` (clipboard
  state), `layerButton.css`, `translations.ts`.

## 7. Layer-menu arrow customization (OSS `5e4fc9bd`, `a04b2a5c` + earlier arrow work)

**Blocked on the renderer**: `web/strand-renderer.js` draws no arrows at all
(zero `arrow` hits), though all arrow props round-trip via `extra`. Two stages:
1. Renderer: port `strand.py` arrow drawing — start/end arrows, full arrow with
   color/transparency/texture, shaft style, arrow head + arrow shadow, numeric
   size params. Verify with the headless harness against OSS renders of
   arrow-bearing files.
2. Menu: arrow section in the layer context menu incl. the new **Arrow Sizes**
   dropdown (all numeric dims), themed dropdowns, enlarged checkboxes.
Recommend doing this LAST (or explicitly deferring); the menu without the
renderer is inert.

## 8. Settings dialog + Button Guide polish (OSS `c37da502`, `406b24b9`, `5d5b81a`, `c0a950d`, `ef9e8f4`, `d859314`, `da206de1`, `f9b72bd`)

- Segmented **+/− stepper spin boxes** (`segmented_spin_box.py`, 164 lines → a
  small React component for `SettingsDialog` numeric fields), with the tightened
  value gap.
- Auto-size the settings category panel to its widest label; shorten the
  Save/Load label; the open-at-stale-position flashing fix is Qt-specific (verify
  the JS modal simply doesn't flash).
- Button Guide page: arrow-details section, **multi-selection section**,
  lock-mode icons + fuller descriptions, exact canvas indicators in the selection
  section (`ButtonGuidePage.tsx`).
- `translations.py` grew ~500 lines in 1.109 — port the new strings for ALL of
  the above across en/fr/it/es/pt/de/he into `translations.ts` (and keep the
  Hebrew RTL layer-panel fixes from `75f8e8e5` in mind for the panel CSS).
- `100e347b`: OSS removed the deletability hover tooltip from layer buttons —
  remove the JS one if present.

## Progress

- **§1 DONE** (commit `e6839e0`): hide_shadow modeled + rendered + menu toggle;
  computeHasCircles honors `manual_circle_visibility[0]` for AttachedStrand;
  ShadowOverride carries auto/pinned. Fixtures verified byte-identical;
  hide_shadow removes exactly the cast shadow.
- **§2 DONE** (this commit): lock-mode padlock redesign — padlock chip toggles
  the lock, layer click selects normally (no attach switch in lock mode), locked
  strands selectable but frozen (move/attach gating on lock_mode), New Strand
  enabled in lock mode, delete blocked only for locked layers, blue border only
  on the selected button, RTL mirroring for chip + attachable strip. Verified
  live: 14 deterministic Playwright checks (padlock counts, lock/unlock,
  selection, stash/restore on exit/re-enter, delete gating), zero page errors.

## Suggested order & verification

1. §1 quick wins (hide_shadow render+menu, circle-load fix, type widening)
2. §2 lock mode redesign
3. §3 selection hit-test parity
4. §5 CP visibility settings
5. §4 shadow editor + auto-shadow
6. §6 copy/paste
7. §8 settings/button-guide/i18n polish
8. §7 arrows (renderer first)

Each rendering change: `node tools/js_render.mjs fixtures/<f>.json artifacts/<f>`
then `node tools/diff.mjs artifacts/<f>` (serially), ideally adding a fixture
saved by OSS **1.109** with `hide_shadow` + auto-overrides set, so the oracle
exercises the new fields. Interactive slices: verify in the live editor
(`npm run dev`) with deterministic pointer events, per repo convention.
