import { useRef } from 'react';

// The 1px draggable divider between the canvas (left_widget) and the layer panel.
// OSS uses a transparent 1px QSplitter handle. Dragging resizes the panel width;
// the direction flips under RTL (panel sits on the opposite side).
export function Splitter(props: {
  width: number;
  setWidth: (w: number) => void;
  min: number;
  max: number;
  rtl: boolean;
}) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const onDown = (e: React.PointerEvent) => {
    drag.current = { startX: e.clientX, startW: props.width };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    // LTR: panel on the right → dragging the handle left (dx<0) widens it.
    // RTL: panel on the left  → dragging right (dx>0) widens it.
    const delta = props.rtl ? dx : -dx;
    props.setWidth(Math.max(props.min, Math.min(props.max, drag.current.startW + delta)));
  };
  const onUp = (e: React.PointerEvent) => {
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
  };

  return (
    <div
      className="splitter-handle"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    />
  );
}
