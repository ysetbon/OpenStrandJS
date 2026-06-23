import { useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { t } from '../i18n';

// Pick the members for a NEW group: a group-name line edit plus a checkbox list
// of every non-masked strand (20x20 indicators) with a Select-All toggle. OK
// hands back (name, members); both must be non-empty for OK to be enabled.
export function MainStrandSelectDialog(props: {
  onSubmit: (name: string, members: string[]) => void;
  onClose: () => void;
}): JSX.Element {
  const { onSubmit, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const doc = useEditorStore((s) => s.doc);

  // Candidate strands = non-masked layers, listed in z-order (bottom -> top).
  const candidates = useMemo(
    () => doc.order.filter((n) => doc.strands[n] && doc.strands[n].type !== 'MaskedStrand'),
    [doc.order, doc.strands],
  );

  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const toggle = (n: string) => setPicked((p) => ({ ...p, [n]: !p[n] }));
  const allSelected = candidates.length > 0 && candidates.every((n) => picked[n]);
  const selectAll = () => {
    const next: Record<string, boolean> = {};
    if (!allSelected) for (const n of candidates) next[n] = true;
    setPicked(next);
  };

  const members = candidates.filter((n) => picked[n]);
  const canOk = name.trim().length > 0 && members.length > 0;

  const submit = () => {
    if (!canOk) return;
    onSubmit(name.trim(), members);
    onClose();
  };

  return (
    <Modal
      title={t('create_group', lang)}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('cancel', lang)}</button>
          <button onClick={submit} disabled={!canOk}>{t('ok', lang)}</button>
        </>
      }
    >
      <input
        className="gd-name-input"
        type="text"
        autoFocus
        placeholder={t('enter_group_name', lang)}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
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
