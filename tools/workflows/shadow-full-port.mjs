export const meta = {
  name: 'shadow-full-port',
  description: 'Port ALL remaining shader_utils shadow paths (mask-as-caster, mask-blocking, intermediate subtraction, shadow_overrides) + build fixtures that trigger & pixel-verify each, vs the Qt oracle',
  phases: [
    { title: 'Recon', detail: 'Parallel: exact Qt algorithm for the uncovered paths + fixture design + harness plumbing' },
    { title: 'Design', detail: 'Synthesize ITEM2_SPEC.md: code-change plan + fixture build list + harness diff' },
    { title: 'BuildFixtures', detail: 'Edit reference_render.py meta, create constructed fixtures, generate Qt refs, baseline-measure' },
    { title: 'Port', detail: 'Implement the paths in castStrandShadow; iterate render->diff on each fixture (serial)' },
    { title: 'Verify', detail: 'prove.mjs on every fixture (new + box_stitch + overhand + regression set), serial' },
    { title: 'Review', detail: 'Adversarial fidelity punch-list for the whole shadow implementation (covers item 1)' },
  ],
}

const QT = 'C:/Users/YonatanSetbon/projects/OpenStrandStudio/src'
const JS = 'C:/Users/YonatanSetbon/projects/OpenStrandJS'

// Verified facts from the main-loop scout (agents may refine but these are confirmed):
const FACTS = `
CONFIRMED FACTS (from source):
- shader_utils.py draw_strand_shadow (~446): the visible single-strand shadow algorithm (solid core @alpha 150 +
  NUM_STEPS faded clipped strokes) is ALREADY ported in JS (castStrandShadow). NUM_STEPS=2 is CONFIRMED CORRECT.
- MASK-AS-CASTER is REAL: masked_strand.py draw() calls draw_strand_shadow(painter, self, ...) at lines 521 and 664
  ("allow the mask layer to cast editable shadows onto lower layers"), IN ADDITION TO draw_mask_strand_shadow (the
  crossing self-shadow). The mask's CASTING geometry for draw_strand_shadow comes from get_proper_masked_strand_path
  (= the mask's get_mask_path crossing region). JS currently SKIPS MaskedStrand casters in its main loop -> GAP.
- MASK-BLOCKING: inside draw_strand_shadow, a VISIBLE mask whose layer index is ABOVE the caster subtracts
  get_shadow_blocker_path(mask, max_blur_radius) [= mask visual path UNION stroked-outline@blur, MiterJoin/FlatCap]
  from the intersection; plus _subtract_visible_component_mask_coverage (shader_utils.py ~119).
- INTERMEDIATE-STRAND subtraction: _get_intermediate_layer_names (~394) + _subtract_named_layer_paths (~406) subtract
  build_rendered_geometry of every strand strictly between caster and receiver in layer order.
- SHADOW_OVERRIDES (layer_state_manager.py): get_shadow_overrides() -> dict keyed casting_layer -> receiving_layer ->
  {visibility, allow_full_shadow, subtracted_layers}. In draw_strand_shadow: get_shadow_visibility(c,r) False -> SKIP the
  whole pair; allow_full_shadow True -> SKIP mask-blocking AND intermediate subtraction; get_subtracted_layers(c,r) (~761,
  includes a DEFAULT component branch ~720-738) -> _subtract_named_layer_paths those layers. side-line exclusion is a NO-OP.
- The harness reference.meta.json currently has NO shadow_overrides / layer_order / num_steps (reference_render.py ~196).
  load_strands returns shadow_overrides as the 8th element of load_result (reference_render.py ~106). layer order =
  canvas.layer_state_manager.getOrder() (falls back to canvas.strands order).
- box_stitch.json (now at ${JS}/fixtures/box_stitch.json) = 2 Strand + 4 AttachedStrand + 1 MaskedStrand, shadow_enabled
  true, and override {"2_3":{"1_1":{visibility:true, allow_full_shadow:true, subtracted_layers:[...]}}}. Current JS match
  = 99.733% (gap clustered at the central crossings + universal stroker edge residual). overhand_knot = 98.809%.
- Harness (run SERIAL, never 2 renders at once): full pipeline = node tools/prove.mjs <fixture.json> [name]  (Qt oracle ->
  JS render -> diff). Qt python = ${JS}/../OpenStrandStudio/src/build_env/Scripts/python.exe (works, PyQt5 OK).
  Regression set (shadow OFF, must not drop): single_strand 100.000, three_strand_braid 99.860, closed_knot 100.000.
`

const RECON_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['focus', 'findings', 'concreteInstructions', 'sourceRefs'],
  properties: {
    focus: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    exactValues: { type: 'array', items: { type: 'string' }, description: 'formulas / stroker settings / numeric constants with source line' },
    concreteInstructions: { type: 'array', items: { type: 'string' }, description: 'actionable steps: JS code to add, JSON edits, file diffs' },
    sourceRefs: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['specFilePath', 'fixturePlan', 'codeChangePlan', 'harnessChangePlan'],
  properties: {
    specMarkdown: { type: 'string' },
    specFilePath: { type: 'string' },
    fixturePlan: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, basedOn: { type: 'string' }, edits: { type: 'array', items: { type: 'string' } }, triggersPath: { type: 'string' }, expectedEffect: { type: 'string' } } } },
    codeChangePlan: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { location: { type: 'string' }, change: { type: 'string' } } } },
    harnessChangePlan: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { file: { type: 'string' }, change: { type: 'string' } } } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}
const BUILD_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['fixturesCreated', 'harnessEdited', 'issues'],
  properties: {
    fixturesCreated: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, path: { type: 'string' }, baselineMatch: { type: 'number' }, triggersConfirmed: { type: 'boolean' }, note: { type: 'string' } } } },
    harnessEdited: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
  },
}
const PORT_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['filesChanged', 'summary', 'perFixture', 'openConcerns'],
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    perFixture: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, before: { type: 'number' }, after: { type: 'number' } } } },
    openConcerns: { type: 'array', items: { type: 'string' } },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['results', 'regressionOk', 'verdict'],
  properties: {
    results: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { fixture: { type: 'string' }, match: { type: 'number' }, baseline: { type: 'number' }, note: { type: 'string' } } } },
    regressionOk: { type: 'boolean' },
    verdict: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['deviations', 'verdict'],
  properties: {
    deviations: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { severity: { type: 'string' }, location: { type: 'string' }, issue: { type: 'string' }, expected: { type: 'string' } } } },
    verdict: { type: 'string' },
  },
}

const RENDER_RULES = `RENDERING RULES: run renders STRICTLY ONE AT A TIME (two concurrent Chromium or Qt renders hang each other).
Emit a short progress line before and after every render so you never go silent for long. NEVER read agent-*.jsonl or
other transcript files. The full pipeline for one fixture is: node tools/prove.mjs fixtures/<f>.json <name>  (cwd ${JS}).`

// ===========================================================================
phase('Recon')
log('Extracting exact Qt algorithm for the uncovered paths + fixture design + harness plumbing (3 parallel)')

const recon = (await parallel([
  () => agent(
    `Extract the EXACT algorithm for the shadow paths NOT yet ported to JS, so they can be ported 1:1.
Read ${QT}/shader_utils.py (draw_strand_shadow ~446, helpers ~119/394/406/1441-2034), ${QT}/masked_strand.py (draw()
shadow blocks ~483-720), and ${QT}/layer_state_manager.py (get_shadow_overrides ~653, get_shadow_override ~677,
get_shadow_visibility ~740, get_subtracted_layers ~761 INCLUDING its default component branch ~720-738).
For EACH path give exact stroker settings, formulas, ordering, and a concrete description of the JS code to add inside
castStrandShadow:
  (a) MASK-AS-CASTER: how a MaskedStrand casts draw_strand_shadow onto lower NON-component strands; the casting core
      geometry (get_proper_masked_strand_path = the mask crossing region) and how to build that in JS (the drawMasked
      stroke region: first@(w+2sw) ∩ second@(w+2sw)). Confirm it still skips its own components (maskPairs).
  (b) MASK-BLOCKING: get_shadow_blocker_path(mask, blur) [mask visual path ∪ stroker(width=blur, MiterJoin, FlatCap)]
      and _subtract_visible_component_mask_coverage; only masks ABOVE the caster block; skip the mask being cast onto.
  (c) INTERMEDIATE subtraction: _get_intermediate_layer_names + _subtract_named_layer_paths (subtract
      build_rendered_geometry of each strand strictly between caster and receiver in layer order).
  (d) SHADOW_OVERRIDES: visibility False -> skip pair; allow_full_shadow True -> skip (b)+(c); subtracted_layers ->
      subtract those layers; plus the default component subtracted-layers branch.
${FACTS}`,
    { label: 'recon:qt-algorithm', phase: 'Recon', schema: RECON_SCHEMA }
  ),
  () => agent(
    `Design CONSTRUCTED FIXTURES that each TRIGGER one uncovered shadow path so it can be pixel-verified against the Qt
oracle. Read ${JS}/fixtures/box_stitch.json and ${JS}/fixtures/overhand_knot.json (OpenStrandStudioHistory format:
states[].data.{strands, shadow_enabled, shadow_overrides}) and ${QT}/save_load_manager.py load_strands to know what
fields load. Prefer DERIVING fixtures by minimally EDITING box_stitch (it already has a mask + an override) rather than
authoring geometry from scratch. Specify, for each fixture, the EXACT JSON edits (keys/values) and the expected visible
effect, ensuring it still loads + renders in Qt:
  1. mask-blocking: a copy of box_stitch with the override's allow_full_shadow set FALSE (and visibility true) so the
     mask actually blocks the caster's shadow on the lower strand. (Confirm which casting->receiving key to edit.)
  2. shadow-hidden: a copy with visibility FALSE for one pair -> that shadow must disappear.
  3. intermediate-strand: identify (or describe minimal edits to produce) a 3-strand stack where a middle strand sits
     between caster and receiver so it blocks part of the shadow. If box_stitch already has such a triple, name it.
  4. subtracted_layers: box_stitch as-is already exercises subtracted_layers + allow_full_shadow=true; keep it.
Return a fixturePlan list. Also note any field that must be threaded through reference.meta.json for these to work.
${FACTS}`,
    { label: 'recon:fixture-design', phase: 'Recon', schema: RECON_SCHEMA }
  ),
  () => agent(
    `Spec the HARNESS PLUMBING so reference.meta.json carries shadow_overrides + layer_order (+ num_steps, shadow_color)
to the JS renderer. Read ${JS}/tools/reference_render.py (meta dict ~196-213; load_result unpack ~105-106 where
shadow_overrides is the 8th element; canvas.layer_state_manager), ${JS}/tools/js_render.mjs (does it pass the WHOLE meta
object through to window.renderFixture, or only selected keys? quote the exact code), and ${JS}/web/strand-renderer.js
renderFixture meta usage (~595-646). Return EXACT edits:
  - reference_render.py: add shadow_overrides (from load_result), layer_order (canvas.layer_state_manager.getOrder() with
    fallback to [s.layer_name for s in canvas.strands]), num_steps, shadow_color to the meta dict. CONFIRM this does NOT
    change the rendered reference.png (only adds JSON meta fields).
  - js_render.mjs: whatever is needed so meta.shadow_overrides / meta.layer_order reach renderFixture (ideally it already
    forwards the full meta object — verify and quote).
  - strand-renderer.js: where renderFixture should read meta.shadow_overrides and meta.layer_order (use layer_order for
    casting direction if present, else current list order).
${FACTS}`,
    { label: 'recon:harness-plumbing', phase: 'Recon', schema: RECON_SCHEMA }
  ),
])).filter(Boolean)

// ===========================================================================
phase('Design')
log('Synthesizing ITEM2_SPEC.md (code-change plan + fixture build list + harness diff)')

const design = await agent(
  `You are the lead. Using the recon findings below, write the definitive plan to (1) plumb shadow_overrides/layer_order
through the harness, (2) build the constructed fixtures, and (3) port mask-as-caster + mask-blocking + intermediate
subtraction + shadow_overrides into ${JS}/web/strand-renderer.js castStrandShadow — all 1:1 faithful to Qt.

Recon findings (JSON):
${JSON.stringify(recon, null, 2)}

Write the full spec to ${JS}/ITEM2_SPEC.md (Write tool). Return: specFilePath; fixturePlan (each: name, basedOn, exact
edits, triggersPath, expectedEffect); codeChangePlan (concrete edits to castStrandShadow and helpers, in order);
harnessChangePlan (reference_render.py + js_render.mjs + strand-renderer.js meta plumbing). Be explicit that the existing
single-strand shadow algorithm and the shadow-OFF path must stay byte-identical, and that masks must keep skipping their
own components (maskPairs) while NOW casting onto other lower strands.`,
  { label: 'design:item2-spec', phase: 'Design', agentType: 'general-purpose', schema: DESIGN_SCHEMA }
)

// ===========================================================================
phase('BuildFixtures')
log('Plumbing the harness meta, creating constructed fixtures, generating Qt refs, baseline-measuring')

const build = await agent(
  `Implement the harness plumbing and build the constructed fixtures per the plan, then baseline-measure each.
SPEC: ${JS}/ITEM2_SPEC.md
fixturePlan: ${JSON.stringify(design && design.fixturePlan, null, 2)}
harnessChangePlan: ${JSON.stringify(design && design.harnessChangePlan, null, 2)}

Steps:
1. Edit ${JS}/tools/reference_render.py to add shadow_overrides, layer_order, num_steps, shadow_color to the meta dict
   (do NOT change the rendered image). Make js_render.mjs forward meta.shadow_overrides/layer_order to renderFixture if
   it does not already. DO NOT yet add any shadow LOGIC to strand-renderer.js (that is the Port phase) — only meta passthrough.
2. Create the constructed fixtures in ${JS}/fixtures/ (e.g. box_stitch_block.json, box_stitch_hidden.json, and an
   intermediate-strand fixture) exactly per fixturePlan, by editing copies of existing fixtures. Keep them loadable.
3. For EACH new fixture AND box_stitch + overhand_knot, regenerate the Qt reference + meta and measure the CURRENT JS
   match (this is BEFORE the path logic, so the blocking/hidden/override fixtures SHOULD show a visible mismatch — that
   confirms the fixture truly triggers the path). Use: node tools/prove.mjs fixtures/<f>.json <name>
4. Report each fixture's baselineMatch and whether the intended path is actually triggered (triggersConfirmed = the
   diff shows mismatch in the expected shadow region). If a fixture does NOT trigger a difference, say so clearly.
${RENDER_RULES}`,
  { label: 'build:fixtures+plumbing', phase: 'BuildFixtures', agentType: 'general-purpose', schema: BUILD_SCHEMA }
)

// ===========================================================================
phase('Port')
log('Porting mask-as-caster + mask-blocking + intermediate subtraction + shadow_overrides; iterating on fixtures')

const port = await agent(
  `Port the remaining shadow paths into ${JS}/web/strand-renderer.js castStrandShadow, faithful to Qt, then iterate.
SPEC: ${JS}/ITEM2_SPEC.md
codeChangePlan: ${JSON.stringify(design && design.codeChangePlan, null, 2)}
Fixtures now available (with baselines): ${JSON.stringify(build && build.fixturesCreated, null, 2)}

Implement, reading meta.shadow_overrides / meta.layer_order (now plumbed through):
  (a) MASK-AS-CASTER: let MaskedStrand layers cast a regular shadow onto lower NON-component strands, using the mask
      crossing region as the caster core (still skip the mask's own components via maskPairs).
  (b) MASK-BLOCKING: subtract get_shadow_blocker_path(mask) for visible masks ABOVE the caster; + component-mask-coverage.
  (c) INTERMEDIATE subtraction: subtract rendered geometry of strands strictly between caster and receiver.
  (d) SHADOW_OVERRIDES: visibility False -> skip pair; allow_full_shadow True -> skip (b)+(c); subtracted_layers ->
      subtract those layers' geometry (+ the default component branch).
HARD CONSTRAINTS: the already-correct single-strand shadow core/blur and the shadow-OFF path stay byte-identical;
overhand_knot and the regression set must not drop.
ITERATE (serial renders): for each shadow fixture run node tools/prove.mjs fixtures/<f>.json <name>, read match%, and
fix faithful deviations until the blocking/hidden/override/intermediate fixtures match the Qt oracle markedly better than
their baseline and nothing regresses. Up to ~5 total harness iterations. Report perFixture before/after match%.
${RENDER_RULES}`,
  { label: 'port:shadow-paths', phase: 'Port', agentType: 'general-purpose', schema: PORT_SCHEMA }
)

// ===========================================================================
phase('Verify')
log('Final authoritative measurement across all fixtures (serial)')

const verify = await agent(
  `Authoritatively measure the full result. Run node tools/prove.mjs fixtures/<f>.json <name> for EACH of: every
constructed fixture from the Port phase, box_stitch, overhand_knot, single_strand, three_strand_braid, closed_knot.
${RENDER_RULES}
Report each fixture's final match% vs its baseline (constructed/shadow baselines from the Port report:
${JSON.stringify(port && port.perFixture, null, 2)}; regression baselines: single_strand 100.000, three_strand_braid
99.860, closed_knot 100.000, overhand_knot 98.809, box_stitch 99.733). regressionOk = true iff no shadow-OFF fixture and
neither overhand_knot nor box_stitch dropped (allow <=0.02 noise). Give a clear verdict on whether each uncovered path is
now faithful (its fixture improved toward the oracle) without regressions. Report any errors/anomalies.`,
  { label: 'verify:all-fixtures', phase: 'Verify', agentType: 'general-purpose', schema: VERIFY_SCHEMA }
)

// ===========================================================================
phase('Review')
log('Adversarial fidelity review of the WHOLE shadow implementation (covers item 1)')

const review = await agent(
  `Adversarially review the ENTIRE shadow implementation in ${JS}/web/strand-renderer.js for fidelity to the Qt source.
Do NOT run the harness (no Chromium). Run \`git -C ${JS} diff -- web/strand-renderer.js tools/reference_render.py\` to see
all changes. Compare line-by-line against ${QT}/shader_utils.py (draw_strand_shadow + draw_mask_strand_shadow + helpers),
${QT}/masked_strand.py (mask-as-caster), and ${QT}/layer_state_manager.py (override API), plus ${JS}/ITEM2_SPEC.md.
Cover BOTH the original single-strand shadow port AND the new paths. Flag pixel-affecting deviations:
- per-step alpha/width formula (NUM_STEPS=2: 15px@150, 30px@75; widths*S); solid core uses plain body not blur-expanded;
  blur strokes clipped to receiver union; butt cap / round join; SourceOver; core filled at full 150.
- mask-as-caster casting geometry correct; masks still skip own components; only cast onto lower layers.
- mask-blocking only for visible masks ABOVE caster; blocker = visual ∪ stroke@blur; component-mask-coverage applied.
- intermediate subtraction over the right index range; uses rendered geometry.
- overrides: visibility False skips pair; allow_full_shadow True skips blocking+intermediate; subtracted_layers + default
  component branch applied; layer_order used for direction when present.
- shadow-OFF path and non-shadow rendering byte-identical; paper.js temporaries removed (no leaks).
Return a deviations punch-list {severity high|med|low, location, issue, expected} and a clear VERDICT (any high = not
faithful). Keep it specific with line numbers. This is the final text I receive.`,
  { label: 'review:full-fidelity', phase: 'Review', agentType: 'general-purpose', schema: REVIEW_SCHEMA }
)

return {
  specFile: design && design.specFilePath,
  fixtures: build && build.fixturesCreated,
  harnessEdited: build && build.harnessEdited,
  port: port && { summary: port.summary, filesChanged: port.filesChanged, perFixture: port.perFixture, concerns: port.openConcerns },
  verify: verify && { results: verify.results, regressionOk: verify.regressionOk, verdict: verify.verdict, issues: verify.issues },
  review: review && { verdict: review.verdict, deviations: review.deviations },
}
