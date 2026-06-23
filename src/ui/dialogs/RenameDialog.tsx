import { useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { t } from '../i18n';

// Generic single-line rename dialog. Used for "Rename Group" (and reusable for
// layer rename). Submits the trimmed name; empty input is rejected (OK disabled).
export function RenameDialog(props: {
  title: string;
  initial: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { title, initial, onSubmit, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const [name, setName] = useState(initial);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('cancel', lang)}</button>
          <button onClick={submit} disabled={!name.trim()}>{t('ok', lang)}</button>
        </>
      }
    >
      <input
        className="gd-name-input"
        type="text"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
    </Modal>
  );
}
