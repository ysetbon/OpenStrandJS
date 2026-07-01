#!/usr/bin/env python
"""Grab the REAL OpenStrand Studio layer-panel MASK button in three states
(normal / hover / checked-selected) to PNGs, so it can be pixel-diffed against
the OpenStrandJS port's .nlb.nlb-masked button.

Loads a fixture through OSS's own save_load_manager + apply_loaded_strands (which
calls layer_panel.refresh(), building the buttons with their mask border), finds
the NumberedLayerButton for the requested MaskedStrand, and grabs it. Hover is
faked by setting WA_UnderMouse (the QSS :hover pseudo-state reads State_MouseOver
from that); checked via setChecked(True).

Usage: python tools/grab_mask_button.py <fixture.json> <out_dir> [mask_layer_name]
Run with the OSS env: ../OpenStrandStudio/src/build_env/Scripts/python.exe
"""
import os
import sys
import json

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_LOGGING_RULES", "*=false")

OSS_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "OpenStrandStudio", "src"))
sys.path.insert(0, OSS_ROOT)
sys.path.insert(0, os.path.join(OSS_ROOT, "json_to_png_exporter"))


def main():
    if len(sys.argv) < 3:
        print("usage: grab_mask_button.py <fixture.json> <out_dir> [mask_layer_name]", file=sys.stderr)
        return 2
    in_json = os.path.abspath(sys.argv[1])
    out_dir = os.path.abspath(sys.argv[2])
    want_name = sys.argv[3] if len(sys.argv) > 3 else None
    os.makedirs(out_dir, exist_ok=True)

    os.chdir(OSS_ROOT)
    from PyQt5.QtWidgets import QApplication
    from PyQt5.QtCore import Qt
    from main_window import MainWindow
    from save_load_manager import load_strands, apply_loaded_strands
    from masked_strand import MaskedStrand

    app = QApplication.instance() or QApplication(sys.argv)
    main_window = MainWindow()
    canvas = main_window.canvas

    with open(in_json) as f:
        data = json.load(f)
    if data.get("type") == "OpenStrandStudioHistory":
        states = data.get("states", [])
        target_step = data.get("current_step", 1)
        current = next((s["data"] for s in states if s["step"] == target_step), None)
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
            json.dump(current, tmp)
            tmp_path = tmp.name
        try:
            load_result = load_strands(tmp_path, canvas)
        finally:
            os.unlink(tmp_path)
    else:
        load_result = load_strands(in_json, canvas)

    (strands, groups, selected_strand_name, locked_layers, lock_mode,
     shadow_enabled, show_control_points, shadow_overrides) = load_result
    apply_loaded_strands(canvas, strands, groups, shadow_overrides)

    main_window.resize(1400, 860)
    main_window.show()
    for _ in range(5):
        app.processEvents()

    lp = main_window.layer_panel
    # attachable flag == is_deletable (green strip); masks are deletable -> shown.
    if hasattr(lp, "update_layer_button_states"):
        lp.update_layer_button_states()
    for _ in range(3):
        app.processEvents()

    # locate the mask button (by layer_name if given, else first MaskedStrand)
    target_i = None
    for i, s in enumerate(canvas.strands):
        if isinstance(s, MaskedStrand):
            if want_name is None or getattr(s, "layer_name", None) == want_name:
                target_i = i
                break
    if target_i is None:
        print(f"no MaskedStrand named {want_name!r} found; strands="
              f"{[getattr(s,'layer_name',None) for s in canvas.strands]}", file=sys.stderr)
        return 1

    button = lp.layer_buttons[target_i]
    strand = canvas.strands[target_i]
    print(f"mask button: layer={strand.layer_name} size={button.width()}x{button.height()} "
          f"attachable={getattr(button,'attachable',None)} border={getattr(button,'border_color',None)}")

    def grab(name):
        for _ in range(2):
            app.processEvents()
        pm = button.grab()
        ok = pm.save(os.path.join(out_dir, name))
        print(f"  saved {name} ok={ok} {pm.width()}x{pm.height()}")

    # normal
    button.setChecked(False)
    button.setAttribute(Qt.WA_UnderMouse, False)
    button.update_style() if hasattr(button, "update_style") else None
    button.update()
    grab("normal.png")

    # hover: QSS :hover reads State_MouseOver from the real cursor, which a manual
    # grab() can't supply, so force the exact hover appearance instead — the same
    # colour :hover would use, self.color.lighter() (factor 150), keeping the mask
    # border. This reproduces the hovered pixels faithfully (see update_style).
    from PyQt5.QtGui import QColor
    c = button.color
    lc = c.lighter()  # default factor 150 == the :hover rule
    bname = button.border_color.name() if getattr(button, "border_color", None) else "#000000"
    button.setStyleSheet(
        "QPushButton { background-color: rgba(%d, %d, %d, %s); border: 5px solid %s; font-weight: bold; }"
        % (lc.red(), lc.green(), lc.blue(), lc.alpha() / 255, bname)
    )
    button.update()
    grab("hover.png")
    if hasattr(button, "update_style"):
        button.update_style()   # restore

    # checked / selected
    button.setChecked(True)
    if hasattr(button, "update_style"):
        button.update_style()
    button.update()
    grab("selected.png")
    button.setChecked(False)

    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump({"fixture": os.path.basename(in_json), "maskName": strand.layer_name,
                   "size": [button.width(), button.height()]}, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
