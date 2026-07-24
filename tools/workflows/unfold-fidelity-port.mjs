export const meta = {
  name: 'unfold-fidelity-port',
  description: 'Understand OSS unfold/attached-start drawing and find the JS shadow-fidelity divergences',
  phases: [
    { title: 'Understand', detail: 'Parallel readers map OSS unfold+shadow behavior and the JS port' },
    { title: 'Diff', detail: 'Synthesize concrete OSS-vs-JS divergences (seeded with the user hypotheses)' },
    { title: 'Verify', detail: 'Adversarially confirm each divergence against BOTH sources' },
  ],
}

// ---- shared pointers ------------------------------------------------------
// OSS = the Qt ground truth (real OpenStrandStudio). JS = the port under test.
const OSS = '/workspace/openstrandstudio/src'
const JS = '/home/user/OpenStrandJS'
const RENDERER = `${JS}/web/strand-renderer.js`

// The JS renderer is a line-by-line port of the Qt paint code, and every
// function cites the exact OSS source it mirrors. "Byte similar to OSS" means:
// for a given fixture JSON, web/strand-renderer.js must produce the same pixels
// the Qt canvas (strand.draw / attached_strand.draw / shader_utils.draw_strand_shadow)
// would. The Qt pixel oracle (PyQt5) is NOT runnable in this environment, so the
// OSS *source* is the authority — agents verify divergences by reading code, not
// by rendering.

// Ground-truth hypotheses from the initial scout. Agents MUST verify each against
// source and correct any that are wrong — do NOT trust these blindly.
const SCOUT = `
SCOUT HYPOTHESES (verify against the real source; correct if wrong):

USER'S REPORTED SYMPTOM: the only things NOT byte-similar to OSS are (1) the
SHADING (cast shadow) of UNFOLDED strands, and (2) ATTACHED strands' STARTING side.

An "unfolded" end = a circle-stroke whose alpha == 0 (transparent). For an
AttachedStrand the START (side 0) is the attachment point and is transparent
when unfolded — so BOTH symptoms may share ONE root cause in the shadow path.

H1 (PRIMARY — high confidence): OSS draw_strand_shadow subtracts a full circle
   from the caster shadow path at every end that is BOTH has_circles[idx] AND
   transparent (circle-stroke alpha 0). See ${OSS}/shader_utils.py:528-556:
     radius_base = (strand.width + strand.stroke_width * 2) / 1.5
     cut = ellipse(centre=strand.start if idx==0 else strand.end, r=radius_base)
     shadow_path = shadow_path.subtracted(cut)
   The JS renderer (castStrandShadow / buildShadowCasterCore, ${RENDERER}:465-708)
   performs NO such subtraction, so an unfolded end casts the full square end-cap
   shadow instead of a cut-back one. This is likely BOTH user symptoms.
   -> Exact radius, shape (full circle vs half), gate, and whether it applies to
      the caster CORE only or core+circles must be pinned down.

H2 (verify): build_shadow_circle_geometry (${OSS}/shader_utils.py:1731) skips a
   transparent circle entirely (radius (w+2sw)/2 + 2, depth_margin 2). For an
   AttachedStrand the circle uses _cap_shadow_path (${OSS}/strand.py:386). With
   _partner_cap_dims == (None,None) (elliptical_end_caps OFF, the whole corpus)
   _cap_shadow_path returns a FULL circle. But the JS buildShadowCasterCircles
   (${RENDERER}:476-504) uses capOuterStart/End (HALF circles) for AttachedStrand.
   -> Is this a real divergence for the shadow-circle geometry, or does
      _partner_cap_dims return non-None at an attached start? Read _partner_cap_dims.

H3 (verify): get_shadow_path exists on both Strand (${OSS}/strand.py:1169) and
   AttachedStrand (${OSS}/attached_strand.py:1916) and is what build_shadow_geometry
   strokes. It computes extended_start/extended_end (10px tangent extension, skipped
   when transparent) but the scout believes those variables are DEAD (path is built
   from self.start/self.end, curve identical to get_path). CONFIRM whether
   get_shadow_path is byte-equivalent to get_path (so the JS buildCenterline core is
   correct) OR whether the 10px extension is actually applied somewhere.

H4 (verify): The BODY drawing (not shadow) at an unfolded attached start. OSS
   attached_strand.py:1291 & 3102 keep the inner fill circle at an unfolded start
   (is_setting_staring_circle derived as start alpha==0, strand.py:534-541,
   numbered_layer_button.py:2097). JS collectCaps (${RENDERER}:321-335) mirrors
   this. CONFIRM the body is already correct and the ONLY gap is the shadow.
`

// ---------------- schemas ----------------
const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'summary', 'facts'],
  properties: {
    area: { type: 'string', description: 'which subsystem this spec covers' },
    summary: { type: 'string', description: '3-6 sentence plain-English description of how it works' },
    facts: {
      type: 'array',
      description: 'atomic, verifiable facts each anchored to a file:line',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'ref'],
        properties: {
          claim: { type: 'string', description: 'one precise behavioral fact (formula, gate, shape, order)' },
          ref: { type: 'string', description: 'file:line (absolute path) backing the claim' },
          verbatim: { type: 'string', description: 'short verbatim code snippet if useful' },
        },
      },
    },
  },
}

const DIVERGENCE_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['divergences'],
  properties: {
    divergences: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'symptom', 'oss_behavior', 'oss_ref', 'js_behavior', 'js_ref', 'diverges', 'proposed_fix', 'confidence'],
        properties: {
          id: { type: 'string', description: 'kebab-case id, e.g. missing-transparent-circle-cut' },
          title: { type: 'string' },
          symptom: { type: 'string', enum: ['unfolded-shading', 'attached-start', 'both', 'other'] },
          oss_behavior: { type: 'string', description: 'exactly what OSS does (formula/shape/gate)' },
          oss_ref: { type: 'string', description: 'file:line in /workspace/openstrandstudio' },
          js_behavior: { type: 'string', description: 'exactly what the JS renderer does today' },
          js_ref: { type: 'string', description: 'file:line in web/strand-renderer.js (or src/)' },
          diverges: { type: 'boolean', description: 'true if JS output differs from OSS' },
          proposed_fix: { type: 'string', description: 'the exact code change: where to insert/edit and the JS (paper.js) code, respecting the *S pixel-scaling convention' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          risk: { type: 'string', description: 'regression risk / fixtures that could be affected' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'verdict', 'reason', 'evidence'],
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNCERTAIN'] },
    reason: { type: 'string', description: 'why the divergence is real (or not), in terms of pixel output' },
    evidence: {
      type: 'array',
      description: 'verbatim quotes from BOTH sources proving the claim',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'quote'],
        properties: {
          ref: { type: 'string', description: 'file:line' },
          quote: { type: 'string', description: 'verbatim code' },
        },
      },
    },
    corrected_fix: { type: 'string', description: 'the exact, final fix (correct any error in proposed_fix); empty if REFUTED' },
    fixture_hint: { type: 'string', description: 'which fixture(s) exercise this (e.g. fixtures/unfolded_start.json) and how to eyeball it' },
  },
}

// ---------------- Phase 1: Understand ----------------
phase('Understand')

const READERS = [
  {
    label: 'oss-unfold-semantics',
    prompt: `Read the REAL OpenStrandStudio source and describe EXACTLY how the "unfold start edge" (a.k.a. fold-over / transparent start circle) works. Cover: how the unfolded state is represented and derived (is_setting_staring_circle, start_circle_stroke_color / end_circle_stroke_color and their fallback chain to circle_stroke_color, _is_start_unfolded), where it is set (numbered_layer_button.py set_start_circle_stroke_color ~2081+ and :2097, strand.py:495-557, :534-541, :115, :219-290), and how a new AttachedStrand gets an unfolded start by default (attached_strand.py:143-146, :201, :705). Read these files under ${OSS}: strand.py, attached_strand.py, numbered_layer_button.py. Return a SPEC: atomic facts each with a file:line ref. This is a READ-ONLY mapping task.`,
  },
  {
    label: 'oss-shadow-geometry',
    prompt: `Read the REAL OpenStrandStudio shadow code and pin down EXACTLY how the cast shadow (shading) geometry is built, with special attention to UNFOLDED (transparent-circle) ends. Read ${OSS}/shader_utils.py: draw_strand_shadow (448-700), build_shadow_geometry (1819+), build_shadow_circle_geometry (1731+), build_rendered_geometry (1542+); and ${OSS}/strand.py: get_shadow_path (1169+), _cap_shadow_path (386-403), _partner_cap_dims; and ${OSS}/attached_strand.py: get_shadow_path (1916+). Answer PRECISELY:
1. The transparent-circle subtraction in draw_strand_shadow (~528-556): exact radius formula, shape (full circle? half?), centre, the exact gate (has_circles[idx] AND alpha==0), and whether it mutates the caster CORE (shadow_path from build_shadow_geometry include_circles=False) BEFORE the receiver intersection. Quote the code.
2. build_shadow_circle_geometry: radius formula, depth_margin, per-circle transparent skip, and the all_transparent early-return. What SHAPE is a circle for an AttachedStrand start when _partner_cap_dims returns None vs non-None? Read _partner_cap_dims to determine what it returns for a normal attached start with elliptical caps OFF.
3. get_shadow_path (both classes): are extended_start/extended_end ACTUALLY used in the built path, or dead? Is the resulting curve byte-identical to get_path()? Quote the moveTo/cubicTo/lineTo lines.
Return a SPEC of atomic facts, each with file:line + verbatim snippet. READ-ONLY.`,
  },
  {
    label: 'oss-attached-start-body',
    prompt: `Read the REAL OpenStrandStudio body-drawing code for an AttachedStrand's STARTING side and describe what is painted there in folded vs unfolded state. Read ${OSS}/attached_strand.py draw / _draw_direct: the start cap block and the unfolded-start inner-fill at :1291 and :3102, the start side-line (~1332), and the unified highlight pull-in (:564-583); and ${OSS}/strand.py:2090-2095. Answer: at an unfolded attached start, which of {outer half-circle stroke cap, inner fill circle, start side line} are drawn/omitted, and the exact gate for each. Return a SPEC of atomic facts with file:line refs. READ-ONLY.`,
  },
  {
    label: 'js-port-map',
    prompt: `Read ONLY ${RENDERER} (the JS/paper.js port under test) and describe EXACTLY what it does at unfolded ends and at an AttachedStrand start, so it can be diffed against OSS. Cover with file:line refs:
- castStrandShadow (595-708), buildShadowCasterCore (465-468), buildShadowCasterCircles (476-504), buildShadowReceiverGeom (433-460), buildPairShadowRegion (543-593): how the caster footprint is built; is there ANY transparent-circle subtraction? What shape are attached-strand shadow circles (capOuterStart/End half-circles vs full)?
- collectCaps (306-367) and collectSideLines (371-399): what is drawn at an AttachedStrand unfolded start (startA==0).
- drawHighlight (717-802): the band pull-in at unfolded edges (743-753).
- The *S pixel-scaling convention (S = ss*zoom); note that world dimensions are multiplied by S.
Return a SPEC of atomic facts each with a file:line ref. READ-ONLY — do not edit anything.`,
  },
]

const specs = await parallel(
  READERS.map((r) => () =>
    agent(`${r.prompt}\n\n${SCOUT}`, { label: r.label, phase: 'Understand', schema: SPEC_SCHEMA, effort: 'high' })
  )
)
const goodSpecs = specs.filter(Boolean)
log(`Understand: ${goodSpecs.length}/${READERS.length} specs returned`)

// ---------------- Phase 2: Diff (barrier — needs all specs together) --------
phase('Diff')
const specBlob = JSON.stringify(goodSpecs, null, 2)
const diffResult = await agent(
  `You are comparing the REAL OpenStrandStudio (Qt) drawing behavior against the JS/paper.js port in ${RENDERER}. Below are structured specs produced by readers of both codebases:\n\n${specBlob}\n\nUsing these specs AND re-reading the source where needed (OSS under ${OSS}, JS at ${RENDERER}), enumerate every concrete divergence that would make the JS output NOT byte-similar to OSS, focused on: (1) the cast SHADOW/shading of UNFOLDED (transparent-circle) strands, and (2) ATTACHED strands' STARTING side. For each divergence give the exact OSS behavior (with formula/shape/gate + file:line), the exact current JS behavior (+ file:line), whether it truly diverges, and a precise proposed_fix as JS/paper.js code that respects the *S pixel-scaling convention and the existing style of the file. Include the primary transparent-circle-subtraction divergence if it is real, plus any secondary ones you can justify. Order most-impactful first.\n\n${SCOUT}`,
  { label: 'diff-synthesis', phase: 'Diff', schema: DIVERGENCE_LIST_SCHEMA, effort: 'high' }
)
const candidates = (diffResult && diffResult.divergences ? diffResult.divergences : []).filter((d) => d && d.diverges)
log(`Diff: ${candidates.length} candidate divergence(s) that diverge`)

// ---------------- Phase 3: Verify (adversarial, per candidate) --------------
phase('Verify')
const verdicts = await parallel(
  candidates.map((d) => () =>
    agent(
      `Adversarially VERIFY this claimed divergence between OpenStrandStudio (Qt, ground truth) and the JS port. Your default posture is SKEPTICAL: try to REFUTE it. Independently re-read BOTH sources — OSS under ${OSS}, JS at ${RENDERER} — and confirm the claim ONLY if the code genuinely proves the JS pixel output differs from OSS. Quote verbatim from BOTH sides.\n\nCLAIMED DIVERGENCE:\n${JSON.stringify(d, null, 2)}\n\nDecide CONFIRMED / REFUTED / UNCERTAIN. If CONFIRMED, provide the exact final fix (correct any error in proposed_fix; it must be valid paper.js honoring the *S scaling and the file's conventions) and name the fixture that exercises it (fixtures/*.json — e.g. fixtures/unfolded_start.json). If REFUTED, explain why the JS is already correct.`,
      { label: `verify:${d.id}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' }
    ).then((v) => (v ? { ...v, candidate: d } : null))
  )
)
const good = verdicts.filter(Boolean)
const confirmed = good.filter((v) => v.verdict === 'CONFIRMED')
const uncertain = good.filter((v) => v.verdict === 'UNCERTAIN')
log(`Verify: ${confirmed.length} CONFIRMED, ${uncertain.length} UNCERTAIN, ${good.length - confirmed.length - uncertain.length} REFUTED`)

return {
  specs: goodSpecs,
  candidates,
  verdicts: good,
  confirmed: confirmed.map((v) => ({
    id: v.id,
    title: v.candidate.title,
    symptom: v.candidate.symptom,
    oss_ref: v.candidate.oss_ref,
    js_ref: v.candidate.js_ref,
    reason: v.reason,
    fix: v.corrected_fix,
    fixture_hint: v.fixture_hint,
    evidence: v.evidence,
  })),
  uncertain: uncertain.map((v) => ({ id: v.id, reason: v.reason })),
}
