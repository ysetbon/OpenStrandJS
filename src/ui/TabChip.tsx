import React, { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { serializeHistory } from '../io/saveLoad';
import { saveProjectFile } from '../io/fileDialog';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

// OSS tab_bar_widget.TabChip: a 40px-tall, radius-9 chip laid out as
// [dirty dot][title 9pt, bold when active][duplicate][close] (margins 11/3/7/3,
// spacing 7). In RTL the row is mirrored: [close][duplicate][title][dot].
// The edge sizes chips to 1.1× their natural width (TAB_WIDTH_SCALE) and the
// title expands into the slack. Pressing a chip never starts an edge drag.
export function TabChip(props: {
  id: number;
  title: string;
  active: boolean;
  dirty?: boolean;
  rtl: boolean;
}): JSX.Element {
  const { id, title, active, dirty, rtl } = props;
  const switchTab = useEditorStore((s) => s.switchTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const duplicateTab = useEditorStore((s) => s.duplicateTab);
  const markTabSaved = useEditorStore((s) => s.markTabSaved);
  // "Skip the unsaved-changes prompt when closing a tab" (Settings -> General;
  // OSS canvas.skip_close_tab_warning read in TabManager.close_tab).
  const skipCloseWarning = useEditorStore((s) => s.settings.skip_close_tab_warning);

  const [confirmOpen, setConfirmOpen] = useState(false);

  const onCloseClick = () => {
    if (dirty && !skipCloseWarning) {
      setConfirmOpen(true);
      return;
    }
    closeTab(id);
  };

  // Save = write THIS tab's project to a file, then close it. If the save is
  // cancelled the tab stays (OSS: "if not saved: return"). A background tab is
  // serialized from its stored doc, so the live tab is never disturbed.
  const doSave = async () => {
    const s = useEditorStore.getState();
    const tab = s.tabs.find((tb) => tb.id === id);
    if (!tab) { setConfirmOpen(false); return; }
    const opts = { enable_curvature_bias_control: s.settings.enable_curvature_bias_control };
    // The live tab saves its whole undo/redo history like OSS save_project; a
    // background tab holds only its document (its history was dropped on the
    // switch), so it saves the one-step history a snapshot would produce.
    const payload = id === s.activeTabId
      ? serializeHistory(s.past, { doc: s.doc, meta: s.presentMeta }, s.future, opts)
      : serializeHistory([], { doc: tab.doc ?? s.doc, meta: null }, [], opts);
    const res = await saveProjectFile(tab.filePath ?? 'openstrand_project.json', payload);
    if (!res.saved) return;
    markTabSaved(id, res.filename);
    setConfirmOpen(false);
    closeTab(id);
  };
  const doDiscard = () => {
    setConfirmOpen(false);
    closeTab(id);
  };
  const doCancel = () => setConfirmOpen(false);

  // Consume presses so the click selects the chip instead of dragging the edge.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const dot = dirty ? <span className="tab-chip-dot" aria-hidden /> : null;
  const label = <span className="tab-chip-title" dir={rtl ? 'rtl' : 'ltr'}>{title}</span>;
  const dup = (
    <button
      type="button"
      className="tab-icon-btn"
      aria-label="Duplicate tab"
      onPointerDown={stop}
      onClick={(e) => { stop(e); duplicateTab(id); }}
    >
      <DuplicateGlyph />
    </button>
  );
  const close = (
    <button
      type="button"
      className="tab-icon-btn"
      aria-label="Close tab"
      onPointerDown={stop}
      onClick={(e) => { stop(e); onCloseClick(); }}
    >
      <CloseGlyph />
    </button>
  );

  return (
    <>
      <div
        className={'tab-chip' + (active ? ' tab-chip-active' : '') + (rtl ? ' tab-chip-rtl' : '')}
        role="tab"
        aria-selected={active}
        onPointerDown={stop}
        onClick={() => switchTab(id)}
      >
        {rtl ? <>{close}{dup}{label}{dot}</> : <>{dot}{label}{dup}{close}</>}
      </div>

      {confirmOpen ? (
        <UnsavedChangesDialog tabTitle={title} onSave={doSave} onDiscard={doDiscard} onCancel={doCancel} />
      ) : null}
    </>
  );
}

// OSS IconButton('duplicate'), 18×18: two overlapping 5px squares, pen 1.6.
function DuplicateGlyph(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable="false">
      <rect x="8" y="5" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="5" y="8" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

// OSS IconButton('close'), 18×18: an X from (5,5) to (13,13), pen 1.6 round caps.
function CloseGlyph(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path d="M5 5 L13 13 M13 5 L5 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
