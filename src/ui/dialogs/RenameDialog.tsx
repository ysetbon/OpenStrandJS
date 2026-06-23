import { useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { t } from '../i18n';

// Generic single-line rename dialog. Used for "Rename Group" (and reusable for
// layer rename). Mirrors OSS rename_group: an "Enter group name:" label above the
// line edit, and a duplicate-name guard that surfaces a "Group Exists" error
// instead of silently no-opping. Renaming to the unchanged name just closes.
export function RenameDialog(props: {
  title: string;
  initial: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
  /** Existing sibling names that would collide (excludes the current name). */
  siblings?: string[];
}): JSX.Element {
  const { title, initial, onSubmit, onClose, siblings = [] } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed === initial) {
      // Unchanged — OSS treats this as a no-op and just closes.
      onClose();
      return;
    }
    if (siblings.includes(trimmed)) {
      setError(t('group_exists', lang));
      return;
    }
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      lang={lang}
      onEnter={submit}
      footer={
        <>
          <button onClick={submit} disabled={!name.trim()}>{t('ok', lang)}</button>
          <button onClick={onClose}>{t('cancel', lang)}</button>
        </>
      }
    >
      <label className="gd-field-label" htmlFor="rename-input">{t('enter_group_name', lang)}</label>
      <input
        id="rename-input"
        className="gd-name-input"
        type="text"
        autoFocus
        value={name}
        onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      {error && <div className="gd-field-error">{error}</div>}
    </Modal>
  );
}
