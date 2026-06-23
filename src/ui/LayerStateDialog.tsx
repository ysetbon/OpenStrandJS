import { useEditorStore } from '../store/editorStore';
import { t } from './i18n';
import { Modal } from './Modal';
import type { RGBA } from '../model/types';

function hex2(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return v.toString(16).padStart(2, '0');
}

function rgbaHex(c: RGBA): string {
  return ('#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a < 255 ? hex2(c.a) : '')).toUpperCase();
}

// Toolbar "State" button: a read-only summary of the current document's layer
// state — each layer in draw order with its type, flags, set number, and color.
export function LayerStateDialog(props: { onClose: () => void }): JSX.Element {
  const { onClose } = props;

  const order = useEditorStore((s) => s.doc.order);
  const strands = useEditorStore((s) => s.doc.strands);
  const locked = useEditorStore((s) => s.doc.locked_layers);
  const lang = useEditorStore((s) => s.settings.language);

  const lockedSet = new Set(locked);

  return (
    <Modal
      title={t('layer_state', lang)}
      onClose={onClose}
      footer={<button onClick={onClose}>{t('close', lang)}</button>}
    >
      <div className="layer-state-log">
        {order.length === 0 ? (
          <div className="layer-state-empty">—</div>
        ) : (
          order.map((name, i) => {
            const s = strands[name];
            if (s == null) {
              return (
                <div key={name} className="layer-state-row">
                  <span className="ls-idx">{i}</span>
                  <span className="ls-name">{name}</span>
                  <span className="ls-missing">(missing)</span>
                </div>
              );
            }
            const flags: string[] = [];
            if (s.is_hidden) flags.push('hidden');
            if (lockedSet.has(name)) flags.push('locked');
            if (s.shadow_only) flags.push('shadow_only');
            return (
              <div key={name} className="layer-state-row">
                <span className="ls-idx">{i}</span>
                <span
                  className="ls-swatch"
                  style={{ background: rgbaHex(s.color) }}
                  aria-hidden="true"
                />
                <span className="ls-name">{name}</span>
                <span className="ls-type">{s.type}</span>
                <span className="ls-set">set {s.set_number}</span>
                <span className="ls-color">{rgbaHex(s.color)}</span>
                {flags.length > 0 && <span className="ls-flags">{flags.join(', ')}</span>}
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
