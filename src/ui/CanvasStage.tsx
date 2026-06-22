import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { requestRender, setOverlay } from '../renderer/renderScheduler';

// The only component that touches <canvas>. Owns #c (renderer output) and
// #overlay (handles/selection, Slice B). Measures its box into the view state
// and re-renders whenever the document, view, or settings change.
export function CanvasStage() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const setView = useEditorStore((s) => s.setView);
  const docRevision = useEditorStore((s) => s.docRevision);
  const view = useEditorStore((s) => s.view);
  const settings = useEditorStore((s) => s.settings);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const overlay = document.getElementById('overlay') as HTMLCanvasElement | null;
    setOverlay(overlay, null);
    const measure = () => {
      const r = wrap.getBoundingClientRect();
      setView({ width: Math.max(1, Math.floor(r.width)), height: Math.max(1, Math.floor(r.height)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [setView]);

  useEffect(() => {
    requestRender();
  }, [docRevision, view, settings]);

  return (
    <div className="stage" ref={wrapRef}>
      <canvas id="c" />
      <canvas id="overlay" />
    </div>
  );
}
