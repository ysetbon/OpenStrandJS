import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { isRTL, t } from './i18n';
import { TabChip } from './TabChip';
import './tabEdge.css';

// OSS constants (tab_bar_widget.py).
const PANEL_HEIGHT = 53;       // TAB_EDGE_HEIGHT
const MARGIN = 24;             // ANCHOR_MARGIN: gap from canvas edges at an anchor
const SNAP_THRESHOLD = 75;     // px distance to snap to a magnet anchor
const SNAP_W = 128;            // SNAP_MARKER_WIDTH
const SNAP_H = 38;             // SNAP_MARKER_HEIGHT

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

// Top-left position for an anchor given container size and panel size. RAW math,
// mirroring OSS _anchor_positions exactly (no MARGIN floor; integer-floor center);
// the resolved position is clamped into the canvas separately, like OSS reposition.
function anchorPoint(anchor: AnchorId, c: Size, p: Size): Pt {
  const top = anchor.startsWith('top') ? MARGIN : (c.h - p.h - MARGIN);
  let left: number;
  if (anchor.endsWith('left')) left = MARGIN;
  else if (anchor.endsWith('right')) left = c.w - p.w - MARGIN;
  else left = Math.floor((c.w - p.w) / 2);
  return { left, top };
}

// Clamp a top-left so the panel stays inside the canvas (OSS reposition lines 550-551).
function clampPt(pt: Pt, c: Size, p: Size): Pt {
  return {
    left: Math.max(0, Math.min(pt.left, Math.max(0, c.w - p.w))),
    top: Math.max(0, Math.min(pt.top, Math.max(0, c.h - p.h))),
  };
}

// Floating, draggable tab edge parented over the canvas (absolute inside .canvas-wrap).
export function TabEdge(): JSX.Element {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const newTab = useEditorStore((s) => s.newTab);
  const lang = useEditorStore((s) => s.settings.language);
  const tabEdgePosition = useEditorStore((s) => s.tabEdgePosition);
  const setTabEdgePosition = useEditorStore((s) => s.setTabEdgePosition);
  const rtl = isRTL(lang);

  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pt | null>(null);
  // While dragging: the raw free top-left, the anchor we'd snap to if released now
  // (null when between anchors), and the rendered top-left (locked to the anchor
  // mid-drag when snapping, mirroring OSS self.move(ax,ay)).
  const [drag, setDrag] = useState<{ free: Pt; snap: AnchorId | null; rendered: Pt } | null>(null);

  // Container + panel sizes from the live DOM (panel size is stable mid-drag).
  const measure = (): { c: Size; p: Size } | null => {
    const el = panelRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return null;
    return {
      c: { w: parent.clientWidth, h: parent.clientHeight },
      p: { w: el.offsetWidth, h: el.offsetHeight || PANEL_HEIGHT },
    };
  };

  // Resolve the docked/free position from the persisted model whenever layout or
  // the persisted position changes (and we're not mid-drag).
  const layout = useCallback(() => {
    const m = measure();
    if (!m) return;
    const { c, p } = m;
    const a = tabEdgePosition.anchor;
    if (a && (ANCHORS as string[]).includes(a)) {
      setPos(clampPt(anchorPoint(a as AnchorId, c, p), c, p));
    } else {
      // Free mode: resolve from canvas center ratio (OSS reposition ratio branch).
      const base = { left: tabEdgePosition.cx * c.w - p.w / 2, top: tabEdgePosition.cy * c.h - p.h / 2 };
      setPos(clampPt(base, c, p));
    }
  }, [tabEdgePosition.anchor, tabEdgePosition.cx, tabEdgePosition.cy]);

  useLayoutEffect(() => {
    if (drag) return;
    layout();
    const onResize = () => layout();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [layout, drag, tabs.length]);

  // Nearest anchor whose top-left is within SNAP_THRESHOLD of `free` (OSS magnet).
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

  // Drag start: any press on the panel body begins a move (OSS mousePressEvent),
  // EXCEPT presses that land on a chip or the + button — those own their click.
  const onPanelDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tab-chip, .tab-edge-plus')) return;
    e.preventDefault();
    const m = measure();
    if (!m) return;
    const { c, p } = m;
    const parent = panelRef.current!.offsetParent as HTMLElement;
    const parentRect = parent.getBoundingClientRect();
    // The app renders under a global CSS `zoom`, so getBoundingClientRect (screen
    // px) and clientWidth/offsetWidth (layout px) differ by that factor. Convert
    // pointer coords to LAYOUT px so the drag math matches anchorPoint()/clampPt(),
    // which work in layout px (panel style.left is layout px too).
    const zoom = c.w > 0 ? parentRect.width / c.w : 1;
    const toLayout = (clientX: number, clientY: number): Pt => ({
      left: (clientX - parentRect.left) / zoom,
      top: (clientY - parentRect.top) / zoom,
    });
    const startPos = pos ?? { left: 0, top: 0 };
    const grab = toLayout(e.clientX, e.clientY);
    const grabDX = grab.left - startPos.left;
    const grabDY = grab.top - startPos.top;
    setDrag({ free: startPos, snap: null, rendered: startPos });

    const freeFrom = (ev: PointerEvent): Pt => {
      const pl = toLayout(ev.clientX, ev.clientY);
      return clampPt({ left: pl.left - grabDX, top: pl.top - grabDY }, c, p);
    };

    const move = (ev: PointerEvent) => {
      const free = freeFrom(ev);
      const snap = nearestAnchor(free, c, p);
      const rendered = snap ? clampPt(anchorPoint(snap, c, p), c, p) : free;
      setDrag({ free, snap, rendered });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      const free = freeFrom(ev);
      const snap = nearestAnchor(free, c, p);
      setDrag(null);
      if (snap) {
        setTabEdgePosition({ anchor: snap, cx: tabEdgePosition.cx, cy: tabEdgePosition.cy });
      } else {
        // Free release: persist as a canvas center ratio (OSS _store_ratio).
        setTabEdgePosition({
          anchor: null,
          cx: Math.max(0, Math.min(1, (free.left + p.w / 2) / c.w)),
          cy: Math.max(0, Math.min(1, (free.top + p.h / 2) / c.h)),
        });
      }
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  };

  // While dragging, OSS shows ALL six anchors as ghost dock targets (128×38),
  // highlighting the one the magnet would grab. Build them from the panel boxes.
  const pills = (() => {
    if (!drag) return null;
    const m = measure();
    if (!m) return null;
    const { c, p } = m;
    return ANCHORS.map((a) => {
      const ap = anchorPoint(a, c, p);
      return {
        a,
        left: ap.left + p.w / 2 - SNAP_W / 2,
        top: ap.top + p.h / 2 - SNAP_H / 2,
        active: a === drag.snap,
      };
    });
  })();

  const current: Pt = drag ? drag.rendered : (pos ?? { left: MARGIN, top: MARGIN });

  return (
    <>
      {pills
        ? pills.map((pl) => (
            <div
              key={pl.a}
              className={'tab-snap-pill' + (pl.active ? ' tab-snap-pill-active' : '')}
              style={{ left: pl.left, top: pl.top }}
              aria-hidden
            />
          ))
        : null}
      <div
        ref={panelRef}
        className={'tab-edge' + (drag ? ' tab-edge-dragging' : '')}
        style={{ left: current.left, top: current.top, visibility: pos ? 'visible' : 'hidden' }}
        role="tablist"
        dir={rtl ? 'rtl' : 'ltr'}
        onPointerDown={onPanelDown}
      >
        <div className="tab-edge-grip" aria-hidden /* move handle: cursor only, like OSS */>
          <span className="tab-grip-dots">
            <i /><i /><i /><i /><i /><i />
          </span>
        </div>

        <div className="tab-edge-chips">
          {tabs.map((tab) => (
            <TabChip
              key={tab.id}
              id={tab.id}
              name={tab.name}
              active={tab.id === activeTabId}
              dirty={tab.dirty}
              untitledIndex={tab.untitledIndex}
            />
          ))}
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
      </div>
    </>
  );
}
