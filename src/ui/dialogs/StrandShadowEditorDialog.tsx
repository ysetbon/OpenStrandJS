import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import {
  setShadowVisibilityUser,
  setAllowFullShadow,
  setSubtractedLayers,
} from '../../store/actions';
import { maskComponents } from '../../model/layerName';
import { requestRender } from '../../renderer/renderScheduler';
import { t, isRTL } from '../i18n';
import '../groupPanel.css';

// OSS-faithful per-strand Shadow Editor (shadow_editor_dialog.py), 1.109 shape:
// rows for every non-hidden layer BELOW this strand (this strand casting onto
// each), then a "Shadows cast via masks" section (77cd95ee) — for every
// non-hidden mask whose OVER strand is this layer, one row per layer below the
// mask. Mask-proxy rows read/write the overrides keyed under the MASK's layer
// name (the same settings the mask's own dialog edits).
//
// Visibility toggles route through setShadowVisibilityUser, which implements
// the auto_shadow interplay: re-enabling an auto-hidden pair drops `auto` and
// sets `pinned` so the recompute never touches that pair again.
//
// The header row mirrors OSS's (shadow_editor_dialog.py:800-849): four checkable
// buttons that apply to EVERY row at once — Visible, Full, Subtract, Shadow Path.
// Like OSS's, they signal their state by colour rather than by swapping the label,
// which is why shadow_show_all and shadow_hide_all carry the same text.
//
// Like the group dialog: non-modal, applies immediately, one undo step per
// session, Close is the only action. Full Shadow / Subtract are stored-only
// (same renderer status as the group dialog).
export function StrandShadowEditorDialog(props: {
  layerName: string;
  onClose: () => void;
}): JSX.Element {
  const { layerName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const live = useEditorStore((s) => s.doc);

  useEffect(() => {
    useEditorStore.getState().beginGesture({ action: 'strand.shadow', source: 'dialog', targets: [layerName] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    useEditorStore.getState().commit();
    // OSS clears every preview when the editor closes (group_shadow_editor_dialog.py
    // :677). Leaving them on would strand a blue overlay on the canvas with no
    // open dialog to switch it back off.
    useEditorStore.getState().setVisibleShadowPaths([]);
    requestRender();
    onClose();
  };

  const notHidden = (nm: string) => {
    const s = live.strands[nm];
    return !!s && !s.is_hidden;
  };

  // Main rows: every non-hidden layer below this strand, TOP-TO-BOTTOM.
  const ci = live.order.indexOf(layerName);
  const receivers: string[] = [];
  for (let i = ci - 1; i >= 0; i--) {
    if (notHidden(live.order[i])) receivers.push(live.order[i]);
  }

  // Mask-proxy rows (1.109 77cd95ee): masks whose OVER strand is this layer.
  const maskRows: { mask: string; recv: string }[] = [];
  for (const nm of live.order) {
    const s = live.strands[nm];
    if (!s || s.type !== 'MaskedStrand' || s.is_hidden) continue;
    const comp = maskComponents(nm);
    if (!comp || comp.first !== layerName) continue;
    const mi = live.order.indexOf(nm);
    for (let i = mi - 1; i >= 0; i--) {
      const recv = live.order[i];
      if (recv === layerName || !notHidden(recv)) continue;
      maskRows.push({ mask: nm, recv });
    }
  }

  // Subtraction candidates: every non-hidden non-mask layer except the receiver
  // (the caster itself stays available, matching OSS).
  const availableSubtract = (receiving: string): string[] =>
    live.order.filter((nm) => {
      const s = live.strands[nm];
      return s && s.type !== 'MaskedStrand' && !s.is_hidden && nm !== receiving;
    });

  const ovOf = (c: string, r: string) => (live.shadow_overrides[c] || {})[r] || {};
  const isVisible = (c: string, r: string) => ovOf(c, r).visibility !== false;
  const isFull = (c: string, r: string) => ovOf(c, r).allow_full_shadow === true;
  const subsOf = (c: string, r: string) => ovOf(c, r).subtracted_layers ?? [];

  const cssColor = (n: string): string => {
    const c = live.strands[n]?.color;
    return c ? `rgb(${c.r}, ${c.g}, ${c.b})` : 'transparent';
  };

  const [expanded, setExpanded] = useState<Record<string, boolean | undefined>>({});
  const keyOf = (c: string, r: string) => `${c}|${r}`;
  const preview = (fn: (d: typeof live) => void) => useEditorStore.getState().mutateDoc(fn);

  // Shadow Path preview pairs. Store state rather than doc state: OSS holds these
  // on the canvas, so they are not saved and not undoable.
  const shownPaths = useEditorStore((st) => st.visibleShadowPaths);
  const pathShown = (c: string, r: string) => shownPaths.includes(`${c}|${r}`);
  const togglePath = (c: string, r: string, on: boolean) => {
    useEditorStore.getState().toggleVisibleShadowPath(c, r, on);
    requestRender();
  };

  // Every (casting, receiving) pair this dialog lists — the set the header row's
  // buttons act on. Built from the same two lists the rows render from, so a
  // bulk toggle can never touch a pair the user cannot see.
  const allPairs: { c: string; r: string }[] = [
    ...receivers.map((r) => ({ c: layerName, r })),
    ...maskRows.map(({ mask, recv }) => ({ c: mask, r: recv })),
  ];
  const allAre = (pred: (p: { c: string; r: string }) => boolean) =>
    allPairs.length > 0 && allPairs.every(pred);

  const allVisible = allAre((p) => isVisible(p.c, p.r));
  const allFull = allAre((p) => isFull(p.c, p.r));
  const allSubtract = allAre((p) => subsOf(p.c, p.r).length > 0);
  const allPaths = allAre((p) => pathShown(p.c, p.r));

  const setAllVisible = (v: boolean) =>
    preview((d) => allPairs.forEach((p) => setShadowVisibilityUser(d, p.c, p.r, v)));
  const setAllFull = (v: boolean) =>
    preview((d) => allPairs.forEach((p) => setAllowFullShadow(d, p.c, p.r, v)));
  const setAllSubtract = (v: boolean) =>
    preview((d) => allPairs.forEach((p) =>
      setSubtractedLayers(d, p.c, p.r, v ? availableSubtract(p.r) : [])));
  const setAllPaths = (v: boolean) => {
    const st = useEditorStore.getState();
    allPairs.forEach((p) => st.toggleVisibleShadowPath(p.c, p.r, v));
    requestRender();
  };

  const ToggleBtn = (p: { active: boolean; label: string; onClick: () => void; title?: string }) => (
    <button
      type="button"
      className={'gd-toggle-btn' + (p.active ? ' active' : '')}
      onClick={p.onClick}
      title={p.title}
    >
      {p.label}
    </button>
  );

  const viaMaskText = (mask: string, recv: string) =>
    t('shadow_via_mask', lang).replace('{0}', mask).replace('{1}', recv);

  const row = (casting: string, recv: string, displayText?: string) => {
    const subs = subsOf(casting, recv);
    const ek = keyOf(casting, recv);
    const isOpen = expanded[ek] ?? subs.length > 0;
    return (
      <div key={ek} className="gd-shadow-row">
        <div className="gd-shadow-row-main">
          <span className="gd-swatch" style={{ background: cssColor(recv) }} />
          <span className="gd-member-name">{displayText ?? recv}</span>
          <label className="gd-check">
            <input
              type="checkbox"
              checked={isVisible(casting, recv)}
              onChange={(e) => preview((d) => setShadowVisibilityUser(d, casting, recv, e.target.checked))}
            />
            <span>{t('shadow_visible_on', lang)}</span>
          </label>
          <label className="gd-check" title={t('shadow_stored_only_note', lang)}>
            <input
              type="checkbox"
              checked={isFull(casting, recv)}
              onChange={(e) => preview((d) => setAllowFullShadow(d, casting, recv, e.target.checked))}
            />
            <span>{t('shadow_full_on', lang)}</span>
          </label>
          <button
            type="button"
            className="gd-shadow-expander"
            onClick={() => setExpanded((m) => ({ ...m, [ek]: !isOpen }))}
            title={t('shadow_stored_only_note', lang)}
          >
            {(isOpen ? '▼ ' : '▶ ') + t('shadow_subtract_on', lang)}
          </button>
          <ToggleBtn
            active={pathShown(casting, recv)}
            label={t('shadow_path_button', lang)}
            onClick={() => togglePath(casting, recv, !pathShown(casting, recv))}
          />
        </div>
        {isOpen && (
          <div className="gd-shadow-subtract">
            {availableSubtract(recv).length === 0 ? (
              <span className="gd-member-name">{t('shadow_no_layers', lang)}</span>
            ) : (
              availableSubtract(recv).map((layer) => (
                <label key={layer} className="gd-check">
                  <input
                    type="checkbox"
                    checked={subs.includes(layer)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...subs, layer]
                        : subs.filter((l) => l !== layer);
                      preview((d) => setSubtractedLayers(d, casting, recv, next));
                    }}
                  />
                  <span>{layer}</span>
                </label>
              ))
            )}
          </div>
        )}
      </div>
    );
  };

  const empty = receivers.length === 0 && maskRows.length === 0;

  return (
    <Modal
      title={`${t('shadow_editor_title', lang)} - ${layerName}`}
      onClose={close}
      lang={lang}
      modeless
      onEnter={close}
      footer={<button onClick={close}>{t('close', lang)}</button>}
    >
      <div className="gd-shadow-editor">
        {/* Bulk row (OSS shadow_editor_dialog.py:800-849). Hidden when there is
            nothing to act on, so an empty editor shows only its explanation. */}
        {allPairs.length > 0 && (
          <div className="gd-shadow-toggle-row gd-shadow-global">
            <span className="gd-swatch" style={{ background: cssColor(layerName) }} />
            <span className="gd-member-name">{`${layerName} - ${t('select_all', lang)}`}</span>
            <ToggleBtn active={allVisible} label={t('shadow_visible_on', lang)}
              onClick={() => setAllVisible(!allVisible)} />
            <ToggleBtn active={allFull} label={t('shadow_full_on', lang)}
              title={t('shadow_stored_only_note', lang)}
              onClick={() => setAllFull(!allFull)} />
            <ToggleBtn active={allSubtract} label={t('shadow_subtract_on', lang)}
              title={t('shadow_stored_only_note', lang)}
              onClick={() => setAllSubtract(!allSubtract)} />
            <ToggleBtn active={allPaths} label={t('shadow_show_all', lang)}
              onClick={() => setAllPaths(!allPaths)} />
          </div>
        )}

        <div className="gd-member-list gd-shadow-scroll">
          {empty && (
            <div className="gd-member-row">
              <span className="gd-member-name">{t('shadow_no_casters', lang)}</span>
            </div>
          )}
          {receivers.map((recv) => row(layerName, recv))}
          {maskRows.length > 0 && (
            <div className="gd-shadow-toggle-row gd-shadow-section-head">
              <span className="gd-member-name"><b>{t('shadow_via_mask_section', lang)}</b></span>
            </div>
          )}
          {maskRows.map(({ mask, recv }) => row(mask, recv, viaMaskText(mask, recv)))}
        </div>

        <div className="gd-shadow-help" dir={isRTL(lang) ? 'rtl' : 'ltr'}>
          {t('shadow_editor_help_text', lang)}
        </div>
      </div>
    </Modal>
  );
}
