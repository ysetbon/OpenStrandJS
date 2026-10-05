#!/usr/bin/env python
"""
Save-format oracle for the OpenStrandJS save/load parity check.

Drives the REAL OpenStrand Studio (headless) through its own load -> save path:
the input is a project-state dict (or an OpenStrandStudioHistory file, whose
current step is used), it is put on the canvas exactly the way OpenStrand Studio
does it, and the resulting canvas is serialized with serialize_project_state —
the dict save_state records for that canvas. A bare project state goes through
MainWindow.load_project's snapshot branch (load_strands, which keeps the masks on
top since 2.0, + apply_loaded_strands); a history file's step goes through
UndoRedoManager.import_history_payload / _load_state, the path every undo, redo
and history open takes (load_strands only). tools/saveload_check.mjs diffs the
JS serializer against it key for key.

Usage:
    python oss_save_oracle.py <input.json> <out.json> [--bias on|off] [--step N]
                              [--state-log out.txt]

--state-log also writes the text MainWindow.show_layer_state_log would show for
the loaded drawing (LayerStateManager.save_current_state + the English labels).

Requires PyQt5 + the OpenStrandStudio sources (OSS_ROOT, default ../../OpenStrandStudio).
"""
import json
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_LOGGING_RULES", "*=false")

_HERE = os.path.dirname(os.path.abspath(__file__))
OSS_ROOT = os.environ.get(
    "OSS_ROOT",
    os.path.abspath(os.path.join(_HERE, "..", "..", "OpenStrandStudio")),
)
sys.path.insert(0, os.path.join(OSS_ROOT, "src"))


def main():
    args = [a for a in sys.argv[1:]]
    bias = "on"
    step = None
    if "--bias" in args:
        i = args.index("--bias")
        bias = args[i + 1]
        del args[i:i + 2]
    if "--step" in args:
        i = args.index("--step")
        step = int(args[i + 1])
        del args[i:i + 2]
    state_log = None
    if "--state-log" in args:
        i = args.index("--state-log")
        state_log = os.path.abspath(args[i + 1])
        del args[i:i + 2]
    if len(args) != 2:
        print(__doc__)
        return 2
    in_json, out_json = os.path.abspath(args[0]), os.path.abspath(args[1])
    os.chdir(OSS_ROOT)

    from PyQt5.QtWidgets import QApplication
    from main_window import MainWindow
    from save_load_manager import (
        load_strands_from_data, _with_masks_on_top, apply_loaded_strands, serialize_project_state,
        SafeJSONEncoder,
    )

    app = QApplication.instance() or QApplication(sys.argv)
    win = MainWindow()
    win.hide()
    canvas = win.canvas
    canvas.enable_curvature_bias_control = (bias == "on")

    with open(in_json) as f:
        data = json.load(f)
    if data.get("type") == "OpenStrandStudioHistory":
        states = sorted(
            (s for s in data.get("states", []) if isinstance(s, dict)
             and isinstance(s.get("step"), int) and s.get("data") is not None),
            key=lambda s: s["step"])
        if not states:
            sys.exit("oracle: history file has no states")
        if step is None:
            # import_history_payload: min(saved current_step, steps recreated),
            # taken by source step number.
            step = min(data.get("current_step", len(states)), len(states))
        state = next((s["data"] for s in states if s["step"] == step), None)
        if state is None:
            sys.exit("oracle: step %s not in file (steps %s)" % (step, [s["step"] for s in states]))
        # UndoRedoManager._load_state, through import_history_payload with the
        # requested step as the current one (the temp state files are the
        # file's steps, renumbered 1..n in order, as import does).
        undo_mgr = win.layer_panel.undo_redo_manager
        position = [s["step"] for s in states].index(step) + 1
        payload = {"type": "OpenStrandStudioHistory", "version": 1,
                   "current_step": position, "max_step": len(states),
                   "states": [{"step": i + 1, "data": s["data"]} for i, s in enumerate(states)]}
        if not undo_mgr.import_history_payload(payload):
            sys.exit("oracle: import_history_payload failed")
        # _load_state keeps the canvas's CURRENT shadow toggle (undo/redo must
        # not flip it), and load_project turns it off before importing. The JS
        # port keeps the state's own value, a known separate difference, so the
        # state's value is what is compared here.
        canvas.shadow_enabled = bool(state.get("shadow_enabled", True))
    else:
        state = data
        # MainWindow.load_project, snapshot branch: load_strands (masks on top,
        # 45d6f1f) + apply_loaded_strands.
        (strands, groups, selected_strand_name, locked_layers, lock_mode,
         shadow_enabled, show_control_points, shadow_overrides) = _with_masks_on_top(
            load_strands_from_data(state, canvas))
        canvas.strands = []
        canvas.groups = {}
        canvas.shadow_enabled = shadow_enabled
        gp = canvas.group_layer_manager.group_panel
        gp.clear_all()
        gp.groups_loaded_from_json = False
        apply_loaded_strands(canvas, strands, groups, shadow_overrides)
        canvas.show_control_points = show_control_points
        for s in canvas.strands:
            s.should_draw_shadow = shadow_enabled
        if hasattr(canvas.layer_panel, "apply_lock_state"):
            canvas.layer_panel.apply_lock_state(locked_layers, lock_mode)
        # The selection is restored by the undo manager's _load_state, not by
        # the snapshot branch; mirror what a saved file carries by selecting it.
        canvas.selected_strand = None
        for s in canvas.strands:
            if s.layer_name == selected_strand_name:
                canvas.selected_strand = s
                break

    out = serialize_project_state(canvas.strands, win.group_layer_manager.get_group_data(), canvas)

    if state_log:
        lsm = win.layer_state_manager
        lsm.save_current_state()
        _ = win.translations
        text = f"""
{_['current_layer_state']}:

{_['order']}:
{lsm.getOrder()}

{_['connections']}:
{lsm.getConnections()}

{_['masked_layers']}:
{lsm.getMaskedLayers()}

{_['colors']}:
{lsm.getColors()}

{_['positions']}:
{lsm.getPositions()}

{_['selected_strand']}:
{lsm.getSelectedStrand()}

{_['newest_strand']}:
{lsm.getNewestStrand()}

{_['newest_layer']}:
{lsm.getNewestLayer()}
"""
        with open(state_log, "w", encoding="utf-8") as f:
            f.write(text)
        with open(state_log + ".json", "w", encoding="utf-8") as f:
            json.dump(lsm.layer_state, f, indent=2, cls=SafeJSONEncoder)
    with open(out_json, "w") as f:
        json.dump(out, f, indent=2, cls=SafeJSONEncoder)
    print("wrote", out_json, "strands", len(out["strands"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
