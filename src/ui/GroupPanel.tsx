// GroupPanel — OSS-faithful Groups UI (UI_PORT_PLAN §2.5 / phase 6.2).
//
// Replaces the minimal GroupsSection. Renders:
//   1. A 140x50 themed "Create Group" button (var(--create-group-*)) that opens
//      MainStrandSelectDialog to pick members, then createGroup().
//   2. A QTreeWidget-style tree: each group is a bold "▼ name"/"▶ name" row
//      (click toggles expand); children are one row per unique member main-strand
//      id (indentation 16, row bg var(--group-bg), hover var(--group-hover-bg)).
//   3. A right-click ContextMenu on a group row with the EXACT OSS order:
//        Move Strands, Rotate Strands, Edit Strand Angles, Edit Shadows,
//        Create Mask Grid, Duplicate Group, Rename Group, [sep], Delete Group.
//
// The five member dialogs (Move/Rotate/ShadowEditor/Rename/MainStrandSelect) are
// the subject of C4. To stay tsc-clean and self-contained *before* C4 lands,
// GroupPanel accepts them via an optional `dialogs` prop (a GroupDialogs bag).
// Integration (and C4) pass the real components; until then GroupPanel falls
// back to built-in Modal-based placeholders so the panel is fully usable.

import React, { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  createGroup,
  deleteGroup,
  duplicateGroup,
  createMaskGrid,
  renameGroup,
} from '../store/actions';
import { resolveGroupMembers } from '../model/group';
import { t } from './i18n';
import { ContextMenu, MenuItem } from './ContextMenu';
import { Modal } from './Modal';
import './groupPanel.css';

/* ------------------------------------------------------------------ */
/* Dialog contracts (implemented by C4; injected via the `dialogs` prop) */
/* ------------------------------------------------------------------ */

export interface GroupMoveDialogProps {
  groupName: string;
  onClose: () => void;
}
export interface GroupRotateDialogProps {
  groupName: string;
  onClose: () => void;
}
export interface GroupShadowEditorDialogProps {
  groupName: string;
  onClose: () => void;
}
export interface RenameDialogProps {
  /** Initial text shown in the line edit. */
  initial: string;
  title: string;
  onClose: () => void;
  onAccept: (next: string) => void;
}
export interface MainStrandSelectDialogProps {
  /** Candidate member layer_names (non-masked). */
  candidates: string[];
  onClose: () => void;
  /** Receives the chosen member layer_names. */
  onAccept: (members: string[]) => void;
}

export interface GroupDialogs {
  GroupMoveDialog?: React.ComponentType<GroupMoveDialogProps>;
  GroupRotateDialog?: React.ComponentType<GroupRotateDialogProps>;
  GroupShadowEditorDialog?: React.ComponentType<GroupShadowEditorDialogProps>;
  RenameDialog?: React.ComponentType<RenameDialogProps>;
  MainStrandSelectDialog?: React.ComponentType<MainStrandSelectDialogProps>;
}

/* ------------------------------------------------------------------ */
/* Built-in fallbacks (used until C4 injects the real dialogs)          */
/* ------------------------------------------------------------------ */

function FallbackRenameDialog(props: RenameDialogProps): JSX.Element {
  const { initial, title, onClose, onAccept } = props;
  const [text, setText] = useState(initial);
  const lang = useEditorStore((s) => s.settings.language);
  const accept = () => {
    const v = text.trim();
    if (v) onAccept(v);
    onClose();
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="gp-dlg-btn" onClick={onClose}>
            {t('cancel', lang)}
          </button>
          <button className="gp-dlg-btn" onClick={accept}>
            {t('ok', lang)}
          </button>
        </>
      }
    >
      <input
        className="gp-rename-input"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') accept();
        }}
      />
    </Modal>
  );
}

function FallbackSelectDialog(props: MainStrandSelectDialogProps): JSX.Element {
  const { candidates, onClose, onAccept } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const toggle = (n: string) => setPicked((p) => ({ ...p, [n]: !p[n] }));
  const accept = () => {
    const members = candidates.filter((n) => picked[n]);
    if (members.length) onAccept(members);
    onClose();
  };
  return (
    <Modal
      title={t('create_group', lang)}
      onClose={onClose}
      footer={
        <>
          <button className="gp-dlg-btn" onClick={onClose}>
            {t('cancel', lang)}
          </button>
          <button className="gp-dlg-btn" onClick={accept}>
            {t('ok', lang)}
          </button>
        </>
      }
    >
      <div className="gp-select-list">
        {candidates.map((n) => (
          <label key={n} className="gp-select-row">
            <input type="checkbox" checked={!!picked[n]} onChange={() => toggle(n)} />
            <span>{n}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

// Generic placeholder for dialogs not yet wired (Move/Rotate/Shadow before C4,
// and Edit Strand Angles which is a TODO in OSS-parity terms).
function PlaceholderDialog(props: { title: string; onClose: () => void }): JSX.Element {
  const lang = useEditorStore((s) => s.settings.language);
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <button className="gp-dlg-btn" onClick={props.onClose}>
          {t('close', lang)}
        </button>
      }
    >
      <div className="gp-placeholder">…</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Local dialog state                                                   */
/* ------------------------------------------------------------------ */

type DialogState =
  | { kind: 'none' }
  | { kind: 'select' } // pick members for a new group
  | { kind: 'move'; group: string }
  | { kind: 'rotate'; group: string }
  | { kind: 'angles'; group: string }
  | { kind: 'shadow'; group: string }
  | { kind: 'rename'; group: string };

interface GroupRecordLike {
  main_strands: string[];
}

export interface GroupPanelProps {
  /** C4 dialog components; omitted entries fall back to built-ins. */
  dialogs?: GroupDialogs;
}

export function GroupPanel(props: GroupPanelProps): JSX.Element {
  const dialogs = props.dialogs ?? {};
  const doc = useEditorStore((s) => s.doc);
  const groups = useEditorStore((s) => s.doc.groups) as Record<string, GroupRecordLike>;
  const strands = useEditorStore((s) => s.doc.strands);
  const lang = useEditorStore((s) => s.settings.language);
  const commitEdit = useEditorStore((s) => s.commitEdit);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ group: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });

  const groupNames = Object.keys(groups || {});

  // Candidate member ids for a NEW group = all non-masked strand layer_names.
  const candidates = Object.keys(strands).filter((n) => strands[n]?.type !== 'MaskedStrand');

  const toggleExpand = (name: string) =>
    setExpanded((e) => ({ ...e, [name]: !(name in e ? e[name] : true) }));

  const isExpanded = (name: string) => (name in expanded ? expanded[name] : true);

  // One row per resolved member strand (whole branches — matches what move/rotate/
  // shadow operate on). resolveGroupMembers already returns distinct layer_names.
  const uniqueMembers = (name: string): string[] => resolveGroupMembers(doc, name).regular;

  const openMenu = (e: React.MouseEvent, group: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ group, x: e.clientX, y: e.clientY });
  };

  const menuItems = (group: string): MenuItem[] => [
    { label: t('move_group_strands', lang), onClick: () => setDialog({ kind: 'move', group }) },
    { label: t('rotate_group_strands', lang), onClick: () => setDialog({ kind: 'rotate', group }) },
    { label: t('edit_strand_angles', lang), onClick: () => setDialog({ kind: 'angles', group }) },
    { label: t('edit_shadows', lang), onClick: () => setDialog({ kind: 'shadow', group }) },
    {
      label: t('create_mask_grid', lang),
      onClick: () => commitEdit((d) => createMaskGrid(d, group)),
    },
    {
      label: t('duplicate_group', lang),
      onClick: () => commitEdit((d) => duplicateGroup(d, group)),
    },
    { label: t('rename_group', lang), onClick: () => setDialog({ kind: 'rename', group }) },
    { label: '', separator: true },
    {
      label: t('delete_group', lang),
      danger: true,
      onClick: () => commitEdit((d) => deleteGroup(d, group)),
    },
  ];

  const closeDialog = () => setDialog({ kind: 'none' });

  const renderDialog = (): React.ReactNode => {
    switch (dialog.kind) {
      case 'none':
        return null;
      case 'select': {
        const Dlg = dialogs.MainStrandSelectDialog ?? FallbackSelectDialog;
        return (
          <Dlg
            candidates={candidates}
            onClose={closeDialog}
            onAccept={(members) => {
              const base = `Group ${groupNames.length + 1}`;
              let nm = base;
              let i = 2;
              while (groups[nm]) nm = `${base} ${i++}`;
              commitEdit((d) => createGroup(d, nm, members));
            }}
          />
        );
      }
      case 'move': {
        const Dlg = dialogs.GroupMoveDialog;
        return Dlg ? (
          <Dlg groupName={dialog.group} onClose={closeDialog} />
        ) : (
          <PlaceholderDialog title={t('move_group_strands', lang)} onClose={closeDialog} />
        );
      }
      case 'rotate': {
        const Dlg = dialogs.GroupRotateDialog;
        return Dlg ? (
          <Dlg groupName={dialog.group} onClose={closeDialog} />
        ) : (
          <PlaceholderDialog title={t('rotate_group_strands', lang)} onClose={closeDialog} />
        );
      }
      case 'angles':
        // Edit Strand Angles has no faithful action yet (OSS-parity TODO).
        return <PlaceholderDialog title={t('edit_strand_angles', lang)} onClose={closeDialog} />;
      case 'shadow': {
        const Dlg = dialogs.GroupShadowEditorDialog;
        return Dlg ? (
          <Dlg groupName={dialog.group} onClose={closeDialog} />
        ) : (
          <PlaceholderDialog title={t('edit_shadows', lang)} onClose={closeDialog} />
        );
      }
      case 'rename': {
        const Dlg = dialogs.RenameDialog ?? FallbackRenameDialog;
        const group = dialog.group;
        return (
          <Dlg
            initial={group}
            title={t('rename_group', lang)}
            onClose={closeDialog}
            onAccept={(next) => commitEdit((d) => renameGroup(d, group, next))}
          />
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="gp-panel">
      <button
        className="gp-create-btn"
        onClick={() => setDialog({ kind: 'select' })}
        title={t('create_group', lang)}
      >
        {t('create_group', lang)}
      </button>

      <div className="gp-tree" role="tree">
        {groupNames.map((name) => {
          const open = isExpanded(name);
          return (
            <div key={name} className="gp-group">
              <div
                className="gp-group-row"
                role="treeitem"
                aria-expanded={open}
                onClick={() => toggleExpand(name)}
                onContextMenu={(e) => openMenu(e, name)}
              >
                <span className="gp-arrow">{open ? '▼' : '▶'}</span>
                <span className="gp-group-name">{name}</span>
              </div>
              {open &&
                uniqueMembers(name).map((m) => (
                  <div key={m} className="gp-child-row" role="treeitem">
                    {m}
                  </div>
                ))}
            </div>
          );
        })}
      </div>

      {menu && (
        <ContextMenu
          items={menuItems(menu.group)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}

      {renderDialog()}
    </div>
  );
}

export default GroupPanel;
