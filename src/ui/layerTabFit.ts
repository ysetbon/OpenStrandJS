// How wide the layer-list column has to be for the Strands / Masks switch.
//
// OSS 2.0 (layer_panel.py, commits 9fc7cbd / 21ae6b0) builds the switch as two
// QPushButtons with equal stretch in a QHBoxLayout with no spacing, a 1px border
// and NO side padding (_layer_tab_half_style). Nothing shrinks, elides or wraps
// a label: each half is simply half the list column, and the column is
// LAYER_LIST_BUTTON_WIDTH 146 + the scrollbar extent + 2 (list_column_min_width;
// 158px offscreen, 165px with Windows' 17px scrollbar), so a half is ~79px. What
// keeps every language inside is that geometry, and OSS pins it with
// tests/test_layer_tab_switch.py::test_labels_fit_the_panel, run for every
// language:
//
//     need = QFontMetrics(half.font()).horizontalAdvance(half.text())
//     assert need <= half.width() - 4
//
// i.e. a label clears its half's border box by 4px (the 1px border and 1px of
// air on each side).
//
// The port's list column is narrower than OSS's because its layer buttons are
// 132px, not 146 (App.tsx, "sized to its widest content"). The switch is content
// of that column too, so the column is never narrower than two halves that each
// hold the widest label of ANY language with OSS's 4px — measured once, in the
// halves' own font, so the geometry is the same in every language, as in OSS.
// With the fonts of a stock Linux / Chromium that is Japanese "ストランド"
// (~72px bold 14px): 2 x 76 = 152, against the 146 the layer buttons need.

import { STRINGS } from './translations';

// OSS test_labels_fit_the_panel: need <= half.width() - 4.
export const TAB_LABEL_CLEARANCE = 4;

const TAB_KEYS = ['layer_tab_strands', 'layer_tab_masks'] as const;

let widest: number | null = null;

// Widest Strands / Masks label of every language, in CSS px, measured in a
// hidden half (same element, class and therefore font as the real ones).
export function widestTabLabel(): number {
  if (widest != null) return widest;
  if (typeof document === 'undefined' || !document.body) return 0;
  const probe = document.createElement('button');
  probe.type = 'button';
  probe.className = 'lc-tab pressed';
  probe.setAttribute('aria-hidden', 'true');
  probe.tabIndex = -1;
  probe.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;width:auto;flex:none;';
  const text = document.createElement('span');
  probe.appendChild(text);
  document.body.appendChild(probe);
  let w = 0;
  try {
    for (const key of TAB_KEYS) {
      for (const label of Object.values(STRINGS[key] ?? {})) {
        if (!label) continue;
        text.textContent = label;
        w = Math.max(w, text.getBoundingClientRect().width);
      }
    }
  } finally {
    probe.remove();
  }
  widest = w;
  return w;
}

// Narrowest list column that gives both halves the widest label plus OSS's
// clearance, in whole pixels.
export function tabRowMinWidth(): number {
  const w = widestTabLabel();
  return w > 0 ? 2 * Math.ceil(w + TAB_LABEL_CLEARANCE) : 0;
}
