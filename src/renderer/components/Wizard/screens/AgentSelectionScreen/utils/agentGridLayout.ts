/**
 * How the provider tiles are laid out: a centered block that wraps, or a
 * horizontally scrolling strip.
 *
 * The screen shows every supported provider by default, and that list is long
 * enough that a wrapping block would push the Continue button below the fold -
 * hence the strip. The moment the user filters down to what is installed, the
 * strip stops earning its keep: a handful of tiles pinned to the left edge of a
 * wide row reads as a layout that forgot to reflow. So a set small enough to
 * fit in two rows goes back to the wrapping block, centered.
 *
 * Rows are BALANCED rather than filled left to right. Five tiles across a
 * four-wide row would draw 4 + 1, which looks like a mistake; splitting them
 * 3 + 2 reads as a deliberate arrangement.
 */

/** Tile width, matching `w-[220px]` in `AgentTileButton`. */
export const AGENT_TILE_WIDTH_PX = 220;

/** Gap between tiles, matching `gap-4` on the container. */
export const AGENT_TILE_GAP_PX = 16;

/**
 * Widest the tiles are allowed to spread, matching the strip's `max-w-5xl`.
 *
 * Without this cap a maximized wizard would draw eight tiles in one row while
 * the strip beside it stays 1024px wide, so flipping the filter would change
 * the width of the whole block as well as its shape.
 */
export const AGENT_GRID_MAX_WIDTH_PX = 1024;

/** Rows that fit above the Continue button. */
export const AGENT_GRID_MAX_ROWS = 2;

/** Columns assumed before the container reports a width (first frame, jsdom). */
export const AGENT_GRID_FALLBACK_COLUMNS = 4;

export interface AgentGridLayout {
	/** `wrap` for a centered block, `strip` for the scrolling single row. */
	mode: 'wrap' | 'strip';
	/**
	 * Tiles per row, which is also what up/down arrow movement steps by. In strip
	 * mode this is the whole tile count, so vertical movement has nowhere to go.
	 */
	columns: number;
	/** Width cap that forces the wrap, in pixels. Undefined in strip mode. */
	maxWidthPx: number | undefined;
}

/** How many tiles fit across the available width, capped at the strip's width. */
export function agentTilesPerRow(containerWidth: number): number {
	if (containerWidth <= 0) return AGENT_GRID_FALLBACK_COLUMNS;
	const usable = Math.min(containerWidth, AGENT_GRID_MAX_WIDTH_PX);
	const perRow = Math.floor(
		(usable + AGENT_TILE_GAP_PX) / (AGENT_TILE_WIDTH_PX + AGENT_TILE_GAP_PX)
	);
	return Math.max(1, perRow);
}

export function resolveAgentGridLayout(tileCount: number, containerWidth: number): AgentGridLayout {
	const perRow = agentTilesPerRow(containerWidth);

	if (tileCount > perRow * AGENT_GRID_MAX_ROWS) {
		return { mode: 'strip', columns: Math.max(1, tileCount), maxWidthPx: undefined };
	}

	const columns =
		tileCount <= perRow
			? Math.max(1, tileCount)
			: Math.min(perRow, Math.ceil(tileCount / AGENT_GRID_MAX_ROWS));

	return {
		mode: 'wrap',
		columns,
		maxWidthPx: columns * AGENT_TILE_WIDTH_PX + (columns - 1) * AGENT_TILE_GAP_PX,
	};
}
