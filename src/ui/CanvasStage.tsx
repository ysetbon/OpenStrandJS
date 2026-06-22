import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { requestRender, setOverlay } from '../renderer/renderScheduler';
import { InteractionHost } from '../interaction/InteractionHost';
import { drawOverlay } from '../overlay/overlayRenderer';
import { modes } from '../modes';

// The only component that touches <canvas>. Owns #c (renderer output) and
// #overlay (handles/selection). Measures its box into the view state, mounts the
// imperative InteractionHost on #c, and re-renders when document/view/settings
// change.
export function CanvasStage() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const setView = useEditorStore((s) => s.setView);
  const docRevision = useEditorStore((s) => s.docRevision);
  const view = useEditorStore((s) => s.view);
  const settings = useEditorStore((s) => s.settings);
  const mode = useEditorStore((s) => s.mode);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cCanvas = document.getElementById('c') as HTMLCanvasElement | null;
    const overlay = document.getElementById('overlay') as HTMLCanvasElement | null;

    setOverlay(overlay, (ctx2d) => {
      const s = useEditorStore.getState();
      drawOverlay(ctx2d, {
        doc: s.doc, view: s.view, selection: s.selection, settings: s.settings,
        hover: s.hover, pending: s.pending, maskPending: s.maskPending,
      });
    });

    const host = cCanvas ? new InteractionHost(cCanvas) : null;

    const measure = () => {
      const r = wrap.getBoundingClientRect();
      setView({ width: Math.max(1, Math.floor(r.width)), height: Math.max(1, Math.floor(r.height)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);

    return () => {
      ro.disconnect();
      host?.detach();
      setOverlay(null, null);
    };
  }, [setView]);

  useEffect(() => {
    requestRender();
  }, [docRevision, view, settings]);

  useEffect(() => {
    const cCanvas = document.getElementById('c') as HTMLCanvasElement | null;
    if (cCanvas) cCanvas.style.cursor = modes[mode]?.cursor ?? 'default';
  }, [mode]);

  return (
    <div className="stage" ref={wrapRef}>
      <canvas id="c" />
      <canvas id="overlay" />
    </div>
  );
}
