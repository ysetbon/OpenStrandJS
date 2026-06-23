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

**Decision needed:** adopt OSS root-resolution (store roots, resolve descendants on
demand) **or** keep flat membership and make Move/Rotate/Create include attached &
masked descendants explicitly. This one call settles three operations — do it first.

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
