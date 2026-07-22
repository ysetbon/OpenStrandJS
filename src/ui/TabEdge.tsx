import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { t } from './translations';
import { TabChip } from './TabChip';
import './tabEdge.css';

// OSS constants (UI_PORT_PLAN §2.7).
const PANEL_HEIGHT = 53;
const MARGIN = 24;            // anchor margin from canvas edges
const SNAP_THRESHOLD = 75;    // px distance to snap to a magnet anchor

// The six magnet anchors. Position is the panel's TOP-LEFT, computed from the
// containing .canvas-wrap rect and the measured panel size.
type AnchorId =
  | 'top_left' | 'top_center' | 'top_right'
  | 'bottom_left' | 'bottom_center' | 'bottom_right';

const ANCHORS: AnchorId[] = [
  'top_left', 'top_center', 'top_right',
  'bottom_left', 'bottom_center', 'bottom_right',
];

interface Size { w: number; h: number; }
interface Pt { left: number; top: number; }

// Top-left position for an anchor given container size and panel size.
function anchorPoint(anchor: AnchorId, c: Size, p: Size): Pt {
  const top = anchor.startsWith('top') ? MARGIN : Math.max(MARGIN, c.h - p.h - MARGIN);
  let left: number;
  if (anchor.endsWith('left')) left = MARGIN;
  else if (anchor.endsWith('right')) left = Math.max(MARGIN, c.w - p.w - MARGIN);
  else left = Math.max(MARGIN, (c.w - p.w) / 2);
  return { left, top };
}

// Floating, draggable tab edge parented over the canvas (absolute inside .canvas-wrap).
export function TabEdge(): JSX.Element {
  const tabs = useEditorStore((s) => s.tabs);
  const lang = useEditorStore((s) => s.settings.language);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const newTab = useEditorStore((s) => s.newTab);
  const tabEdgePosition = useEditorStore((s) => s.tabEdgePosition);
  const setTabEdgePosition = useEditorStore((s) => s.setTabEdgePosition);

  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pt | null>(null);
  // While dragging: the free position (top-left in container coords), plus the
  // anchor we'd snap to if released now (for the snap-pill hint), or null.
  const [drag, setDrag] = useState<{ free: Pt; snap: AnchorId | null } | null>(null);

  // Resolve the docked position from the persisted anchor whenever layout or the
  // persisted anchor changes (and we're not mid-drag).
  const layout = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent) return;
    const c: Size = { w: parent.clientWidth, h: parent.clientHeight };
    const p: Size = { w: el.offsetWidth, h: el.offsetHeight || PANEL_HEIGHT };
    const a = (ANCHORS.includes(tabEdgePosition.anchor as AnchorId)
      ? (tabEdgePosition.anchor as AnchorId)
      : 'bottom_center');
    const base = anchorPoint(a, c, p);
    setPos({ left: base.left + tabEdgePosition.dx, top: base.top + tabEdgePosition.dy });
  }, [tabEdgePosition.anchor, tabEdgePosition.dx, tabEdgePosition.dy]);

  useLayoutEffect(() => {
    if (drag) return;
    layout();
    const onResize = () => layout();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [layout, drag, tabs.length]);

  // Find the nearest anchor whose top-left is within SNAP_THRESHOLD of `free`.
  const nearestAnchor = (free: Pt, c: Size, p: Size): AnchorId | null => {
    let best: AnchorId | null = null;
    let bestD = SNAP_THRESHOLD;
    for (const a of ANCHORS) {
      const ap = anchorPoint(a, c, p);
      const d = Math.hypot(ap.left - free.left, ap.top - free.top);
      if (d <= bestD) { bestD = d; best = a; }
    }
    return best;
  };

  // Grip drag: reposition the panel; on release, snap to the nearest magnet anchor.
  const onGripDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = panelRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const startPos = pos ?? { left: 0, top: 0 };
    // Offset of pointer within the panel at grab time.
    const grabDX = e.clientX - parentRect.left - startPos.left;
    const grabDY = e.clientY - parentRect.top - startPos.top;
    const c: Size = { w: parent.clientWidth, h: parent.clientHeight };
    const p: Size = { w: el.offsetWidth, h: el.offsetHeight || PANEL_HEIGHT };

    const move = (ev: PointerEvent) => {
      let left = ev.clientX - parentRect.left - grabDX;
      let top = ev.clientY - parentRect.top - grabDY;
      // Clamp to keep the panel visible inside the canvas.
      left = Math.max(0, Math.min(left, c.w - p.w));
      top = Math.max(0, Math.min(top, c.h - p.h));
      const free = { left, top };
      setDrag({ free, snap: nearestAnchor(free, c, p) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      let left = ev.clientX - parentRect.left - grabDX;
      let top = ev.clientY - parentRect.top - grabDY;
      left = Math.max(0, Math.min(left, c.w - p.w));
      top = Math.max(0, Math.min(top, c.h - p.h));
      const free = { left, top };
      const snap = nearestAnchor(free, c, p);
      const anchor: AnchorId = snap ?? 'bottom_center';
      // Persist offset relative to the chosen anchor (0,0 when snapped exactly).
      const ap = anchorPoint(anchor, c, p);
      const dx = snap ? 0 : Math.round(free.left - ap.left);
      const dy = snap ? 0 : Math.round(free.top - ap.top);
      setDrag(null);
      setTabEdgePosition({ anchor, dx, dy });
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  };

  // Snap-pill hint position (128×38) centered on the candidate anchor's panel box.
  const snapPill = (() => {
    if (!drag || !drag.snap) return null;
    const el = panelRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return null;
    const c: Size = { w: parent.clientWidth, h: parent.clientHeight };
    const p: Size = { w: el.offsetWidth, h: el.offsetHeight || PANEL_HEIGHT };
    const ap = anchorPoint(drag.snap, c, p);
    return {
      left: ap.left + p.w / 2 - 64,
      top: ap.top + p.h / 2 - 19,
    };
  })();

  const current: Pt = drag ? drag.free : (pos ?? { left: MARGIN, top: MARGIN });

  return (
    <>
      {snapPill ? (
        <div className="tab-snap-pill" style={{ left: snapPill.left, top: snapPill.top }} aria-hidden />
      ) : null}
      <div
        ref={panelRef}
        className={'tab-edge' + (drag ? ' tab-edge-dragging' : '')}
        style={{ left: current.left, top: current.top, visibility: pos ? 'visible' : 'hidden' }}
        role="tablist"
      >
        <div
          className="tab-edge-grip"
          title="Drag to move"
          onPointerDown={onGripDown}
        >
          <span className="tab-grip-dots">
            <i /><i /><i /><i /><i /><i />
          </span>
        </div>

        <button
          type="button"
          className="tab-edge-plus"
          title={t('new_tab', lang)}
          aria-label={t('new_tab', lang)}
          onClick={newTab}
        >
          <svg width="14" height="14" viewBox="0 0 22 22" aria-hidden focusable="false">
            <path d="M11 5 V17 M5 11 H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        <div className="tab-edge-chips">
          {tabs.map((tab) => (
            <TabChip
              key={tab.id}
              id={tab.id}
              name={tab.name}
              active={tab.id === activeTabId}
              dirty={tab.dirty}
            />
          ))}
        </div>
      </div>
    </>
  );
}
