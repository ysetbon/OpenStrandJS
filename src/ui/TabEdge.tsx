import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  TAB_EDGE_ANCHORS, tabTitleFor, useEditorStore, type TabEdgeAnchor,
} from '../store/editorStore';
import { isRTL } from './i18n';
import { TabChip } from './TabChip';
import './tabEdge.css';

// OSS tab_bar_widget.DraggableTabEdge: a floating, semi-transparent edge parented
// to the canvas. Layout: [grip 26px][chips… spacing 8][+] with 12px trailing
// margin (mirrored in RTL: [+][chips reversed][grip]). The WHOLE panel drags
// (chips and icon buttons consume their presses); six magnet anchors grab it
// within 75px, otherwise it floats free at a remembered center ratio.
const TAB_EDGE_HEIGHT = 53;
const TAB_WIDTH_SCALE = 1.1;
const ANCHOR_MARGIN = 24;
const SNAP_THRESHOLD = 75;
const SNAP_MARKER_WIDTH = 128;
const SNAP_MARKER_HEIGHT = 38;

interface Size { w: number; h: number; }
interface Pt { x: number; y: number; }

// OSS _anchor_positions: top-left of the edge at each magnet anchor.
function anchorPositions(c: Size, p: Size): Record<TabEdgeAnchor, Pt> {
  const m = ANCHOR_MARGIN;
  const leftX = m;
  const centerX = Math.floor((c.w - p.w) / 2);
  const rightX = c.w - p.w - m;
  const topY = m;
  const bottomY = c.h - p.h - m;
  return {
    top_left: { x: leftX, y: topY },
    top_center: { x: centerX, y: topY },
    top_right: { x: rightX, y: topY },
    bottom_left: { x: leftX, y: bottomY },
    bottom_center: { x: centerX, y: bottomY },
    bottom_right: { x: rightX, y: bottomY },
  };
}

function clampPos(pt: Pt, c: Size, p: Size): Pt {
  return {
    x: Math.max(0, Math.min(pt.x, Math.max(0, c.w - p.w))),
    y: Math.max(0, Math.min(pt.y, Math.max(0, c.h - p.h))),
  };
}

// OSS snap_target_style: per-theme colours of the magnet target pills.
interface SnapStyle { shadow: string; glow: string; fill: string; outer: string; inner: string; }
function snapTargetStyle(theme: string, active: boolean): SnapStyle {
  const rgba = (r: number, g: number, b: number, a: number) => `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
  if (theme === 'dark') {
    return {
      shadow: rgba(0, 0, 0, active ? 105 : 82),
      glow: rgba(255, 255, 255, active ? 42 : 30),
      fill: rgba(255, 255, 255, active ? 34 : 24),
      outer: rgba(235, 235, 235, active ? 175 : 142),
      inner: rgba(235, 235, 235, active ? 152 : 122),
    };
  }
  if (theme === 'light') {
    return {
      shadow: rgba(0, 0, 0, active ? 42 : 32),
      glow: rgba(255, 255, 255, active ? 88 : 68),
      fill: rgba(255, 255, 255, active ? 118 : 92),
      outer: rgba(154, 154, 154, active ? 186 : 150),
      inner: rgba(152, 152, 152, active ? 158 : 126),
    };
  }
  return {
    shadow: rgba(0, 0, 0, active ? 36 : 27),
    glow: rgba(255, 255, 255, active ? 82 : 62),
    fill: rgba(255, 255, 255, active ? 108 : 82),
    outer: rgba(198, 198, 198, active ? 186 : 150),
    inner: rgba(190, 190, 190, active ? 164 : 130),
  };
}

// One magnet target pill (OSS SnapOverlay._draw_snap_target): three soft shadow
// layers, a glow ring, the fill, a solid outer border and a dashed inner pill.
function SnapTarget(props: { cx: number; cy: number; active: boolean; theme: string }): JSX.Element {
  const { cx, cy, active, theme } = props;
  const st = snapTargetStyle(theme, active);
  const w = SNAP_MARKER_WIDTH;
  const h = SNAP_MARKER_HEIGHT;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const radius = Math.min(12, h / 2);
  const shadowLayers: Array<[number, number]> = [[4, 0.34], [2.6, 0.52], [1.2, 0.68]];
  const outerW = active ? 3 : 2.4;
  const inset = 7;
  const innerR = Math.max(1, (h - 2 * inset) / 2);
  return (
    <g>
      {shadowLayers.map(([d, k]) => (
        <rect
          key={d}
          x={x - d} y={y - d} width={w + 2 * d} height={h + 2 * d}
          rx={radius + d} ry={radius + d}
          fill={st.shadow} opacity={k}
        />
      ))}
      <rect x={x - 2} y={y - 2} width={w + 4} height={h + 4} rx={radius + 2} ry={radius + 2} fill={st.glow} />
      <rect x={x} y={y} width={w} height={h} rx={radius} ry={radius} fill={st.fill} />
      <rect
        x={x + outerW / 2} y={y + outerW / 2} width={w - outerW} height={h - outerW}
        rx={Math.max(1, radius - outerW / 2)} ry={Math.max(1, radius - outerW / 2)}
        fill="none" stroke={st.outer} strokeWidth={outerW} strokeLinejoin="round"
      />
      <rect
        x={x + inset} y={y + inset} width={w - 2 * inset} height={h - 2 * inset}
        rx={innerR} ry={innerR}
        fill="none" stroke={st.inner} strokeWidth={active ? 1.7 : 1.45}
        strokeDasharray="4 5" strokeLinecap="round" strokeLinejoin="round"
      />
    </g>
  );
}

export function TabEdge(): JSX.Element {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const newTab = useEditorStore((s) => s.newTab);
  const lang = useEditorStore((s) => s.settings.language);
  const theme = useEditorStore((s) => s.settings.theme);
  const tabEdgePosition = useEditorStore((s) => s.tabEdgePosition);
  const setTabEdgePosition = useEditorStore((s) => s.setTabEdgePosition);
  const rtl = isRTL(lang);

  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pt | null>(null);
  // Container size, refreshed by the ResizeObserver; drives the snap overlay.
  const [container, setContainer] = useState<Size>({ w: 0, h: 0 });
  // Mid-drag: the anchor the magnet is holding (null while floating free).
  const [drag, setDrag] = useState<{ snap: TabEdgeAnchor | null } | null>(null);
  const dragRef = useRef<{ grab: Pt; c: Size; p: Size; snap: TabEdgeAnchor | null } | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);

  const parentOf = (el: HTMLElement | null): HTMLElement | null => (el?.offsetParent as HTMLElement | null) ?? null;

  // OSS rebuild() + reposition(): size the edge (chips at 1.1× their natural
  // width, the panel no wider than the canvas minus 20), then dock it at its
  // anchor or free center ratio.
  const layout = useCallback(() => {
    const el = panelRef.current;
    const parent = parentOf(el);
    if (!el || !parent) return;
    const c: Size = { w: parent.clientWidth, h: parent.clientHeight };
    setContainer(c);

    const chips = Array.from(el.querySelectorAll<HTMLElement>('.tab-chip'));
    el.style.width = '';
    for (const chip of chips) chip.style.minWidth = '';
    const baseW = el.offsetWidth;
    for (const chip of chips) chip.style.minWidth = `${Math.round(chip.offsetWidth * TAB_WIDTH_SCALE)}px`;
    const hintW = el.offsetWidth;
    const maxW = Math.max(120, c.w - 20);
    const w = Math.min(Math.max(Math.round(baseW * TAB_WIDTH_SCALE), hintW), maxW);
    el.style.width = `${w}px`;

    if (dragRef.current) return;   // the pointer owns the position mid-drag
    const p: Size = { w, h: TAB_EDGE_HEIGHT };
    let pt: Pt;
    if (tabEdgePosition.anchor) {
      const anchors = anchorPositions(c, p);
      pt = anchors[tabEdgePosition.anchor] ?? anchors.bottom_center;
    } else if (tabEdgePosition.ratio) {
      const [cx, cy] = tabEdgePosition.ratio;
      pt = { x: Math.trunc(cx * c.w - p.w / 2), y: Math.trunc(cy * c.h - p.h / 2) };
    } else {
      pt = { x: Math.floor((c.w - p.w) / 2), y: c.h - p.h - ANCHOR_MARGIN };
    }
    setPos(clampPos(pt, c, p));
  }, [tabEdgePosition]);

  useLayoutEffect(() => {
    layout();
    const parent = parentOf(panelRef.current);
    if (!parent || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', layout);
      return () => window.removeEventListener('resize', layout);
    }
    const ro = new ResizeObserver(() => setLayoutTick((n) => n + 1));
    ro.observe(parent);
    return () => ro.disconnect();
  }, [layout, tabs, activeTabId, lang, rtl, theme, layoutTick]);

  // Drag the whole edge (OSS mousePressEvent on the panel background).
  const onPanelPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    const parent = parentOf(el);
    if (!el || !parent || !pos) return;
    e.preventDefault();
    const rect = parent.getBoundingClientRect();
    const c: Size = { w: parent.clientWidth, h: parent.clientHeight };
    const p: Size = { w: el.offsetWidth, h: el.offsetHeight || TAB_EDGE_HEIGHT };
    dragRef.current = {
      grab: { x: e.clientX - rect.left - pos.x, y: e.clientY - rect.top - pos.y },
      c, p, snap: null,
    };
    el.setPointerCapture(e.pointerId);
    setDrag({ snap: null });
  };

  const onPanelPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const parent = parentOf(panelRef.current);
    if (!d || !parent) return;
    const rect = parent.getBoundingClientRect();
    const free = clampPos({ x: e.clientX - rect.left - d.grab.x, y: e.clientY - rect.top - d.grab.y }, d.c, d.p);
    // Magnet: the nearest anchor grabs the edge once it is within range.
    const anchors = anchorPositions(d.c, d.p);
    let best: TabEdgeAnchor | null = null;
    let bestD = Infinity;
    for (const name of TAB_EDGE_ANCHORS) {
      const a = anchors[name];
      const dist = Math.hypot(free.x - a.x, free.y - a.y);
      if (dist < bestD) { best = name; bestD = dist; }
    }
    if (best !== null && bestD <= SNAP_THRESHOLD) {
      d.snap = best;
      setPos(anchors[best]);
    } else {
      d.snap = null;
      setPos(free);
    }
    setDrag({ snap: d.snap });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try { panelRef.current?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    setDrag(null);
    if (d.snap) {
      setTabEdgePosition({ anchor: d.snap, ratio: null });
    } else if (pos) {
      const cw = Math.max(1, d.c.w);
      const ch = Math.max(1, d.c.h);
      setTabEdgePosition({ anchor: null, ratio: [(pos.x + d.p.w / 2) / cw, (pos.y + d.p.h / 2) / ch] });
    }
  };

  const chips = tabs.map((tab) => (
    <TabChip
      key={tab.id}
      id={tab.id}
      title={tabTitleFor(tab, lang)}
      active={tab.id === activeTabId}
      dirty={tab.dirty}
      rtl={rtl}
    />
  ));
  const plus = (
    <button
      key="plus"
      type="button"
      className="tab-edge-plus"
      aria-label="New tab"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); newTab(); }}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden focusable="false">
        <path d="M11 5 V17 M5 11 H17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );

  // Snap overlay (OSS SnapOverlay): shown only while dragging, one ghost pill per
  // anchor centered where the edge would sit, the held one highlighted.
  const overlay = (() => {
    if (!drag || !panelRef.current) return null;
    const p: Size = { w: panelRef.current.offsetWidth, h: TAB_EDGE_HEIGHT };
    const anchors = anchorPositions(container, p);
    return (
      <svg className="tab-snap-overlay" width={container.w} height={container.h} aria-hidden>
        {TAB_EDGE_ANCHORS.map((name) => (
          <SnapTarget
            key={name}
            cx={anchors[name].x + p.w / 2}
            cy={anchors[name].y + p.h / 2}
            active={name === drag.snap}
            theme={theme}
          />
        ))}
      </svg>
    );
  })();

  return (
    <>
      {overlay}
      <div
        ref={panelRef}
        className={'tab-edge' + (rtl ? ' tab-edge-rtl' : '') + (drag ? ' tab-edge-dragging' : '')}
        style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}
        role="tablist"
        onPointerDown={onPanelPointerDown}
        onPointerMove={onPanelPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="tab-edge-grip" aria-hidden>
          <span className="tab-grip-dots"><i /><i /><i /><i /><i /><i /></span>
        </div>
        {rtl ? [plus, ...chips.slice().reverse()] : [...chips, plus]}
      </div>
    </>
  );
}
