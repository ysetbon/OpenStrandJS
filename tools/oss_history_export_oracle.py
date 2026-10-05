#!/usr/bin/env python
"""
History-export oracle for tools/history_export_check.mjs.

Drives the REAL OpenStrand Studio (headless) through what a user does:
File > Open (MainWindow.load_project, with the file dialog answered), then
optional Undo / Redo clicks, then File > Save's history payload
(UndoRedoManager.export_history_payload). The payload is written as JSON, so the
JS side can be compared against it step by step.

This is what pins down the OSS 2.0 behaviour around keep_masks_on_top (45d6f1f):
load_strands puts the masks above the strands on the canvas, but the step files
keep the file's order, so export_history_payload's save_state sees a different
layer order and records one more step ("captured before exporting the history"),
dropping the redo states, exactly like any other new state.

Usage:
    python oss_history_export_oracle.py <input.json> <out.json> [--ops undo,redo,...] [--bias on|off]

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
    args = list(sys.argv[1:])
    ops = []
    bias = "on"
    if "--bias" in args:
        i = args.index("--bias")
        bias = args[i + 1]
        del args[i:i + 2]
    if "--ops" in args:
        i = args.index("--ops")
        ops = [o for o in args[i + 1].split(",") if o]
        del args[i:i + 2]
    if len(args) != 2:
        print(__doc__)
        return 2
    in_json, out_json = os.path.abspath(args[0]), os.path.abspath(args[1])
    os.chdir(OSS_ROOT)

    from PyQt5.QtWidgets import QApplication, QFileDialog
    from main_window import MainWindow

    app = QApplication.instance() or QApplication(sys.argv)
    win = MainWindow()
    win.hide()
    win.canvas.enable_curvature_bias_control = (bias == "on")

    # File > Open with the dialog answered.
    QFileDialog.getOpenFileName = staticmethod(lambda *a, **k: (in_json, "JSON Files (*.json)"))
    win.load_project()
    app.processEvents()

    undo_mgr = win.layer_panel.undo_redo_manager
    for op in ops:
        if op == "undo":
            undo_mgr.undo()
        elif op == "redo":
            undo_mgr.redo()
        else:
            sys.exit("oracle: unknown op %r" % op)
        app.processEvents()

    payload = undo_mgr.export_history_payload()
    if payload is None:
        sys.exit("oracle: export_history_payload failed")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
