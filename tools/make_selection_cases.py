#!/usr/bin/env python3
"""Generate the selection-footprint parity fixtures (fixtures/selection/*.json +
manifest.json): one small scene per end-cap / side-line / circle / mask case,
each naming the layer to hover and the mode. Consumed by
tools/oss_selection_capture.py (the OSS side) and tools/selection_parity.mjs
(the OSSJS side + report). Re-run after editing a case."""
import json, os, copy

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'fixtures', 'selection')
os.makedirs(OUT, exist_ok=True)

BLACK = {"r": 0, "g": 0, "b": 0, "a": 255}
CLEAR = {"r": 0, "g": 0, "b": 0, "a": 0}
PURPLE = {"r": 200, "g": 170, "b": 230, "a": 255}
BEIGE = {"r": 230, "g": 200, "b": 160, "a": 255}
GREEN = {"r": 170, "g": 220, "b": 180, "a": 255}


def P(x, y):
    return {"x": float(x), "y": float(y)}


def strand(name, start, end, cps=None, typ='Strand', color=PURPLE, width=46, sw=4,
           has_circles=(False, False), start_line=True, end_line=True, closed=(False, False),
           mcv=None, start_alpha=255, end_alpha=255, attached_to=None, side=1, set_number=1,
           index=0):
    if cps is None:
        cps = [start, start] if typ != 'AttachedStrand' else [start, start]
    return {
        "type": typ, "index": index, "start": P(**start), "end": P(**end),
        "width": width, "color": color, "stroke_color": BLACK, "stroke_width": sw,
        "width_in_grid_units": None, "elliptical_end_caps": False,
        "has_circles": list(has_circles), "layer_name": name, "set_number": set_number,
        "is_first_strand": typ == 'Strand', "is_start_side": True,
        "start_line_visible": start_line, "end_line_visible": end_line,
        "is_hidden": False, "start_extension_visible": False, "end_extension_visible": False,
        "start_arrow_visible": False, "end_arrow_visible": False, "full_arrow_visible": False,
        "shadow_only": False, "hide_shadow": False, "closed_connections": list(closed),
        "arrow_color": None, "arrow_transparency": 100, "arrow_texture": "none",
        "arrow_shaft_style": "solid", "arrow_head_visible": True, "arrow_casts_shadow": False,
        "knot_connections": {},
        "circle_stroke_color": BLACK,
        "start_circle_stroke_color": dict(BLACK, a=start_alpha),
        "end_circle_stroke_color": dict(BLACK, a=end_alpha),
        "control_points": [P(**cps[0]), P(**cps[1])],
        "control_point_center": None, "control_point_center_locked": False,
        "triangle_has_moved": cps[0] != start, "control_point2_shown": cps[1] != start,
        "control_point2_activated": False,
        **({"attached_to": attached_to, "attachment_side": side} if typ == 'AttachedStrand' else {}),
        **({"manual_circle_visibility": list(mcv)} if mcv is not None else {}),
    }


def masked(name, first, second, index):
    return {
        "type": "MaskedStrand", "index": index, "start": first["start"], "end": first["end"],
        "width": first["width"], "color": first["color"], "stroke_color": BLACK,
        "stroke_width": first["stroke_width"], "has_circles": [False, False],
        "layer_name": name, "set_number": 99, "is_first_strand": False, "is_start_side": True,
        "control_points": [first["start"], first["end"]],
        "first_selected_strand": first["layer_name"], "second_selected_strand": second["layer_name"],
        "deletion_rectangles": [],
    }


def project(strands):
    for i, s in enumerate(strands):
        s["index"] = i
    return {"strands": strands, "groups": {}, "selected_strand_name": None, "locked_layers": [],
            "lock_mode": False, "shadow_enabled": False, "show_control_points": False,
            "shadow_overrides": {}}


cases = []


def add(key, title, what, strands, hover, mode='select', group='Plain strands'):
    cases.append({"key": key, "title": title, "what": what, "hover": hover, "mode": mode, "group": group})
    with open(os.path.join(OUT, key + '.json'), 'w') as f:
        json.dump(project(strands), f, indent=1)


A, B = dict(x=100, y=200), dict(x=420, y=200)

# 1. lone straight strand, both side lines (the default)
add('plain_sidelines', 'Lone strand, side lines at both flat ends',
    'start_line_visible + end_line_visible (default). Footprint = flat-capped body + the two 4px side-line bars just past each end.',
    [strand('1_1', A, B)], '1_1')

# 2. curved
add('plain_curved', 'Lone curved strand, side lines',
    'Same flags on a curved centreline: the side-line bars follow the end tangents.',
    [strand('1_1', dict(x=100, y=260), dict(x=420, y=260), cps=[dict(x=180, y=120), dict(x=340, y=400)])], '1_1')

# 3. no side lines
add('plain_no_sidelines', 'Lone strand, side lines hidden',
    'start_line_visible = end_line_visible = false. Footprint is exactly the flat-capped body: nothing beyond the ends.',
    [strand('1_1', A, B, start_line=False, end_line=False)], '1_1')

# 4. only start side line
add('plain_start_line_only', 'Lone strand, only the start side line',
    'end_line_visible = false. One end has the bar, the other is a bare flat cap.',
    [strand('1_1', A, B, end_line=False)], '1_1')

# 5. wide stroke to exaggerate
add('plain_wide_stroke', 'Lone strand, stroke_width 12',
    'A thick stroke makes the side-line bar (stroke_width thick) and the flat end obvious.',
    [strand('1_1', A, B, sw=12)], '1_1')

# --- attached / circles ---
J = dict(x=380, y=200)
par = strand('1_1', A, J, has_circles=(False, True))
child = strand('1_2', J, dict(x=380, y=420), typ="AttachedStrand",
               has_circles=(True, False), attached_to='1_1', side=1)

add('parent_end_circle', 'Parent strand: junction circle at its end',
    'A child attaches at the end -> OSS draws a cap circle there (radius (w+2sw)/2). Footprint = body + start side line + full end circle.',
    [copy.deepcopy(par), copy.deepcopy(child)], '1_1', group='Attached strands & circles')

add('child_folded_start', 'Attached child: folded start circle + end side line',
    'has_circles[0] with an opaque circle stroke -> full start circle in the footprint; free end keeps its side line (attached starts never get a start side line).',
    [copy.deepcopy(par), copy.deepcopy(child)], '1_2', group='Attached strands & circles')

ch_unf = copy.deepcopy(child); ch_unf['start_circle_stroke_color'] = dict(CLEAR)
add('child_unfolded_start', 'Attached child: UNFOLDED start (transparent circle stroke)',
    'start_circle_stroke_color.a = 0 -> no outer circle, but the inner fill circle (radius w/2) is drawn and belongs to the footprint.',
    [copy.deepcopy(par), ch_unf], '1_2', group='Attached strands & circles')

par_t = copy.deepcopy(par); par_t['end_circle_stroke_color'] = dict(CLEAR)
add('parent_transparent_end_circle', 'Parent: junction circle with transparent stroke',
    'has_circles[1] but end_circle_stroke_color.a = 0 -> OSS draws no circle AND no side line (a circle "occupies" the end). Footprint = flat body only at that end.',
    [par_t, copy.deepcopy(child)], '1_1', group='Attached strands & circles')

ch_hidden = copy.deepcopy(child); ch_hidden['has_circles'] = [False, False]; ch_hidden['manual_circle_visibility'] = [False, None]
add('child_start_circle_hidden', 'Attached child: start circle hidden via layer menu',
    'manual_circle_visibility[0] = false -> no start circle; an attached start never draws a side line either, so that end is a bare flat cap.',
    [copy.deepcopy(par), ch_hidden], '1_2', group='Attached strands & circles')

# chain: 1_1 -> 1_2 -> 1_3 ; hover the middle one (circle at both ends)
mid = strand('1_2', J, dict(x=380, y=400), typ="AttachedStrand", has_circles=(True, True), attached_to='1_1', side=1)
gc = strand('1_3', dict(x=380, y=400), dict(x=120, y=400), typ="AttachedStrand", has_circles=(True, False), attached_to='1_2', side=1)
add('child_both_circles', 'Middle of a chain: circles at both ends',
    'Start = its own attachment circle, end = junction circle for the grandchild. Both full circles join the footprint.',
    [copy.deepcopy(par), mid, gc], '1_2', group='Attached strands & circles')

ch_endc = copy.deepcopy(child); ch_endc['has_circles'] = [True, True]; ch_endc['manual_circle_visibility'] = [None, True]
add('child_end_circle_no_child', 'Attached child: end circle forced on, nothing attached',
    'has_circles[1] via manual override with no junction: draw() only adds the INNER end fill (radius w/2, no stroke ring). OSS puts exactly that inner circle in the footprint.',
    [copy.deepcopy(par), ch_endc], '1_2', group='Attached strands & circles')

# closed connection: 1_1 (A->J) and 1_2 attached at J, ending back at A
cl_par = strand('1_1', A, J, has_circles=(True, True), closed=(True, False), mcv=(True, None))
cl_ch = strand('1_2', J, A, typ="AttachedStrand", cps=[dict(x=380, y=420), dict(x=100, y=420)],
               has_circles=(True, True), closed=(False, True), mcv=(None, True), attached_to='1_1', side=1)
cl_par['knot_connections'] = {"start": {"connected_strand_name": "1_2", "connected_end": "end", "is_closing_strand": False}}
cl_ch['knot_connections'] = {"end": {"connected_strand_name": "1_1", "connected_end": "start", "is_closing_strand": True}}
add('closed_connection', 'Closed knot: closed_connections circles',
    'The child loops back onto the parent start; closed_connections marks both ends. Parent footprint = body + closing circle at start + junction circle at end.',
    [cl_par, cl_ch], '1_1', group='Attached strands & circles')

# --- masks ---
m1 = strand('1_1', dict(x=100, y=220), dict(x=420, y=220))
m2 = strand('2_1', dict(x=260, y=90), dict(x=260, y=350), color=BEIGE, set_number=2)
add('mask_select_hover', 'MaskedStrand hovered in SELECT mode',
    'OSS highlights the drawn mask (stroke layer ∪ fill layer). OSSJS draws nothing for a hovered mask.',
    [copy.deepcopy(m1), copy.deepcopy(m2), masked('1_1_2_1', m1, m2, 2)], '1_1_2_1', group='Masks & mask mode')

add('mask_mode_hover_parent', 'MASK mode: hover the parent of a junction',
    'Mask mode uses the identical footprint (body + circle + side line). Same gap as select mode.',
    [copy.deepcopy(par), copy.deepcopy(child)], '1_1', mode='mask', group='Masks & mask mode')

add('mask_mode_hover_unfolded', 'MASK mode: hover an unfolded child',
    'Inner start fill circle must be part of the yellow area and of the clickable area.',
    [copy.deepcopy(par), copy.deepcopy(ch_unf)], '1_2', mode='mask', group='Masks & mask mode')

with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
    json.dump(cases, f, indent=1)
print(len(cases), 'cases ->', OUT)
