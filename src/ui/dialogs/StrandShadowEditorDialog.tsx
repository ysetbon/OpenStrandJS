import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import {
  setShadowVisibility,
  setAllowFullShadow,
  setSubtractedLayers,
} from '../../store/actions';
import { t, isRTL } from '../i18n';

// OSS-faithful per-strand Shadow Editor (shadow_editor_dialog.py). Opened from a
// layer button's "Edit Shadows" item; edits the shadows the CASTING strand throws
// onto the strands below it in z-order. Structurally this is one section of the group
// editor (GroupShadowEditorDialog) — an info label, a header batch-toggle row for the
// casting strand, one row per receiver (Visible / Full Shadow / Subtract), then help.
// Non-modal, applies immediately, bracketed by one undo step.
//
// Per (casting -> receiving) shadow_overrides:
//   * Visible      — WIRED to the renderer (meta.shadow_overrides skips the pair).
//   * Full Shadow  — STORED-ONLY (OSS-shape field; renderer geometry not yet ported).
//   * Subtract     — STORED-ONLY (subtracted_layers persisted; not yet consumed).
export function StrandShadowEditorDialog(props: {
  layerName: string;
  onClose: () => void;
}): JSX.Element {
  const { layerName: casting, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const live = useEditorStore((s) => s.doc);

  // One undo step for the whole session; changes apply immediately (OSS).
  useEffect(() => {
    useEditorStore.getState().beginGesture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    useEditorStore.getState().commit();
    onClose();
  };

  // Receivers = non-masked, non-hidden strands BELOW the caster (lower z),
  // top-to-bottom (matches GroupShadowEditorDialog's display order).
  const receiversOf = (): string[] => {
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

  const ovOf = (r: string) => (live.shadow_overrides[casting] || {})[r] || {};
  const isVisible = (r: string) => ovOf(r).visibility !== false;
  const isFull = (r: string) => ovOf(r).allow_full_shadow === true;
  const subsOf = (r: string) => ovOf(r).subtracted_layers ?? [];

  const cssColor = (n: string): string => {
    const c = live.strands[n]?.color;
    return c ? `rgb(${c.r}, ${c.g}, ${c.b})` : 'transparent';
  };

  const [expanded, setExpanded] = useState<Record<string, boolean | undefined>>({});
  const preview = (fn: (d: typeof live) => void) => useEditorStore.getState().mutateDoc(fn);

  const recvs = receiversOf();

  // Header batch toggles over every receiver of this casting strand.
  const setSectionVisible = (v: boolean) => preview((d) => recvs.forEach((r) => setShadowVisibility(d, casting, r, v)));
  const setSectionFull = (v: boolean) => preview((d) => recvs.forEach((r) => setAllowFullShadow(d, casting, r, v)));
  const setSectionSubtract = (v: boolean) =>
    preview((d) => recvs.forEach((r) => setSubtractedLayers(d, casting, r, v ? availableSubtract(r) : [])));
  const sectionVisibleAll = () => recvs.length > 0 && recvs.every((r) => isVisible(r));
  const sectionFullAll = () => recvs.length > 0 && recvs.every((r) => isFull(r));
  const sectionSubtractAll = () => recvs.length > 0 && recvs.every((r) => subsOf(r).length > 0);

  const infoParts = t('shadow_editor_info', lang).replace(/<\/?b>/g, '').split('{0}');

  const ToggleBtn = (p: { active: boolean; label: string; onClick: () => void; title?: string }) => (
    <button type="button" className={'gd-toggle-btn' + (p.active ? ' active' : '')} onClick={p.onClick} title={p.title}>
      {p.label}
    </button>
  );

  return (
    <Modal
      title={`${t('shadow_editor_title', lang)} - ${casting}`}
      onClose={close}
      lang={lang}
      modeless
      onEnter={close}
      footer={<button onClick={close}>{t('close', lang)}</button>}
    >
      <div className="gd-shadow-editor">
        <div className="gd-shadow-info">
          {infoParts[0]}
          <b>{casting}</b>
          {infoParts[1] ?? ''}
        </div>

        <div className="gd-member-list gd-shadow-scroll">
          <div className="gd-shadow-section">
            {/* Section header: batch toggles for this casting strand */}
            <div className="gd-shadow-toggle-row gd-shadow-section-head">
              <span className="gd-swatch" style={{ background: cssColor(casting) }} />
              <span className="gd-member-name">{casting}</span>
              <ToggleBtn active={sectionVisibleAll()} label={t('shadow_visible_on', lang)} onClick={() => setSectionVisible(!sectionVisibleAll())} />
              <ToggleBtn active={sectionFullAll()} label={t('shadow_full_on', lang)} title={t('shadow_stored_only_note', lang)} onClick={() => setSectionFull(!sectionFullAll())} />
              <ToggleBtn active={sectionSubtractAll()} label={t('shadow_subtract_on', lang)} title={t('shadow_stored_only_note', lang)} onClick={() => setSectionSubtract(!sectionSubtractAll())} />
            </div>

            {recvs.length === 0 ? (
              <div className="gd-shadow-row gd-shadow-empty">
                <span className="gd-member-name">{t('shadow_no_layers', lang)}</span>
              </div>
            ) : (
              recvs.map((recv) => {
                const subs = subsOf(recv);
                const isOpen = expanded[recv] ?? subs.length > 0;
                return (
                  <div key={recv} className="gd-shadow-row">
                    <div className="gd-shadow-row-main">
                      <span className="gd-swatch" style={{ background: cssColor(recv) }} />
                      <span className="gd-member-name">{recv}</span>
                      <label className="gd-check">
                        <input
                          type="checkbox"
                          checked={isVisible(recv)}
                          onChange={(e) => preview((d) => setShadowVisibility(d, casting, recv, e.target.checked))}
                        />
                        <span>{t('shadow_visible_on', lang)}</span>
                      </label>
                      <label className="gd-check" title={t('shadow_stored_only_note', lang)}>
                        <input
                          type="checkbox"
                          checked={isFull(recv)}
                          onChange={(e) => preview((d) => setAllowFullShadow(d, casting, recv, e.target.checked))}
                        />
                        <span>{t('shadow_full_on', lang)}</span>
                      </label>
                      <button
                        type="button"
                        className="gd-shadow-expander"
                        onClick={() => setExpanded((m) => ({ ...m, [recv]: !isOpen }))}
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
                                  const next = e.target.checked ? [...subs, layer] : subs.filter((l) => l !== layer);
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
        </div>

        <div className="gd-shadow-help" dir={isRTL(lang) ? 'rtl' : 'ltr'}>
          {t('shadow_editor_help_text', lang)}
        </div>
      </div>
    </Modal>
  );
}
