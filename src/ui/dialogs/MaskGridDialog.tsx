import { useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { createMaskGrid } from '../../store/actions';
import { resolveGroupMembers } from '../../model/group';
import { t } from '../i18n';

// OSS "Create Mask Grid" (mask_grid_dialog.py / group_layers.create_mask_grid).
// Faithful, minimal port of the manual pairwise selector: the user ticks which
// of the group's regular strands participate, then OK batch-creates a single
// MaskedStrand for every CROSSING pair among the picked strands (createMaskGrid
// gates on real geometry and derives over/under from z-order). The whole batch
// is ONE undo step (commitEdit). Members are listed in doc.order so the over/
// under z-order resolution downstream is meaningful.
//
// (OSS shows an N×N directional checkbox matrix where the user also picks the
// over/under *direction* per crossing; we keep the faithful member-pick variant
// — z-order decides direction — which is the minimal, deterministic port.)
export function MaskGridDialog(props: { groupName: string; onClose: () => void }): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const doc = useEditorStore((s) => s.doc);
  const curve = useEditorStore((s) => s.settings.curve_params);
  const commitEdit = useEditorStore((s) => s.commitEdit);

  // Group's regular (non-masked) members, kept in z-order (bottom -> top) so the
  // grid's over/under resolution sees the real stacking.
  const candidates = useMemo(() => {
    const regular = new Set(resolveGroupMembers(doc, groupName).regular);
    return doc.order.filter((n) => regular.has(n) && doc.strands[n]?.type !== 'MaskedStrand');
  }, [doc, groupName]);

  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const toggle = (n: string) => setPicked((p) => ({ ...p, [n]: !p[n] }));

  const allSelected = candidates.length > 0 && candidates.every((n) => picked[n]);
  const selectAll = () => {
    const next: Record<string, boolean> = {};
    if (!allSelected) for (const n of candidates) next[n] = true;
    setPicked(next);
  };

  const members = candidates.filter((n) => picked[n]);
  const canOk = members.length >= 2;

  const submit = () => {
    if (!canOk) return;
    commitEdit((d) => createMaskGrid(d, groupName, { members, curve }));
    onClose();
  };

  return (
    <Modal
      title={`${t('create_mask_grid', lang)}: ${groupName}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('cancel', lang)}</button>
          <button onClick={submit} disabled={!canOk}>{t('ok', lang)}</button>
        </>
      }
    >
      <div className="gd-row">
        <span className="gd-label">{t('mask_grid_info', lang)}</span>
      </div>
      <label className="gd-check">
        <input type="checkbox" checked={allSelected} onChange={selectAll} />
        <span>{t('select_all', lang)}</span>
      </label>
      <div className="gd-select-list">
        {candidates.map((n) => (
          <label key={n} className="gd-select-row">
            <input type="checkbox" checked={!!picked[n]} onChange={() => toggle(n)} />
            <span>{n}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

export default MaskGridDialog;
