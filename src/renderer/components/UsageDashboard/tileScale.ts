/**
 * Tile zoom for the Usage Dashboard's card grids.
 *
 * Both grids are `auto-fill` grids over a minimum column width, so the one
 * number that decides how big a tile is - and therefore how much of an agent
 * name survives - is that floor. The scale multiplies it: `+` widens the tiles
 * and drops a column, `-` narrows them and gains one, `0` returns to the
 * shipped default. Nothing else scales, which is the point. Zooming the type
 * along with the tile would leave exactly as much of the name truncated as
 * before, just larger.
 *
 * The chosen size is persisted per grid: the Agents tab and the Groups tab
 * start from very different floors and answer different questions, so a user
 * who widens one has said nothing about the other.
 *
 * `useScalePreference` owns the clamping, rounding, and storage handling, and
 * `useScaleShortcuts` binds the keys.
 */

import type { ScaleRange } from '../../hooks/ui/useScalePreference';

/**
 * Half size to nearly double, in tenths.
 *
 * The floor stops short of the point where a tile can no longer hold its stat
 * row, and the ceiling short of where a grid on a wide window would render a
 * single column.
 */
export const TILE_SCALE_RANGE: ScaleRange = { min: 0.7, max: 1.8, step: 0.1, initial: 1 };

export const AGENT_TILE_SCALE_KEY = 'usageDashboard.agentTileScale';
export const GROUP_TILE_SCALE_KEY = 'usageDashboard.groupTileScale';

/**
 * Unscaled column floor for an agent tile.
 *
 * The name is what this width is spent on. At the old 220px an ordinary agent
 * name truncated after about ten characters even though the tile had room, so
 * the default is wider and the title now owns its whole row.
 */
export const AGENT_TILE_MIN_WIDTH = 260;

/**
 * Unscaled column floor for a group tile.
 *
 * Well clear of the agent floor: a group tile is larger than the agents it
 * contains, and it carries four stats whose values are the long ones - "142h
 * 5m", "220.7M", "$187.18" - so the width buys legible numbers rather than
 * whitespace. Trading a column for extra rows is the right way round here: the
 * grid scrolls vertically, so a row costs nothing a clipped value does not.
 */
export const GROUP_TILE_MIN_WIDTH = 440;

/** `grid-template-columns` for an auto-fill tile grid at the given zoom. */
export function tileGridColumns(minWidth: number, scale: number): string {
	return `repeat(auto-fill, minmax(${Math.round(minWidth * scale)}px, 1fr))`;
}
