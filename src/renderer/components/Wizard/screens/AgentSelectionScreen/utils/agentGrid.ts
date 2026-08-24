import { AGENT_TILES } from './agentTiles';

/**
 * Keyboard movement across the provider strip.
 *
 * The strip is a single horizontally scrolling row, so left/right step one tile
 * and up/down are no-ops. It used to be a wrapping 4-column grid, but the tile
 * count now grows with every provider we add and a grid pushed the Continue
 * button below the fold once it reached a third row.
 *
 * Movement is clamped rather than wrapped: running off the end should stop, not
 * teleport the focus ring back to the far side of a row the user can't see.
 */
export function getNextAgentTileIndex(currentIndex: number, key: string): number {
	switch (key) {
		case 'ArrowLeft':
			return currentIndex > 0 ? currentIndex - 1 : currentIndex;

		case 'ArrowRight':
			return currentIndex + 1 < AGENT_TILES.length ? currentIndex + 1 : currentIndex;

		default:
			return currentIndex;
	}
}
