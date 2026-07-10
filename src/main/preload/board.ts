/**
 * Preload API for Board operations
 *
 * Provides the window.maestro.board namespace for the persistent Board (the
 * task DAG stored in `.maestro/board.yaml`): list boards, get a board, and
 * card-level mutations (create / update / delete / set status).
 */

import { ipcRenderer } from 'electron';
import type { Board, BoardCard, CardStatus } from '../../shared/board/types';

export type { Board, BoardCard, CardStatus } from '../../shared/board/types';

/**
 * Creates the Board API object for preload exposure.
 */
export function createBoardApi() {
	return {
		// List all boards for a project.
		list: (projectRoot: string): Promise<Board[]> =>
			ipcRenderer.invoke('board:list', { projectRoot }),

		// Get a single board by id (null when it does not exist).
		get: (projectRoot: string, boardId: string): Promise<Board | null> =>
			ipcRenderer.invoke('board:get', { projectRoot, boardId }),

		// Create a card on a board. Returns the updated board.
		addCard: (projectRoot: string, boardId: string, card: BoardCard): Promise<Board> =>
			ipcRenderer.invoke('board:addCard', { projectRoot, boardId, card }),

		// Update a card in place. Returns the updated board.
		updateCard: (projectRoot: string, boardId: string, card: BoardCard): Promise<Board> =>
			ipcRenderer.invoke('board:updateCard', { projectRoot, boardId, card }),

		// Set a card's status (manual drag-to-move overrides). Returns the board.
		setCardStatus: (
			projectRoot: string,
			boardId: string,
			cardId: string,
			status: CardStatus
		): Promise<Board> =>
			ipcRenderer.invoke('board:setCardStatus', { projectRoot, boardId, cardId, status }),

		// Delete a card by id. Returns the updated board.
		deleteCard: (projectRoot: string, boardId: string, cardId: string): Promise<Board> =>
			ipcRenderer.invoke('board:deleteCard', { projectRoot, boardId, cardId }),
	};
}

export type BoardApi = ReturnType<typeof createBoardApi>;
