import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { requestRender, setOverlay } from '../renderer/renderScheduler';
import { InteractionHost } from '../interaction/InteractionHost';
import { drawOverlay } from '../overlay/overlayRenderer';
import { modes } from '../modes';
import { AngleAdjustDialog } from './dialogs/AngleAdjustDialog';
import { t } from './i18n';

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
  // Validated target: only active while the mask still exists in the current doc
  // (a tab switch / file load / undo / delete that removes it ends the session,
  // so the banner + crosshair never get stuck across documents).
  const maskEditTarget = useEditorStore((s) =>
    (s.maskEditTarget && s.doc.strands[s.maskEditTarget]?.type === 'MaskedStrand') ? s.maskEditTarget : null);
  const lang = useEditorStore((s) => s.settings.language);
  const angleEditTarget = useEditorStore((s) => s.angleEditTarget);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cCanvas = document.getElementById('c') as HTMLCanvasElement | null;
    const overlay = document.getElementById('overlay') as HTMLCanvasElement | null;

    setOverlay(overlay, (ctx2d) => {
      const s = useEditorStore.getState();
      drawOverlay(ctx2d, {
        doc: s.doc, view: s.view, selection: s.selection, settings: s.settings,
        hover: s.hover, pending: s.pending, maskPending: s.maskPending, eraser: s.eraser,
        mode: s.mode, dragging: s.dragging,
        drawNames: s.drawNames,
        angleEditTarget: s.angleEditTarget, angleEditInitial: s.angleEditInitial,
      });
    });

    const host = cCanvas ? new InteractionHost(cCanvas) : null;

    const measure = () => {
      // Use the LAYOUT size (clientWidth/Height), NOT getBoundingClientRect():
      // under a CSS page zoom (html{zoom}) getBoundingClientRect returns VISUAL
      // (post-zoom) px, but the renderer writes view.width back as the canvas
      // style.width in LAYOUT px — feeding the visual size there double-counts the
      // zoom and the canvas fills only zoom× the stage (grid shrunk, wrong bounds).
      // clientWidth/Height are layout px (zoom-independent) and identical to the
      // box at zoom 1, so the canvas fills the stage at any page zoom. .stage has
      // no padding/border, so clientWidth == the visual content area.
      setView({ width: Math.max(1, wrap.clientWidth), height: Math.max(1, wrap.clientHeight) });
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
    // An active Edit Mask session forces the crosshair (OSS enter_mask_edit_mode).
    if (cCanvas) cCanvas.style.cursor = maskEditTarget ? 'crosshair' : (modes[mode]?.cursor ?? 'default');
  }, [mode, maskEditTarget]);

  return (
    <div className="stage" ref={wrapRef}>
      <canvas id="c" />
      <canvas id="overlay" />
      {/* OSS mask_edit_label banner: "MASK EDIT MODE / Press ESC to exit". */}
      {maskEditTarget && (
        <div className="mask-edit-banner" role="status">
          {t('mask_edit_mode_message', lang).split('\n').map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      {/* OSS AngleAdjustMode "Adjust Angle and Length" dialog (mounted while a
          strand is under angle edit). Modeless, so the canvas preview stays live. */}
      {angleEditTarget && <AngleAdjustDialog />}
    </div>
  );
}
