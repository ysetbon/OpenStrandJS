import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import {
  setShadowVisibility,
  setAllowFullShadow,
  setSubtractedLayers,
} from '../../store/actions';
import { maskComponents } from '../../model/layerName';
import { t, tf, isRTL } from '../i18n';

// OSS-faithful per-strand Shadow Editor (shadow_editor_dialog.py). Opened from a
// layer button's "Edit Shadows" item; edits the shadows the CASTING strand throws
// onto the strands below it in z-order. Structurally this is one section of the group
// editor (GroupShadowEditorDialog) — an info label, a header batch-toggle row for the
// casting strand, one row per receiver (Visible / Full Shadow / Subtract), then help.
// Non-modal, applies immediately, bracketed by one undo step.
//
// Masks whose over-strand is this layer own the shadow drawn at each crossing, so
// their rows are surfaced here too under a "Shadows cast via masks" header (OSS
// _collect_mask_proxy_rows): each row "mask → receiver (via mask)" reads and writes
// the overrides keyed under the MASK's layer name — the same settings the renderer's
// crossing-shadow gate and the mask's own dialog consume.
//
// Per (casting -> receiving) shadow_overrides:
//   * Visible      — WIRED to the renderer (meta.shadow_overrides skips the pair;
//                    for mask rows it also gates the crossing shading in drawMasked).
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

  // Mask-proxy rows (OSS _collect_mask_proxy_rows): for each visible mask whose
  // OVER-strand (first component) is this dialog's strand, one row per visible
  // strand below the mask in z-order — excluding the caster itself (the over-strand
  // shadowing itself is noise) and, like receiversOf, masked receivers. Receivers
  // are listed top-to-bottom to match the regular section's display order.
  const maskRowsOf = (): { mask: string; recv: string }[] => {
    const rows: { mask: string; recv: string }[] = [];
    for (const maskName of live.order) {
      const m = live.strands[maskName];
      if (!m || m.type !== 'MaskedStrand' || m.is_hidden) continue;
      const comp = maskComponents(maskName);
      if (!comp || comp.first !== casting) continue;
      const mi = live.order.indexOf(maskName);
      for (let i = mi - 1; i >= 0; i--) {
        const nm = live.order[i];
        if (nm === casting) continue;
        const s = live.strands[nm];
        if (!s || s.type === 'MaskedStrand' || s.is_hidden) continue;
        rows.push({ mask: maskName, recv: nm });
      }
    }
    return rows;
  };

  const availableSubtract = (receiving: string): string[] =>
    live.order.filter((nm) => {
      const s = live.strands[nm];
      return s && s.type !== 'MaskedStrand' && !s.is_hidden && nm !== receiving;
    });

  // Every override helper takes the row's caster: regular rows edit (casting -> r),
  // mask-proxy rows edit (mask -> r) — the mask's own override dict (OSS keys them
  // identically, so both dialogs and the renderer stay in sync).
  const ovOf = (caster: string, r: string) => (live.shadow_overrides[caster] || {})[r] || {};
  const isVisible = (caster: string, r: string) => ovOf(caster, r).visibility !== false;
  const isFull = (caster: string, r: string) => ovOf(caster, r).allow_full_shadow === true;
  const subsOf = (caster: string, r: string) => ovOf(caster, r).subtracted_layers ?? [];

  const cssColor = (n: string): string => {
    const c = live.strands[n]?.color;
    return c ? `rgb(${c.r}, ${c.g}, ${c.b})` : 'transparent';
  };

  const [expanded, setExpanded] = useState<Record<string, boolean | undefined>>({});
  const preview = (fn: (d: typeof live) => void) => useEditorStore.getState().mutateDoc(fn);

  const recvs = receiversOf();
  const maskRows = maskRowsOf();
  // Header batch toggles cover every row of the dialog — regular AND mask-proxy —
  // mirroring OSS's dialog-wide Show All, whose handler resolves each item's own
  // caster (shadow_editor_dialog.py:954).
  const allPairs: { caster: string; recv: string }[] = [
    ...recvs.map((r) => ({ caster: casting, recv: r })),
    ...maskRows.map((m) => ({ caster: m.mask, recv: m.recv })),
  ];

  const setSectionVisible = (v: boolean) =>
    preview((d) => allPairs.forEach((p) => setShadowVisibility(d, p.caster, p.recv, v)));
  const setSectionFull = (v: boolean) =>
    preview((d) => allPairs.forEach((p) => setAllowFullShadow(d, p.caster, p.recv, v)));
  const setSectionSubtract = (v: boolean) =>
    preview((d) => allPairs.forEach((p) => setSubtractedLayers(d, p.caster, p.recv, v ? availableSubtract(p.recv) : [])));
  const sectionVisibleAll = () => allPairs.length > 0 && allPairs.every((p) => isVisible(p.caster, p.recv));
  const sectionFullAll = () => allPairs.length > 0 && allPairs.every((p) => isFull(p.caster, p.recv));
  const sectionSubtractAll = () => allPairs.length > 0 && allPairs.every((p) => subsOf(p.caster, p.recv).length > 0);

  const infoParts = t('shadow_editor_info', lang).replace(/<\/?b>/g, '').split('{0}');
  // OSS shadow_via_mask: '{0} → {1} (via mask)'.
  const viaMaskText = (mask: string, recv: string) => tf('shadow_via_mask', lang, mask, recv);

  const ToggleBtn = (p: { active: boolean; label: string; onClick: () => void; title?: string }) => (
    <button type="button" className={'gd-toggle-btn' + (p.active ? ' active' : '')} onClick={p.onClick} title={p.title}>
      {p.label}
    </button>
  );

  // One editable override row for the (caster -> recv) shadow. Regular rows show
  // the receiver's name; mask-proxy rows carry the mask as caster and a
  // "mask → receiver (via mask)" label (OSS _add_shadow_row display_text).
  const renderRow = (caster: string, recv: string, displayText?: string) => {
    const key = `${caster}|${recv}`;
    const subs = subsOf(caster, recv);
    const isOpen = expanded[key] ?? subs.length > 0;
    return (
      <div key={key} className="gd-shadow-row">
        <div className="gd-shadow-row-main">
          <span className="gd-swatch" style={{ background: cssColor(recv) }} />
          <span className="gd-member-name" title={displayText ?? recv}>{displayText ?? recv}</span>
          <label className="gd-check">
            <input
              type="checkbox"
              checked={isVisible(caster, recv)}
              onChange={(e) => preview((d) => setShadowVisibility(d, caster, recv, e.target.checked))}
            />
            <span>{t('shadow_visible_on', lang)}</span>
          </label>
          <label className="gd-check" title={t('shadow_stored_only_note', lang)}>
            <input
              type="checkbox"
              checked={isFull(caster, recv)}
              onChange={(e) => preview((d) => setAllowFullShadow(d, caster, recv, e.target.checked))}
            />
            <span>{t('shadow_full_on', lang)}</span>
          </label>
          <button
            type="button"
            className="gd-shadow-expander"
            onClick={() => setExpanded((m) => ({ ...m, [key]: !isOpen }))}
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
                      preview((d) => setSubtractedLayers(d, caster, recv, next));
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

            {recvs.map((recv) => renderRow(casting, recv))}

            {/* Shadows this strand casts THROUGH its masks (OSS via-mask section):
                a bold static header, then one row per (mask, receiver) pair. */}
            {maskRows.length > 0 && (
              <>
                <div className="gd-shadow-row gd-shadow-static-head">
                  <span className="gd-member-name">{t('shadow_via_mask_section', lang)}</span>
                </div>
                {maskRows.map((m) => renderRow(m.mask, m.recv, viaMaskText(m.mask, m.recv)))}
              </>
            )}

            {/* OSS shadow_no_casters empty state: shown only when the dialog has NO
                rows at all — nothing below the strand and no mask uses it on top. */}
            {allPairs.length === 0 && (
              <div className="gd-shadow-row gd-shadow-empty">
                <span className="gd-member-name">{t('shadow_no_casters', lang)}</span>
              </div>
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
