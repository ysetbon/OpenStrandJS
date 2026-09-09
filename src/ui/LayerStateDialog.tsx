import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { computeLayerState, formatLayerStateLog } from '../store/layerStateManager';
import { t } from './i18n';
import { Modal } from './Modal';
import { HtmlBlock } from './settings/HtmlBlock';

// Toolbar "State" button — main_window.show_layer_state_log: a 400x600 dialog
// titled layer_state_log_title holding a title row (the title label, a 40x40 "?"
// button that opens the explanation, a stretch), a read-only QTextEdit with the
// LayerStateManager's dict printed as Python literals, and a Close button.
export function LayerStateDialog(props: { onClose: () => void }): JSX.Element {
  const { onClose } = props;
  const doc = useEditorStore((s) => s.doc);
  const newestStrand = useEditorStore((s) => s.newestStrand);
  const selected = useEditorStore((s) => s.selection.layerName);
  const lang = useEditorStore((s) => s.settings.language);
  const [infoOpen, setInfoOpen] = useState(false);

  // OSS reads the snapshot taken at the last save_current_state; the canvas
  // selection is what that snapshot recorded as selected_strand.
  const state = computeLayerState(doc, { newestStrand, selectedStrand: selected ?? doc.selected_strand_name });
  const text = formatLayerStateLog(state, {
    current_layer_state: t('current_layer_state', lang),
    order: t('order', lang),
    connections: t('connections', lang),
    masked_layers: t('masked_layers', lang),
    colors: t('colors', lang),
    positions: t('positions', lang),
    selected_strand: t('selected_strand', lang),
    newest_strand: t('newest_strand', lang),
    newest_layer: t('newest_layer', lang),
  });

  return (
    <Modal
      title={t('layer_state_log_title', lang)}
      onClose={onClose}
      lang={lang}
      width={400}
      closeButton
      footer={<button onClick={onClose}>{t('close', lang)}</button>}
    >
      <div className="layer-state-dialog">
        <div className="layer-state-title-row">
          <span>{t('layer_state_log_title', lang)}</span>
          <button
            type="button"
            className="layer-state-info-btn"
            title={t('layer_state_info_tooltip', lang)}
            onClick={() => setInfoOpen(true)}
          >
            ?
          </button>
        </div>
        <textarea className="layer-state-text" readOnly value={text} spellCheck={false} />
      </div>
      {infoOpen && (
        <Modal
          title={t('layer_state_info_title', lang)}
          onClose={() => setInfoOpen(false)}
          lang={lang}
          width={520}
          footer={<button onClick={() => setInfoOpen(false)}>{t('close', lang)}</button>}
        >
          <div className="layer-state-info">
            <HtmlBlock html={t('layer_state_info_text', lang)} lang={lang} />
          </div>
        </Modal>
      )}
    </Modal>
  );
}
