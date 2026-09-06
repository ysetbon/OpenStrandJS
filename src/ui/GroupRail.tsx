// GroupRail — the collapsed form of the layer panel's group column (OSS
// src/group_rail.py, option B3 of docs/group_panel_toggle_feature).
//
// When the user collapses the group column, the Create Group button and the
// group tree give way to this 40px rail: a create tile carrying the language's
// letter for "group" (G in Latin scripts, ק in Hebrew — translation key
// create_group_tile) that runs the normal Create Group flow while the column
// stays collapsed, and one tile per group, in tree order, that expands the
// column again with that group brought into view.
//
// OSS rebuilds its tiles from the group tree's model signals; here the group
// names come straight from the store's `doc.groups`, so every path that adds,
// removes or renames a group is covered the same way. Like OSS, the rail and
// its tiles carry NO tooltips.

import './groupRail.css';

export const RAIL_WIDTH = 40;
export const TILE_WIDTH = 30;
export const CREATE_TILE_HEIGHT = 30;
export const GROUP_TILE_HEIGHT = 24;

// First letter of the group's name, upper-cased; its position in the list if
// the name has no letter or digit to show (OSS GroupRail.tile_label). Python's
// str.isalnum is Unicode-aware, hence \p{L}\p{N} rather than [A-Za-z0-9].
export function tileLabel(name: string, number: number): string {
  for (const ch of String(name).trim()) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase();
  }
  return String(number);
}

export interface GroupRailProps {
  /** Group names in tree order (Object.keys(doc.groups)). */
  groupNames: string[];
  /** The create tile's letter (create_group_tile); empty falls back to G. */
  createLabel: string;
  /** Mirrors the Create Group button's enabled state (off while editing a mask). */
  createEnabled: boolean;
  onCreate: () => void;
  onActivate: (groupName: string) => void;
}

export function GroupRail(props: GroupRailProps): JSX.Element {
  const { groupNames, createLabel, createEnabled, onCreate, onActivate } = props;
  const label = String(createLabel || '').trim() || 'G';
  return (
    <div className="gp-rail" data-testid="group-rail">
      {/* The Create Group button in compact form. */}
      <button
        type="button"
        className="gp-rail-create"
        disabled={!createEnabled}
        onClick={onCreate}
      >
        {label}
      </button>

      {/* One tile per group, in tree order, inside a vertical-only scroller
        * with no visible scrollbar: it would eat 12-16px of a 40px rail and
        * clip the 30px tiles. The wheel still scrolls the column. */}
      <div className="gp-rail-tiles">
        {groupNames.map((name, i) => (
          <button
            type="button"
            key={name}
            className="gp-rail-tile"
            data-group={name}
            tabIndex={-1}
            onClick={() => onActivate(name)}
          >
            {tileLabel(name, i + 1)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default GroupRail;
