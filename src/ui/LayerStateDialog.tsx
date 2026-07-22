import type { CSSProperties } from 'react';
import { useEditorStore } from '../store/editorStore';
import { t } from './i18n';
import { Modal } from './Modal';
import { buildConnTable, connectionSlot } from '../interaction/connections';
import type { EndKey, RGBA } from '../model/types';

function hex2(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return v.toString(16).padStart(2, '0');
}

function rgbaHex(c: RGBA): string {
  return ('#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a < 255 ? hex2(c.a) : '')).toUpperCase();
}

const r0 = (n: number) => Math.round(n);

// OSS get_layer_connections format: the directed neighbor of (layer,end) as
// `neighbor(0|1)` (0=neighbor's start, 1=neighbor's end), else 'null'. Mirrors OSS's
// single-slot, first-claim-wins, knot-overwrite table (connections.ts — no
// LayerStateManager needed).
function connStr(table: ReturnType<typeof buildConnTable>, layer: string, end: EndKey): string {
  const slot = connectionSlot(table, layer, end);
  return slot ? `${slot.name}(${slot.point})` : 'null';
}

const HEADING: CSSProperties = { fontWeight: 600, opacity: 0.65, margin: '10px 0 2px', fontSize: '0.85em' };

// Toolbar "State" button: a read-only inspector of the current document's layer
// state, mirroring OSS's Layer State Log — selected strand, the per-layer overview
// (order/type/color/flags), the endpoint connection graph, positions, and masks.
export function LayerStateDialog(props: { onClose: () => void }): JSX.Element {
  const { onClose } = props;

  const doc = useEditorStore((s) => s.doc);
  const lang = useEditorStore((s) => s.settings.language);
  const { order, strands, selected_strand_name } = doc;

  const lockedSet = new Set(doc.locked_layers);
  const table = buildConnTable(doc);
  const nonMasked = order.filter((n) => strands[n] && strands[n].type !== 'MaskedStrand');
  const masked = order.filter((n) => strands[n] && strands[n].type === 'MaskedStrand');

  return (
    <Modal
      title={t('current_layer_state', lang)}
      lang={lang}
      onClose={onClose}
      footer={<button onClick={onClose}>{t('close', lang)}</button>}
    >
      <div className="layer-state-log">
        {order.length === 0 ? (
          <div className="layer-state-empty">—</div>
        ) : (
          <>
            {/* Selected strand (live — kept in sync with the canvas selection). */}
            <div style={HEADING}>{t('selected_strand', lang)}</div>
            <div className="layer-state-row"><span className="ls-name">{selected_strand_name ?? '—'}</span></div>

            {/* Order: the per-layer overview (index / swatch / name / type / set / color / flags). */}
            <div style={HEADING}>{t('order', lang)}</div>
            {order.map((name, i) => {
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
                  <span className="ls-swatch" style={{ background: rgbaHex(s.color) }} aria-hidden="true" />
                  <span className="ls-name">{name}</span>
                  <span className="ls-type">{s.type}</span>
                  <span className="ls-set">set {s.set_number}</span>
                  <span className="ls-color">{rgbaHex(s.color)}</span>
                  {flags.length > 0 && <span className="ls-flags">{flags.join(', ')}</span>}
                </div>
              );
            })}

            {/* Connections: the endpoint weld graph, [start, end] per non-masked layer. */}
            <div style={HEADING}>{t('connections', lang)}</div>
            {nonMasked.map((name) => (
              <div key={name} className="layer-state-row">
                <span className="ls-name">{name}</span>
                <span className="ls-conn">[{connStr(table, name, 'start')}, {connStr(table, name, 'end')}]</span>
              </div>
            ))}

            {/* Positions: each strand's start -> end coordinates. */}
            <div style={HEADING}>{t('positions', lang)}</div>
            {order.map((name) => {
              const s = strands[name];
              if (s == null) return null;
              return (
                <div key={name} className="layer-state-row">
                  <span className="ls-name">{name}</span>
                  <span className="ls-pos">({r0(s.start.x)}, {r0(s.start.y)}) → ({r0(s.end.x)}, {r0(s.end.y)})</span>
                </div>
              );
            })}

            {/* Masked layers. */}
            {masked.length > 0 && (
              <>
                <div style={HEADING}>{t('masked_layers', lang)}</div>
                {masked.map((name) => (
                  <div key={name} className="layer-state-row"><span className="ls-name">{name}</span></div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
