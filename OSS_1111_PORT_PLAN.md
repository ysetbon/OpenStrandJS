# OSS v1.111 → OpenStrandJS port

OpenStrand Studio shipped **v1.111 on 2026-09-22** (OSS range `9df3a92` back to the
1.110 release on 2026-08-26). This maps each 1.111 change to what the JS port does
about it. OSS refs are commits / files in `ysetbon/OpenStrandStudio`.

## Ported

### Stylize End Side (`end_style.py`, `end_style_dialog.py`, `352ab3e`…`5e2cd35`)
A free end (no circle; never an attached strand's start) can carry an end style:
Straight / Angled / Rounded / Pointed / Notched / Concave, a tilt (±60°), a depth
(share of the width), an extend/trim offset along the tangent, and a side line
with its own thickness and colour. Everything derives from one profile in the
end's local frame; nothing ahead of the endpoint plane is ever removed, and a
default record renders through the classic code (stored as `null`).

- `src/model/endStyle.ts` — the record: normalize / default detection / equality /
  (de)serialize, in OSS `serialize_style` key order.
- `src/model/types.ts` `StrandRecord.end_styles`, `factory.ts` default,
  `io/saveLoad.ts` (`end_styles` written right after `end_line_visible`, like
  `serialize_strand`), `store/visualEqual.ts` (undo dedupe sees an end-style-only
  or side-line-visibility change), `store/historyMeta.ts` (`strand.end_style`).
- `web/strand-renderer.js` — the geometry (`esGeometry`): profile, cap pieces
  added ahead of the endpoint plane, cut polygons removed behind it, the styled
  body painted under a winding-fill keep-clip (no boolean op on the raw band,
  same reason as `windingFillLayer`), the side-line band clipped to the body,
  the outer / inner / dilated footprints for shadows and masks
  (`strandFootprintAtWidth`), the styled selection halo, and the dash-extension /
  small-arrow anchor shift (`_end_anchor`). Unstyled strands never enter this
  code: `tools/render_identity.mjs` proves every pre-existing fixture is
  pixel-identical.
- `src/interaction/endStyleFootprint.ts` + `selectionFootprint.ts` — the
  click / hover footprint gains the cap pieces and loses the cuts.
- `src/ui/dialogs/EndStyleDialog.tsx` — the dialog: live canvas preview through
  one gesture (Cancel = `cancelGesture`, OK = one undo step), the preview
  picture and the six shape icons painted by the real renderer
  (`callRenderTo`), Apply to both free ends, Reset to Straight.
- `src/ui/NumberedLayerButton.tsx` — the "Stylize End Side  Start / End" row
  right under Close the Knot (End only for an attached strand, none for a mask).
- `src/ui/settings/ButtonGuidePage.tsx` — the guide entries (and the Hide Shadow
  entry OSS added in `6adc6d4`).
- `fixtures/end_styles.json`, `tools/end_style_check.mjs` (CI).

### Smoother dragging (`8543a33`, `6045d4f`, `bd7354f`)
- Move mode shows the closed hand while a point is held
  (`InteractionHost.cursorFor`, from `store.dragging`).
- View mode pans with the left button too (`InteractionHost.onPointerDown`).
- The Refresh tooltip says what it does: "Reload layers and reset the view"
  (translations sync).
- `tools/cursor_check.mjs` covers both cursor rules.

### Translated undo / redo tooltips (`0d049ec`)
- `src/store/historyTranslations.ts` (generated from `undo_redo_translations.py`
  by the sync script) and `historyShortLabel(meta, lang)`: the Undo / Redo button
  tooltips name the action in the UI language, a move says endpoint vs control
  point, and Hebrew isolates the layer names (U+2068/2069) like OSS.

### Russian, Finnish, Swedish, Japanese, Chinese (`256d550`, `99cdce4`, `1b244d5`, `25c82c6`)
- `Language` is now twelve codes; `tools/sync_translations.py` regenerates
  `src/ui/translations.ts` from the desktop table (every existing entry gains the
  five languages, every desktop key the table lacked is appended — the end-style
  strings, the language names, `toggle_shadow_tooltip`, the 1.111 What's New).
- Language page order and flags follow `settings_dialog.py` (`se.png`, `jp.png`,
  `cn.png`); flag icons lost their outline like OSS `25c82c6`.
- `tools/tier4_check.mjs` now requires all twelve languages per entry.

## Not ported (deliberately)

- **Right Size on Scaled Screens / Dialogs Fit Small Screens / canvas stays
  sharp while dragging** (`5a90953`, `cb95a39`…`4704671`, `500ea01`,
  `4c028d2`, `a7c39f4`): Qt display-scaling, QDialog sizing and QPainter
  device-pixel fixes. The browser handles DPR, dialogs are CSS-sized and scroll,
  and the drag path already renders at the canvas's backing resolution.
- **Tutorial re-recordings, installers, release files, Inno Setup / macOS
  localisation notes**: N/A.
