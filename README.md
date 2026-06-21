# OpenStrandJS

A fidelity-first JavaScript/Canvas reimplementation of [OpenStrand Studio](../OpenStrandStudio)
(a PyQt5 strand/knot diagramming tool). The goal is a web app whose rendering
matches the Qt original under a small-tolerance pixel diff (~99%), and whose
logic (save/load, masking topology, undo/redo) matches exactly.

## Method: never reinvent, always translate-and-verify

The Python source is the **spec**; the running Qt app is the **oracle**. Every
JS module is a faithful translation of its Qt counterpart, verified against the
real app's output before moving on.

## Stack

- **TypeScript** — sanity for a large port.
- **Paper.js** — closest analog to Qt's `QPainterPath`: it has the boolean path
  ops (`unite`/`subtract`/`intersect`) and stroke-to-outline the masking engine
  depends on (used 111× in the Qt source).
- **Canvas2D** in a real browser (via Playwright/Chromium for the headless diff)
  — the eventual runtime's rasterizer, so we tune against the right target.
- **React** — later, for the editing UI, once rendering is proven.

## Build order (renderer before UI)

The hard part is the visual engine, not buttons. We prove the renderer + diff
harness first; UI comes only after a knot matches closely.

1. Scaffold + verification harness ← *in progress*
2. Reference render (Qt) → JS render → `pixelmatch` diff, over a fixture corpus
3. Port rendering from JSON: basic strands → masked (boolean) strands → shadows
4. Tune until a simple knot matches (`/loop` on one fixture at a time)
5. Expand UI (React) around the proven renderer

## Harness

```
npm run reference -- fixtures/mxn_lh_1x1.json artifacts/mxn_lh_1x1/reference.png artifacts/mxn_lh_1x1/reference.meta.json
npm run render    -- fixtures/mxn_lh_1x1.json artifacts/mxn_lh_1x1   # (Playwright + Paper.js) — TODO
npm run diff      -- artifacts/mxn_lh_1x1                            # pixelmatch — TODO
```

- `tools/reference_render.py` drives the **real Qt canvas headlessly** and emits a
  PNG + `meta.json` (exact image size + content offset). It does **not** auto-crop
  (unlike the Qt exporter), so the JS side can render into an identically sized
  canvas at the identical offset and the diff measures rendering fidelity alone.
- Requires the sibling `../OpenStrandStudio` repo with its `.venv` (PyQt5). Override
  the location with the `OSS_ROOT` env var.

## Fixtures

Copied from the OpenStrandStudio corpus:
- `mxn_lh_1x1.json` — simplest single crossing (1 Strand + 1 AttachedStrand).
- `three_strand_braid.json` — real masked braid; the first hard masking target.

## License

GNU General Public License v3.0 (same as OpenStrand Studio).
