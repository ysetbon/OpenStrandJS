import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore, cloneDoc } from '../../store/editorStore';
import {
  setShadowVisibility,
  setAllowFullShadow,
  setSubtractedLayers,
} from '../../store/actions';
import { resolveGroupMembers } from '../../model/group';
import { t, isRTL } from '../i18n';

// OSS-faithful Group Shadow Editor (group_shadow_editor_dialog.py).
//
// Layout mirrors the desktop: an info label, a global "{group} - All" toggle row,
// then one collapsible section per casting strand (a header row of batch toggles +
// one row per receiver below it in z-order), then the help text. The dialog is
// NON-MODAL (the canvas stays interactive) and applies immediately — closing is the
// only action (OSS QDialogButtonBox.Close, setModal(False)). The whole session is
// bracketed by one undo step.
//
// Per (casting -> receiving) shadow_overrides:
//   * Visible      — WIRED to the renderer (meta.shadow_overrides skips the pair).
//   * Full Shadow  — STORED-ONLY (OSS-shape field; renderer geometry not yet ported).
//   * Subtract     — STORED-ONLY (subtracted_layers persisted; not yet consumed).
// Deferred vs OSS: the per-row "Show Current Shadow" canvas path-preview button is a
// pure renderer visualization (no model state) and is left for a renderer pass.
export function GroupShadowEditorDialog(props: {
  groupName: string;
  onClose: () => void;
}): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const live = useEditorStore((s) => s.doc);

  const members = useMemo(
    () => resolveGroupMembers(live, groupName).regular,
    [live.groups, live.strands, groupName],
  );

  // One undo step for the whole session; changes apply immediately (OSS).
  useEffect(() => {
    useEditorStore.getState().beginGesture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    useEditorStore.getState().commit();
    onClose();
  };

  // Receivers of `casting` = non-masked, non-hidden strands BELOW it (lower z),
  // listed top-to-bottom (OSS display order).
  const receiversOf = (casting: string): string[] => {
    const ci = live.order.indexOf(casting);
    if (ci < 0) return [];
    const out: string[] = [];
    for (let i = ci - 1; i >= 0; i--) {
      const s = live.strands[live.order[i]];
      if (!s || s.type === 'MaskedStrand' || s.is_hidden) continue;
      out.push(live.order[i]);
    }
    return out;
  };

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

  // ── Batch toggles (section + global) ──────────────────────────────────
  const setSectionVisible = (c: string, v: boolean) =>
    preview((d) => receiversOf(c).forEach((r) => setShadowVisibility(d, c, r, v)));
  const setSectionFull = (c: string, v: boolean) =>
    preview((d) => receiversOf(c).forEach((r) => setAllowFullShadow(d, c, r, v)));
  const setSectionSubtract = (c: string, v: boolean) =>
    preview((d) => receiversOf(c).forEach((r) => setSubtractedLayers(d, c, r, v ? availableSubtract(r) : [])));

  const allCastings = members;
  const setGlobalVisible = (v: boolean) => allCastings.forEach((c) => setSectionVisible(c, v));
  const setGlobalFull = (v: boolean) => allCastings.forEach((c) => setSectionFull(c, v));
  const setGlobalSubtract = (v: boolean) => allCastings.forEach((c) => setSectionSubtract(c, v));

  const sectionVisibleAll = (c: string) => {
    const rs = receiversOf(c);
    return rs.length > 0 && rs.every((r) => isVisible(c, r));
  };
  const sectionFullAll = (c: string) => {
    const rs = receiversOf(c);
    return rs.length > 0 && rs.every((r) => isFull(c, r));
  };
  const sectionSubtractAll = (c: string) => {
    const rs = receiversOf(c);
    return rs.length > 0 && rs.every((r) => subsOf(c, r).length > 0);
  };
  const globalAll = (pred: (c: string) => boolean) => allCastings.length > 0 && allCastings.every(pred);

  // Render the info label with the group name bolded (OSS rich-text <b>{0}</b>).
  const infoParts = t('group_shadow_editor_info', lang).replace(/<\/?b>/g, '').split('{0}');

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

  return (
    <Modal
      title={`${t('group_shadow_editor_title', lang)} - ${groupName}`}
      onClose={close}
      lang={lang}
      modeless
      onEnter={close}
      footer={<button onClick={close}>{t('close', lang)}</button>}
    >
      <div className="gd-shadow-editor">
        <div className="gd-shadow-info">
          {infoParts[0]}
          <b>{groupName}</b>
          {infoParts[1] ?? ''}
        </div>

        {/* Global "All" toggle row */}
        <div className="gd-shadow-toggle-row gd-shadow-global">
          <span className="gd-swatch" style={{ background: 'transparent' }} />
          <span className="gd-member-name">{`${groupName} - ${t('select_all', lang)}`}</span>
          <ToggleBtn active={globalAll(sectionVisibleAll)} label={t('shadow_visible_on', lang)} onClick={() => setGlobalVisible(!globalAll(sectionVisibleAll))} />
          <ToggleBtn active={globalAll(sectionFullAll)} label={t('shadow_full_on', lang)} title={t('shadow_stored_only_note', lang)} onClick={() => setGlobalFull(!globalAll(sectionFullAll))} />
          <ToggleBtn active={globalAll(sectionSubtractAll)} label={t('shadow_subtract_on', lang)} title={t('shadow_stored_only_note', lang)} onClick={() => setGlobalSubtract(!globalAll(sectionSubtractAll))} />
        </div>

        <div className="gd-member-list gd-shadow-scroll">
          {members.length === 0 && (
            <div className="gd-member-row">
              <span className="gd-member-name">{t('shadow_no_layers', lang)}</span>
            </div>
          )}
          {members.map((casting) => {
            const recvs = receiversOf(casting);
            return (
              <div key={casting} className="gd-shadow-section">
                {/* Section header: batch toggles for this casting strand */}
                <div className="gd-shadow-toggle-row gd-shadow-section-head">
                  <span className="gd-swatch" style={{ background: cssColor(casting) }} />
                  <span className="gd-member-name">{casting}</span>
                  <ToggleBtn active={sectionVisibleAll(casting)} label={t('shadow_visible_on', lang)} onClick={() => setSectionVisible(casting, !sectionVisibleAll(casting))} />
                  <ToggleBtn active={sectionFullAll(casting)} label={t('shadow_full_on', lang)} title={t('shadow_stored_only_note', lang)} onClick={() => setSectionFull(casting, !sectionFullAll(casting))} />
                  <ToggleBtn active={sectionSubtractAll(casting)} label={t('shadow_subtract_on', lang)} title={t('shadow_stored_only_note', lang)} onClick={() => setSectionSubtract(casting, !sectionSubtractAll(casting))} />
                </div>

                {recvs.length === 0 ? (
                  <div className="gd-shadow-row gd-shadow-empty">
                    <span className="gd-member-name">{t('shadow_no_layers', lang)}</span>
                  </div>
                ) : (
                  recvs.map((recv) => {
                    const subs = subsOf(casting, recv);
                    const ek = keyOf(casting, recv);
                    // Default-open when subtracted layers exist, but an explicit
                    // collapse wins (fixes the can't-collapse-once-populated bug).
                    const isOpen = expanded[ek] ?? subs.length > 0;
                    return (
                      <div key={recv} className="gd-shadow-row">
                        <div className="gd-shadow-row-main">
                          <span className="gd-swatch" style={{ background: cssColor(recv) }} />
                          <span className="gd-member-name">{recv}</span>
                          <label className="gd-check">
                            <input
                              type="checkbox"
                              checked={isVisible(casting, recv)}
                              onChange={(e) => preview((d) => setShadowVisibility(d, casting, recv, e.target.checked))}
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
                  })
                )}
              </div>
            );
          })}
        </div>

        <div className="gd-shadow-help" dir={isRTL(lang) ? 'rtl' : 'ltr'}>
          {t('shadow_editor_help_text', lang)}
        </div>
      </div>
    </Modal>
  );
}
