import { useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { setShadowOnly } from '../../store/actions';
import type { GroupRecord } from '../../model/types';
import { t } from '../i18n';

// Per-strand shadow_only editor for a group (min 750x450). Lists every member
// strand with a shadow_only toggle row; the changes are staged locally and
// applied on OK as a single undo step (per-strand setShadowOnly). Cancel discards.
export function GroupShadowEditorDialog(props: {
  groupName: string;
  onClose: () => void;
}): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const doc = useEditorStore((s) => s.doc);
  const commitEdit = useEditorStore((s) => s.commitEdit);

  // Member strands (existing only), in group order.
  const members = useMemo(() => {
    const g = (doc.groups as Record<string, GroupRecord>)[groupName];
    return (g?.main_strands || []).filter((n) => doc.strands[n]);
  }, [doc.groups, doc.strands, groupName]);

  // Staged shadow_only values, seeded from current doc.
  const [values, setValues] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const n of members) init[n] = !!doc.strands[n]?.shadow_only;
    return init;
  });

  const toggle = (n: string) => setValues((v) => ({ ...v, [n]: !v[n] }));

  const apply = () => {
    commitEdit((d) => {
      for (const n of members) setShadowOnly(d, n, !!values[n]);
    });
    onClose();
  };

  return (
    <Modal
      title={t('edit_shadows', lang)}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('cancel', lang)}</button>
          <button onClick={apply}>{t('ok', lang)}</button>
        </>
      }
    >
      <div style={{ minWidth: 750 - 48, minHeight: 450 - 120, display: 'flex', flexDirection: 'column' }}>
        <div className="gd-member-list">
          {members.map((n) => (
            <div key={n} className="gd-member-row">
              <span className="gd-member-name">{n}</span>
              <label className="gd-check">
                <input type="checkbox" checked={!!values[n]} onChange={() => toggle(n)} />
                <span>{t('shadow_only', lang)}</span>
              </label>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
