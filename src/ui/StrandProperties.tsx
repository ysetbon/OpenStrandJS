import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { moveHandle, resetMask, setColor, setShadowOnly, setWidth } from '../store/actions';
import { ColorField } from './ColorField';

// Editor for the selected strand: fill/stroke color (RGBA), width + stroke width,
// "apply to whole set" propagation, shadow-only. Masked strands get Reset mask.
export function StrandProperties() {
  const name = useEditorStore((s) => s.selection.layerName);
  const strand = useEditorStore((s) => (name ? s.doc.strands[name] : null));
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const [wholeSet, setWholeSet] = useState(false);

  if (!name || !strand) return <div className="props empty">Select a strand to edit its color &amp; width.</div>;

  if (strand.type === 'MaskedStrand') {
    return (
      <div className="props">
        <div className="props-title">{name} (mask)</div>
        <button onClick={() => commitEdit((d) => resetMask(d, name))}>Reset mask</button>
        <div className="props-hint">In mask mode, drag inside the overlap to erase.</div>
      </div>
    );
  }

  // Angle/Length: rotate the end around the start (length preserved when only
  // the angle changes). Routed through moveHandle so attached children follow.
  const dx = strand.end.x - strand.start.x;
  const dy = strand.end.y - strand.start.y;
  const angle = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
  const length = Math.round(Math.hypot(dx, dy));
  const setAngleLen = (angDeg: number, len: number) => {
    const rad = (angDeg * Math.PI) / 180;
    const end = { x: strand.start.x + len * Math.cos(rad), y: strand.start.y + len * Math.sin(rad) };
    commitEdit((d) => moveHandle(d, name, 'end', end));
  };

  return (
    <div className="props">
      <div className="props-title">{name} · set {strand.set_number}</div>
      <label className="props-row">
        <span>Angle</span>
        <input type="number" value={angle} step={1}
          onChange={(e) => setAngleLen(Number(e.target.value), length)} />
        <span style={{ width: 'auto' }}>°</span>
      </label>
      <label className="props-row">
        <span>Length</span>
        <input type="number" value={length} min={1} step={1}
          onChange={(e) => setAngleLen(angle, Math.max(1, Number(e.target.value)))} />
      </label>
      <ColorField label="Fill" value={strand.color} onChange={(c) => commitEdit((d) => setColor(d, name, 'fill', c, wholeSet))} />
      <ColorField label="Stroke" value={strand.stroke_color} onChange={(c) => commitEdit((d) => setColor(d, name, 'stroke', c, wholeSet))} />
      <label className="props-row">
        <span>Width</span>
        <input type="range" min={1} max={120} value={strand.width}
          onChange={(e) => commitEdit((d) => setWidth(d, name, 'width', Number(e.target.value), wholeSet))} />
        <b>{strand.width}</b>
      </label>
      <label className="props-row">
        <span>Stroke</span>
        <input type="range" min={0} max={20} value={strand.stroke_width}
          onChange={(e) => commitEdit((d) => setWidth(d, name, 'stroke_width', Number(e.target.value), wholeSet))} />
        <b>{strand.stroke_width}</b>
      </label>
      <label className="props-check">
        <input type="checkbox" checked={wholeSet} onChange={(e) => setWholeSet(e.target.checked)} /> apply to whole set
      </label>
      <label className="props-check">
        <input type="checkbox" checked={strand.shadow_only} onChange={(e) => commitEdit((d) => setShadowOnly(d, name, e.target.checked))} /> shadow only
      </label>
    </div>
  );
}
