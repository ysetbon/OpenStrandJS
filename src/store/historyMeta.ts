// Provenance metadata for undo/redo states.
//
// The history stack stores documents: `past[i]` is what the drawing looked like,
// and nothing more. That makes every step anonymous — you can walk back through
// twenty of them without ever learning WHAT produced each one. This module adds
// the missing half: every state also carries a record of the mode (or the panel /
// dialog / menu action) that created it, so the stack doubles as a log of what
// was actually done.
//
// The record is attached where the state is made (commit / commitEdit take it),
// travels with the state through undo/redo, is persisted alongside the session
// snapshots (ui/settings/history.ts), and is read back by the undo/redo tooltips
// and the History settings page.
import type { ModeName } from '../model/types';

// Which part of the app produced a state. Modes are the canvas tools; the rest
// are the non-mode surfaces that also mutate the document.
export type HistorySource =
  | 'mode'      // a canvas tool: attach / move / rotate / mask / angle
  | 'panel'     // layer panel, group panel, layer control stack
  | 'dialog'    // a modal editor (colour picker, shadow editor, group rotate…)
  | 'menu'      // a layer-button context menu entry
  | 'system';   // automatic bookkeeping (auto-shadow, load, new document)

// What a caller supplies at the point of the edit. `mode` and `at` are filled in
// by the store, so a call site only names the action and what it touched.
export interface HistoryMetaInput {
  action: string;            // stable id from ACTIONS, e.g. 'move.handle'
  source?: HistorySource;    // defaults to 'mode' when a mode owns the edit
  targets?: string[];        // affected layer / group names
  detail?: string;           // free-form extra ("#ff0000", "45°", "start")
}

// What actually gets stored with the state.
export interface HistoryMeta extends HistoryMetaInput {
  source: HistorySource;
  targets: string[];
  mode: ModeName | null;     // mode active when the state was created
  at: number;                // epoch ms
}

// One entry in the session journal: every history event in order, including the
// undos and redos themselves (which create no new state but ARE things you did).
export interface HistoryEvent {
  kind: 'edit' | 'undo' | 'redo' | 'load' | 'reset';
  meta: HistoryMeta | null;  // the action created (edit) or replayed (undo/redo)
  at: number;
}

// Action catalogue: id -> human-readable description. Ids are stable and are
// what gets persisted; the text is only for display, so renaming it is safe.
// Keep ids grouped by the surface that raises them.
export const ACTIONS: Record<string, string> = {
  // Canvas modes
  'attach.new': 'Drew a new strand',
  'attach.child': 'Attached a strand',
  'move.handle': 'Moved a point',
  'rotate.strand': 'Rotated a strand',
  'angle.adjust': 'Adjusted angle/length',
  'mask.create': 'Created a mask',
  'mask.edit': 'Edited a mask',

  // Layer panel / layer controls
  'layer.delete': 'Deleted a layer',
  'layer.delete_all': 'Cleared the canvas',
  'layer.reorder': 'Reordered layers',
  'layer.add_set': 'Added a strand set',
  'layer.lock': 'Locked/unlocked a layer',
  'layer.clear_locks': 'Cleared all locks',
  'layer.lock_mode': 'Toggled lock mode',

  // Layer button context menu
  'strand.color': 'Changed strand colour',
  'strand.circle_stroke': 'Changed circle stroke',
  'strand.end_circle_stroke': 'Changed end-circle stroke',
  'strand.hidden': 'Toggled layer visibility',
  'strand.shadow_only': 'Toggled shadow-only',
  'strand.hide_shadow': 'Toggled shadow hiding',
  'strand.line_visible': 'Toggled line visibility',
  'strand.extension': 'Toggled an extension line',
  'strand.circle_visible': 'Toggled an end circle',
  'strand.arrow': 'Toggled an arrow',
  'strand.arrow_style': 'Changed arrow style',
  'strand.reset_mask': 'Reset a mask',
  'strand.close_knot': 'Closed a knot',
  'strand.paste': 'Pasted strand data',
  'strand.width': 'Changed strand width',
  'strand.properties': 'Edited strand properties',
  'strand.shadow': 'Edited strand shadow',

  // Groups
  'group.create': 'Created a group',
  'group.delete': 'Deleted a group',
  'group.rename': 'Renamed a group',
  'group.move': 'Moved a group',
  'group.rotate': 'Rotated a group',
  'group.angle': 'Edited group angles',
  'group.shadow': 'Edited group shadow',
  'group.edit': 'Edited a group',

  // System
  'system.auto_shadow': 'Auto shadow update',
  'system.load': 'Loaded a document',
  'system.new': 'New document',
};

// Fill in the parts the store owns. Call sites only describe the action.
export function buildMeta(input: HistoryMetaInput, mode: ModeName | null): HistoryMeta {
  return {
    action: input.action,
    source: input.source ?? 'mode',
    targets: input.targets ?? [],
    detail: input.detail,
    mode,
    at: Date.now(),
  };
}

// Turn an id nobody catalogued into something readable ('foo.bar_baz' -> 'Foo bar baz').
function prettify(action: string): string {
  const words = action.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// One-line description of a state's provenance, e.g.
//   "Moved a point — 1_2 (start)  ·  Move mode"
export function historyLabel(meta: HistoryMeta | null): string {
  if (!meta) return 'Unrecorded change';
  const parts: string[] = [ACTIONS[meta.action] ?? prettify(meta.action)];
  const what = [...meta.targets];
  if (meta.detail) what.push(meta.detail);
  if (what.length) parts.push(what.join(', '));
  const where = meta.source === 'mode' && meta.mode ? `${meta.mode} mode` : meta.source;
  return `${parts.join(' — ')}  ·  ${where}`;
}

// Short form for a button tooltip: no source suffix.
export function historyShortLabel(meta: HistoryMeta | null): string {
  if (!meta) return '';
  const head = ACTIONS[meta.action] ?? prettify(meta.action);
  return meta.targets.length ? `${head} (${meta.targets.join(', ')})` : head;
}
