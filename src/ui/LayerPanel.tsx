import { useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { createGroup, reorderLayer } from '../store/actions';
import { ControlColumn } from './ControlColumn';
import { NumberedLayerButton } from './NumberedLayerButton';
import { LayerControlStack } from './LayerControlStack';
import {
  GroupPanel,
  type GroupDialogs,
  type RenameDialogProps,
  type MainStrandSelectDialogProps,
} from './GroupPanel';
import { GroupMoveDialog } from './dialogs/GroupMoveDialog';
import { GroupRotateDialog } from './dialogs/GroupRotateDialog';
import { GroupShadowEditorDialog } from './dialogs/GroupShadowEditorDialog';
import { RenameDialog } from './dialogs/RenameDialog';
import { MainStrandSelectDialog } from './dialogs/MainStrandSelectDialog';
import { t } from './i18n';

// Adapters: the C4 dialogs expose onSubmit; GroupPanel's contract expects
// onAccept. GroupMove/Rotate/Shadow already match ({groupName,onClose}) so they
// are passed straight through.
function RenameDialogAdapter(props: RenameDialogProps): JSX.Element {
  return (
    <RenameDialog
      title={props.title}
      initial={props.initial}
      onClose={props.onClose}
      onSubmit={(name) => props.onAccept(name)}
    />
  );
}

// The OSS-faithful member picker owns its own group-name field (and candidate
// list), so the adapter commits createGroup with that name directly instead of
// routing through GroupPanel's auto-naming onAccept.
function MainStrandSelectDialogAdapter(props: MainStrandSelectDialogProps): JSX.Element {
  const commitEdit = useEditorStore((s) => s.commitEdit);
  return (
    <MainStrandSelectDialog
      onClose={props.onClose}
      onSubmit={(name, members) => commitEdit((d) => createGroup(d, name, members))}
    />
  );
}

const GROUP_DIALOGS: GroupDialogs = {
  GroupMoveDialog,
  GroupRotateDialog,
  GroupShadowEditorDialog,
  RenameDialog: RenameDialogAdapter,
  MainStrandSelectDialog: MainStrandSelectDialogAdapter,
};

// OSS layer panel. Top-to-bottom: the vertical ControlColumn, a title header,
// the scrollable layer list (newest/topmost first = [...order].reverse()) of
// NumberedLayerButtons with drag-reorder + a blue insertion line, then the
// six-button LayerControlStack and the GroupPanel tree. (No inline strand-
// properties editor — OSS edits via the layer right-click menu instead.)
//
// All mutation goes through the store actions, so the panel stays decoupled.
export function LayerPanel() {
  const order = useEditorStore((s) => s.doc.order);
  const strands = useEditorStore((s) => s.doc.strands);
  const locked = useEditorStore((s) => s.doc.locked_layers);
  const lang = useEditorStore((s) => s.settings.language);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const setSelection = useEditorStore((s) => s.setSelection);

  // Drag-reorder state: source order index + the order index we'd drop ON.
  const dragIdx = useRef<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  // Visual list: top (z-top) first.
  const visual = [...order].map((name, i) => ({ name, orderIdx: i })).reverse();

  function select(name: string) {
    if (locked.includes(name)) return;
    setSelection({ layerName: name, handle: null });
  }

  function onDragStart(orderIdx: number) {
    dragIdx.current = orderIdx;
  }

  function onDragOver(orderIdx: number) {
    if (dragIdx.current == null) return;
    if (dropIdx !== orderIdx) setDropIdx(orderIdx);
  }

  function onDrop(targetOrderIdx: number) {
    const from = dragIdx.current;
    dragIdx.current = null;
    setDropIdx(null);
    if (from == null || from === targetOrderIdx) return;
    commitEdit((d) => reorderLayer(d, from, targetOrderIdx));
  }

  function onDragEnd() {
    dragIdx.current = null;
    setDropIdx(null);
  }

  return (
    <div className="layer-panel">
      {/* Left sub-column: control column, layer list, 6-button stack (OSS left_panel). */}
      <div className="lp-left">
        <ControlColumn />

        <div className="lp-head">
          <span>{t('layer_panel_title', lang)}</span>
        </div>

        <div className="lp-list">
          {visual.length === 0 && <div className="lp-empty">No strands. Load a file or ＋.</div>}
          {visual.map(({ name, orderIdx }) => {
            if (!strands[name]) return null;
            // The blue insertion line (QColor(0,120,215), 2px) shows above the row
            // currently under the drag.
            const showLine = dropIdx === orderIdx && dragIdx.current !== orderIdx;
            return (
              <div key={name} className="lp-item">
                {showLine && <div className="lp-drop-line" />}
                <NumberedLayerButton
                  name={name}
                  orderIdx={orderIdx}
                  onSelect={select}
                  draggable
                  onDragStart={(idx) => onDragStart(idx)}
                  onDragOver={(idx) => onDragOver(idx)}
                  onDrop={(idx) => onDrop(idx)}
                  onDragEnd={onDragEnd}
                />
              </div>
            );
          })}
        </div>

        <LayerControlStack />
      </div>

      {/* Right sub-column: the fixed 270px group panel (OSS right_panel). */}
      <div className="lp-right">
        <GroupPanel dialogs={GROUP_DIALOGS} />
      </div>
    </div>
  );
}
