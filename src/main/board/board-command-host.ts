import { captureBoardCardFromHost } from './board-review';
import { refreshBoardSources } from './board-source-host';
import { executeBoardRuntimeCommand } from './board-runtime-host';
/** Ordinary (non-human) commands share the desktop's current facade and host registers. */
import { maybeCreateCardPr } from './board-pr';
import type { CardPrResult } from './board-pr';
import { getBoard, stampBoardRunPr } from './board-storage';
import type { BoardCommandHost } from '../../shared/board/commands';
import {
	BoardStorageError,
	createBoard,
	deleteBoard,
	deleteCard,
	enqueueBoardWrite,
	getBoardCaptureCatalog,
	getBoardStorage,
	queryBoardWorkspace,
	queryBoardWorkspaceAsync,
	prepareBoardWorkspaceQuery,
	renameBoard,
	updateCardStatus,
} from './board-storage';

export const executeBoardCommand: BoardCommandHost = async (command) => {
	try {
		await refreshBoardSources();
		if (command.action === 'tick' || command.action === 'control')
			return await executeBoardRuntimeCommand(command);
		if (command.action === 'query')
			return { ok: true, value: await queryBoardWorkspaceAsync(command.query) };
		if (command.action === 'catalog') return { ok: true, value: getBoardCaptureCatalog() };
		const sourceIdentity =
			command.action === 'create'
				? undefined
				: getBoardStorage().sourceIdentity(command.target.sourceKey);
		const projectRoot =
			command.action === 'create'
				? command.projectRoot
				: (
						await prepareBoardWorkspaceQuery({
							projectRoot: command.target.projectRoot,
							sourceKey: command.target.sourceKey,
						})
					).projectRoot!;
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
			const current = await prepareBoardWorkspaceQuery({
				projectRoot: target.projectRoot,
				sourceKey: target.sourceKey,
			});
			if (
				current.projectRoot !== projectRoot ||
				getBoardStorage().sourceIdentity(target.sourceKey) !== sourceIdentity
			)
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
