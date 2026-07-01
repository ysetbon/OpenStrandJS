export const meta = {
  name: 'diagnose-strand-repaint',
  description: 'Diagnose the zoom/move strand-body repaint bug in OpenStrandJS vs the fixed OSS reference',
  phases: [
    { title: 'Investigate', detail: 'OSS reference fix + JS repaint-path candidates, concurrently' },
    { title: 'Verify', detail: 'adversarially verify each candidate reproduces the missing-body symptom' },
    { title: 'Synthesize', detail: 'ranked root-cause diagnosis + concrete fix plan' },
  ],
}

const JS = 'C:\\Users\\YonatanSetbon\\projects\\OpenStrandJS';
const OSS = 'C:\\Users\\YonatanSetbon\\projects\\OpenStrandStudio\\src';

const SYMPTOM = `
THE BUG (user report, verbatim intent): "There's a dragging/repaint issue for a strand and
attached strand (a painter save/restore issue, maybe also for the start/end circle). When
zooming in/out or MOVING (dragging), sometimes the STRAND BODY (the filled/painted body — NOT
just the stroke outline) is not painted on the canvas. Nudging (a tiny extra zoom or move)
restores it. This was a KNOWN OSS bug the author COMPLETELY FIXED; they are confident it is due
to 'restore and repaint strand'."

THE OSS FIX (reference, already located — this is how OSS AVOIDS the bug):
- ${OSS}\\strand.py  Strand.draw() lines ~2155-2174: at the very top, if
  'zoom_factor != 1.0 or is_panned' it calls self._draw_direct(painter) and returns, DELIBERATELY
  bypassing the "temporary image optimization" because that optimization "can cause clipping
  issues ... with bounds calculations" when zoomed/panned (i.e. the per-strand temp QImage sized
  to strand bounds clips the body away -> body vanishes until a nudge recomputes bounds).
- Strand._draw_direct() ~2893; AttachedStrand.draw()/_draw_direct() in attached_strand.py;
  MaskedStrand in masked_strand.py. draw() balances painter save/restore carefully
  (SAVE 1/RESTORE 1 top-level, SAVE 2/RESTORE 2 shadow).
- ${OSS}\\strand_drawing_canvas.py paintEvent just iterates strands and calls draw(); repaint is
  a plain self.update() (no background bitmap cache).

THE JS PORT (where the analogous bug likely lives). The JS full renderer draws Paper.js paths
directly (NO per-strand temp image) and flushes via paper.view.update(), so the OSS temp-image
bug has no DIRECT analog in the full render. BUT the JS port has THREE bitmap-cache fast-paths
that ARE the moral equivalent of OSS's temp-image optimization and are the prime suspects:
  1. DRAG bake/frame: web/strand-renderer.js renderDragBackground (~1807), renderDragFrame
     (~1870), _dragPaint (~1752), computeDragTopology (~1735). Bakes static strands into z-order
     "bands" + draws moving strands live; keyed on view signature; DRAG_BG cache.
  2. PAN blit: web/strand-renderer.js renderPanImage (~1970); src/renderer/renderScheduler.ts
     renderPanOverImage/panBlit/beginPanGesture/endPanGesture (~53-153). Captures scene once,
     blits translated; invalidated on size/zoom change; PAN_MAX_DIM clip.
  3. rAF SCHEDULER: src/renderer/renderScheduler.ts runFrame/requestRender/requestOverlay
     (~180-277) with the 'scheduled'/'pendingFull' flags, DRAG_BG(dragBaked/bakedKey) and panSnap
     lifecycle. Wiring: src/ui/CanvasStage.tsx (view-change effect ~77-79), src/interaction/
     InteractionHost.ts (wheel-zoom onWheel ~261, pan/drag lifecycle), src/modes/MoveMode.ts,
     RotateMode.ts, AngleMode.ts (dragging/dragMoving set + release order).

REPOS: JS port = ${JS} ; OSS reference = ${OSS} (read files with absolute paths).
Focus on: any path where a zoom or a move (or its release) shows a STALE or MISSING strand body
because a full/correct repaint was skipped, swallowed, or a cached bitmap wasn't invalidated —
i.e. the render didn't HAPPEN or didn't FLUSH, and the next tiny input fixes it ("nudge restores").
Start/end attachment circles are in scope too.`;

const REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    mechanism: { type: 'string', description: 'How OSS draws this type + when the temp-image path vs _draw_direct is used' },
    missing_body_cause: { type: 'string', description: 'Exactly how/why the body could vanish before the fix' },
    fix_summary: { type: 'string', description: 'What the fix does and the invariant it guarantees' },
    js_must_replicate: { type: 'string', description: 'What the JS port must do to be correct by analogy' },
    key_lines: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      file: { type: 'string' }, line: { type: 'integer' }, note: { type: 'string' } }, required: ['file', 'note'] } },
  },
  required: ['area', 'mechanism', 'missing_body_cause', 'fix_summary', 'js_must_replicate', 'key_lines'],
};

const FIND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      description: 'Concrete candidate causes of the missing-body-until-nudge symptom. Empty if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          file: { type: 'string', description: 'repo-relative or absolute path' },
          line: { type: 'integer' },
          symptom_match: { type: 'string', description: 'the exact user-visible symptom this produces (zoom? move? release? which strand type? body vs circle?)' },
          flow: { type: 'string', description: 'step-by-step code flow that skips/swallows/staleness the repaint' },
          repro: { type: 'string', description: 'concrete input sequence that triggers it, and why a nudge restores' },
          oss_divergence: { type: 'string', description: 'how this differs from what OSS does (or "N/A - JS-only optimization")' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          fix_hint: { type: 'string' },
        },
        required: ['title', 'file', 'symptom_match', 'flow', 'repro', 'confidence'],
      },
    },
  },
  required: ['findings'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    real: { type: 'boolean', description: 'true only if this genuinely produces a MISSING/STALE strand body during zoom/move that a nudge restores' },
    reproduces_symptom: { type: 'boolean' },
    reasoning: { type: 'string', description: 'trace the actual code; try hard to REFUTE. Default real=false if the repaint is actually covered elsewhere.' },
    corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-a-bug'] },
    fix: { type: 'string', description: 'the specific code change if real' },
  },
  required: ['title', 'real', 'reproduces_symptom', 'reasoning', 'corrected_severity'],
};

const OSS_DIMS = [
  {
    label: 'oss:strand',
    prompt: `${SYMPTOM}

YOUR TASK (OSS reference): Read ${OSS}\\strand.py — the Strand.draw() method (~2155-2892) AND
_draw_direct() (~2893+) AND render_utils.py setup_painter. Characterize PRECISELY:
(a) the temp-image optimization path vs the direct path, and the exact zoom/pan condition that
switches between them; (b) HOW the temp-image path could drop the filled body (bounds clip) while
leaving strokes/overlays — i.e. the "strand not stroke" distinction; (c) the painter save/restore
balance (SAVE1/RESTORE1/SAVE2/RESTORE2) and any imbalance risk; (d) how start/end circles / caps
are drawn and whether they share the vanishing-body fate; (e) what an equivalent JS renderer MUST
guarantee. Return via schema.`,
  },
  {
    label: 'oss:attached',
    prompt: `${SYMPTOM}

YOUR TASK (OSS reference): Read ${OSS}\\attached_strand.py — AttachedStrand.draw() and its
_draw_direct() and the zoom/pan bypass, plus how the attached START circle / half-circle cap is
drawn. Same 5 points (a)-(e) as the strand agent, focused on ATTACHED strands and their start/end
circles (the user specifically flagged "starting and ending circle"). Note anything attached-only
that makes its body/circle more prone to the missing-paint bug. Return via schema.`,
  },
  {
    label: 'oss:masked+canvas',
    prompt: `${SYMPTOM}

YOUR TASK (OSS reference): Read ${OSS}\\masked_strand.py (MaskedStrand.draw / _draw_direct /
temp-image handling) AND ${OSS}\\strand_drawing_canvas.py paintEvent + the repaint/update()
machinery + zoom_factor/pan_offset usage + any active_strand / moving-strand special redraw and
${OSS}\\move_mode.py optimized paint handler. Characterize: how the canvas decides to repaint,
whether there is ANY background/bitmap cache (and how it's invalidated on zoom/pan/move), how the
moving strand is painted during a move, and how masks avoid the missing-body bug. Return via
schema with area='masked+canvas'.`,
  },
];

const JS_DIMS = [
  {
    label: 'js:fullrender',
    prompt: `${SYMPTOM}

YOUR TASK (JS full renderer): Read ${JS}\\web\\strand-renderer.js renderFixture (~1475-1702),
drawStrand (~1080-1115), drawHighlight, bodyLayers/collectCaps, drawMasked (~1390-1447). Hunt for
any way the FULL render drops or fails to flush a strand BODY at particular zoom/pan: paper.view.
update() not flushing, a Paper boolean op (unite/intersect/subtract) returning null/empty at
extreme scale so fill/stroke is lost, save/restore imbalance, offscreen 'hi' sizing (W*ss) overflow
at high zoom, or a body clipped by a bounds/region. Also: does renderFixture ignore meta.drag so
the drag fallback is safe? Return findings via schema (may be empty).`,
  },
  {
    label: 'js:dragpaint-topology',
    prompt: `${SYMPTOM}

YOUR TASK (JS drag topology): Read ${JS}\\web\\strand-renderer.js computeDragTopology (~1735),
_dragPaint (~1752-1796), and the band construction in renderDragBackground (~1807-1863). Hunt for
cases where a MOVING strand, an ATTACHED CHILD, or a start/end CIRCLE is omitted from any band /
painted into the wrong z-slot / dropped for one or more frames (appears only after a nudge changes
the moving set or band structure). Check has_circles caching correctness during a move, and mask
components read through a stale byLayer. Return findings via schema (may be empty).`,
  },
  {
    label: 'js:drag-bake-frame',
    prompt: `${SYMPTOM}

YOUR TASK (JS drag bake/frame lifecycle): Read ${JS}\\web\\strand-renderer.js renderDragBackground
(~1807-1863) + renderDragFrame (~1870-1960) + endDrag (~1963), and how DRAG_BG is keyed/validated.
Hunt for: the key mismatch fallback to renderFixture dropping strands; res_scale/mv_scale producing
an empty (1px) moving band so the moving body disappears; non-contiguous moving-set bands with a
gap; a bake that omits the backdrop or a static band; stale DRAG_BG surviving into a new gesture.
Focus on "body missing until nudge" during a MOVE. Return findings via schema (may be empty).`,
  },
  {
    label: 'js:pan-blit',
    prompt: `${SYMPTOM}

YOUR TASK (JS pan fast-path): Read ${JS}\\src\\renderer\\renderScheduler.ts renderPanOverImage
(~81-114), snapshotPanBase (~64-76), panBlit (~119-139), beginPanGesture/endPanGesture (~142-153),
and ${JS}\\web\\strand-renderer.js renderPanImage (~1970-1999). Hunt for: strands beyond PAN_MAX_DIM/
PAN_PX_BUDGET clipped out of the capture (off-screen body vanishes when panned into view — the
CLOSEST analog to the OSS bounds-clip bug!); a stale panSnap blitted after zoom/resize; the capture
taken before a pending render so it snapshots a missing body; endPan not restoring. Also whether a
PAN counts as the user's "moving". Return findings via schema (may be empty).`,
  },
  {
    label: 'js:scheduler',
    prompt: `${SYMPTOM}

YOUR TASK (JS rAF scheduler): Read ${JS}\\src\\renderer\\renderScheduler.ts runFrame (~206-277),
requestRender/requestOverlay (~182-201), and the scheduled/pendingFull/dragBaked/bakedKey/panSnap
state machine. Hunt for any interleaving where a zoom or move (or its release) results in an
OVERLAY-ONLY frame or NO full render (strand body left stale), a stale DRAG_BG/panSnap not dropped
before a full render, or the "deferred release leaves dragBaked=true" window. Enumerate every path
that reaches runFrame and whether it full-renders when it must. Return findings via schema.`,
  },
  {
    label: 'js:wiring',
    prompt: `${SYMPTOM}

YOUR TASK (JS event wiring): Read ${JS}\\src\\ui\\CanvasStage.tsx (the [docRevision,view,settings,
mode] effect ~77-79 and measure/ResizeObserver), ${JS}\\src\\interaction\\InteractionHost.ts
(onWheel ~261-272, pan begin/move/up, pointer lifecycle), and ${JS}\\src\\interaction\\
viewTransform.ts, plus ${JS}\\src\\store\\editorStore.ts setView. Verify that EVERY zoom (wheel,
buttons) and EVERY move/release actually reaches requestRender (full) — not requestOverlay — and
that view object identity changes so the React effect fires (incl. clamped zoom at 0.1/5 and
same-value setView). Hunt for a zoom/move that mutates view/doc WITHOUT a full repaint. Return
findings via schema.`,
  },
  {
    label: 'js:modes',
    prompt: `${SYMPTOM}

YOUR TASK (JS interaction modes): Read ${JS}\\src\\modes\\MoveMode.ts, RotateMode.ts, AngleMode.ts,
AttachMode.ts and ${JS}\\src\\store\\actions.ts drag helpers + ${JS}\\src\\store\\editorStore.ts
setDragging/setDragMoving. Verify the drag lifecycle: does dragMoving include the grabbed strand +
its attached children + masks so they all redraw each frame (else a peer body freezes)? On RELEASE
is dragging set false and dragMoving cleared BEFORE requestRender so the release does a FULL render
(shadows on, bake dropped) rather than another drag frame? On ABORT/ESC/pointercancel is a full
repaint issued? Hunt for a strand body left in a stale drag/baked state after a move. Return
findings via schema.`,
  },
];

phase('Investigate');
const ossThunks = OSS_DIMS.map((d) => () => agent(d.prompt, { label: d.label, phase: 'Investigate', schema: REF_SCHEMA }));
const jsThunks = JS_DIMS.map((d) => () => agent(d.prompt, { label: d.label, phase: 'Investigate', schema: FIND_SCHEMA }));
const all = await parallel([...ossThunks, ...jsThunks]);
const ossRefs = all.slice(0, OSS_DIMS.length).filter(Boolean);
const jsResults = all.slice(OSS_DIMS.length).filter(Boolean);
const ossText = ossRefs.map((r) => `## ${r.area}\nmechanism: ${r.mechanism}\ncause: ${r.missing_body_cause}\nfix: ${r.fix_summary}\nJS must: ${r.js_must_replicate}`).join('\n\n');
const flatFindings = jsResults.flatMap((r) => (r && r.findings) || []);
log(`Investigate: ${ossRefs.length} OSS refs, ${flatFindings.length} JS candidate findings`);

phase('Verify');
const verified = await parallel(flatFindings.map((f) => () =>
  agent(`${SYMPTOM}

OSS REFERENCE (ground truth of correct behavior):
${ossText}

CANDIDATE FINDING TO VERIFY (adversarially — try HARD to refute it; set real=false unless you can
trace an actual code path that leaves a strand BODY missing/stale during zoom/move that a nudge
restores):
${JSON.stringify(f, null, 2)}

Read the cited files in ${JS} (and OSS at ${OSS} if needed) and trace the real control flow. A
finding is only real if (1) a full/correct repaint of the body is genuinely skipped/swallowed/
stale, AND (2) it is triggered by zoom or move (or their release), AND (3) a subsequent tiny input
would restore it. If the repaint is actually covered (e.g. CanvasStage's view effect always
requestRender()s, or the scheduler re-bakes/drops the stale cache), mark real=false and explain.
Return via schema.`,
    { label: `verify:${(f.title || '').slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA })
    .then((v) => ({ finding: f, verdict: v }))));
const confirmed = verified.filter(Boolean).filter((x) => x.verdict && x.verdict.real);
log(`Verify: ${confirmed.length}/${flatFindings.length} findings confirmed real`);

phase('Synthesize');
const report = await agent(`${SYMPTOM}

OSS REFERENCE SUMMARIES:
${ossText}

CONFIRMED FINDINGS (survived adversarial verification):
${JSON.stringify(confirmed.map((x) => ({ ...x.finding, verdict: x.verdict })), null, 2)}

ALL CANDIDATE FINDINGS (incl. refuted, for completeness):
${JSON.stringify(flatFindings, null, 2)}

YOUR TASK: Write the definitive diagnosis for the OpenStrandJS maintainer. Structure:
1. ROOT CAUSE(S): the specific code path(s) that cause "strand body (not stroke) not painted during
   zoom/move, restored by a nudge", ranked by likelihood, each with file:line and the OSS behavior
   it diverges from. If multiple independent causes, list all.
2. Why it matches the OSS temp-image / _draw_direct history (the analog).
3. CONCRETE FIX for each root cause (exact function + change), oracle-safe (must NOT change
   renderFixture's byte-identical offline output — the fidelity harness/PNG export depend on it).
4. A quick way to REPRODUCE + a way to VERIFY the fix (a fixture / interaction / harness tool).
5. Anything still uncertain that needs a live repro to confirm.
Be concrete and cite exact lines. This is the final answer the user will act on.`,
  { label: 'synthesize', phase: 'Synthesize', effort: 'max' });

return { report, ossRefCount: ossRefs.length, candidateCount: flatFindings.length, confirmedCount: confirmed.length,
  confirmed: confirmed.map((x) => ({ title: x.finding.title, file: x.finding.file, line: x.finding.line, severity: x.verdict.corrected_severity })) };
