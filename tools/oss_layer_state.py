#!/usr/bin/env python
"""Dump the ORIGINAL OpenStrand Studio Layer-State data for a fixture, so it can be
compared against the JS editor's "State" dialog. Loads the fixture through OSS's own
save_load_manager + apply_loaded_strands (so parent/attached/knot wiring is real),
then prints get_layer_connections() (the dialog's connection graph) plus order,
masked_layers, positions and selected_strand as JSON.

Usage: python tools/oss_layer_state.py <fixture.json>
Run with the OSS env: ../OpenStrandStudio/src/build_env/Scripts/python.exe
"""
import os
import sys
import json

OSS_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "OpenStrandStudio", "src"))
sys.path.insert(0, OSS_ROOT)
sys.path.insert(0, os.path.join(OSS_ROOT, "json_to_png_exporter"))


def main():
    if len(sys.argv) != 2:
        print("usage: oss_layer_state.py <fixture.json>", file=sys.stderr)
        return 2
    in_json = os.path.abspath(sys.argv[1])

    os.chdir(OSS_ROOT)
    from PyQt5.QtWidgets import QApplication
    from main_window import MainWindow
    from save_load_manager import load_strands, apply_loaded_strands
    from masked_strand import MaskedStrand
    from layer_state_manager import LayerStateManager

    app = QApplication.instance() or QApplication(sys.argv)
    main_window = MainWindow()
    canvas = main_window.canvas
    main_window.hide()
    canvas.hide()
    if hasattr(canvas, "select_mode"):
        canvas.current_mode = canvas.select_mode

    with open(in_json) as f:
        data = json.load(f)

    # Handle the OpenStrandStudioHistory wrapper like reference_render.py.
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

    lsm = LayerStateManager(canvas)
    lsm.movement_in_progress = False
    conns = lsm.get_layer_connections(canvas.strands)

    def pos(s):
        return [round(s.start.x()), round(s.start.y()), round(s.end.x()), round(s.end.y())]

    out = {
        "order": [s.layer_name for s in canvas.strands],
        "connections": conns,
        "masked_layers": [s.layer_name for s in canvas.strands if isinstance(s, MaskedStrand)],
        "positions": {s.layer_name: pos(s) for s in canvas.strands},
        "selected_strand": selected_strand_name,
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
