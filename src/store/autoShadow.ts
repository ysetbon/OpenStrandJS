// Auto-managed shadow_overrides for masked weaves — the JS twin of
// OpenStrandStudio's src/auto_shadow.py (branch auto-mask-shadow-overrides).
//
// A mask X_Y flips the visual over/under for ONE pair at ONE crossing, but the
// regular shadow pass still runs on plain z-order for every other pair, so the
// masked-under strand Y keeps casting residue shadows (edge slivers + the
// Pass-B blur fringe, which mask/intermediate subtraction never clip) onto
// chain members buried under the woven fabric. The geometry analysis lives in
// web/strand-renderer.js (window.computeAutoShadowHiddenPairs — second
// components of visible masks casting into their mask's weld-chain fabric,
// hidden when the survival ratio of their shadow region is below 0.45); this
// module turns its verdicts into plain shadow_overrides data on the document.
//
// Contract (identical to the Qt side, so saves round-trip between apps):
//   * every run wipes entries tagged auto:true (and entries naming deleted
//     layers) and rebuilds them from the current scene;
//   * user-authored entries (no auto tag, incl. pinned) are never touched;
//   * hidden pairs are written as {visibility:false, auto:true}.
// Called from createMask / deleteStrand / MoveMode release — never from a
// render path, so the pixel oracle is untouched. Never throws: a geometry
// failure must not break an edit.

import type { EditorDocument } from '../model/types';
import { toRenderArray } from '../renderer/toRenderArray';

interface AutoShadowPair {
  casting: string;
  receiving: string;
  ratio: number;
  raw_area: number;
  hide: boolean;
}

export function recomputeAutoShadowOverrides(
  draft: EditorDocument,
  curveParams?: unknown,
): void {
  const compute = typeof window !== 'undefined'
    ? (window as unknown as {
        computeAutoShadowHiddenPairs?: (strands: unknown, meta: unknown) => AutoShadowPair[];
      }).computeAutoShadowHiddenPairs
    : undefined;
  if (typeof compute !== 'function') return;

  try {
    // 1) Wipe previous auto entries + prune entries naming deleted layers.
    const overrides = draft.shadow_overrides;
    for (const c of Object.keys(overrides)) {
      const byRecv = overrides[c];
      for (const r of Object.keys(byRecv)) {
        if (byRecv[r]?.auto || !draft.strands[c] || !draft.strands[r]) delete byRecv[r];
      }
      if (Object.keys(byRecv).length === 0) delete overrides[c];
    }

    // 2) Nothing to compute without masks (the wipe above still ran, so
    // deleting the last mask clears its autos).
    if (!Object.values(draft.strands).some((s) => s.type === 'MaskedStrand')) return;

    // 3) Analyze the scene exactly as the renderer will draw it.
    const strands = toRenderArray(draft);
    const pairs = compute(strands, {
      shadow_overrides: overrides,
      curve_params: curveParams,
    });

    for (const p of pairs) {
      if (!p.hide) continue;
      const cur = overrides[p.casting]?.[p.receiving];
      if (cur) continue; // user-authored survives (autos were wiped in step 1)
      (overrides[p.casting] ??= {})[p.receiving] = { visibility: false, auto: true };
    }
  } catch (err) {
    // Overrides stay as-is; the edit itself must never fail on this.
    console.warn('autoShadow: recompute failed; overrides left unchanged', err);
  }
}
