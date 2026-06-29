import { useState } from 'react';
import { Modal } from '../Modal';
import { ColorField } from '../ColorField';
import { t } from '../i18n';
import type { Language, RGBA } from '../../model/types';

// OSS change_color / change_stroke_color open a QColorDialog with ShowAlphaChannel
// (numbered_layer_button.py:2072, 2440) so fill/stroke transparency is reachable. The
// native <input type=color> drops alpha, so we wrap ColorField (RGB picker + alpha
// slider) in a small modal and return the full RGBA on accept.
export function ColorPickerDialog({
  title, initial, lang, onClose, onApply,
}: {
  title: string;
  initial: RGBA;
  lang: Language;
  onClose: () => void;
  onApply: (c: RGBA) => void;
}): JSX.Element {
  const [c, setC] = useState<RGBA>({ ...initial });
  const apply = () => onApply(c);
  return (
    <Modal
      title={title}
      onClose={onClose}
      lang={lang}
      onEnter={apply}
      width={360}
      footer={(
        <>
          <button onClick={apply}>{t('ok', lang)}</button>
          <button onClick={onClose}>{t('cancel', lang)}</button>
        </>
      )}
    >
      <ColorField label={title} value={c} onChange={setC} />
    </Modal>
  );
}
