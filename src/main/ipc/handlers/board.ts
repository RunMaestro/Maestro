/**
 * Board IPC Handlers
 *
 * Provides IPC handlers for the persistent Board (the task DAG stored in
 * `.maestro/board.yaml`): list boards, get a board, and card-level mutations
 * (create / update / delete / set status), plus the shared fenced runtime entry.
 *
 * This module is a thin transport layer: filesystem I/O, validation, and cycle
 * rejection live in the domain module (`src/main/board/board-storage.ts`). Each
 * handler is a 1-line delegation, mirroring the Cue and Profiles IPC handlers.
 */

import { captureBoardCardFromHost } from '../../board/board-review';
import { refreshBoardSources, executeBoardSourceCommand } from '../../board/board-source-host';
import { ipcMain, type BrowserWindow } from 'electron';
import { getLiveSessions } from '../../stores/getters';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	getBoardCaptureCatalog,
	getBoardStorage,
	listBoards,
	queryBoardWorkspaceAsync,
	BoardStorageError,
	getBoard,
	createBoard,
	renameBoard,
	deleteBoard,
	addCard,
	updateCard,
	updateCardStatus,
	deleteCard,
	enqueueBoardWrite,
	listBoardWorkers,
	listBoardWorkerAccessOptions,
	registerBoardWorker,
	setBoardWorkerPaused,
	setBoardWorkerEnabled,
	setBoardWorkerAccess,
} from '../../board/board-storage';
import {
	executeBoardRuntimeCommand,
	cancelBoardRuntimeCard,
	controlBoardRuntimeCard,
} from '../../board/board-runtime-host';
import { parseBoardCommand, type BoardCommandResult } from '../../../shared/board/commands';
import { startCardPr } from '../../board/board-pr';
import type { BoardCardToastPayload } from '../../board/board-toast';
import type {
	BoardCaptureCommand,
	BoardCaptureResponse,
	Board,
	BoardCard,
	CardStatus,
	BoardWorkspaceQuery,
	BoardWorkspaceQueryResponse,
} from '../../../shared/board/types';
import type { CueEngine } from '../../cue/cue-engine';

const LOG_CONTEXT = '[Board]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/** Dependencies required for Board handler registration. */
export interface BoardHandlerDependencies {
	getMainWindow?: () => BrowserWindow | null;
	/** The live Cue engine (Board rides its tick), or `null` before it is built. */
	getCueEngine: () => CueEngine | null;
	/**
	 * Relay a Board toast to the renderer (`remote:notifyToast`). Used by the F3
	 * PR-on-done path, which runs after the IPC reply has already gone out.
	 * Optional: without it the PR is still opened, just silently.
	 */
	notifyToast?: (payload: BoardCardToastPayload) => void;
	/** Structured log sink for the same out-of-band PR path. */
	onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Register all Board IPC handlers. Storage handlers need no service dependency -
 * the storage layer reads/writes `.maestro/board.yaml` under the passed project
 * root on demand. Stop/Resume resolve the persisted attempt and call the same
 * owning runtime as CLI; an unavailable owner never fabricates termination.
 */
export function registerBoardHandlers(deps: BoardHandlerDependencies): void {
	ipcMain.handle(
		'board:runtimeCommand',
		async (event, input: Record<string, unknown>): Promise<BoardCommandResult> => {
			try {
				const command = input && parseBoardCommand(input);
				if (!command || (command.action !== 'tick' && command.action !== 'control'))
					throw new BoardStorageError('invalid-input', 'Invalid Board runtime command');
				const window = deps.getMainWindow?.();
				const native =
					!!window &&
					!window.isDestroyed() &&
					event.sender === window.webContents &&
					event.senderFrame === window.webContents.mainFrame;
				return await executeBoardRuntimeCommand(
					command,
					native ? 'native-desktop-main-frame' : undefined
				);
			} catch (error) {
				if (!(error instanceof BoardStorageError)) throw error;
				return { ok: false, error: { code: error.code, message: error.message } };
			}
		}
	);

	ipcMain.handle(
		'board:setStartPolicy',
		async (
			event,
			options: {
				projectRoot: string;
				boardId: string;
				expectedRevision: number;
				mode: 'approval' | 'direct';
			}
		): Promise<BoardCaptureResponse> => {
			try {
				const window = deps.getMainWindow?.();
				const human =
					!!window &&
					!window.isDestroyed() &&
					event?.sender === window.webContents &&
					event.senderFrame === window.webContents.mainFrame;
				if (!human)
					throw new BoardStorageError(
						'protected-field',
						'Board start policy requires the desktop main frame'
					);
				if (
					!options ||
					Object.keys(options).some(
						(key) => !['projectRoot', 'boardId', 'expectedRevision', 'mode'].includes(key)
					)
				)
					throw new BoardStorageError('invalid-input', 'Invalid policy command');
				const value = await enqueueBoardWrite(options.projectRoot, () =>
					getBoardStorage().setStartPolicy(
						options.projectRoot,
						options.boardId,
						options.expectedRevision,
						options.mode,
						true
					)
				);
				return { ok: true, value, readiness: getBoardStorage().captureReadiness(value) };
			} catch (error) {
				if (!(error instanceof BoardStorageError)) throw error;
				return { ok: false, error: { code: error.code, message: error.message } };
			}
		}
	);

	ipcMain.handle(
		'board:sourceCommand',
		async (event, command: import('../../../shared/board/types').BoardSourceCommand) => {
			const window = deps.getMainWindow?.();
			if (
				!window ||
				window.isDestroyed() ||
				event?.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame
			)
				return {
					ok: false,
					error: {
						code: 'protected-field',
						message: 'Source management requires the desktop main frame',
					},
				};
			return executeBoardSourceCommand(command);
		}
	);

	ipcMain.handle(
		'board:upsertRole',
		async (
			event,
			options: {
				projectRoot: string;
				profile: import('../../../shared/profiles/types').AgentProfile;
			}
		) => {
			const window = deps.getMainWindow?.();
			if (
				!window ||
				window.isDestroyed() ||
				event?.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame
			)
				throw new BoardStorageError(
					'protected-field',
					'Board role editing requires the desktop main frame'
				);
			await refreshBoardSources();
			return enqueueBoardWrite(options.projectRoot, () =>
				getBoardStorage().upsertRole(options.projectRoot, options.profile)
			);
		}
	);

	ipcMain.handle(
		'board:captureCatalog',
		withIpcErrorLogging(handlerOpts('captureCatalog'), async () => {
			await refreshBoardSources();
			return getBoardCaptureCatalog();
		})
	);
	// This native-only channel derives authority from the actual top-level desktop sender.
	// Remote/web/CLI callers use ordinary mutations and cannot claim human policy authority.
	ipcMain.handle(
		'board:captureCard',
		async (event, command: BoardCaptureCommand): Promise<BoardCaptureResponse> => {
			try {
				const window = deps.getMainWindow?.();
				const human =
					!!window &&
					!window.isDestroyed() &&
					event?.sender === window.webContents &&
					event.senderFrame === window.webContents.mainFrame;
				if (!human)
					throw new BoardStorageError(
						'protected-field',
						'Native human capture requires the desktop main frame'
					);
				if (
					!command ||
					Object.keys(command).some(
						(key) => !['projectRoot', 'boardId', 'expectedRevision', 'card'].includes(key)
					)
				)
					throw new BoardStorageError('invalid-input', 'Invalid capture command');
				return await enqueueBoardWrite(command.projectRoot, () =>
					captureBoardCardFromHost(command, true)
				);
			} catch (error) {
				if (!(error instanceof BoardStorageError)) throw error;
				return {
					ok: false,
					error: {
						code: error.code,
						message: error.message,
						captureErrors: error.details.captureErrors,
					},
				};
			}
		}
	);

	ipcMain.handle(
		'board:queryWorkspace',
		withIpcErrorLogging(
			handlerOpts('queryWorkspace'),
			async (query?: BoardWorkspaceQuery): Promise<BoardWorkspaceQueryResponse> => {
				try {
					await refreshBoardSources();
					return { ok: true, value: await queryBoardWorkspaceAsync(query) };
				} catch (error) {
					if (!(error instanceof BoardStorageError)) throw error;
					return { ok: false, error: { code: error.code, message: error.message } };
				}
			}
		)
	);

	ipcMain.handle(
		'board:listWorkers',
		withIpcErrorLogging(handlerOpts('listWorkers'), async () => listBoardWorkers())
	);
	ipcMain.handle(
		'board:listWorkerAccessOptions',
		withIpcErrorLogging(handlerOpts('listWorkerAccessOptions'), async () =>
			listBoardWorkerAccessOptions()
		)
	);
	ipcMain.handle(
		'board:registerWorker',
		withIpcErrorLogging(handlerOpts('registerWorker'), async (options: { agentId: string }) => {
			if (
				!options ||
				typeof options.agentId !== 'string' ||
				!getLiveSessions().some((session) => session.id === options.agentId)
			) {
				throw new Error('Live agent not found');
			}
			registerBoardWorker(options.agentId);
			return listBoardWorkers();
		})
	);
	ipcMain.handle(
		'board:setWorkerAccess',
		withIpcErrorLogging(
			handlerOpts('setWorkerAccess'),
			async (options: {
				agentId: string;
				roleRefs: { namespace: string; profileId: string }[];
				allowedRepositoryIds: string[];
			}) => {
				if (!options || typeof options.agentId !== 'string')
					throw new Error('Invalid Board worker');
				if (!getLiveSessions().some((session) => session.id === options.agentId))
					throw new Error('Live agent not found');
				setBoardWorkerAccess(options.agentId, options.roleRefs, options.allowedRepositoryIds);
				return listBoardWorkers();
			}
		)
	);

	ipcMain.handle(
		'board:enableWorker',
		withIpcErrorLogging(
			handlerOpts('enableWorker'),
			async (options: { agentId: string; enabled: boolean }) => {
				if (!options || typeof options.agentId !== 'string')
					throw new Error('Invalid Board worker');
				setBoardWorkerEnabled(options.agentId, options.enabled);
				return listBoardWorkers();
			}
		)
	);
	ipcMain.handle(
		'board:pauseWorker',
		withIpcErrorLogging(
			handlerOpts('pauseWorker'),
			async (options: { agentId: string; paused: boolean }) => {
				if (!options || typeof options.agentId !== 'string')
					throw new Error('Invalid Board worker');
				setBoardWorkerPaused(options.agentId, options.paused);
				return listBoardWorkers();
			}
		)
	);

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

	// Rename a board in place. Returns the renamed board.
	ipcMain.handle(
		'board:rename',
		withIpcErrorLogging(
			handlerOpts('rename'),
			async (options: { projectRoot: string; boardId: string; name: string }): Promise<Board> => {
				return enqueueBoardWrite(options.projectRoot, () =>
					renameBoard(options.projectRoot, options.boardId, options.name)
				);
			}
		)
	);

	// Delete an entire board. Refuses without `force` when any card is not `done`.
	// Returns the remaining boards.
	ipcMain.handle(
		'board:delete',
		withIpcErrorLogging(
			handlerOpts('delete'),
			async (options: {
				projectRoot: string;
				boardId: string;
				force?: boolean;
			}): Promise<Board[]> => {
				return enqueueBoardWrite(options.projectRoot, () =>
					deleteBoard(options.projectRoot, options.boardId, { force: options.force })
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
				const board = await enqueueBoardWrite(options.projectRoot, () =>
					updateCardStatus(options.projectRoot, options.boardId, options.cardId, options.status)
				);
				// Board F3: approving a `review` card (or any manual move into Done) is
				// the OTHER transition into `done`, so it opens the card's pull request
				// too. Fire-and-forget: the opt-in gate and every failure path live in
				// `startCardPr`, and the IPC reply must not wait on git/gh.
				if (options.status === 'done') {
					startCardPr(options.projectRoot, options.boardId, options.cardId, {
						notify: deps.notifyToast,
						onLog: deps.onLog,
					});
				}
				return board;
			}
		)
	);

	// Cancel a running card: kill its agent process and record a `canceled` run
	// (which does NOT count toward the circuit breaker). The card returns to
	// `todo` but is HELD there (`heldByUser`), so the promote pass leaves it alone
	// until a person resumes it. Returns the updated board.
	ipcMain.handle(
		'board:cancelCard',
		withIpcErrorLogging(
			handlerOpts('cancelCard'),
			async (options: { projectRoot: string; boardId: string; cardId: string }): Promise<Board> => {
				return cancelBoardRuntimeCard(options.projectRoot, options.boardId, options.cardId);
			}
		)
	);

	ipcMain.handle(
		'board:resumeCard',
		withIpcErrorLogging(
			handlerOpts('resumeCard'),
			async (options: { projectRoot: string; boardId: string; cardId: string }): Promise<Board> =>
				controlBoardRuntimeCard(options.projectRoot, options.boardId, options.cardId, 'resume')
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
