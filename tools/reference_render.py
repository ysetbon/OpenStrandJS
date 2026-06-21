#!/usr/bin/env python
"""
Reference (ground-truth) renderer for the OpenStrandJS fidelity harness.

This drives the REAL OpenStrand Studio Qt canvas headlessly to render a fixture
JSON to a PNG, and emits a sidecar meta.json describing the exact image
dimensions and content offset.

It deliberately differs from json_to_png_exporter/export_json_to_image.py in one
way: it does NOT auto-crop to non-white pixels. Cropping is content-dependent and
would make two renderers crop differently, defeating a pixel diff. Here the image
size and the content offset are fully determined by the strand bounds, so the JS
renderer can draw into an identically sized canvas at the identical offset and the
diff measures rendering fidelity alone.

Usage:
    python reference_render.py <input.json> <out.png> <out_meta.json>

Requires a Python with PyQt5 + the OpenStrandStudio sources. By default it locates
the sibling repo at ../OpenStrandStudio relative to this file; override with the
OSS_ROOT environment variable.
"""
import os
import sys
import json

# Render with no display.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_LOGGING_RULES", "*=false")

_HERE = os.path.dirname(os.path.abspath(__file__))
OSS_ROOT = os.environ.get(
    "OSS_ROOT",
    os.path.abspath(os.path.join(_HERE, "..", "..", "OpenStrandStudio")),
)

sys.path.insert(0, os.path.join(OSS_ROOT, "src"))
sys.path.insert(0, os.path.join(OSS_ROOT, "json_to_png_exporter"))


def main():
    if len(sys.argv) != 4:
        print("usage: reference_render.py <input.json> <out.png> <out_meta.json>")
        return 2

    in_json = os.path.abspath(sys.argv[1])
    out_png = os.path.abspath(sys.argv[2])
    out_meta = os.path.abspath(sys.argv[3])
    os.makedirs(os.path.dirname(out_png), exist_ok=True)

    # Some OpenStrandStudio modules load assets relative to the repo root.
    os.chdir(OSS_ROOT)

    from PyQt5.QtWidgets import QApplication
    from PyQt5.QtGui import QImage, QPainter, QColor
    from PyQt5.QtCore import QSize, Qt
    from main_window import MainWindow
    from save_load_manager import load_strands, apply_loaded_strands
    from attached_strand import AttachedStrand
    from render_utils import RenderUtils
    # Reuse the exact bounds calculation the real exporter uses.
    from export_json_to_image import calculate_bounds

    app = QApplication.instance() or QApplication(sys.argv)

    main_window = MainWindow()
    canvas = main_window.canvas
    main_window.hide()
    canvas.hide()

    # Force select mode so no attach/preview indicators are drawn.
    if hasattr(canvas, "select_mode"):
        canvas.current_mode = canvas.select_mode

    # Saved files are usually wrapped in the OpenStrandStudioHistory format
    # (a list of undo/redo states). Extract one step's flat {strands, groups}
    # data and load that, mirroring json_to_png_exporter. OSS_STEP overrides
    # which step to render (default: current_step); early steps are simpler,
    # which is handy for minimal fixtures.
    with open(in_json) as f:
        data = json.load(f)

    if data.get("type") == "OpenStrandStudioHistory":
        states = data.get("states", [])
        step_override = os.environ.get("OSS_STEP")
        target_step = int(step_override) if step_override else data.get("current_step", 1)
        current_data = next((s["data"] for s in states if s["step"] == target_step), None)
        if current_data is None:
            print(f"ERROR: step {target_step} not found in history "
                  f"(steps: {[s['step'] for s in states]})")
            return 1
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
            json.dump(current_data, tmp)
            temp_path = tmp.name
        try:
            load_result = load_strands(temp_path, canvas)
        finally:
            os.unlink(temp_path)
    else:
        load_result = load_strands(in_json, canvas)

    (strands, groups, selected_strand_name, locked_layers, lock_mode,
     shadow_enabled, show_control_points, shadow_overrides) = load_result
    apply_loaded_strands(canvas, strands, groups, shadow_overrides)

    # Enable third control point if any strand uses one (mirrors the exporter).
    for strand in canvas.strands:
        if getattr(strand, "control_point_center", None) is not None:
            canvas.enable_third_control_point = True
            break

    canvas.show_grid = False
    canvas.show_control_points = show_control_points
    canvas.shadow_enabled = shadow_enabled
    if hasattr(canvas, "is_attaching"):
        canvas.is_attaching = False
    if hasattr(canvas, "attach_preview_strand"):
        canvas.attach_preview_strand = None
    for strand in canvas.strands:
        strand.should_draw_shadow = shadow_enabled

    min_x, min_y, max_x, max_y = calculate_bounds(canvas)

    # Image geometry (mirrors json_to_png_exporter.create_image): content plus a
    # fixed padding, with a minimum size, and content placed at (padding, padding).
    padding = 200
    content_w = max_x - min_x
    content_h = max_y - min_y
    image_width = max(int(content_w + 2 * padding), 800)
    image_height = max(int(content_h + 2 * padding), 600)
    x_offset = padding - min_x
    y_offset = padding - min_y

    # Match how the real app paints: zoom=1, pan=0, no grid.
    canvas.zoom_factor = 1.0
    canvas.pan_offset_x = 0
    canvas.pan_offset_y = 0
    canvas.setFixedSize(image_width, image_height)

    # The app renders at supersampling_factor then downsamples (default 2). We do
    # the same so the oracle matches what the user actually sees on screen.
    factor = int(os.environ.get("OSS_SUPERSAMPLE", getattr(canvas, "supersampling_factor", 2)) or 1)
    factor = max(1, factor)

    hi = QImage(QSize(image_width * factor, image_height * factor), QImage.Format_RGBA8888)
    hi.fill(QColor(255, 255, 255, 255))
    painter = QPainter(hi)
    RenderUtils.setup_painter(painter, enable_high_quality=True)
    painter.scale(factor, factor)
    painter.translate(x_offset, y_offset)

    # Replicate strand_drawing_canvas._paintEventInner's draw loop for the simple
    # case (select mode, nothing selected, draw_all_strands=True): draw every
    # strand, pre-drawing an attached strand's parent once for correct z-order.
    for s in canvas.strands:
        if hasattr(s, "_already_drawn_this_frame"):
            del s._already_drawn_this_frame
    for strand in canvas.strands:
        if not hasattr(strand, "canvas"):
            strand.canvas = canvas
        if isinstance(strand, AttachedStrand) and getattr(strand, "parent_strand", None):
            parent = strand.parent_strand
            if not hasattr(parent, "_already_drawn_this_frame"):
                parent._already_drawn_this_frame = True
                if not hasattr(parent, "canvas"):
                    parent.canvas = canvas
                parent.draw(painter, skip_painter_setup=True)
        strand.draw(painter, skip_painter_setup=True)
    painter.end()

    if factor != 1:
        image = hi.scaled(image_width, image_height, Qt.IgnoreAspectRatio, Qt.SmoothTransformation)
    else:
        image = hi
    image.save(out_png, "PNG")
    meta = {
        "fixture": os.path.basename(in_json),
        "image_width": image.width(),
        "image_height": image.height(),
        "min_x": min_x,
        "min_y": min_y,
        "max_x": max_x,
        "max_y": max_y,
        "padding": padding,
        # Content point (cx, cy) maps to pixel (cx + x_offset, cy + y_offset).
        "x_offset": padding - min_x,
        "y_offset": padding - min_y,
        "shadow_enabled": bool(shadow_enabled),
        "show_control_points": bool(show_control_points),
        "num_strands": len(canvas.strands),
    }
    with open(out_meta, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"OK {image.width()}x{image.height()} strands={len(canvas.strands)} -> {out_png}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
