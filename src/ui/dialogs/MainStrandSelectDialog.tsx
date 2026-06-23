import { useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { maskComponents } from '../../model/layerName';
import { t } from '../i18n';

// OSS-faithful create-group flow (group_layers.py create_group): a sequence of
// TWO dialogs — first "Create Group" asks for the name ("Enter group name:"),
// then "Select Main Strands" lists one checkbox per unique main strand (set) with
// the instruction label, no Select-All. Checking a strand that participates in a
// mask auto-checks its masked partner (and unchecking auto-unchecks), matching
// the desktop. OK hands back (name, representative main-strand layer_names); the
// group resolves to whole branches downstream.
export function MainStrandSelectDialog(props: {
  onSubmit: (name: string, members: string[]) => void;
  onClose: () => void;
}): JSX.Element {
  const { onSubmit, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const doc = useEditorStore((s) => s.doc);

  const { sets, mainBySet, partners } = useMemo(() => {
    // One representative layer_name per set_number (prefer the "_1" main strand).
    const mainBySet = new Map<number, string>();
    for (const n of doc.order) {
      const s = doc.strands[n];
      if (!s || s.type === 'MaskedStrand') continue;
      const cur = mainBySet.get(s.set_number);
      if (cur === undefined || (n.endsWith('_1') && !cur.endsWith('_1'))) mainBySet.set(s.set_number, n);
    }
    // Mask adjacency between sets (drives OSS auto-check of masked partners).
    const partners = new Map<number, Set<number>>();
    const link = (a: number, b: number) => {
      if (a === b) return;
      if (!partners.has(a)) partners.set(a, new Set());
      if (!partners.has(b)) partners.set(b, new Set());
      partners.get(a)!.add(b);
      partners.get(b)!.add(a);
    };
    for (const n of Object.keys(doc.strands)) {
      if (doc.strands[n].type !== 'MaskedStrand') continue;
      const comp = maskComponents(n);
      if (!comp) continue;
      const sa = doc.strands[comp.first]?.set_number;
      const sb = doc.strands[comp.second]?.set_number;
      if (sa != null && sb != null) link(sa, sb);
    }
    const sets = [...mainBySet.keys()].sort((a, b) => a - b);
    return { sets, mainBySet, partners };
  }, [doc.order, doc.strands]);

  const [step, setStep] = useState<'name' | 'select'>('name');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Record<number, boolean>>({});

  const toggle = (set: number) => {
    setPicked((p) => {
      const next = { ...p };
      const turnOn = !p[set];
      next[set] = turnOn;
      for (const q of partners.get(set) ?? []) next[q] = turnOn;
      return next;
    });
  };

  const members = sets.filter((s) => picked[s]).map((s) => mainBySet.get(s)!);
  const goSelect = () => { if (name.trim()) setStep('select'); };
  const submit = () => {
    if (!name.trim() || !members.length) return;
    onSubmit(name.trim(), members);
    onClose();
  };

  if (step === 'name') {
    return (
      <Modal
        title={t('create_group', lang)}
        onClose={onClose}
        lang={lang}
        onEnter={goSelect}
        footer={
          <>
            <button onClick={goSelect} disabled={!name.trim()}>{t('ok', lang)}</button>
            <button onClick={onClose}>{t('cancel', lang)}</button>
          </>
        }
      >
        <label className="gd-field-label" htmlFor="group-name-input">{t('enter_group_name', lang)}</label>
        <input
          id="group-name-input"
          className="gd-name-input"
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Modal>
    );
  }

  return (
    <Modal
      title={t('select_main_strands', lang)}
      onClose={onClose}
      lang={lang}
      onEnter={submit}
      footer={
        <>
          <button onClick={submit} disabled={!members.length}>{t('ok', lang)}</button>
          <button onClick={onClose}>{t('cancel', lang)}</button>
        </>
      }
    >
      <div className="gd-field-label">{t('select_main_strands_to_include_in_the_group', lang)}</div>
      <div className="gd-select-list">
        {sets.map((s) => (
          <label key={s} className="gd-select-row">
            <input type="checkbox" checked={!!picked[s]} onChange={() => toggle(s)} />
            <span>{s}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
