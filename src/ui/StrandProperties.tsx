import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  resetMask, setColor, setMemberNames, setShadowOnly, setStrandAngleLength, setWidth,
} from '../store/actions';
import { ColorField } from './ColorField';

// Editor for the selected strand: fill/stroke color (RGBA), width + stroke width,
// "apply to whole set" propagation, shadow-only. Masked strands get Reset mask.
export function StrandProperties() {
  const name = useEditorStore((s) => s.selection.layerName);
  const strand = useEditorStore((s) => (name ? s.doc.strands[name] : null));
  // The angle/length read-out below is derived from the strand's live geometry
  // and has always tracked a drag frame by frame. A drag now edits the strand
  // object IN PLACE (see mutateDocLive), so the selector above returns the same
  // object every frame and would never re-render on its own — subscribing to the
  // revision counter is what keeps the read-out live. It is deliberately the
  // ONLY view that does: everything else in the chrome (layer names, colours,
  // lock state, groups) is unchanged by a drag, so it stays asleep until the
  // gesture ends.
  useEditorStore((s) => s.docRevision);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  // Threaded into the angle/length edit so a mask built on this strand drifts
  // its deletion rectangles with the same centroid rule a drag uses.
  const curve = useEditorStore((s) => s.settings.curve_params);
  const [wholeSet, setWholeSet] = useState(false);
  const doc = useEditorStore((s) => s.doc);

  if (!name || !strand) return <div className="props empty">Select a strand to edit its color &amp; width.</div>;

  if (strand.type === 'MaskedStrand') {
    return (
      <div className="props">
        <div className="props-title">{name} (mask)</div>
        <button onClick={() => commitEdit((d) => resetMask(d, name), { action: 'strand.reset_mask', source: 'panel', targets: [name] })}>Reset mask</button>
        <div className="props-hint">In mask mode, drag inside the overlap to erase.</div>
      </div>
    );
  }

  // Angle/Length: pivot on the start. Routed through setStrandAngleLength, which
  // rotates and scales the control points with the endpoint the way OSS
  // AngleAdjustMode does, so a curved strand rotates instead of deforming — and
  // which goes on to moveHandle, so attached children still follow.
  // A whole-set edit changes every non-mask strand in the set, so that is what
  // the history entry has to name — not just the layer that was clicked.
  const edited = () => (wholeSet ? setMemberNames(doc, name) : [name]);

  const dx = strand.end.x - strand.start.x;
  const dy = strand.end.y - strand.start.y;
  const angle = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
  const length = Math.round(Math.hypot(dx, dy));
  const setAngleLen = (angDeg: number, len: number) =>
    commitEdit((d) => setStrandAngleLength(d, name, angDeg, len, curve),
      { action: 'angle.adjust', source: 'panel', targets: [name], detail: `${angDeg}deg, len ${len}` });

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
      <ColorField label="Fill" value={strand.color} onChange={(c) => commitEdit((d) => setColor(d, name, 'fill', c, wholeSet),
        { action: 'strand.color', source: 'panel', targets: edited(), detail: 'fill' })} />
      <ColorField label="Stroke" value={strand.stroke_color} onChange={(c) => commitEdit((d) => setColor(d, name, 'stroke', c, wholeSet),
        { action: 'strand.color', source: 'panel', targets: edited(), detail: 'stroke' })} />
      <label className="props-row">
        <span>Width</span>
        <input type="range" min={1} max={120} value={strand.width}
          onChange={(e) => commitEdit((d) => setWidth(d, name, 'width', Number(e.target.value), wholeSet),
            { action: 'strand.width', source: 'panel', targets: edited(), detail: `width ${e.target.value}` })} />
        <b>{strand.width}</b>
      </label>
      <label className="props-row">
        <span>Stroke</span>
        <input type="range" min={0} max={20} value={strand.stroke_width}
          onChange={(e) => commitEdit((d) => setWidth(d, name, 'stroke_width', Number(e.target.value), wholeSet),
            { action: 'strand.width', source: 'panel', targets: edited(), detail: `stroke ${e.target.value}` })} />
        <b>{strand.stroke_width}</b>
      </label>
      <label className="props-check">
        <input type="checkbox" checked={wholeSet} onChange={(e) => setWholeSet(e.target.checked)} /> apply to whole set
      </label>
      <label className="props-check">
        <input type="checkbox" checked={strand.shadow_only} onChange={(e) => commitEdit((d) => setShadowOnly(d, name, e.target.checked),
          { action: 'strand.shadow_only', source: 'panel', targets: [name], detail: e.target.checked ? 'on' : 'off' })} /> shadow only
      </label>
    </div>
  );
}
