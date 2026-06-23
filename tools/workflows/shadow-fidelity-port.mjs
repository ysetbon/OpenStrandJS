export const meta = {
  name: 'shadow-fidelity-port',
  description: 'Port OpenStrandJS shadow rendering to be pixel-identical to OpenStrandStudio (Qt shader_utils.py)',
  phases: [
    { title: 'Extract', detail: 'Parallel readers extract the exact Qt shadow algorithm + current JS gaps' },
    { title: 'Design', detail: 'Synthesize the faithful port spec (paper.js mappings, exact formulas)' },
    { title: 'Implement', detail: 'Rewrite shadow rendering in web/strand-renderer.js + iterate on overhand_knot' },
    { title: 'Verify', detail: 'Run fidelity harness serially: overhand_knot match% + regression fixtures' },
    { title: 'Review', detail: 'Adversarial fidelity-to-spec review of the implemented shadow code' },
  ],
}

// ---- shared pointers ------------------------------------------------------
const QT = 'C:/Users/YonatanSetbon/projects/OpenStrandStudio/src'
const JS = 'C:/Users/YonatanSetbon/projects/OpenStrandJS'

// Ground-truth hypotheses from the initial scout. Agents must VERIFY each
// against source and correct any that are wrong — do not trust these blindly.
const HYP = `
SCOUT HYPOTHESES (verify against source; correct if wrong):
- Constants: num_steps=3, max_blur_radius=30.0, default shadow_color = QColor(0,0,0,150).
- Per blur step i in 0..num_steps-1:
    progress      = (num_steps - i) / num_steps        -> 1.0, 2/3, 1/3
    current_alpha = base_alpha * progress * (1/num_steps) * 2.0   (base_alpha=150 -> 100, 66, 33; int()-truncated)
    current_width = max_blur_radius * (i+1)/num_steps   -> 10, 20, 30
    pen: setWidthF(current_width), FlatCap (=butt), RoundJoin (=round); painter.strokePath(total, pen).
- CASTER core geometry = build_shadow_geometry(strand, 0, include_circles=False)
    = centerline stroked at (width + 2*stroke_width), RoundJoin + FlatCap. (extension arg is 0 for the core.)
- RECEIVER geometry = build_rendered_geometry(other) = centerline stroked at (width+2*sw) RoundJoin/FlatCap,
    UNIONED with each visible end-circle. AttachedStrand draws HALF-circles (full ellipse minus a tangent-rotated
    rect); radius = (width + 2*sw)/2. Transparent (alpha==0) circles are excluded.
- Per casting->receiving pair (caster ABOVE receiver in layer order, i.e. self_index > other_index):
    intersection = (caster_core + build_shadow_circle_geometry(caster, max_blur_radius+2 = 32)) ∩ receiver_geom
    then subtract: overlying-mask blockers, intermediate strands, (side-line exclusion is a NO-OP - returns empty).
- SOLID CORE fill: union(all intersections), WindingFill, filled with shadow_color at FULL alpha (150),
    CompositionMode_SourceOver, NOT clipped (it is already inside receivers).
- FADED BLUR: total = union(all intersections) + build_shadow_circle_geometry(caster, max_blur_radius=30);
    CLIPPED to clip_path = union of all receiver_geoms that received shadow; then the 3 stroke passes above.
- Gating: skip self; skip hidden strands (caster hidden -> no cast unless arrow; receiver hidden -> skip);
    skip pairs that are the two components of the SAME visible MaskedStrand; only cast onto LOWER layers.
- MaskedStrand crossings use draw_mask_strand_shadow: intersection of the two component stroked paths, the SAME
    3-step faded stroke loop, plus a darker inner-core fill (stroker width = first_w + first_sw*2).
- shadow_enabled is a per-canvas flag; only the overhand_knot fixture has it ON in the JS corpus.
`

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['area', 'keyFindings', 'exactValues', 'sourceRefs'],
  properties: {
    area: { type: 'string' },
    keyFindings: { type: 'array', items: { type: 'string' } },
    exactValues: { type: 'array', items: { type: 'string' }, description: 'exact formulas / numeric constants / pen + stroke settings, with the source line' },
    drawOrderAndGating: { type: 'array', items: { type: 'string' } },
    correctionsToHypotheses: { type: 'array', items: { type: 'string' }, description: 'any SCOUT HYPOTHESIS that is wrong, with the correct value' },
    sourceRefs: { type: 'array', items: { type: 'string' }, description: 'file:line anchors' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'things still unknown / unverifiable in the corpus' },
  },
}

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['portSpecMarkdown', 'changeList', 'paperJsMappings', 'specFilePath', 'risks'],
  properties: {
    portSpecMarkdown: { type: 'string', description: 'the full faithful-port spec, markdown' },
    changeList: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { location: { type: 'string' }, change: { type: 'string' } } } },
    paperJsMappings: { type: 'array', items: { type: 'string' }, description: 'each Qt construct -> the paper.js construct that reproduces it' },
    specFilePath: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['filesChanged', 'summary', 'selfCheckMatchPercent', 'openConcerns'],
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    diffHighlights: { type: 'array', items: { type: 'string' } },
    selfCheckMatchPercent: { type: 'number', description: 'overhand_knot match% from the implementer\'s own last harness run, or -1 if not run' },
    iterations: { type: 'array', items: { type: 'string' }, description: 'what each render->diff->adjust pass changed and its match%' },
    openConcerns: { type: 'array', items: { type: 'string' } },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['fixtureResults', 'shadowFixtureMatch', 'regressionOk', 'verdict'],
  properties: {
    fixtureResults: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { fixture: { type: 'string' }, matchPercent: { type: 'number' }, baseline: { type: 'number' }, note: { type: 'string' } } } },
    shadowFixtureMatch: { type: 'number', description: 'overhand_knot final match%' },
    regressionOk: { type: 'boolean', description: 'true iff single_strand/three_strand_braid/closed_knot did NOT regress vs baseline' },
    commandsRun: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['fidelityToSpec', 'deviations', 'verdict'],
  properties: {
    fidelityToSpec: { type: 'string' },
    deviations: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { severity: { type: 'string' }, location: { type: 'string' }, issue: { type: 'string' }, expected: { type: 'string' } } } },
    verdict: { type: 'string' },
  },
}

// ===========================================================================
phase('Extract')
log('Extracting the exact Qt shadow algorithm (4 parallel readers) + current JS gaps')

const READERS = [
  {
    label: 'extract:draw_strand_shadow',
    prompt: `You are reverse-engineering the EXACT shadow algorithm of OpenStrand Studio so it can be ported 1:1 to JS.
Read ${QT}/shader_utils.py fully. FOCUS on draw_strand_shadow (def at ~line 446) end-to-end:
the solid-core fill block (~1006-1034) AND the faded-blur stroke loop (~1337-1431).
Report with byte-level precision:
- The exact per-step alpha and width formulas (num_steps, max_blur_radius), the pen (cap/join/widthF), composition mode.
- Exactly what path is filled for the SOLID core vs what path is STROKED for the blur, and how clip_path is built/applied.
- The caster core path source (build_shadow_geometry call + its extension arg) and what circle geometry is added (extensions).
- The per-pair gating (layer order, should_be_above, hidden skip, same-visible-mask skip) and the order of subtractions.
${HYP}`,
  },
  {
    label: 'extract:geometry-helpers',
    prompt: `Read ${QT}/shader_utils.py fully. FOCUS on the geometry helpers and report exact stroker settings + math for each:
build_shadow_geometry, build_rendered_geometry, build_shadow_circle_geometry, get_proper_masked_strand_path,
get_shadow_blocker_path, _get_mask_visual_path, _subtract_named_layer_paths, _get_intermediate_layer_names,
_subtract_visible_component_mask_coverage, get_side_line_exclusion_path, draw_mask_strand_shadow.
For each: the QPainterPathStroker width (in terms of width/stroke_width), joinStyle, capStyle; how circles/half-circles
are built (radius, tangent angle, the masking-rect subtraction); and whether it is actually a no-op.
Be explicit about get_side_line_exclusion_path (does it return a real path or empty?) and draw_mask_strand_shadow's
inner-core stroker width and its faded-stroke loop.
${HYP}`,
  },
  {
    label: 'extract:gating-callsites',
    prompt: `Read the shadow CALL SITES and gating. In ${QT}/strand.py the calls to draw_strand_shadow are near lines
2182, 2416, 2911, 3163; also read ${QT}/attached_strand.py and ${QT}/masked_strand.py draw() shadow blocks.
Report: (1) WHEN draw_strand_shadow / draw_mask_strand_shadow is invoked during paint and in what ORDER relative to
drawing the strand body (shadow before or after body?); (2) where shadow_color comes from (canvas.default_shadow_color)
and its default value; (3) the canvas.shadow_enabled flag and its default; (4) any is_hidden / arrow gating at the call
site; (5) for MaskedStrand, exactly which two component paths are passed to draw_mask_strand_shadow and the widths used.
Also grep the canvas/save-load for default_shadow_color and shadow_enabled defaults.
${HYP}`,
  },
  {
    label: 'extract:js-current+harness',
    prompt: `Document the CURRENT JS shadow implementation and the fidelity harness, precisely, with file:line.
Read ${JS}/web/strand-renderer.js: the shadow constants (~33-40), the shadow loop inside renderFixture (~644-710),
the MaskedStrand crossing-shadow block in drawMasked (~555-569), and these helpers: strokedBodyAtWidth (~134),
maskComponentPath (~508), drawStrand (~454), computeHasCircles (~187), toColor (~13). Explain EXACTLY how the current
shadow is computed (expBody = body expanded by MAX_BLUR; region = expBody ∩ fullBody; filled solid) and enumerate every
way it diverges from the Qt algorithm (no fade, expanded-caster intersect instead of body-core + clipped strokes, etc).
Note the supersample/zoom scale S (= ss*zoom) and that ALL world lengths/widths get multiplied by S before drawing.
Then read ${JS}/tools/js_render.mjs and ${JS}/tools/diff.mjs and ${JS}/fixtures/overhand_knot.json: report the EXACT
measure-loop commands, how the harness derives meta.shadow_enabled / shadow color for overhand_knot, and which fixtures
are shadow-ON vs shadow-OFF. Confirm: only overhand_knot is shadow-ON. List model fields available to the renderer
(and whether ${JS}/src/renderer/toRenderArray.ts would need to forward any shadow field for the editor path).
${HYP}`,
  },
]

const extracts = (await parallel(
  READERS.map((r) => () => agent(r.prompt, { label: r.label, phase: 'Extract', schema: EXTRACT_SCHEMA }))
)).filter(Boolean)

if (extracts.length < 3) {
  log(`WARNING: only ${extracts.length}/4 extract agents returned; proceeding with partial knowledge`)
}

// ===========================================================================
phase('Design')
log('Synthesizing the faithful port spec')

const design = await agent(
  `You are the lead. Using the extraction findings below, write THE definitive, unambiguous spec to port
OpenStrandJS shadow rendering to be PIXEL-IDENTICAL to OpenStrand Studio's shader_utils.py.

Extraction findings (JSON):
${JSON.stringify(extracts, null, 2)}

Requirements for the spec:
1. State the exact algorithm: SOLID CORE (caster body @ (w+2*sw) ∩ receiver geometry, unioned over receivers, filled at
   shadow alpha, SourceOver, unclipped) + 3-STEP FADED BLUR (stroke the boundary of [core ∪ caster-circle-geom@30] at
   widths/alphas per the verified formulas, butt cap / round join, CLIPPED to the union of receiver geometries).
2. Give the exact numeric per-step widths & alphas (scaled note: world widths 10/20/30 and circle extensions 30/32 must be
   multiplied by the renderer scale S=ss*zoom before drawing; alphas are 0-255 -> divide by 255 for paper.Color).
3. paper.js MAPPINGS: how to reproduce "painter.setClipPath(clip); painter.strokePath(region, pen)" in paper.js — a Path/
   CompoundPath with fillColor=null, strokeColor=shadow@alpha, strokeWidth=W*S, strokeCap='butt', strokeJoin='round',
   wrapped in a clipping paper.Group whose first child is the clip region (clipMask=true). Note paper.js has no
   morphological dilate, so boundary-stroking-then-clip is the faithful route (NOT expand+fill).
4. RECEIVER geometry must include visible end-circles (half-circles for AttachedStrand) like build_rendered_geometry;
   for the current corpus (overhand_knot) confirm whether circles are present so the implementer knows the minimum.
5. The MaskedStrand crossing shadow (drawMasked ~555-569) must be replaced by a draw_mask_strand_shadow-faithful version
   (component intersection + same 3-step faded strokes + darker inner core). Mark it port-for-completeness (no mask fixture
   has shadows on in the corpus).
6. HARD CONSTRAINT: the shadow-OFF render path must stay byte-identical — only the shadowEnabled branch changes. Regression
   fixtures single_strand / three_strand_braid / closed_knot must not move from baseline.
7. A concrete change-list against ${JS}/web/strand-renderer.js with the specific regions/functions to add or replace.

Write the spec to ${JS}/SHADOW_PORT_SPEC.md (use the Write tool) and return it (specFilePath = that path).`,
  { label: 'design:port-spec', phase: 'Design', agentType: 'general-purpose', schema: DESIGN_SCHEMA }
)

// ===========================================================================
phase('Implement')
log('Implementing the faithful shadow port in web/strand-renderer.js (with self-check iterations on overhand_knot)')

const impl = await agent(
  `Implement the faithful shadow port in ${JS}/web/strand-renderer.js per the spec below.

SPEC (also saved at ${design && design.specFilePath}):
${design ? design.portSpecMarkdown : '(design step failed — read SHADOW_PORT_SPEC.md if present, else reconstruct from the algorithm summary)'}

CHANGE LIST:
${design ? JSON.stringify(design.changeList, null, 2) : '(none)'}

Rules:
- Replace the current hard-block shadow (the expBody ∩ fullBody solid fill in renderFixture, ~644-710) with the
  faithful SOLID-CORE + 3-STEP CLIPPED FADED-BLUR algorithm. Also port the drawMasked crossing shadow (~555-569).
- Reproduce Qt EXACTLY: caster CORE = body @ (w+2*sw) (NOT blur-expanded) ∩ receiver geometry; blur strokes at world
  widths 10/20/30 (×S) with alphas 100/66/33 (of 255), butt cap, round join, clipped to the union of receiver bodies.
- Multiply every world length/width by S (= ss*zoom) before drawing. Use toColor / SHADOW_COLOR for the shadow paint.
- DO NOT change the shadow-OFF code path or any non-shadow rendering. Keep helper functions tidy and commented in the
  style of the surrounding file.
- After editing, ITERATE: run the harness on the shadow fixture and read the match%:
    node tools/js_render.mjs fixtures/overhand_knot.json artifacts/overhand_knot
    node tools/diff.mjs artifacts/overhand_knot
  Run these STRICTLY SERIALLY (never two Chromium renders at once). If the match% is clearly improvable by a faithful
  correction (wrong width scale, missing clip, alpha off), fix and re-run — up to ~3 harness iterations. Report the
  match% from your final run as selfCheckMatchPercent. (Pre-fix overhand baseline ≈ 98.562; goal: maximize toward 100.)
- Do NOT touch other fixtures in this step; the Verify phase measures regression.`,
  { label: 'implement:shadow', phase: 'Implement', agentType: 'general-purpose', schema: IMPLEMENT_SCHEMA }
)

// ===========================================================================
phase('Verify')
log('Measuring fidelity on the harness (serial): overhand_knot + regression fixtures')

const verify = await agent(
  `Authoritatively measure shadow-port fidelity using the OpenStrandJS harness. Working dir = ${JS}.
Run renders STRICTLY SERIALLY — two concurrent Chromium launches hang each other. For EACH fixture run, in order:
    node tools/js_render.mjs fixtures/<f>.json artifacts/<f>
    node tools/diff.mjs artifacts/<f>
and capture the reported match%.

Fixtures + baselines (from project memory, post-faithful-cap port):
  - overhand_knot       (shadow ON, the target)   baseline ≈ 98.562
  - single_strand       (shadow OFF, regression)  baseline ≈ 99.972
  - three_strand_braid  (shadow OFF, regression)  baseline ≈ 99.860
  - closed_knot         (shadow OFF, regression)  baseline ≈ 100.000

Report each fixture's matchPercent vs baseline. regressionOk = true iff the three shadow-OFF fixtures did NOT drop
(allow <=0.01 noise). shadowFixtureMatch = overhand_knot's final match%. Give a clear verdict: did the shadow port
improve overhand toward 100 without regressing the others? List any anomalies (errors, stale vite on 5173/5174, hangs).
If a render fails, report the exact command and error; do not silently skip.`,
  { label: 'verify:harness', phase: 'Verify', agentType: 'general-purpose', schema: VERIFY_SCHEMA }
)

// ===========================================================================
phase('Review')
log('Adversarial fidelity-to-spec review of the implemented shadow code')

const review = await agent(
  `Adversarially review the shadow implementation for fidelity to the Qt algorithm. Read the current
${JS}/web/strand-renderer.js shadow code (run \`git -C ${JS} diff -- web/strand-renderer.js\` to see exactly what changed)
and compare it line-by-line against the verified Qt algorithm and the spec at ${JS}/SHADOW_PORT_SPEC.md and
${QT}/shader_utils.py (draw_strand_shadow + draw_mask_strand_shadow).
Hunt specifically for deviations that would cause pixel differences:
- per-step alpha/width formula wrong, or widths not multiplied by S (supersample*zoom);
- using the blur-EXPANDED caster instead of the plain body for the solid core;
- blur strokes NOT clipped to the union of receiver bodies, or clipped to the wrong region;
- wrong cap (must be butt/FlatCap) or join (must be round/RoundJoin), wrong composition (must be SourceOver/normal);
- missing solid core fill, or core filled at the wrong alpha (must be full 150, not faded);
- receiver geometry missing visible circles; casting onto wrong-direction layers; missing hidden / same-mask-pair skips;
- the shadow-OFF path accidentally altered.
Do NOT run the harness (no Chromium). Return a deviations punch-list (severity high/med/low, location, issue, expected)
and a verdict on whether the implementation is faithful.`,
  { label: 'review:fidelity', phase: 'Review', agentType: 'general-purpose', schema: REVIEW_SCHEMA }
)

return {
  specFile: design && design.specFilePath,
  implement: impl && { summary: impl.summary, filesChanged: impl.filesChanged, selfCheck: impl.selfCheckMatchPercent, concerns: impl.openConcerns },
  verify: verify && { overhand: verify.shadowFixtureMatch, regressionOk: verify.regressionOk, verdict: verify.verdict, results: verify.fixtureResults, issues: verify.issues },
  review: review && { verdict: review.verdict, deviations: review.deviations },
}
