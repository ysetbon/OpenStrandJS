#!/usr/bin/env python
"""Grab the REAL OpenStrand Studio main window to a PNG (offscreen), for a
UI side-by-side vs the OpenStrandJS port.

Renders the full MainWindow widget tree (toolbar + canvas + layer panel + group
panel) via QWidget.grab() — no OS title bar, just the app content, which is what
the browser viewport shows too.

Usage:  python grab_main_window.py <out.png>
Env:    W,H (window size, default 1400x860), THEME (default), LANG (en)
"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_LOGGING_RULES", "*=false")

_HERE = os.path.dirname(os.path.abspath(__file__))
OSS_ROOT = os.environ.get(
    "OSS_ROOT", os.path.abspath(os.path.join(_HERE, "..", "..", "OpenStrandStudio"))
)
sys.path.insert(0, os.path.join(OSS_ROOT, "src"))
os.chdir(OSS_ROOT)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "main_window_grab.png"
    W = int(os.environ.get("W", "1400"))
    H = int(os.environ.get("H", "860"))
    theme = os.environ.get("THEME")   # only re-apply if explicitly requested
    lang = os.environ.get("LANG")

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    from PyQt5.QtWidgets import QApplication
    from main_window import MainWindow

    app = QApplication.instance() or QApplication(sys.argv)
    w = MainWindow()

    for meth, arg in (("apply_theme", theme), ("set_language", lang)):
        if not arg:
            continue
        try:
            if hasattr(w, meth):
                getattr(w, meth)(arg)
        except Exception as e:  # noqa: BLE001
            print(f"warn: {meth}({arg!r}) failed: {e}")

    w.resize(W, H)
    w.show()
    for _ in range(3):
        app.processEvents()
    # offscreen show() collapses to the size hint; force the size after show and
    # let the splitter/layout settle before grabbing.
    w.setFixedSize(W, H)
    for _ in range(5):
        app.processEvents()

    pm = w.grab()
    ok = pm.save(out)
    print(f"saved={ok} path={out} size={pm.width()}x{pm.height()} theme={theme} lang={lang}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
