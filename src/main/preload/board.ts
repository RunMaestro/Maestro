import type {
	BoardRuntimeCommand,
	BoardCommandResult,
	BoardRoleCommand,
} from '../../shared/board/commands';
/**
 * Preload API for Board operations
 *
 * Provides the window.maestro.board namespace for the persistent Board (the
 * task DAG stored in `.maestro/board.yaml`): list boards, get a board, and
 * card-level mutations (create / update / delete / set status).
 */

import { ipcRenderer } from 'electron';
import type { BoardWorkerOptionsCommand } from '../../shared/board/worker-options';
import type { StoredBoardWorker } from '../board/board-workspace-storage';
import type {
	BoardCaptureCatalog,
	BoardCaptureCommand,
	BoardCaptureResponse,
	Board,
	BoardCard,
	CardStatus,
	BoardWorkspaceQuery,
	BoardWorkspaceQueryResponse,
} from '../../shared/board/types';

export type { Board, BoardCard, CardStatus } from '../../shared/board/types';

/**
 * Creates the Board API object for preload exposure.
 */
export function createBoardApi() {
	return {
		ownerRecoveryStatus: (): Promise<
			import('../../shared/board/owner-recovery').BoardOwnerRecoveryResult<
				import('../../shared/board/owner-recovery').BoardOwnerRecoveryStatus
			>
		> => ipcRenderer.invoke('board:ownerRecoveryStatus'),
		previewOwnerRecovery: (): Promise<
			import('../../shared/board/owner-recovery').BoardOwnerRecoveryResult<
				import('../../shared/board/owner-recovery').BoardOwnerRecoveryPreview
			>
		> => ipcRenderer.invoke('board:previewOwnerRecovery'),
		confirmOwnerRecovery: (
			previewId: string
		): Promise<
			import('../../shared/board/owner-recovery').BoardOwnerRecoveryResult<{ epoch: number }>
		> => ipcRenderer.invoke('board:confirmOwnerRecovery', previewId),
		deleteCards: (
			command: Extract<
				import('../../shared/board/commands').BoardCommand,
				{ action: 'delete-cards' }
			>
		): Promise<BoardCommandResult> => ipcRenderer.invoke('board:deleteCards', command),
		/** Explicitly bootstrap global capture before querying; reads never create a board. */
		initialize: (): Promise<BoardCaptureResponse> => ipcRenderer.invoke('board:initialize'),
		sourceCommand: (
			command: import('../../shared/board/types').BoardSourceCommand
		): Promise<import('../../shared/board/types').BoardSourceResponse> =>
			ipcRenderer.invoke('board:sourceCommand', command),

		upsertRole: (
			projectRoot: string,
			profile: import('../../shared/profiles/types').AgentProfile
		): Promise<import('../../shared/board/types').BoardRoleRef> =>
			ipcRenderer.invoke('board:upsertRole', { projectRoot, profile }),
		setStartPolicy: (
			projectRoot: string,
			boardId: string,
			expectedRevision: number,
			mode: 'approval' | 'direct'
		): Promise<BoardCaptureResponse> =>
			ipcRenderer.invoke('board:setStartPolicy', { projectRoot, boardId, expectedRevision, mode }),
		captureCatalog: (): Promise<BoardCaptureCatalog> => ipcRenderer.invoke('board:captureCatalog'),
		roleCommand: (command: BoardRoleCommand): Promise<BoardCommandResult> =>
			ipcRenderer.invoke('board:roleCommand', command),
		runtimeCommand: (command: BoardRuntimeCommand): Promise<BoardCommandResult> =>
			ipcRenderer.invoke('board:runtimeCommand', command),
		captureCard: (command: BoardCaptureCommand): Promise<BoardCaptureResponse> =>
			ipcRenderer.invoke('board:captureCard', command),
		queryWorkspace: (query?: BoardWorkspaceQuery): Promise<BoardWorkspaceQueryResponse> =>
			ipcRenderer.invoke('board:queryWorkspace', query),
		listWorkerAccessOptions: (): Promise<
			Awaited<ReturnType<typeof import('../board/board-storage').listBoardWorkerAccessOptions>>
		> => ipcRenderer.invoke('board:listWorkerAccessOptions'),
		listWorkers: (): Promise<StoredBoardWorker[]> => ipcRenderer.invoke('board:listWorkers'),
		setWorkerOptions: (command: BoardWorkerOptionsCommand): Promise<StoredBoardWorker[]> =>
			ipcRenderer.invoke('board:setWorkerOptions', command),
		registerWorker: (agentId: string): Promise<StoredBoardWorker[]> =>
			ipcRenderer.invoke('board:registerWorker', { agentId }),
		setWorkerAccess: (
			agentId: string,
			roleRefs: { namespace: string; profileId: string }[],
			allowedRepositoryIds: string[]
		): Promise<StoredBoardWorker[]> =>
			ipcRenderer.invoke('board:setWorkerAccess', { agentId, roleRefs, allowedRepositoryIds }),
		pauseWorker: (agentId: string, paused: boolean): Promise<StoredBoardWorker[]> =>
			ipcRenderer.invoke('board:pauseWorker', { agentId, paused }),
		enableWorker: (agentId: string, enabled: boolean): Promise<StoredBoardWorker[]> =>
			ipcRenderer.invoke('board:enableWorker', { agentId, enabled }),
		// List all boards for a project.
		list: (projectRoot: string): Promise<Board[]> =>
			ipcRenderer.invoke('board:list', { projectRoot }),

		// Get a single board by id (null when it does not exist).
		get: (projectRoot: string, boardId: string): Promise<Board | null> =>
			ipcRenderer.invoke('board:get', { projectRoot, boardId }),

		// Create a new, empty board. Returns the created board.
		create: (projectRoot: string, name: string): Promise<Board> =>
			ipcRenderer.invoke('board:create', { projectRoot, name }),

		// Rename a board in place. Returns the renamed board.
		rename: (projectRoot: string, boardId: string, name: string): Promise<Board> =>
			ipcRenderer.invoke('board:rename', { projectRoot, boardId, name }),

		// Delete an entire board. Refuses without `force` when any card is not
		// `done`. Returns the remaining boards.
		delete: (projectRoot: string, boardId: string, force?: boolean): Promise<Board[]> =>
			ipcRenderer.invoke('board:delete', { projectRoot, boardId, force }),

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
			status: CardStatus,
			read?: { sourceKey: string; collectionKey: string; revision: number; cardRevision: number }
		): Promise<Board> =>
			ipcRenderer.invoke('board:setCardStatus', { projectRoot, boardId, cardId, status, read }),

		// Delete a card by id. Returns the updated board.
		deleteCard: (
			projectRoot: string,
			boardId: string,
			cardId: string,
			read?: { sourceKey: string; collectionKey: string; revision: number; cardRevision: number }
		): Promise<Board> =>
			ipcRenderer.invoke('board:deleteCard', { projectRoot, boardId, cardId, read }),

		// Cancel a running card: kills the agent process and returns the card to
		// `todo` with a `canceled` run. Returns the updated board.
		resumeCard: (
			projectRoot: string,
			boardId: string,
			cardId: string,
			read?: { sourceKey: string; collectionKey: string; revision: number; cardRevision: number }
		): Promise<Board> =>
			ipcRenderer.invoke('board:resumeCard', { projectRoot, boardId, cardId, read }),
		cancelCard: (
			projectRoot: string,
			boardId: string,
			cardId: string,
			read?: { sourceKey: string; collectionKey: string; revision: number; cardRevision: number }
		): Promise<Board> =>
			ipcRenderer.invoke('board:cancelCard', { projectRoot, boardId, cardId, read }),

		// Subscribe to board persistence pushes. Fires whenever `.maestro/board.yaml`
		// is written for any project (dispatcher tick, IPC mutation, auto-decompose);
		// the payload carries only the project root, so the listener refetches. Mirrors
		// `cue.onActivityUpdate`. Returns an unsubscribe function.
		onBoardChanged: (callback: (payload: { projectRoot: string }) => void): (() => void) => {
			const handler = (_e: unknown, payload: { projectRoot: string }) => callback(payload);
			ipcRenderer.on('board:changed', handler);
			return () => {
				ipcRenderer.removeListener('board:changed', handler);
			};
		},
	};
}

export type BoardApi = ReturnType<typeof createBoardApi>;
