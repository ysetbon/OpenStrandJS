import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore, cloneDoc } from '../../store/editorStore';
import {
  setShadowOnly,
  setShadowVisibility,
  setAllowFullShadow,
  setSubtractedLayers,
} from '../../store/actions';
import { resolveGroupMembers } from '../../model/group';
import { t } from '../i18n';

// OSS-faithful Group Shadow Editor (group_shadow_editor_dialog.py).
//
// Two layers of control per group member:
//   1. `shadow_only` (per casting strand) — suppress the strand's own body but
//      keep its shadow. WIRED to the renderer (toRenderArray.shadow_only ->
//      strand-renderer skips drawStrand). This is the original toggle, kept.
//   2. Per (casting -> receiving) shadow_overrides — for each strand BELOW the
//      casting strand (lower z), a row with:
//        * Visible  — WIRED: shadow_overrides[cast][recv].visibility=false skips
//          that shadow pair in the renderer (meta.shadow_overrides).
//        * Full Shadow — STORED-ONLY (forward-compat): the renderer does not yet
//          implement allow_full_shadow geometry, so this writes the OSS-shape
//          field but does not change pixels today.
//        * Subtract Layers — STORED-ONLY (forward-compat): same; subtracted_layers
//          is persisted in the OSS shape but not yet consumed by the renderer.
//
// Lifecycle mirrors GroupRotateDialog: beginGesture on open, live preview via
// mutateDoc + requestRender (shadows STAY ON — unlike the geometry dialogs we do
// NOT engage the drag fast-path, which disables shadows), OK commits ONE undo
// step, Cancel restores the snapshot.
export function GroupShadowEditorDialog(props: {
  groupName: string;
  onClose: () => void;
}): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);

  // Live re-read of the working doc each render so toggles reflect the staged
  // state (we mutate the live doc, not local React state — matches OSS "immediate"
  // writes bracketed by one undo step).
  const live = useEditorStore((s) => s.doc);

  const members = useMemo(
    () => resolveGroupMembers(live, groupName).regular,
    [live.groups, live.strands, groupName],
  );

  // Snapshot for Cancel + open the single-undo gesture bracket on mount.
  const baseRef = useRef(cloneDoc(useEditorStore.getState().doc));
  useEffect(() => {
    useEditorStore.getState().beginGesture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // z-order: doc.order last == topmost. Receivers of `casting` are the non-masked,
  // non-hidden strands BELOW it (lower index), in OSS top-to-bottom display order.
  const receiversOf = (casting: string): string[] => {
    const ci = live.order.indexOf(casting);
    if (ci < 0) return [];
    const out: string[] = [];
    for (let i = ci - 1; i >= 0; i--) {
      const nm = live.order[i];
      const s = live.strands[nm];
      if (!s || s.type === 'MaskedStrand' || s.is_hidden) continue;
      out.push(nm);
    }
    return out;
  };

  // Available layers to subtract for a (casting, receiving) pair: all non-hidden,
  // non-masked layers except the receiver itself (OSS keeps the caster available).
  const availableSubtract = (receiving: string): string[] =>
    live.order.filter((nm) => {
      const s = live.strands[nm];
      return s && s.type !== 'MaskedStrand' && !s.is_hidden && nm !== receiving;
    });

  // Track which subtract sections are expanded (UI-only).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const keyOf = (c: string, r: string) => `${c}|${r}`;

  const preview = (fn: (d: typeof live) => void) => {
    useEditorStore.getState().mutateDoc(fn);
  };

  const apply = () => {
    // The live doc already holds every staged change; commit collapses the whole
    // session into ONE undo step.
    useEditorStore.getState().commit();
    onClose();
  };

  const cancel = () => {
    useEditorStore.getState().setDoc(cloneDoc(baseRef.current));
    useEditorStore.getState().commit(); // base == gestureBase -> clears gesture, no history
    onClose();
  };

  return (
    <Modal
      title={`${t('group_shadow_editor_title', lang)} - ${groupName}`}
      onClose={cancel}
      footer={
        <>
          <button onClick={cancel}>{t('cancel', lang)}</button>
          <button onClick={apply}>{t('ok', lang)}</button>
        </>
      }
    >
      <div
        style={{
          minWidth: 750 - 48,
          minHeight: 450 - 120,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="gd-member-list" style={{ maxHeight: 420 }}>
          {members.length === 0 && (
            <div className="gd-member-row">
              <span className="gd-member-name">{t('shadow_no_layers', lang)}</span>
            </div>
          )}
          {members.map((casting) => {
            const recvs = receiversOf(casting);
            const isShadowOnly = !!live.strands[casting]?.shadow_only;
            return (
              <div key={casting} className="gd-shadow-section">
                <div className="gd-shadow-section-head">
                  <span className="gd-member-name">{casting}</span>
                  <label className="gd-check">
                    <input
                      type="checkbox"
                      checked={isShadowOnly}
                      onChange={(e) =>
                        preview((d) => setShadowOnly(d, casting, e.target.checked))
                      }
                    />
                    <span>{t('shadow_only', lang)}</span>
                  </label>
                </div>
                {recvs.length === 0 ? (
                  <div className="gd-shadow-row gd-shadow-empty">
                    <span className="gd-member-name">{t('shadow_no_layers', lang)}</span>
                  </div>
                ) : (
                  recvs.map((recv) => {
                    const ov = (live.shadow_overrides[casting] || {})[recv] || {};
                    const visible = ov.visibility !== false;
                    const full = ov.allow_full_shadow === true;
                    const subs = ov.subtracted_layers ?? [];
                    const ek = keyOf(casting, recv);
                    const isOpen = !!expanded[ek] || subs.length > 0;
                    return (
                      <div key={recv} className="gd-shadow-row">
                        <div className="gd-shadow-row-main">
                          <span className="gd-member-name">{recv}</span>
                          <label className="gd-check">
                            <input
                              type="checkbox"
                              checked={visible}
                              onChange={(e) =>
                                preview((d) =>
                                  setShadowVisibility(d, casting, recv, e.target.checked),
                                )
                              }
                            />
                            <span>{t('shadow_visible', lang)}</span>
                          </label>
                          <label className="gd-check" title={t('shadow_stored_only_note', lang)}>
                            <input
                              type="checkbox"
                              checked={full}
                              onChange={(e) =>
                                preview((d) =>
                                  setAllowFullShadow(d, casting, recv, e.target.checked),
                                )
                              }
                            />
                            <span>{t('shadow_full', lang)}</span>
                          </label>
                          <button
                            type="button"
                            className="gd-shadow-expander"
                            onClick={() =>
                              setExpanded((m) => ({ ...m, [ek]: !isOpen }))
                            }
                            title={t('shadow_stored_only_note', lang)}
                          >
                            {(isOpen ? '▼ ' : '▶ ') + t('shadow_subtract_layers', lang)}
                          </button>
                        </div>
                        {isOpen && (
                          <div className="gd-shadow-subtract">
                            {availableSubtract(recv).length === 0 ? (
                              <span className="gd-member-name">
                                {t('shadow_no_layers', lang)}
                              </span>
                            ) : (
                              availableSubtract(recv).map((layer) => {
                                const checked = subs.includes(layer);
                                return (
                                  <label key={layer} className="gd-check">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(e) => {
                                        const next = e.target.checked
                                          ? [...subs, layer]
                                          : subs.filter((l) => l !== layer);
                                        preview((d) =>
                                          setSubtractedLayers(d, casting, recv, next),
                                        );
                                      }}
                                    />
                                    <span>{layer}</span>
                                  </label>
                                );
                              })
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
        <div className="gd-shadow-help">{t('shadow_editor_help_text', lang)}</div>
      </div>
    </Modal>
  );
}
