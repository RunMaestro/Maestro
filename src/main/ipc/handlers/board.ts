/**
 * Board IPC Handlers
 *
 * Provides IPC handlers for the persistent Board (the task DAG stored in
 * `.maestro/board.yaml`): list boards, get a board, and card-level mutations
 * (create / update / delete / set status). No dispatcher yet (Phase 3).
 *
 * This module is a thin transport layer: filesystem I/O, validation, and cycle
 * rejection live in the domain module (`src/main/board/board-storage.ts`). Each
 * handler is a 1-line delegation, mirroring the Cue and Profiles IPC handlers.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	listBoards,
	getBoard,
	addCard,
	updateCard,
	updateCardStatus,
	deleteCard,
} from '../../board/board-storage';
import type { Board, BoardCard, CardStatus } from '../../../shared/board/types';

const LOG_CONTEXT = '[Board]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Register all Board IPC handlers. No engine/service dependency - the storage
 * layer reads/writes `.maestro/board.yaml` under the passed project root on
 * demand.
 */
export function registerBoardHandlers(): void {
	// List all boards for a project.
	ipcMain.handle(
		'board:list',
		withIpcErrorLogging(
			handlerOpts('list'),
			async (options: { projectRoot: string }): Promise<Board[]> => {
				return listBoards(options.projectRoot);
			}
		)
	);

	// Get a single board by id (null when it does not exist).
	ipcMain.handle(
		'board:get',
		withIpcErrorLogging(
			handlerOpts('get'),
			async (options: { projectRoot: string; boardId: string }): Promise<Board | null> => {
				return getBoard(options.projectRoot, options.boardId);
			}
		)
	);

	// Create a card on a board. Returns the updated board.
	ipcMain.handle(
		'board:addCard',
		withIpcErrorLogging(
			handlerOpts('addCard'),
			async (options: {
				projectRoot: string;
				boardId: string;
				card: BoardCard;
			}): Promise<Board> => {
				return addCard(options.projectRoot, options.boardId, options.card);
			}
		)
	);

	// Update a card in place (title/body/assignee/parents/etc.). Returns the board.
	ipcMain.handle(
		'board:updateCard',
		withIpcErrorLogging(
			handlerOpts('updateCard'),
			async (options: {
				projectRoot: string;
				boardId: string;
				card: BoardCard;
			}): Promise<Board> => {
				return updateCard(options.projectRoot, options.boardId, options.card);
			}
		)
	);

	// Set a card's status (manual drag-to-move overrides later). Returns the board.
	ipcMain.handle(
		'board:setCardStatus',
		withIpcErrorLogging(
			handlerOpts('setCardStatus'),
			async (options: {
				projectRoot: string;
				boardId: string;
				cardId: string;
				status: CardStatus;
			}): Promise<Board> => {
				return updateCardStatus(options.projectRoot, options.boardId, options.cardId, options.status);
			}
		)
	);

	// Delete a card by id. Returns the updated board.
	ipcMain.handle(
		'board:deleteCard',
		withIpcErrorLogging(
			handlerOpts('deleteCard'),
			async (options: {
				projectRoot: string;
				boardId: string;
				cardId: string;
			}): Promise<Board> => {
				return deleteCard(options.projectRoot, options.boardId, options.cardId);
			}
		)
	);
}
