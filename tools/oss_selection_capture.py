#!/usr/bin/env python3
"""OSS side of the selection-footprint parity harness (tools/selection_parity.mjs).

Renders one fixtures/selection case through the REAL OpenStrand Studio (PyQt5,
offscreen) and writes:
  <out>/oss_hover.png  strands + the exact select/mask-mode hover overlay
                       (select_mode.draw / mask_mode.draw), supersample 1
  <out>/oss_hit.png    hit map: for every pixel of the crop rect, the layer that
                       selection_utils.find_strands_at_point() returns first
                       (topmost), colour-coded per layer
  <out>/meta.json      geometry (image size, offsets, crop rect, curve params,
                       layer colours) the JS side renders at

Usage: python tools/oss_selection_capture.py <case.json> <hover_layer> <select|mask> <out_dir>
Env:   OSS_ROOT  the OpenStrandStudio checkout (default ../OpenStrandStudio)
       QT_QPA_PLATFORM defaults to offscreen
"""
import os, sys, json
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_LOGGING_RULES", "*=false")
_HERE = os.path.dirname(os.path.abspath(__file__))
OSS_ROOT = os.environ.get("OSS_ROOT", os.path.abspath(os.path.join(_HERE, "..", "..", "OpenStrandStudio")))
sys.path.insert(0, os.path.join(OSS_ROOT, "src"))
sys.path.insert(0, os.path.join(OSS_ROOT, "json_to_png_exporter"))

HIT_COLORS = [(230, 60, 60), (60, 120, 230), (60, 180, 90), (230, 160, 40), (160, 60, 200), (40, 190, 190)]
STEP = 1


def main():
    in_json, hover_layer, mode, out_dir = sys.argv[1:5]
    in_json = os.path.abspath(in_json); out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    os.chdir(OSS_ROOT)
    from PyQt5.QtWidgets import QApplication
    from PyQt5.QtGui import QImage, QPainter, QColor
    from PyQt5.QtCore import QSize, QPointF
    from main_window import MainWindow
    from save_load_manager import load_strands, apply_loaded_strands
    from attached_strand import AttachedStrand
    from render_utils import RenderUtils
    from export_json_to_image import calculate_bounds
    from selection_utils import find_strands_at_point

    app = QApplication.instance() or QApplication(sys.argv)
    mw = MainWindow(); canvas = mw.canvas; mw.hide(); canvas.hide()
    canvas.current_mode = canvas.select_mode
    res = load_strands(os.path.abspath(in_json), canvas)
    strands, groups, _sel, _ll, _lm, shadow_enabled, show_cp, overrides = res
    apply_loaded_strands(canvas, strands, groups, overrides)
    canvas.show_grid = False
    canvas.show_control_points = False
    canvas.shadow_enabled = False
    for s in canvas.strands:
        s.should_draw_shadow = False
    if hasattr(canvas, "is_attaching"): canvas.is_attaching = False
    if hasattr(canvas, "attach_preview_strand"): canvas.attach_preview_strand = None

    min_x, min_y, max_x, max_y = calculate_bounds(canvas)
    padding = 200
    W = max(int(max_x - min_x + 2 * padding), 800)
    H = max(int(max_y - min_y + 2 * padding), 600)
    xo, yo = padding - min_x, padding - min_y
    canvas.zoom_factor = 1.0; canvas.pan_offset_x = 0; canvas.pan_offset_y = 0
    canvas.setFixedSize(W, H)

    img = QImage(QSize(W, H), QImage.Format_RGBA8888)
    img.fill(QColor(255, 255, 255, 255))
    p = QPainter(img)
    RenderUtils.setup_painter(p, enable_high_quality=True)
    p.translate(xo, yo)
    for s in canvas.strands:
        if hasattr(s, "_already_drawn_this_frame"): del s._already_drawn_this_frame
    for s in canvas.strands:
        if not hasattr(s, "canvas"): s.canvas = canvas
        if isinstance(s, AttachedStrand) and getattr(s, "parent_strand", None):
            par = s.parent_strand
            if not hasattr(par, "_already_drawn_this_frame"):
                par._already_drawn_this_frame = True
                if not hasattr(par, "canvas"): par.canvas = canvas
                par.draw(p, skip_painter_setup=True)
        s.draw(p, skip_painter_setup=True)

    hov = next((s for s in canvas.strands if getattr(s, "layer_name", None) == hover_layer), None)
    if mode == "mask":
        from mask_mode import MaskMode
        mm = getattr(canvas, "mask_mode", None) or MaskMode(canvas, None)
        mm.canvas = canvas; mm.selected_strands = []; mm.hovered_strand = hov
        mm.draw(p)
        include_masked = False
    else:
        from select_mode import SelectMode
        sm = getattr(canvas, "select_mode", None) or SelectMode(canvas)
        sm.canvas = canvas; canvas.show_hover_highlights = True; sm.hovered_strand = hov
        sm.draw(p)
        include_masked = True
    p.end()
    img.save(os.path.join(out_dir, "oss_hover.png"), "PNG")

    # crop rect (pixel space) = world bounds + margin
    m = 30
    cx0, cy0 = int(min_x - m + xo), int(min_y - m + yo)
    cx1, cy1 = int(max_x + m + xo), int(max_y + m + yo)
    cx0, cy0 = max(0, cx0), max(0, cy0); cx1, cy1 = min(W, cx1), min(H, cy1)

    # hit map over the crop rect: exactly what a click / hover resolves to in OSS
    names = [s.layer_name for s in canvas.strands]
    hit = QImage(QSize(cx1 - cx0, cy1 - cy0), QImage.Format_RGBA8888)
    hit.fill(QColor(255, 255, 255, 255))
    for py in range(cy0, cy1, STEP):
        for px in range(cx0, cx1, STEP):
            r = find_strands_at_point(canvas.strands, QPointF(px - xo, py - yo), include_masked=include_masked)
            if r:
                i = names.index(r[0][0].layer_name)
                c = HIT_COLORS[i % len(HIT_COLORS)]
                hit.setPixelColor(px - cx0, py - cy0, QColor(*c))
    hit.save(os.path.join(out_dir, "oss_hit.png"), "PNG")

    sample = canvas.strands[0]
    meta = {
        "image_width": W, "image_height": H, "x_offset": xo, "y_offset": yo,
        "crop": [cx0, cy0, cx1, cy1], "layers": names, "hit_colors": HIT_COLORS,
        "curve_params": {
            "base_fraction": float(getattr(sample, "control_point_base_fraction", 0.4)),
            "dist_multiplier": float(getattr(sample, "distance_multiplier", 1.2)),
            "exponent": float(getattr(sample, "curve_response_exponent", 1.5)),
        },
        "hover": hover_layer, "mode": mode,
        "has_circles": {s.layer_name: list(s.has_circles) for s in canvas.strands},
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print("OK", W, H, "crop", meta["crop"])


if __name__ == "__main__":
    sys.exit(main())
