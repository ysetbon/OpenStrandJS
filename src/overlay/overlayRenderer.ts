// Draws the interaction overlay (handles, selection, hover, new-strand preview,
// mask-pending highlight) onto #overlay using the SAME viewTransform world->
// screen math as hit-testing, so handles sit exactly on the rendered geometry.
// The overlay canvas is 1:1 with #c's backing store (synced by renderScheduler).

import type { EditorDocument, HandleKind, Selection, Settings, ViewState } from '../model/types';
import type { PendingStrand } from '../store/editorStore';
import { worldToScreen } from '../interaction/viewTransform';
import { strandHandles } from '../interaction/hitTest';
import { sampleCenterline } from '../interaction/hitGeometry';

export interface OverlayState {
  doc: EditorDocument;
  view: ViewState;
  selection: Selection;
  settings: Settings;
  hover: { layerName: string | null; handle: HandleKind | null };
  pending: PendingStrand | null;
  maskPending: string[];
}

const ENDPOINT_COLOR = '#0a7d22';
const CP_COLOR = '#1769d6';
const CENTER_COLOR = '#b8860b';
const HOT_COLOR = '#e8651a';
const MASK_COLOR = '#d61f9c';

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

function highlightCenterline(ctx: CanvasRenderingContext2D, st: OverlayState, layer: string, color: string) {
  const s = st.doc.strands[layer];
  if (!s || s.type === 'MaskedStrand') return;
  const poly = sampleCenterline(s, st.settings.curve_params);
  ctx.beginPath();
  poly.forEach((wp, i) => {
    const p = worldToScreen(wp, st.view);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  ctx.lineWidth = (s.width + s.stroke_width * 2);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.35;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, st: OverlayState): void {
  const { doc, view, selection, hover } = st;

  // Mask-pending: highlight already-picked strands.
  for (const layer of st.maskPending) highlightCenterline(ctx, st, layer, MASK_COLOR);

  // New-strand / attach rubber-band preview.
  if (st.pending) {
    const a = worldToScreen(st.pending.start, view);
    const b = worldToScreen(st.pending.end, view);
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = st.pending.kind === 'attach' ? CP_COLOR : ENDPOINT_COLOR;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
    circle(ctx, b.x, b.y, 5, st.pending.kind === 'attach' ? CP_COLOR : ENDPOINT_COLOR, false);
  }

  // Selected strand handles.
  const layer = selection.layerName;
  if (!layer) return;
  const s = doc.strands[layer];
  if (!s || s.type === 'MaskedStrand') return;

  for (const h of strandHandles(s)) {
    const p = worldToScreen(h.pos, view);
    const hot = (hover.layerName === layer && hover.handle === h.handle) || selection.handle === h.handle;
    if (h.handle === 'start' || h.handle === 'end') {
      square(ctx, p.x, p.y, 6, ENDPOINT_COLOR, hot);
    } else if (h.handle === 'control_point_center') {
      square(ctx, p.x, p.y, 5, CENTER_COLOR, hot);
    } else {
      circle(ctx, p.x, p.y, 5.5, CP_COLOR, hot);
    }
  }
}
