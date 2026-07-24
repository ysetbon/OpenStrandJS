// The catalog of every "window" (dialog / menu / panel / canvas) the dark-mode
// gallery can render. Each entry renders the real component over the real seeded
// <App/>, so the screenshot shows the window exactly as the app draws it in the
// chosen theme.
//
// `overlay` renders a dialog/menu on top of the app (via the component's own
// <Modal> backdrop). `selector` narrows the screenshot to one element (a panel or
// the canvas); when absent the whole viewport is captured (right for modal dialogs,
// which dim the app behind them).

import type { ReactNode } from 'react';
import type { SeedInfo } from './seed';

import { SettingsDialog } from '../ui/SettingsDialog';
import { LayerStateDialog } from '../ui/LayerStateDialog';
import { RenameDialog } from '../ui/dialogs/RenameDialog';
import { MainStrandSelectDialog } from '../ui/dialogs/MainStrandSelectDialog';
import { GroupMoveDialog } from '../ui/dialogs/GroupMoveDialog';
import { GroupRotateDialog } from '../ui/dialogs/GroupRotateDialog';
import { GroupAngleEditorDialog } from '../ui/dialogs/GroupAngleEditorDialog';
import { GroupShadowEditorDialog } from '../ui/dialogs/GroupShadowEditorDialog';
import { StrandShadowEditorDialog } from '../ui/dialogs/StrandShadowEditorDialog';
import { MaskGridDialog } from '../ui/dialogs/MaskGridDialog';
import { DefaultWidthDialog } from '../ui/settings/DefaultWidthDialog';
import { ContextMenu } from '../ui/ContextMenu';
import type { MenuItem } from '../ui/ContextMenu';
import type { Language } from '../model/types';

export interface GalleryEntry {
  id: string;
  title: string;
  category: 'main' | 'panel' | 'dialog' | 'settings' | 'menu';
  /** Element to screenshot; absent => whole viewport. */
  selector?: string;
  /** Rendered on top of the seeded <App/> (a dialog or menu). */
  overlay?: (ctx: EntryContext) => ReactNode;
  /** For the settings window: iterate the nav and shoot each page. */
  isSettings?: boolean;
  /** Short note when the content shown is representative, not app-driven. */
  note?: string;
}

export interface EntryContext {
  seed: SeedInfo;
  lang: Language;
  close: () => void;
}

// Representative layer context menu (OSS NumberedLayerButton menu): plain items,
// a separator, a disabled item, and the compound Line/Circle rows the menu CSS
// styles specially. Content is representative — the point is the menu chrome.
const layerMenuItems = (): MenuItem[] => [
  { label: 'Duplicate', onClick: () => {} },
  { label: 'Reset', onClick: () => {} },
  { label: '', rowLabel: 'Line', buttons: [{ label: 'Start', onClick: () => {} }, { label: 'End', onClick: () => {} }] },
  { label: '', rowLabel: 'Circle', noPad: true, buttons: [{ label: 'Start', onClick: () => {} }, { label: 'End', onClick: () => {} }] },
  { label: '', rowLabel: 'Arrow', buttons: [{ label: 'Start', onClick: () => {} }, { label: 'End', onClick: () => {} }, { label: 'Full', onClick: () => {} }] },
  { separator: true, label: '' },
  { label: 'Shadow Only', onClick: () => {} },
  { label: 'Hide Shadow', onClick: () => {} },
  { label: 'Edit Shadow…', onClick: () => {} },
  { separator: true, label: '' },
  { label: 'Delete', onClick: () => {} },
  { label: 'Locked (unavailable)', disabled: true },
];

const groupMenuItems = (group: string): MenuItem[] => [
  { label: `Move ${group}`, onClick: () => {} },
  { label: `Rotate ${group}`, onClick: () => {} },
  { label: 'Edit Strand Angles', onClick: () => {} },
  { label: 'Edit Shadows', onClick: () => {} },
  { separator: true, label: '' },
  { label: 'Create Mask Grid', onClick: () => {} },
  { label: 'Duplicate Group', onClick: () => {} },
  { label: 'Rename Group', onClick: () => {} },
  { separator: true, label: '' },
  { label: 'Delete Group', onClick: () => {} },
];

export const ENTRIES: GalleryEntry[] = [
  // ---- main window + canvas + panels (all part of the seeded <App/>) ----
  { id: 'main-window', title: 'Main window (toolbar · canvas · layer panel)', category: 'main', selector: '.shell' },
  { id: 'canvas', title: 'Canvas (weave on themed background + grid)', category: 'main', selector: '.stage' },
  { id: 'layer-panel', title: 'Layer panel (control column · layer list · 6-button stack)', category: 'panel', selector: '.lp-left' },
  { id: 'group-panel', title: 'Group panel (QTreeWidget-style groups)', category: 'panel', selector: '.lp-right' },

  // ---- toolbar dialogs ----
  { id: 'settings', title: 'Settings dialog (all pages)', category: 'settings', isSettings: true,
    overlay: ({ close }) => <SettingsDialog onClose={close} /> },
  { id: 'layer-state', title: 'Layer State dialog', category: 'dialog',
    overlay: ({ close }) => <LayerStateDialog onClose={close} /> },

  // ---- group / strand dialogs ----
  { id: 'create-group', title: 'Create Group → Select Main Strands', category: 'dialog',
    overlay: ({ close }) => <MainStrandSelectDialog onSubmit={() => {}} onClose={close} /> },
  { id: 'rename-group', title: 'Rename Group dialog', category: 'dialog',
    overlay: ({ close, lang }) => (
      <RenameDialog title="Rename Group" initial="Group 1" siblings={['Group 2']} onSubmit={() => {}} onClose={close} />
    ) },
  { id: 'group-move', title: 'Move Group dialog', category: 'dialog',
    overlay: ({ seed, close }) => <GroupMoveDialog groupName={seed.group} onClose={close} /> },
  { id: 'group-rotate', title: 'Rotate Group dialog', category: 'dialog',
    overlay: ({ seed, close }) => <GroupRotateDialog groupName={seed.group} onClose={close} /> },
  { id: 'group-angle', title: 'Edit Strand Angles dialog', category: 'dialog',
    overlay: ({ seed, close }) => <GroupAngleEditorDialog groupName={seed.group} onClose={close} /> },
  { id: 'group-shadow', title: 'Group Shadow Editor dialog', category: 'dialog',
    overlay: ({ seed, close }) => <GroupShadowEditorDialog groupName={seed.group} onClose={close} /> },
  { id: 'strand-shadow', title: 'Strand Shadow Editor dialog', category: 'dialog',
    overlay: ({ seed, close }) => <StrandShadowEditorDialog layerName={seed.strandLayer} onClose={close} /> },
  { id: 'mask-grid', title: 'Create Mask Grid dialog', category: 'dialog',
    overlay: ({ seed, close }) => <MaskGridDialog groupName={seed.group} onClose={close} /> },
  { id: 'default-width', title: 'Default Width sub-dialog', category: 'dialog',
    overlay: ({ lang, close }) => <DefaultWidthDialog lang={lang} onClose={close} /> },

  // ---- context menus ----
  { id: 'menu-layer', title: 'Layer context menu', category: 'menu', note: 'representative items',
    overlay: ({ close }) => <ContextMenu items={layerMenuItems()} x={420} y={140} onClose={close} /> },
  { id: 'menu-group', title: 'Group context menu', category: 'menu', note: 'representative items',
    overlay: ({ seed, close }) => <ContextMenu items={groupMenuItems(seed.group)} x={420} y={140} onClose={close} /> },
];

export const ENTRY_IDS = ENTRIES.map((e) => e.id);
export const entryById = (id: string): GalleryEntry | undefined => ENTRIES.find((e) => e.id === id);
