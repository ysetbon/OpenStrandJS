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
### 2. Copy/paste (strand data) flow
### 3. Angle-adjust dialog/mode
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
