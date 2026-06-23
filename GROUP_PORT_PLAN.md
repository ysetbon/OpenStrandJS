# Group Operations Port Plan

Porting all **group operations** from the original OpenStrand Studio (Python/PyQt)
into the JavaScript port, on the dedicated `group` worktree/branch.

- **OSS original:** `C:\Users\YonatanSetbon\projects\OpenStrandStudio`
  (`src/group_layers.py` ~7700 lines, `src/group_shadow_editor_dialog.py`)
- **JS port:** `C:\Users\YonatanSetbon\projects\OpenStrandJS` (this worktree = `group` branch)
- **Working style:** each operation is a discrete unit of work; may be driven by its
  own workflow or its own branch/PR (decided per operation).

This plan was produced by diffing the OSS group machinery against the JS port's
existing group support (much of the scaffolding already exists — see status column).

---

## Data model: the cross-cutting decision (gates #1, #5, #6)

| | OSS | JS port |
|---|-----|---------|
| Group shape | `{main_strands, layers, strands, control_points, data}` | `{ main_strands: string[] }` (`src/model/types.ts:81`) |
| `main_strands` meaning | **roots** (`"x_1"`); full set resolved dynamically | the **flat full member list** |
| Membership resolution | `resolve_group_data()` scans canvas for whole branch incl. attached + masked descendants (`group_layers.py:1776`) | none — members are exactly what's listed |

**DECIDED ✅ (see Status log):** OSS root-resolution. `main_strands` stays the stored
branches; `src/model/group.ts:resolveGroupMembers` resolves full membership on demand
= every non-masked strand sharing a main strand's `set_number` (a "branch" — attached
children inherit the parent's set) + every mask whose both components are in that set.
Move/Rotate/Shadow now operate on the resolved set, so attached children move/rotate
with their parent and the shadow editor lists the whole branch.

---

## Operation checklist (OSS → JS)

Legend: ✅ faithful · 🟡 present but simplified / needs fidelity work · ❌ missing or wrong

### 1. Create group — 🟡
- OSS: `create_group_with_params` (`group_layers.py:4355`), dialog picks roots, collects descendants (regular/masked/attached).
- JS: `createGroup` (`src/store/actions.ts:312`), `createGroupFromSet` (:269), `MainStrandSelectDialog.tsx`. Stores flat list.
- **Gap:** root→descendant resolution / membership parity (see data-model decision).

### 2. Delete group — ✅
- OSS: `delete_group` (`group_layers.py:2312`). JS: `deleteGroup` (`actions.ts:279`).
- Metadata-only; strands untouched. Fidelity spot-check only.

### 3. Rename group — ✅
- OSS: `rename_group` (`group_layers.py:2350`). JS: `renameGroup` (`actions.ts:324`) + `RenameDialog.tsx`.
- Has empty/collision guards. Fidelity spot-check only.

### 4. Duplicate group — ❌ WRONG (highest correctness payoff)
- OSS: `duplicate_group` (`group_layers.py:2474`) **clones strands** (regular/masked/attached)
  with new set numbers via `get_next_consecutive_set_numbers`, preserving geometry,
  control points, deletion rectangles, parent relationships; adds them to the canvas.
- JS: `duplicateGroup` (`actions.ts:334`) merely copies the group record pointing at the
  **same strands** → moving the "copy" moves the originals.
- **Gap:** implement real strand cloning + set-number allocation, then group the clones.

### 5. Move group — 🟡
- OSS: `start_group_move` (`group_layers.py:1578`), `GroupMoveDialog` (:3638), live preview.
- JS: `translateGroup` (`actions.ts:285`) + `GroupMoveDialog.tsx` (X/Y sliders, grid step,
  snap, single undo step, masked deletion-rect transform). Mechanics good.
- **Gap:** only moves listed members + masks whose **both** components are members →
  attached descendants left behind. Resolved by data-model decision (#1).

### 6. Rotate group — 🟡
- OSS: `start_group_rotation` (`group_layers.py:1840`), `GroupRotateDialog` (:5660),
  centroid pivot, `rotate_point` (:2066), smooth-rotation variant (:1964).
- JS: `rotateGroup` (`actions.ts:348`) about centroid + `GroupRotateDialog.tsx`. Faithful math.
- **Gap:** inherits membership-resolution gap (#1). Optional: smooth/animated variant.

### 7. Edit strand angles — ❌ MISSING
- OSS: `edit_strand_angles` (`group_layers.py:3475`), `StrandAngleEditDialog` (:6109):
  per-strand angle value + ±1°/±5° + continuous-hold w/ acceleration; linked-strand
  propagation; `_skip_save` during, save on close; `update_group_after_angle_edit` (:3614).
- JS: context-menu item is a **placeholder**. No dialog, no per-strand angle action.
- **Gap:** new `GroupAngleEditorDialog.tsx` + store action (rotate single strand about
  pivot / set angle) + linked-strand update.

### 8. Edit shadows — 🟡
- OSS: `open_group_shadow_editor` (`group_layers.py:3452`) + `group_shadow_editor_dialog.py`:
  per-strand **visibility / allow-full-shadow / subtract-layer** controls + section toggles,
  writing to `canvas.shadow_overrides[layer_name]`.
- JS: `GroupShadowEditorDialog.tsx` + `setGroupShadowOnly` (`actions.ts:397`) — only a single
  `shadow_only` boolean per member.
- **Gap:** port the real `shadow_overrides` model (visibility/full/subtract) + UI rows.

### 9. Create mask grid — 🟡
- OSS: `create_mask_grid` (`group_layers.py:3511`) + `MaskGridDialog` (`mask_grid_dialog.py`):
  rows×cols + component pick; resolves crossings + over/under ordering from geometry.
- JS: `createMaskGrid` (`actions.ts:411`) — naive all-pairs masks, no dialog (self-flagged TODO).
- **Gap:** dialog (dimensions/components) + geometry-aware over/under ordering.

### 10. Panel sync / refresh — ✅
- OSS: `sync_from_canvas` (`group_layers.py:1477`). JS: React re-renders `GroupPanel.tsx`
  from `doc.groups`. No work.

### 11. Expand / collapse — ✅
- OSS: `eventFilter` (`group_layers.py:946`). JS: present in `GroupPanel.tsx`. No work.

---

## Save / load (parity to verify)

- OSS: `serialize_groups` / `deserialize_groups` (`save_load_manager.py:1285/1335`) writes
  `main_strands`, `layers`, `strands`, `control_points`.
- JS: `serializeProject` / `loadProject` (`src/io/saveLoad.ts:196/46`) pass `groups` through
  verbatim (`Record<string, unknown>`), so any model change here round-trips permissively.
- **Action:** if the data-model decision (#1) changes the group shape, update serialization
  parity and confirm OSS JSON still loads.

---

## Status log

- **Membership model (#1, cross-cutting) — DONE.** Added `src/model/group.ts`
  (`resolveGroupMembers` / `groupSetNumbers`); rewired `translateGroup`, `rotateGroup`,
  `setGroupShadowOnly` (`src/store/actions.ts`) and the member display in `GroupPanel.tsx`
  + `GroupShadowEditorDialog.tsx` to resolve whole branches. Typechecks clean. This
  closes the membership half of #5/#6 and the member-scope of #8. `createMaskGrid`
  deliberately left pairing on the stored mains pending its own task (#9).
  - Behavioural nuance: a group now resolves to whole branches (picking one strand of a
    branch includes its attached children) — faithful to OSS, which has no partial-branch
    groups.
- **Move/Rotate (#5/#6) — perf + exact UI DONE** (commit `6e01912`). Matched OSS live-drag:
  `model/group.ts` `snapshotGroupDrag` / `applyGroupMoveSnapshot` / `applyGroupRotateSnapshot`
  resolve+snapshot once and apply ABSOLUTELY (no per-tick re-resolution, no float drift; pivot =
  weighted centroid). Dialogs engage the renderer drag fast-path (`setDragging`/`setDragMoving`)
  so only the group redraws per tick, and `beginGesture`+`commit` = one undo step. Dialog UI
  matched to OSS (rotate: angle slider + precise °input; move: px sliders/inputs −600..600 + grid-
  step rows + OK/Cancel/Snap). Verified in-browser. Remaining move-dialog deviation: Snap rounds
  the offset (not a true absolute snap-group-to-grid).
- **Duplicate group (#4) — DONE** (commit `9528bf0`). Rewrote `duplicateGroup` to deep-clone the
  group's strands under fresh set numbers into an independent group (was sharing strands — a bug).
  Set-number allocation matches OSS (`sorted(unique_sets)` → next free numbers); attached_to/knot
  refs remapped to clones; masks rebuilt from cloned components. Verified in-browser: multi-set
  {1,2}→{3,4}, clones exact, moving the copy leaves the original untouched, child re-parents to
  cloned parent, one undo step. Built via the `group-duplicate` workflow + adversarial review.
- **UI fidelity check**: Move + Rotate dialogs screenshotted in-browser and confirmed to match the
  OSS spec exactly (Move "Move Group: g", X/Y sliders −600..600 + px inputs + grid-step rows + OK/
  Cancel/Snap; Rotate "Rotate Strands: g", angle slider −180..180 + precise °input). Context menu in
  exact OSS order. (Native Qt-dialog pixel-diff not capturable with current tools.)
- **Edit Strand Angles (#7) — DONE** (commit `d0c317e`, via `group-edit-angles` workflow).
  `setStrandAngle` rotates end about start (length preserved) reusing `moveHandle` weld
  propagation; new `GroupAngleEditorDialog` (snapshot/fast-path/one-undo, like rotate) lists
  editable members (excl. masks, `_1` mains, both-ends-closed) with angle input + ±1/±5; wired
  into GroupPanel/LayerPanel. Verified in-browser (rotate end about start, length preserved,
  round-trips; only `1_2` editable). Deferred OSS extras: End X/Y cols, x / x+180 checkboxes,
  press-and-hold accel. Divergence: editing a parent angle drags welded children (moveHandle)
  vs OSS rotate-about-own-start — flag for later if exact match needed.
- **Edit Shadows (#8) — DONE** (commit `a62091e`, via `group-edit-shadows` workflow). Real
  `shadow_overrides` model (`casting→receiving→{visibility, allow_full_shadow, subtracted_layers}`)
  + new LayerState-style actions. WIRED to renderer (changes pixels): "Shadow Only" (suppress body)
  + "Visible" (per-pair skip), via `buildMeta`/`toRenderArray` → `web/strand-renderer.js` (absent-safe
  gates). STORED-ONLY (need net-new geometry, labeled in-UI): "Full Shadow", "Subtract Layers".
  Rewrote the dialog (per-casting sections + per-pair rows). **Fidelity verified byte-identical**
  (stash A/B: braid 1895 / knot 20498 mismatch px with AND without #8). i18n + CSS added.
  Low nits left: stale preview comment; subtract-section can't collapse once populated (stored-only).
- **Create Mask Grid (#9) — DONE** (commit `2281045`, via `group-mask-grid` workflow + a
  crossing-detector fix). `createMaskGrid` is now geometry-aware: masks only member pairs whose
  centerlines actually cross, over/under from z-order, dedup both directions. New `MaskGridDialog`
  (member multi-select + Select All) wired in. **Fix:** the original `segIntersect` (proper-X only)
  missed symmetric perpendicular crossings (the canonical weave) because a sampled vertex lands on
  the other line (orientation 0) — made it touch-tolerant + added an attached-join guard. Verified:
  HxV cross → one mask (z-order over); isolated + attached-join correctly skipped; idempotent.
  Deferred: full N×N directional matrix; centerline proxy vs OSS stroked-area (T-junctions).

## ALL GROUP OPERATIONS PORTED ✅

Every operation in the checklist is now done or was already faithful:
#1 create/membership · #2 delete · #3 rename · #4 duplicate · #5 move · #6 rotate ·
#7 edit-angles · #8 edit-shadows · #9 mask-grid · #10 panel sync · #11 expand/collapse.
Branch `group`, commits ec596a0 → 2281045. Each verified in-browser; renderer change (#8)
proven fidelity-byte-identical. Known deferrals/divergences are listed per-op above.

## Suggested order

1. **Membership model** (cross-cutting) — settle root-vs-flat; unblocks Create/Move/Rotate.
2. **Duplicate group** (#4) — functionally broken; highest correctness payoff.
3. **Edit strand angles** (#7) — net-new dialog + action.
4. **Edit shadows** (#8) — port the real `shadow_overrides` controls.
5. **Create mask grid** (#9) — dialog + geometry-aware ordering.
6. Polish **Create / Move / Rotate** (#1/#5/#6) once the membership model lands.

✅ rows (delete, rename, sync, expand) need only a fidelity spot-check.

---

## Key file references

**JS (`OpenStrandJS`):**
- `src/store/actions.ts:263-428` — all group actions
- `src/model/types.ts:81` — `GroupRecord`; :84-94 `EditorDocument`
- `src/ui/GroupPanel.tsx` — panel + 9-item context menu
- `src/ui/dialogs/` — GroupMove / GroupRotate / GroupShadowEditor / MainStrandSelect / Rename
- `src/io/saveLoad.ts:196` — serialization
- `src/modes/` — Mode interface (for any canvas-based group mode)

**OSS (`OpenStrandStudio`):**
- `src/group_layers.py` — `GroupPanel`, `GroupLayerManager`, all operations
- `src/group_shadow_editor_dialog.py` — shadow editor
- `src/save_load_manager.py:1285` — group serialization
- `src/undo_redo_manager.py:3198` — undo/redo wrappers
