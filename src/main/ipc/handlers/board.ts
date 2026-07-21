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
	createBoard,
	addCard,
	updateCard,
	updateCardStatus,
	deleteCard,
	saveBoard,
	enqueueBoardWrite,
} from '../../board/board-storage';
import { applyCardCancel } from '../../board/board-dispatcher';
import type { Board, BoardCard, CardStatus } from '../../../shared/board/types';
import type { CueEngine } from '../../cue/cue-engine';

const LOG_CONTEXT = '[Board]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/** Dependencies required for Board handler registration. */
export interface BoardHandlerDependencies {
	/** The live Cue engine (Board rides its tick), or `null` before it is built. */
	getCueEngine: () => CueEngine | null;
}

/**
 * Register all Board IPC handlers. Storage handlers need no service dependency -
 * the storage layer reads/writes `.maestro/board.yaml` under the passed project
 * root on demand. `board:cancelCard` is the exception: it goes through the live
 * dispatcher so the in-flight process is actually killed.
 */
export function registerBoardHandlers(deps: BoardHandlerDependencies): void {
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

	// Create a new, empty board. Returns the created board.
	ipcMain.handle(
		'board:create',
		withIpcErrorLogging(
			handlerOpts('create'),
			async (options: { projectRoot: string; name: string }): Promise<Board> => {
				return enqueueBoardWrite(options.projectRoot, () =>
					createBoard(options.projectRoot, options.name)
				);
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
				return enqueueBoardWrite(options.projectRoot, () =>
					addCard(options.projectRoot, options.boardId, options.card)
				);
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
				return enqueueBoardWrite(options.projectRoot, () =>
					updateCard(options.projectRoot, options.boardId, options.card)
				);
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
				return enqueueBoardWrite(options.projectRoot, () =>
					updateCardStatus(options.projectRoot, options.boardId, options.cardId, options.status)
				);
			}
		)
	);

	// Cancel a running card: kill its agent process and send it back to `todo`
	// with a `canceled` run (which does NOT count toward the circuit breaker).
	// Returns the updated board.
	ipcMain.handle(
		'board:cancelCard',
		withIpcErrorLogging(
			handlerOpts('cancelCard'),
			async (options: { projectRoot: string; boardId: string; cardId: string }): Promise<Board> => {
				const { projectRoot, boardId, cardId } = options;
				// Preferred path: the dispatcher that owns this board kills the process
				// and persists the cancel itself.
				const canceled =
					deps.getCueEngine()?.cancelBoardCard(projectRoot, boardId, cardId) ?? false;
				if (!canceled) {
					// No dispatcher owns the board in this process (engine off, or the app
					// restarted while the card was running), so there is nothing to kill -
					// but the card is still stuck `running` in the file. Finalize it so the
					// user can act on it now instead of waiting out the stale-reclaim
					// window. Serialized like every other async read-modify-write.
					await enqueueBoardWrite(projectRoot, () => {
						const board = listBoards(projectRoot).find((b) => b.id === boardId);
						if (!board) throw new Error(`Board "${boardId}" not found`);
						if (applyCardCancel(board, cardId, new Date().toISOString())) {
							saveBoard(projectRoot, board);
						}
					});
				}
				const updated = getBoard(projectRoot, boardId);
				if (!updated) throw new Error(`Board "${boardId}" not found`);
				return updated;
			}
		)
	);

	// Delete a card by id. Returns the updated board.
	ipcMain.handle(
		'board:deleteCard',
		withIpcErrorLogging(
			handlerOpts('deleteCard'),
			async (options: { projectRoot: string; boardId: string; cardId: string }): Promise<Board> => {
				return enqueueBoardWrite(options.projectRoot, () =>
					deleteCard(options.projectRoot, options.boardId, options.cardId)
				);
			}
		)
	);
}
