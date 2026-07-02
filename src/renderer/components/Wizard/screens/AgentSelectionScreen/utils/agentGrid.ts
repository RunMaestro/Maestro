import { AGENT_TILES } from './agentTiles';

export const GRID_COLS = 4;
export const GRID_ROWS = Math.ceil(AGENT_TILES.length / GRID_COLS);

// Tiles render into a grid that is GRID_COLS * 2 columns wide, each tile spanning
// 2 columns. The extra multiplier lets a short final row start on a half-column so
// it stays centered under the full rows above it.
const TILES_IN_LAST_ROW = AGENT_TILES.length % GRID_COLS;
export const LAST_ROW_START_INDEX =
	TILES_IN_LAST_ROW === 0 ? -1 : AGENT_TILES.length - TILES_IN_LAST_ROW;
export const LAST_ROW_COL_START_CLASS =
	TILES_IN_LAST_ROW === 1
		? 'col-start-4'
		: TILES_IN_LAST_ROW === 2
			? 'col-start-3'
			: TILES_IN_LAST_ROW === 3
				? 'col-start-2'
				: '';

export function getAgentTileColSpanClass(index: number): string {
	return index === LAST_ROW_START_INDEX ? `col-span-2 ${LAST_ROW_COL_START_CLASS}` : 'col-span-2';
}

export function getNextAgentTileIndex(currentIndex: number, key: string): number {
	const currentRow = Math.floor(currentIndex / GRID_COLS);
	const currentCol = currentIndex % GRID_COLS;

	switch (key) {
		case 'ArrowUp':
			if (currentRow > 0) {
				return (currentRow - 1) * GRID_COLS + currentCol;
			}
			return currentIndex;

		case 'ArrowDown': {
			if (currentRow >= GRID_ROWS - 1) return currentIndex;
			const newIndex = (currentRow + 1) * GRID_COLS + currentCol;
			return newIndex < AGENT_TILES.length ? newIndex : currentIndex;
		}

		case 'ArrowLeft':
			return currentCol > 0 ? currentIndex - 1 : currentIndex;

		case 'ArrowRight':
			return currentCol < GRID_COLS - 1 && currentIndex + 1 < AGENT_TILES.length
				? currentIndex + 1
				: currentIndex;

		default:
			return currentIndex;
	}
}
