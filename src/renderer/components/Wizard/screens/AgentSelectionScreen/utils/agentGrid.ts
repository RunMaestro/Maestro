/**
 * Keyboard movement across the provider tiles.
 *
 * The tiles are either one horizontally scrolling row (every supported
 * provider, which no longer fits above the Continue button) or a centered block
 * that wraps into at most two rows (the shorter filtered list). `columns` is
 * what tells the two apart: left/right always step one tile, and up/down jump a
 * whole row, which is a no-op when the row holds everything.
 *
 * Movement is clamped rather than wrapped: running off the end should stop, not
 * teleport the focus ring back to the far side of a row the user can't see. A
 * downward step out of a full row into a shorter last row lands on the last
 * tile rather than refusing to move, since refusing reads as a dead key.
 *
 * `tileCount` is the count of tiles CURRENTLY RENDERED, not the provider total.
 * The list can be filtered to the installed providers, so an index into the
 * full registry names a different tile than the one under the focus ring.
 */
export function getNextAgentTileIndex(
	currentIndex: number,
	key: string,
	tileCount: number,
	columns: number = tileCount
): number {
	if (tileCount <= 0) return currentIndex;
	const perRow = columns > 0 ? columns : tileCount;

	switch (key) {
		case 'ArrowLeft':
			return currentIndex > 0 ? currentIndex - 1 : currentIndex;

		case 'ArrowRight':
			return currentIndex + 1 < tileCount ? currentIndex + 1 : currentIndex;

		case 'ArrowUp':
			return currentIndex - perRow >= 0 ? currentIndex - perRow : currentIndex;

		case 'ArrowDown': {
			if (currentIndex + perRow < tileCount) return currentIndex + perRow;
			const lastRowStart = (Math.ceil(tileCount / perRow) - 1) * perRow;
			return currentIndex < lastRowStart ? tileCount - 1 : currentIndex;
		}

		default:
			return currentIndex;
	}
}
