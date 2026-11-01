import { readyCardsInDispatchOrder } from './board-dispatcher';
/** One host entry for desktop IPC, authenticated CLI and the Cue adapter.
 * The owner installs its existing runtime; an absent owner never creates one. */
import type { BoardRuntime } from './board-runtime';
import { listBoardWorkers, type BoardCardKey } from './board-workspace-storage';
import type {
	BoardRuntimeCommand,
	BoardCommandTarget,
	BoardCommandResult,
	BoardTickResult,
} from '../../shared/board/commands';
import {
	BoardStorageError,
	queryBoardWorkspace,
	prepareBoardWorkspaceQuery,
	getBoardStorage,
} from './board-storage';
import { canonicalJson } from '../../shared/canonicalJson';

let runtimeFor: (key: BoardCardKey) => BoardRuntime | null | Promise<BoardRuntime | null> = () =>
	null;
export function configureBoardRuntimeHost(provider: typeof runtimeFor): void {
	runtimeFor = provider;
}

export async function executeBoardRuntimeCommand(
	command:
		| BoardRuntimeCommand
		| { action: 'tick'; target: Omit<BoardCommandTarget, 'projectRoot'>; operationId: string },
	/** Only a validated native main-frame IPC action supplies this principal. */
	principal?: string
): Promise<BoardCommandResult> {
	const { target } = command;
	const sourceIdentity = getBoardStorage().sourceIdentity(target.sourceKey);
	const requestedQuery = {
		projectRoot: 'projectRoot' in target ? target.projectRoot : undefined,
		sourceKey: target.sourceKey,
	};
	const query = await prepareBoardWorkspaceQuery(requestedQuery);
	const entry = queryBoardWorkspace(query).collections.find(
		(c) => c.collectionKey === target.collectionKey && c.sourceKey === target.sourceKey
	);
	if (!entry) throw new BoardStorageError('not-found', 'Board collection not found');
	if (entry.revision !== target.expectedRevision)
		throw new BoardStorageError('stale-revision', 'Board changed since read');
	const failed = (reason: string): BoardCommandResult => ({
		ok: false,
		error: { code: reason, message: reason, reason },
	});
	if (command.action === 'tick') {
		const results: BoardTickResult[] = [];
		const ordered = readyCardsInDispatchOrder(entry.board, true);
		const selected = new Set(ordered.map((card) => card.id));
		for (const card of [
			...ordered,
			...entry.board.cards.filter((card) => !selected.has(card.id)),
		]) {
			const key = {
				sourceKey: target.sourceKey,
				collectionKey: target.collectionKey,
				cardId: card.id,
			};
			const beforePrepare = queryBoardWorkspace({ sourceKey: key.sourceKey }).collections.find(
				(c) => c.collectionKey === key.collectionKey
			)?.revision;
			const runtime = await runtimeFor(key);
			if (
				canonicalJson(await prepareBoardWorkspaceQuery(requestedQuery)) !== canonicalJson(query) ||
				getBoardStorage().sourceIdentity(target.sourceKey) !== sourceIdentity
			)
				throw new BoardStorageError(
					'stale-revision',
					'Board project alias changed during runtime preparation'
				);
			if (!runtime) return failed('runtime-unavailable');
			const storage = runtime.storage;
			const collection = storage.workspace.readCollection(key);
			const fresh = collection?.cards.find((c) => c.cardId === card.id);
			if (!collection || !fresh) {
				results.push({ cardId: card.id, ok: false, reason: 'not-found' });
				continue;
			}
			if (collection.revision !== beforePrepare) {
				results.push({ cardId: card.id, ok: false, reason: 'stale-revision' });
				continue;
			}
			const workers = listBoardWorkers(storage.db);
			// A foreign pin must fail through claim validation, never fall back to the pool.
			const candidates =
				typeof fresh.payload.assigneeAgentId === 'string'
					? [fresh.payload.assigneeAgentId]
					: workers.map((w) => w.agentId);
			let result: BoardTickResult = { cardId: card.id, ok: false, reason: 'no-workers' };
			for (const workerAgentId of candidates) {
				const claim = runtime.dispatch({
					...key,
					workerAgentId,
					requestId: canonicalJson([command.operationId, key, workerAgentId]),
					readRevision: {
						workspace: storage.workspace.readWorkspace().revision,
						collection: collection.revision,
						card: fresh.revision,
						registry: runtime.intakeRevision(),
					},
				});
				result = claim.ok
					? { cardId: card.id, ok: true, runToken: claim.runToken }
					: { cardId: card.id, ok: false, reason: claim.reason };
				if (claim.ok) break;
			}
			results.push(result);
		}
		return { ok: true, value: results };
	}
	const key = {
		sourceKey: target.sourceKey,
		collectionKey: target.collectionKey,
		cardId: command.cardId,
	};
	const runtime = await runtimeFor(key);
	if (
		canonicalJson(await prepareBoardWorkspaceQuery(requestedQuery)) !== canonicalJson(query) ||
		getBoardStorage().sourceIdentity(target.sourceKey) !== sourceIdentity
	)
		throw new BoardStorageError(
			'stale-revision',
			'Board project alias changed during runtime preparation'
		);
	if (!runtime) return failed('runtime-unavailable');
	const card = runtime.storage.workspace
		.readCollection(key)
		?.cards.find((c) => c.cardId === key.cardId);
	if (!card) throw new BoardStorageError('not-found', 'Board card not found');
	if (card.revision !== command.cardRevision)
		throw new BoardStorageError('stale-revision', 'Card changed since read');
	if (command.operation === 'approve') {
		if (!principal)
			throw new BoardStorageError(
				'protected-field',
				'Dispatch approval requires a native human action'
			);
		const approved = runtime.approve(key, target.expectedRevision, command.cardRevision, principal);
		return approved.ok ? { ok: true, value: { accepted: true } } : failed(approved.reason);
	}
	const token = command.runToken;
	if (!token && (command.operation === 'hold' || command.operation === 'resume')) {
		runtime.storage.setIdleHold(
			key,
			target.expectedRevision,
			command.cardRevision,
			command.operation === 'hold'
		);
		return { ok: true, value: { accepted: true } };
	}
	const attempt = token ? runtime.read(token) : null;
	if (!token || !attempt || canonicalJson(attempt.spec.key) !== canonicalJson(key))
		return failed('attempt-conflict');
	const result = command.operation === 'hold' ? runtime.hold(token) : runtime.resume(token);
	return result.ok
		? { ok: true, value: { accepted: true, runToken: token } }
		: failed(result.reason);
}

/** Compatibility for the existing desktop Stop button. Resolve only the exact
 * current persistent attempt; never declare a missing process terminated. */
export async function controlBoardRuntimeCard(
	projectRoot: string,
	boardId: string,
	cardId: string,
	operation: 'hold' | 'resume' = 'hold'
) {
	const query = await prepareBoardWorkspaceQuery({ projectRoot });
	const entries = queryBoardWorkspace(query).collections.filter((e) => e.board.id === boardId);
	if (entries.length !== 1)
		throw new BoardStorageError('identity-mismatch', 'Ambiguous or missing Board identity');
	const entry = entries[0];
	const key = { sourceKey: entry.sourceKey, collectionKey: entry.collectionKey, cardId };
	const runtime = await runtimeFor(key);
	if (!runtime) throw new BoardStorageError('runtime-unavailable', 'Board runtime is unavailable');
	const row = runtime.storage.db
		.prepare(
			`SELECT specification_json FROM runs
  WHERE collection_key=? AND card_id=? ORDER BY attempt DESC LIMIT 1`
		)
		.get(key.collectionKey, cardId) as { specification_json: string } | undefined;
	const token = row ? JSON.parse(row.specification_json).runToken : undefined;
	const card = entry.board.cards.find((c) => c.id === cardId);
	if (!card) throw new BoardStorageError('not-found', 'Card not found');
	const result = await executeBoardRuntimeCommand({
		action: 'control',
		operation,
		target: {
			projectRoot,
			sourceKey: key.sourceKey,
			collectionKey: key.collectionKey,
			expectedRevision: entry.revision,
		},
		cardId,
		cardRevision: card.storageRevision!,
		runToken: token,
	});
	if (!result.ok) throw new BoardStorageError('runtime-unavailable', result.error.message);
	return queryBoardWorkspace(query).collections.find((e) => e.collectionKey === key.collectionKey)!
		.board;
}

export { controlBoardRuntimeCard as cancelBoardRuntimeCard };
