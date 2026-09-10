/**
 * How the provider tiles are laid out: a centered block that wraps, or a
 * horizontally scrolling strip.
 *
 * The shape follows the width the wizard actually has. Everything that fits on
 * one row goes on one row; what needs a second row gets two; only a set too
 * long for two rows falls back to the scrolling strip, because a third row
 * pushes the Continue button below the fold. Widen the wizard and the strip
 * turns back into a block as soon as the tiles fit, so stretching the window
 * buys visible tiles rather than a longer scroll.
 *
 * Height caps the rows the same way width caps the columns. A wizard too short
 * for a second row gets one row, and if the set does not fit across that one
 * row it becomes the strip. Clipping the second row under the fold hides
 * providers with no arrow to say they exist.
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
 * Room kept clear at each end of the row.
 *
 * A row sized to the last pixel of the container reads as tight against the
 * modal wall, and leaves nothing for a vertical scrollbar to claim: appearing
 * would narrow the container, drop a column, and (in wrap mode) shorten the
 * block enough for the scrollbar to go away again, which oscillates.
 */
export const AGENT_GRID_EDGE_INSET_PX = 16;

/** Most rows ever drawn above the Continue button. A short wizard allows fewer. */
export const AGENT_GRID_MAX_ROWS = 2;

/** Vertical padding on the tile block, matching `py-1` on the wrap block and the strip. */
export const AGENT_TILE_BLOCK_PADDING_PX = 8;

/**
 * Height kept free around the tile block, split above and below it.
 *
 * Without it a second row is allowed the moment it fits to the pixel, which
 * jams the tiles against the name field and the Continue button.
 */
export const AGENT_GRID_VERTICAL_BREATHING_PX = 48;

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

/** How many tiles fit across the available width. */
export function agentTilesPerRow(containerWidth: number): number {
	if (containerWidth <= 0) return AGENT_GRID_FALLBACK_COLUMNS;
	const usable = containerWidth - AGENT_GRID_EDGE_INSET_PX * 2;
	const perRow = Math.floor(
		(usable + AGENT_TILE_GAP_PX) / (AGENT_TILE_WIDTH_PX + AGENT_TILE_GAP_PX)
	);
	return Math.max(1, perRow);
}

/**
 * How many rows of tiles fit in the height available, from 1 to `AGENT_GRID_MAX_ROWS`.
 *
 * Returns the maximum while the tile height is unknown (first frame, jsdom): an
 * unmeasured budget is not a budget of zero. A pane too short for even one row
 * still gets one, and the pane scrolls.
 */
export function agentGridRowsThatFit(availableHeight: number, tileHeight: number): number {
	if (tileHeight <= 0) return AGENT_GRID_MAX_ROWS;
	const usable = availableHeight - AGENT_TILE_BLOCK_PADDING_PX;
	const rows = Math.floor((usable + AGENT_TILE_GAP_PX) / (tileHeight + AGENT_TILE_GAP_PX));
	return Math.min(AGENT_GRID_MAX_ROWS, Math.max(1, rows));
}

/**
 * Picks the shape for `tileCount` tiles in the measured width, drawing at most
 * `maxRows` rows (what `agentGridRowsThatFit` allows for the measured height).
 */
export function resolveAgentGridLayout(
	tileCount: number,
	containerWidth: number,
	maxRows: number = AGENT_GRID_MAX_ROWS
): AgentGridLayout {
	const perRow = agentTilesPerRow(containerWidth);
	const rows = Math.min(AGENT_GRID_MAX_ROWS, Math.max(1, maxRows));

	if (tileCount > perRow * rows) {
		return { mode: 'strip', columns: Math.max(1, tileCount), maxWidthPx: undefined };
	}

	const columns =
		tileCount <= perRow ? Math.max(1, tileCount) : Math.min(perRow, Math.ceil(tileCount / rows));

	return {
		mode: 'wrap',
		columns,
		maxWidthPx: columns * AGENT_TILE_WIDTH_PX + (columns - 1) * AGENT_TILE_GAP_PX,
	};
}
