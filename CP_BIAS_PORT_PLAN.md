# Third control point + Curvature bias — port plan

Ground truth: OpenStrandStudio/src (strand.py, curvature_bias_control.py, move_mode.py,
strand_drawing_canvas.py, save_load_manager.py, settings_dialog.py). Synthesised by the
`understand-cp-features` workflow + direct verification.

## State of the port
- **Third control point**: already ~fully ported (model, factory, curve math in
  strand-renderer.js + hitGeometry.ts, overlay glyph + connector lines, MoveMode drag +
  lock-on-grab, hit-test, 0.5px auto-unlock, save/load, settings interlock). The only gaps
  are (a) the OSS toggle setter side-effects, (b) a stale doc note.
- **Curvature bias**: only the settings toggle + hardcoded `0.5` exist. No per-strand state,
  glyphs, drag, persistence, or formula plumbing.

## Decisive facts
- PATH USES CENTER iff `enable_third_control_point && control_point_center_locked` (strand.py:1417-1422).
- PATH USES BIAS iff `enable_curvature_bias_control` (strand.py:1461-1465, 1556-1560); else 0.5.
  Bias applies in BOTH the locked and unlocked/virtual-center branches (not the straight-line branch).
  Toggling bias OFF neutralises the curve but **preserves** stored bias values.
- Bias squares (UI) gate: `enable_curvature_bias_control && enable_third_control_point &&
  control_point_center_locked && triangle_has_moved && show_control_points`.
- Bias drag = constrained projection onto center→cp1 (triangle) / center→cp2 (circle);
  `bias = clamp(proj,0,len)/len`. Never grid-snaps. Pressing the triangle square sets triangle_has_moved.
- On-disk: nested `bias_control {triangle_bias, circle_bias, triangle_position, circle_position}`.
  On load restore only when toggle on; set triangle_has_moved if |bias-0.5|>0.001.
- Third-CP setter (strand_drawing_canvas.py:6413-6445): ON seeds missing centers=midpoint(cp1,cp2),
  locked=false; OFF resets every center=midpoint, locked=false.
- Formula already byte-matches OSS in strand-renderer.js (bias split triangle/circle, hardcoded 0.5).
  hitGeometry.ts uses a single `bias=0.5` and must be split to match once bias != 0.5.

## Fidelity strategy (oracle stays byte-identical when features OFF)
- Third CP: NO meta flag. Renderer keeps `enableThird = strands.some(cp_center!=null)` and the real
  gate `control_point_center_locked`. Toggle-off is handled by a DOC MUTATION (unlock all), so a
  live store with the setting off carries no locked centers — the oracle never needs the setting.
- Bias: gate the buildProfile read on an OPTIONAL meta flag `meta.curvature_bias` (set by the live
  editor's buildMeta = `enable_third_control_point && enable_curvature_bias_control`). Absent in the
  oracle/export meta → `bias_*  ?? 0.5` → `(0.5+0.5)=1.0` factors → identical floats to today.
- hitGeometry.ts is live-only (hit testing) → gate its bias read on live settings directly.

## Ordered gaps
- G1 model: `bias_triangle:number, bias_circle:number` on StrandRecord (default 0.5) + factory defaults.
- G2 persistence: read/write nested `bias_control`; default 0.5; strip from `extra`; set triangle_has_moved if deviates.
- G3 render plumbing: add bias_triangle/bias_circle to RenderStrand (toRenderArray + type); add `curvature_bias` to RenderMeta + buildMeta.
- G4 renderer: buildProfile reads `enableBias?(s.bias_triangle??0.5):0.5` (and circle); thread enableBias from `!!meta.curvature_bias`.
- G5 hit mirror: split single `bias=0.5` into triangle/circle in both branches; thread enableBias from settings via sampleCenterline.
- G7 handles: HandleKind += 'bias_triangle'|'bias_circle'; biasPositions(s) helper; emit handles when effective gate holds; 25px hit half.
- G8 drag: actions.setBias (projection, no snap); MoveMode handlePos + move case; press-triangle sets triangle_has_moved.
- G9 overlay: drawBiasControls (two squares + icons + dashed influence lines); affected-only during drag.
- G10 settings: settingsFromJson forces bias=false when third=false; effective gate everywhere = third && bias.
- S1 setter side-effects: editorStore.setSettings detects third-CP on→off / off→on and mutates the doc (OSS 6413-6445).
- G6 doc note: MOVE_MODE_OSS_SPEC.md center-grab gate line (documentation only).
