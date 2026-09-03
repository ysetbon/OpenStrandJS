# Why a strand body reads as "square-like", and why its highlight does not

Run `node tools/geometry_fidelity_check.mjs fixtures/three_strand_braid.json`
to reproduce every number below.

## The two constructions

A strand's centreline is the same cubic Bézier in both apps
(`strand.py::get_path` / `strand-renderer.js::buildCenterline`). What differs is
how the *body* is derived from it.

**OpenStrand Studio.** `QPainterPathStroker.createStroke(path)`
(`strand.py:2510-2519` for the stroke layer, `:2595-2600` for the fill layer).
That is an analytic offset: the boundary comes back as a `QPainterPath` of
*curves*, with a real miter join wherever the offset needs one. Only Qt's
rasteriser flattens it, in device space, well under a pixel. There is no
sampling step, so there is nothing to tune and nothing to get wrong.

**OpenStrandJS.** There is no stroker in Paper.js, so
`strand-renderer.js::strokedOutline` re-implements one: walk the centreline in
steps of `SAMPLE_STEP` px of **arc length**, offset each sample by ±half the
width along the normal, and join the samples with straight lines. The result is
a *polygon* — no curve fitting, no joins.

**The selection highlight is built the other way.** `drawHighlight` clones the
centreline and sets `strokeWidth = total + 10`, i.e. it hands the raw Bézier to
the canvas rasteriser and lets *it* stroke the curve. So the red halo is
analytically correct in the same way Qt's body is, while the body underneath it
is a polygon. The two are drawn by different machinery in the same frame, which
is exactly the mismatch you can see.

## Why the polygon shows on some strands and not others

The sampling is uniform along the **centreline**, but the boundary it is drawing
lives half a width away from it. On the outside of a bend of radius `R` that
boundary is longer than the centreline by `(R + half) / R`. So one nominal
"1px" step lands a facet `(R + half) / R` pixels long.

Strand half-widths are ~22px, and the curve profile in `buildProfile` routinely
produces bends of R = 2-10px. Measured on `three_strand_braid`:

| tightest bend R | arc-length magnification | longest painted facet at rest | while dragging |
|---|---|---|---|
| 45.9px | ×1.48 | 1.5px | 4.4px |
| 9.3px | ×3.37 | 3.3px | 9.3px |
| 4.0px | ×6.55 | 6.3px | 14.4px |
| 2.3px | ×10.48 | **8.3px** | **17.6px** |

Gentle strands never show it — `overhand_knot` magnifies ×1.05-1.45 and its
worst facet is 1.5px. Sharply bent ones do. That is the "sometimes".

The deviation those facets carry is small (0.36px at rest, 1.65px mid-drag;
rasterised, the painted body differs from the true stroke by 0.22-0.24% of its
area, at most 1px deep). The artefact is not missing geometry — it is that the
boundary is made of *straight edges up to 17px long*, and a straight break in a
high-contrast black outline is something the eye picks out immediately even when
it is a fraction of a pixel deep.

## Why dragging and releasing is when you notice

`_dragPaint` sets `SAMPLE_STEP = DRAG_SAMPLE_STEP` (3) so a long curvy strand
isn't stroked thousands of times per frame; `renderFixture` resets it to 1.
`MoveMode.onPointerUp` requests a full render, so the accuracy really does come
back on release — the picture visibly changes at that moment:

> `three_strand_braid`: 224,237 painted pixels, **14,068 (6.27%) move on
> pointer-up**, with per-channel deltas up to 255.

Everything else is held equal in that comparison (supersample 1, shadows off,
same pan and zoom), so `SAMPLE_STEP` is the only variable. During the gesture
the facets are ~3× longer; on release they shorten but do not disappear, because
step 1 on the centreline is still an 8.3px facet on the outside of a 2.3px bend.

OpenStrand Studio has no equivalent trade-off to make. Its drag optimisation
(`move_mode.py:668-671`) drops *which strands* are repainted into the background
cache; every strand it does paint still goes through the same
`QPainterPathStroker`. Accuracy is not a dial there, so there is nothing to
lower during a drag and nothing to restore after it.

## Two secondary effects the tool also reports

**The offset self-intersects.** Wherever `R < half` — which is nearly every
curved strand in the braid — the inner offset folds back through itself. The
painted body survives because `windingFillLayer` fills the raw band with the
nonzero rule instead of a boolean union (the reason is already documented in
that function). Consumers that *cannot* take a self-intersecting input —
`bodyOutline`, and through it every shadow footprint and mask component — run
`resolveCrossings()` over it, which is where the measured 23-35% band losses and
the black-band bug come from. Qt's stroker never hands anyone a folded band.

**Cusps.** Where the centreline doubles back (2 places on `1_3`), the normal
flips 180° between adjacent samples and the polygon lays down a single edge a
full width long — 44px — straight across the body. Nonzero winding still fills
it correctly, but it is another input `resolveCrossings()` cannot survive.

**The highlight is a polygon too, on unfolded ends.** When either end circle
stroke is transparent, `drawHighlight` replaces the Bézier with a fixed
**101-point resample** before stroking it (mirroring `strand.py:2090-2105`,
which uses 51). The count is fixed, so the step grows with the strand and is
then magnified by the same `(R + half) / R` factor: up to a **42px** facet on
the halo of `2_4`. This is one of the few cases where the halo is coarser than
the body — and it is parity with OSS, not a divergence.

## What would close the gap

Anything that makes the body's boundary curve-accurate rather than
step-accurate:

* sample by **outline** arc length rather than centreline arc length — i.e.
  make the step adaptive on local curvature, `step = tol · R / (R + half)`, so
  the facet length is bounded on the painted edge instead of on the centreline;
* or fit cubics to the offset (a real stroker) and stop handing the rasteriser
  a polygon at all;
* or, cheapest, drop `DRAG_SAMPLE_STEP` back to 1 and buy the frame budget
  somewhere else, which removes the release "snap" but leaves the 8.3px
  resting facets.

Only the first two make OpenStrandJS agree with its own highlight.
