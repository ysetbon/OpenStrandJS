// Automatic per-pair shadow-visibility overrides for masked weaves — port of
// OSS 1.109 `auto_shadow.py` (92c6f8e2). See that module's docstring for the
// full why; the short version: a mask X_Y flips over/under at ONE crossing, but
// the plain z-order shadow pass still runs for every other pair, and chain
// members buried under the woven fabric keep casting residue slivers that
// contradict the weave. Whenever masks change, evaluate each candidate
// casting->receiving pair the way the renderer will; if the surviving shadow is
// under AUTO_HIDE_SURVIVAL_RATIO of the raw caster∩receiver overlap, write
// shadow_overrides[casting][receiving] = {visibility:false, auto:true}.
//
// Bookkeeping (stored inside the override dict, survives save/undo verbatim):
//   auto: true   -> written here; wiped and recomputed each run.
//   pinned: true -> user re-enabled an auto-hidden pair in the Shadow Editor
//                   (setShadowVisibilityUser); recompute never touches it.
// Entries without `auto` (any user-authored override) are never modified.
//
// The geometry runs in web/strand-renderer.js (window.computeShadowPairAreas),
// through the SAME buildPairShadowRegion the shadow pass renders with, so the
// decision and the pixels can't diverge. Rendering stays byte-identical to OSS
// everywhere overrides are honored — this module only decides when to write them.

import type { EditorDocument, Settings } from '../model/types';
import { toRenderArray } from '../renderer/toRenderArray';
import { maskComponents } from '../model/layerName';
import { useEditorStore } from './editorStore';

// Thresholds — verbatim from auto_shadow.py (measured split on the reference
// weave scene: residue <=0.374 vs real exposed crossings >=0.598; 0.45 mid-gap).
export const AUTO_HIDE_SURVIVAL_RATIO = 0.45;
export const AUTO_MIN_RAW_AREA = 150.0; // world-units²; ignores grazing overlaps

interface PairAreas { casting: string; receiving: string; rawArea: number; ratio: number }

type ProbeFn = (strands: unknown[], meta: Record<string, unknown>, pairs: { casting: string; receiving: string }[]) => PairAreas[];

// layer_name -> chain id for every non-mask strand, unioning attached children
// with their parents and knot-connected partners (auto_shadow._weld_chain_ids).
function weldChainIds(doc: EditorDocument): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    // path compression
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c) as string; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const names = doc.order.filter((n) => doc.strands[n]?.type !== 'MaskedStrand');
  for (const n of names) parent.set(n, n);
  for (const n of names) {
    const s = doc.strands[n];
    const p = s.attached_to;
    if (p && parent.has(p)) union(n, p);
    for (const info of Object.values(s.knot_connections ?? {})) {
      const o = info?.connected_strand_name;
      if (o && parent.has(o)) union(n, o);
    }
  }
  const out = new Map<string, string>();
  for (const n of names) out.set(n, find(n));
  return out;
}

// Refresh the auto-managed shadow_overrides entries from the current scene:
// wipe previous `auto` entries (and entries referencing deleted layers), then
// re-add {visibility:false, auto:true} for every pair whose surviving shadow is
// residue. User-authored entries (incl. `pinned`) are untouched. Mutates the
// draft in place (call inside commitEdit so undo restores consistently).
// Never throws; returns true if the overrides changed.
export function recomputeAutoShadowOverrides(
  draft: EditorDocument,
  settings?: Pick<Settings, 'curve_params'>,
): boolean {
  try {
    const curveParams = settings?.curve_params ?? useEditorStore.getState().settings.curve_params;
    const probe = (globalThis as Record<string, unknown>).computeShadowPairAreas as ProbeFn | undefined;
    let changed = false;

    // ---- wipe: auto entries + entries referencing deleted layers ----
    const overrides = draft.shadow_overrides;
    for (const c of Object.keys(overrides)) {
      const recvMap = overrides[c];
      for (const r of Object.keys(recvMap)) {
        const entry = recvMap[r] ?? {};
        if (entry.auto === true || !draft.strands[c] || !draft.strands[r]) {
          delete recvMap[r];
          changed = true;
        }
      }
      if (Object.keys(recvMap).length === 0) delete overrides[c];
    }

    if (typeof probe !== 'function') return changed; // headless/test context

    // ---- candidates: second components of visible masks casting into their
    //      mask's welded fabric, below their own z-rank ----
    const masks = draft.order.filter((n) => {
      const s = draft.strands[n];
      return s && s.type === 'MaskedStrand' && !s.is_hidden;
    });
    if (masks.length === 0) return changed;

    const chainOf = weldChainIds(draft);
    const componentPairs = new Set<string>();
    const candidateReceivers = new Map<string, Set<string>>();
    for (const m of masks) {
      const comp = maskComponents(m);
      if (!comp || !draft.strands[comp.first] || !draft.strands[comp.second]) continue;
      componentPairs.add(`${comp.first}|${comp.second}`);
      componentPairs.add(`${comp.second}|${comp.first}`);
      const fabricChains = new Set([chainOf.get(comp.first), chainOf.get(comp.second)]);
      fabricChains.delete(undefined);
      const recvs = candidateReceivers.get(comp.second) ?? new Set<string>();
      candidateReceivers.set(comp.second, recvs);
      for (const [name, cid] of chainOf) if (fabricChains.has(cid)) recvs.add(name);
    }

    const pairs: { casting: string; receiving: string }[] = [];
    for (const [casting, fabric] of candidateReceivers) {
      const cs = draft.strands[casting];
      if (!cs || cs.type === 'MaskedStrand' || cs.is_hidden) continue;
      const ci = draft.order.indexOf(casting);
      if (ci < 0) continue;
      for (let ri = 0; ri < ci; ri++) {
        const receiving = draft.order[ri];
        const rs = draft.strands[receiving];
        if (!rs || rs.type === 'MaskedStrand' || rs.is_hidden) continue;
        if (receiving === casting || !fabric.has(receiving)) continue;
        if (componentPairs.has(`${casting}|${receiving}`)) continue;
        const existing = overrides[casting]?.[receiving];
        if (existing && existing.auto !== true) continue; // user-authored — hands off
        pairs.push({ casting, receiving });
      }
    }
    if (pairs.length === 0) return changed;

    // ---- geometry probe at S = 1 so areas come back in world units² ----
    const arr = toRenderArray(draft, null);
    const meta = {
      supersample: 1,
      x_offset: 0,
      y_offset: 0,
      shadow_enabled: true,
      shadow_overrides: overrides,
      curve_params: curveParams,
      layer_order: [...draft.order],
    };
    const results = probe(arr as unknown[], meta, pairs);

    for (const res of results) {
      if (res.rawArea < AUTO_MIN_RAW_AREA) continue;
      if (res.ratio >= AUTO_HIDE_SURVIVAL_RATIO) continue;
      if (overrides[res.casting]?.[res.receiving]) continue; // user-authored survives
      (overrides[res.casting] ?? (overrides[res.casting] = {}))[res.receiving] = {
        visibility: false,
        auto: true,
      };
      changed = true;
    }
    return changed;
  } catch (e) {
    // Mirrors auto_shadow.py: never let the recompute break an edit path.
    console.error('autoShadow: recompute failed; overrides left as-is', e);
    return false;
  }
}
