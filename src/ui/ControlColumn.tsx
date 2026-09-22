import { useEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { requestRender } from '../renderer/renderScheduler';
import { fitPan, viewCenter, zoomAbout, ZOOM_PERCENTAGE } from '../interaction/viewTransform';
import { STRINGS, isRTL, t } from './i18n';
import { ossIcon } from './icons';
import type { Language } from '../model/types';
import { historyShortLabel } from '../store/historyMeta';

// OSS left control column (main_window.py) — sits at the top of the layer panel.
// Four rows of 40×40 circular buttons. Colors are theme-independent literals
// (UI_PORT_PLAN.md §2.3). Every button is functional.

interface V { bg: string; bgh: string; bgp: string; bd: string; gc: string; gs: number; }
const vars = (v: V): React.CSSProperties => ({
  ['--bg' as string]: v.bg, ['--bgh' as string]: v.bgh, ['--bgp' as string]: v.bgp,
  ['--bd' as string]: v.bd, ['--gc' as string]: v.gc, ['--gs' as string]: `${v.gs}px`,
});

// Append the recorded provenance of the state an undo/redo would land on, e.g.
// "Undo:\nUndo last action" + "\nMoved a point (1_2)". Empty `what` leaves the
// plain OSS tooltip untouched.
const withWhat = (tooltip: string, what: string): string => (what ? `${tooltip}\n${what}` : tooltip);

const PURPLE: V = { bg: '#8A2BE2', bgh: '#DA70D6', bgp: '#663399', bd: '#6A1B9A', gc: '#fff', gs: 20 };
const BLUE:   V = { bg: '#4387c2', bgh: '#2c5c8a', bgp: '#10253a', bd: '#3c77a5', gc: '#fff', gs: 24 };
const GOLD:   V = { bg: '#FFD700', bgh: '#FFA500', bgp: '#FF8C00', bd: '#B8860B', gc: '#000', gs: 20 };
const RED:    V = { bg: '#8B0000', bgh: '#DC143C', bgp: '#400000', bd: '#4B0000', gc: '#fff', gs: 24 };
const GREEN:  V = { bg: '#32CD32', bgh: '#00FF00', bgp: '#228B22', bd: '#228B22', gc: '#fff', gs: 20 };
const TAN:    V = { bg: '#D2B48C', bgh: '#CD853F', bgp: '#654321', bd: '#BC9A6A', gc: '#000', gs: 20 };

// OSS tooltip keys (layer_panel.py): reset_tooltip / undo_tooltip / redo_tooltip /
// zoom_in_tooltip / zoom_out_tooltip / pan_tooltip / refresh_tooltip / center_tooltip /
// hide_mode_tooltip (the multi-select button uses hide_mode_tooltip, NOT a multi_select key).
// All of them are in translations.ts (synced from OSS); the English fallback only
// guards against a key going missing, so a raw key string never shows.
function tip(key: string, fallbackEn: string, lang: Language): string {
  return STRINGS[key] ? t(key, lang) : fallbackEn;
}

// OSS TooltipButton / StrokeTextButton (layer_panel.py, undo_redo_manager.py):
// these buttons never show a hover tooltip. The tip appears only while the RIGHT
// mouse button is held on a button — disabled ones included, so a grey Undo can
// still say it is "Currently unavailable" — and disappears on release. `onTip`
// receives the text on the press and null on the release.
function CCBtn(props: {
  v: V; icon: string; tip: string; onTip: (text: string | null) => void;
  onClick?: () => void; checked?: boolean; disabled?: boolean;
}) {
  // OSS renders these buttons from layer_panel_icons/*.png — use the SAME
  // assets so the glyphs look identical on every OS (native emoji fonts,
  // notably macOS, drew completely different symbols here).
  // Not the `disabled` attribute: a disabled <button> swallows mouse events,
  // and the right-click tip must still work on it (aria-disabled + a guarded
  // click instead).
  return (
    <button
      className={`cc-btn${props.checked ? ' checked' : ''}${props.disabled ? ' disabled' : ''}`}
      style={vars(props.v)}
      aria-label={props.tip}
      aria-disabled={props.disabled || undefined}
      onClick={props.disabled ? undefined : props.onClick}
      onMouseDown={(e) => { if (e.button === 2) props.onTip(props.tip); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <img className="cc-icon" src={ossIcon(props.icon)} alt="" draggable={false} />
    </button>
  );
}

export function ControlColumn() {
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  // What undo would reverse, and what redo would replay — recorded when each
  // state was made (store/historyMeta.ts). Appended to the tooltip so the
  // buttons say what they are about to do, not just that they exist.
  const undoWhat = useEditorStore((s) => historyShortLabel(s.presentMeta, s.settings.language));
  const redoWhat = useEditorStore((s) => historyShortLabel(
    s.future.length ? s.future[s.future.length - 1].meta : null, s.settings.language,
  ));
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const panMode = useEditorStore((s) => s.panMode);
  const togglePanMode = useEditorStore((s) => s.togglePanMode);
  // Pan button state. OSS shows the closed hand + checked while the hand tool is
  // on (layer_panel.update_pan_button: pan_closed.png if canvas.pan_mode) AND for
  // the length of a right-drag pan in any mode (canvas._update_pan_button_icon
  // presses it on the press, releases it on the release), so the button "grabs"
  // with the canvas cursor whenever the drawing is being dragged.
  const panning = useEditorStore((s) => s.panning);
  const panHeld = panMode || panning;
  const multiSel = useEditorStore((s) => s.multiSelectMode);
  const toggleMulti = useEditorStore((s) => s.toggleMultiSelect);
  const lang = useEditorStore((s) => s.settings.language);

  // The right-click tip currently held open (null = none). OSS hides it on the
  // right-button release; we also drop it if the release happens off the button
  // or the window loses focus mid-hold, so it can never get stuck on screen.
  const [heldTip, setHeldTip] = useState<string | null>(null);
  useEffect(() => {
    if (heldTip == null) return;
    const hide = () => setHeldTip(null);
    const onUp = (e: MouseEvent) => { if (e.button === 2) hide(); };
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', hide);
    };
  }, [heldTip]);

  // OSS undo_redo_manager.update_undo_redo_buttons: an enabled Undo/Redo names
  // the action it would reverse/replay; a disabled one says so instead —
  // "Undo:\nUndo last action\n(Currently unavailable)".
  const unavailable = `(${t('currently_unavailable', lang)})`;
  const undoTip = canUndo ? withWhat(tip('undo_tooltip', 'Undo', lang), undoWhat) : `${tip('undo_tooltip', 'Undo', lang)}\n${unavailable}`;
  const redoTip = canRedo ? withWhat(tip('redo_tooltip', 'Redo', lang), redoWhat) : `${tip('redo_tooltip', 'Redo', lang)}\n${unavailable}`;

  /**
   * One press of Zoom In / Zoom Out, about the viewport centre.
   *
   * OSS canvas.zoom_in / zoom_out (strand_drawing_canvas.py:1560-1583): one step
   * is 10% OF THE CURRENT zoom, so the steps are geometric — x1.1 in, x0.9 out,
   * deliberately not inverses, exactly as OSS computes them. OSS drops a step
   * that would cross min_zoom/max_zoom; we clamp to the limit instead, so a
   * press gets as far as the wheel can (which has always clamped to the same
   * [0.1, 5]) and the two paths agree about where the range ends.
   */
  const zoomBy = (factor: number) => {
    const st = useEditorStore.getState();
    st.setView(zoomAbout(st.view, st.view.zoom * factor, viewCenter(st.view)));
  };

  const center = () => {
    const st = useEditorStore.getState();
    st.setView(fitPan(st.doc, st.view));
  };
  // Home button. OSS wires it to layer_panel.reset_to_current_state, which is a
  // one-liner onto undo_redo_manager.clear_history(save_current=True): throw away
  // every saved step and keep the current drawing as the first state — hence the
  // tooltip "Keep only current state as first state". It does NOT touch the zoom,
  // the pan or the selection (Center and the zoom buttons own the view), so nothing
  // on the canvas moves; only Undo/Redo go grey.
  const resetStates = () => {
    useEditorStore.getState().resetHistory();
  };

  return (
    <div className="control-column">
      <div className="cc-row cc-row-top">
        <CCBtn v={PURPLE} icon="home" tip={tip('reset_tooltip', 'Reset states', lang)} onTip={setHeldTip} onClick={resetStates} />
        <CCBtn v={BLUE} icon="undo" tip={undoTip} onTip={setHeldTip} disabled={!canUndo} onClick={() => { undo(); requestRender(); }} />
        <CCBtn v={BLUE} icon="redo" tip={redoTip} onTip={setHeldTip} disabled={!canRedo} onClick={() => { redo(); requestRender(); }} />
      </div>
      <div className="cc-row cc-row-mid">
        <CCBtn v={GOLD} icon="zoom_in" tip={tip('zoom_in_tooltip', 'Zoom in', lang)} onTip={setHeldTip} onClick={() => zoomBy(1 + ZOOM_PERCENTAGE)} />
        <CCBtn v={GOLD} icon="zoom_out" tip={tip('zoom_out_tooltip', 'Zoom out', lang)} onTip={setHeldTip} onClick={() => zoomBy(1 - ZOOM_PERCENTAGE)} />
        <CCBtn v={RED} icon={panHeld ? 'pan_closed' : 'pan_open'} tip={tip('pan_tooltip', 'Pan (hand tool)', lang)} onTip={setHeldTip} checked={panHeld} onClick={togglePanMode} />
      </div>
      <div className="cc-row cc-row-mid">
        <CCBtn v={GREEN} icon="refresh" tip={tip('refresh_tooltip', 'Refresh', lang)} onTip={setHeldTip} onClick={() => requestRender()} />
        <CCBtn v={TAN} icon="center" tip={tip('center_tooltip', 'Center on content', lang)} onTip={setHeldTip} onClick={center} />
        <CCBtn v={TAN} icon={multiSel ? 'multi_select_on' : 'multi_select_off'} tip={tip('hide_mode_tooltip', 'Multi-select', lang)} onTip={setHeldTip} checked={multiSel} onClick={toggleMulti} />
      </div>
      {/* OSS CustomTooltip: frameless, transparent, plain black (white in the
          dark theme) text, centred on the button rows one row below them, kept
          inside the panel and wrapped to its width (undo_redo_manager.py). */}
      {heldTip != null && (
        <div className="cc-tip" role="tooltip" dir={isRTL(lang) ? 'rtl' : 'ltr'}>{heldTip}</div>
      )}
    </div>
  );
}
