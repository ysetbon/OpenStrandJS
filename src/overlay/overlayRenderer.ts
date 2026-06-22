// Draws the interaction overlay (handles, selection, hover) onto #overlay using
// the SAME viewTransform world->screen math as hit-testing, so handles sit
// exactly on the rendered geometry. The overlay canvas is 1:1 with #c's backing
// store (synced by renderScheduler), so worldToScreen coordinates map directly.

import type { EditorDocument, HandleKind, Selection, Settings, ViewState } from '../model/types';
import { worldToScreen } from '../interaction/viewTransform';
import { strandHandles } from '../interaction/hitTest';

export interface OverlayState {
  doc: EditorDocument;
  view: ViewState;
  selection: Selection;
  settings: Settings;
  hover: { layerName: string | null; handle: HandleKind | null };
}

const ENDPOINT_COLOR = '#0a7d22';
const CP_COLOR = '#1769d6';
const CENTER_COLOR = '#b8860b';
const HOT_COLOR = '#e8651a';

function square(ctx: CanvasRenderingContext2D, x: number, y: number, half: number, fill: string, hot: boolean) {
  ctx.beginPath();
  ctx.rect(x - half, y - half, half * 2, half * 2);
  ctx.fillStyle = hot ? HOT_COLOR : fill;
  ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, hot: boolean) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = hot ? HOT_COLOR : fill;
  ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
}

export function drawOverlay(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const { doc, view, selection, hover } = st;
  const layer = selection.layerName;
  if (!layer) return;
  const s = doc.strands[layer];
  if (!s || s.type === 'MaskedStrand') return;

  for (const h of strandHandles(s)) {
    const p = worldToScreen(h.pos, view);
    const hot = (hover.layerName === layer && hover.handle === h.handle)
      || selection.handle === h.handle;
    if (h.handle === 'start' || h.handle === 'end') {
      square(ctx, p.x, p.y, 6, ENDPOINT_COLOR, hot);
    } else if (h.handle === 'control_point_center') {
      square(ctx, p.x, p.y, 5, CENTER_COLOR, hot);
    } else {
      circle(ctx, p.x, p.y, 5.5, CP_COLOR, hot);
    }
  }
}
