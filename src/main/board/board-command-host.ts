import { requireBoardEnabled } from './board-feature';
import {
	previewBoardSourceCleanup,
	exportBoardSourceCleanup,
	suppressBoardSource,
	restoreBoardSource,
} from './board-source-cleanup';
import { canonicalJson } from '../../shared/canonicalJson';
import { captureBoardCardFromHost } from './board-review';
import { refreshBoardSources, prepareBoardMutationTarget } from './board-source-host';
import { executeBoardRuntimeCommand } from './board-runtime-host';
/** Ordinary (non-human) commands share the desktop's current facade and host registers. */
import { maybeCreateCardPr } from './board-pr';
import type { CardPrResult } from './board-pr';
import { getBoard, stampBoardRunPr } from './board-storage';
import type { BoardCommandHost } from '../../shared/board/commands';
import { getLiveSessions } from '../stores/getters';
import {
	BoardStorageError,
	createBoard,
	deleteBoard,
	deleteCard,
	deleteCards,
	enqueueBoardWrite,
	getBoardCaptureCatalog,
	getBoardStorage,
	initializeBoardWorkspace,
	listBoardWorkers,
	registerBoardWorker,
	setBoardWorkerEnabled,
	setBoardWorkerPaused,
	setBoardWorkerOptions,
	queryBoardWorkspace,
	queryBoardWorkspaceAsync,
	renameBoard,
	updateCardStatus,
} from './board-storage';

export const executeBoardCommand: BoardCommandHost = async (command) => {
	requireBoardEnabled();
	try {
		if (
			command.action === 'source-preview' ||
			command.action === 'source-export' ||
			command.action === 'source-suppress' ||
			command.action === 'source-restore'
		) {
			const db = getBoardStorage().db;
			try {
				if (command.action === 'source-restore') {
					restoreBoardSource(db, command.receipt, command.backupPath);
					return { ok: true, value: null };
				}
				const snapshot = previewBoardSourceCleanup(db, command.sourceKey);
				if (command.action === 'source-preview') return { ok: true, value: { ...snapshot } };
				// Workspace revision is advisory for source cleanup. The verified
				// backup and persisted suppression receipt fence this source exactly.
				if (command.action === 'source-export') {
					const exported = exportBoardSourceCleanup(db, command.sourceKey, command.backupPath);
					return {
						ok: true,
						value: {
							sha256: exported.sha256,
							revision: exported.snapshot.revision,
							sourceKey: command.sourceKey,
							backupPath: command.backupPath,
						},
					};
				}
				return {
					ok: true,
					value: suppressBoardSource(
						db,
						command.sourceKey,
						command.backupPath,
						command.backupSha256
					),
				};
			} catch (error) {
				if (error instanceof BoardStorageError) throw error;
				throw new BoardStorageError(
					'invalid-input',
					error instanceof Error ? error.message : 'Source cleanup failed'
				);
			}
		}
		if (!('target' in command) || command.action === 'tick' || command.action === 'control')
			await refreshBoardSources();
		if (command.action === 'tick' || command.action === 'control')
			return await executeBoardRuntimeCommand(command);
		if (command.action === 'query')
			return { ok: true, value: await queryBoardWorkspaceAsync(command.query) };
		if (command.action === 'catalog') return { ok: true, value: getBoardCaptureCatalog() };
		if (command.action === 'list-workers') return { ok: true, value: listBoardWorkers() };
		if (command.action === 'worker-lifecycle') {
			const db = getBoardStorage().db;
			db.transaction(() => {
				const worker = listBoardWorkers().find((entry) => entry.agentId === command.agentId);
				if ((worker ? canonicalJson(worker) : null) !== command.expected)
					throw new BoardStorageError('stale-revision', 'Board worker changed since read');
				if (command.operation === 'register') {
					if (!getLiveSessions().some((session) => session.id === command.agentId))
						throw new BoardStorageError('not-found', 'Live agent not found');
					if (!worker) registerBoardWorker(command.agentId);
					else setBoardWorkerEnabled(command.agentId, true);
				} else {
					if (!worker) throw new BoardStorageError('not-found', 'Board worker not found');
					if (command.operation === 'unregister') {
						setBoardWorkerEnabled(command.agentId, false);
					} else setBoardWorkerPaused(command.agentId, command.operation === 'pause');
				}
			}).immediate();
			return { ok: true, value: listBoardWorkers() };
		}
		if (command.action === 'set-worker-options') {
			if (!getLiveSessions().some((session) => session.id === command.command.agentId))
				throw new BoardStorageError('not-found', 'Live agent not found');
			try {
				setBoardWorkerOptions(command.command);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === 'Board worker changed; refresh before saving'
				)
					throw new BoardStorageError('stale-revision', error.message);
				if (error instanceof Error && error.message === 'Board worker not found')
					throw new BoardStorageError('not-found', error.message);
				throw error;
			}
			return { ok: true, value: listBoardWorkers() };
		}
		if (command.action === 'initialize') return { ok: true, value: initializeBoardWorkspace() };
		if (command.action === 'create-role')
			return { ok: true, value: getBoardStorage().createRole(command.name) };
		if (command.action === 'edit-role') {
			const storage = getBoardStorage();
			storage.db
				.transaction(() => {
					const row = storage.db
						.prepare(
							'SELECT payload_json, source_key FROM profiles WHERE profile_namespace=? AND id=?'
						)
						.get(command.role.namespace, command.role.profileId) as
						| { payload_json: string; source_key: string }
						| undefined;
					if (!row || row.source_key !== command.sourceKey)
						throw new BoardStorageError('not-found', 'Exact role not found in source');
					if (canonicalJson(JSON.parse(row.payload_json)) !== command.expected)
						throw new BoardStorageError('stale-revision', 'Role changed since read');
					if (command.profile && command.profile.id !== command.role.profileId)
						throw new BoardStorageError('identity-mismatch', 'Role ID cannot change');
					storage.editSourceRole(
						command.profile
							? {
									action: 'save-role',
									sourceKey: command.sourceKey,
									namespace: command.role.namespace,
									profile: command.profile,
								}
							: {
									action: 'delete-role',
									sourceKey: command.sourceKey,
									namespace: command.role.namespace,
									profileId: command.role.profileId,
								}
					);
				})
				.immediate();
			return { ok: true, value: null };
		}
		if (command.action === 'set-worker-role') {
			getBoardStorage().setWorkerRole(command.agentId, command.role, command.enabled);
			return { ok: true, value: null };
		}
		const prepared =
			command.action === 'create'
				? undefined
				: await prepareBoardMutationTarget(command.target, command.action);
		const projectRoot = command.action === 'create' ? command.projectRoot : prepared!.projectRoot;
		const result = await enqueueBoardWrite(projectRoot, async () => {
			if (command.action === 'create') {
				return {
					ok: true as const,
					value: createBoard(projectRoot, command.name, {
						expectedSourceKey: command.sourceKey,
						maxInProgress: command.maxInProgress,
						autoDecompose: command.autoDecompose,
					}),
				};
			}
			const target = command.target;
			const current = await prepareBoardMutationTarget(target, command.action);
			if (current.projectRoot !== projectRoot || current.identity !== prepared!.identity)
				throw new BoardStorageError('stale-revision', 'Board project alias changed while queued');
			const snapshot = queryBoardWorkspace({ projectRoot, sourceKey: target.sourceKey });
			const entry = snapshot.collections.find(
				(collection) =>
					collection.sourceKey === target.sourceKey &&
					collection.collectionKey === target.collectionKey
			);
			if (!entry)
				throw new BoardStorageError(
					'not-found',
					'Board collection not found in the selected source/project'
				);
			if (entry.revision !== target.expectedRevision)
				throw new BoardStorageError('stale-revision', 'Board changed since read');
			// This route has no human authority. A review cannot be escaped through
			// an intermediate status or through a whole-card capture replacement.
			const requestedCard =
				command.action === 'capture'
					? command.capture.card
					: command.action === 'status'
						? { id: command.cardId, status: command.status }
						: undefined;
			if (
				requestedCard &&
				requestedCard.status !== 'review' &&
				entry.board.cards.some((card) => card.id === requestedCard.id && card.status === 'review')
			)
				throw new BoardStorageError(
					'protected-field',
					'Human review requires an explicit authorized UI action'
				);
			if (command.action === 'card-pr') {
				const source = snapshot.sources.find((source) => source.sourceKey === entry.sourceKey);
				if (source?.location?.location.kind === 'ssh')
					throw new BoardStorageError(
						'legacy-mapping-missing',
						'Remote PR completion requires an explicit remote Git/PR adapter'
					);
				if (!entry.board.cards.some((card) => card.id === command.cardId && card.status === 'done'))
					throw new BoardStorageError('invalid-input', 'PR requires a completed card');
				return { ok: true as const, value: null };
			}
			if (command.action === 'capture') {
				if (command.capture.boardId !== entry.board.id)
					throw new BoardStorageError(
						'identity-mismatch',
						'Board legacy identity does not match collection'
					);
				return captureBoardCardFromHost({ ...command.capture, projectRoot }, false);
			}
			if (command.action === 'rename')
				return {
					ok: true as const,
					value: renameBoard(projectRoot, entry.board.id, command.name, target.expectedRevision),
				};
			if (command.action === 'delete')
				return {
					ok: true as const,
					value: deleteBoard(projectRoot, entry.board.id, {
						force: command.force,
						expectedRevision: target.expectedRevision,
					}),
				};
			if (command.action === 'delete-cards')
				return { ok: true as const, value: deleteCards(projectRoot, entry.board, command.cards) };
			const card = entry.board.cards.find((card) => card.id === command.cardId);
			if (!card) throw new BoardStorageError('not-found', 'Board card not found');
			if (card.storageRevision !== command.cardRevision)
				throw new BoardStorageError('stale-revision', 'Card changed since read');
			return {
				ok: true as const,
				value:
					command.action === 'delete-card'
						? deleteCard(projectRoot, entry.board.id, card.id, target.expectedRevision)
						: updateCardStatus(
								projectRoot,
								entry.board.id,
								card.id,
								command.status,
								target.expectedRevision
							),
			};
		});
		if (command.action !== 'card-pr') return result;
		const snapshot = queryBoardWorkspace({ projectRoot, sourceKey: command.target.sourceKey });
		const board = snapshot.collections.find(
			(entry) => entry.collectionKey === command.target.collectionKey
		)!.board;
		return { ok: true, value: await createCardPrFromHost(projectRoot, board.id, command.cardId) };
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
};

function createCardPrFromHost(
	projectRoot: string,
	boardId: string,
	cardId: string
): Promise<CardPrResult | null> {
	return maybeCreateCardPr(cardId, {
		loadBoard: () => getBoard(projectRoot, boardId),
		stampPrUrl: (id, prUrl, run) =>
			enqueueBoardWrite(projectRoot, () => {
				const board = getBoard(projectRoot, boardId);
				if (board) stampBoardRunPr(projectRoot, board, id, run, { prUrl });
			}),
		stampPrError: (id, error, run) =>
			enqueueBoardWrite(projectRoot, () => {
				const board = getBoard(projectRoot, boardId);
				if (board) stampBoardRunPr(projectRoot, board, id, run, { prError: error.slice(0, 500) });
			}),
		// The existing PR helper defaults to the run's checkout. projectRoot
		// identifies Board storage, not necessarily the card's repository.
		// No toast sink: there is no renderer to relay to from a CLI process. The
		// outcome is printed by the caller and persisted on the run either way.
		onLog: (level, message) => {
			if (level !== 'info') console.error(`[board-pr] ${message}`);
		},
	});
}
