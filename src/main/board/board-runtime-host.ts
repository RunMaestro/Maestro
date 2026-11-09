import { isBoardEnabled, requireBoardEnabled } from './board-feature';
import { yieldToEventLoop } from '../utils/concurrency';
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
import { prepareBoardReviewHandoff } from './board-review';
import { evaluateClaimWorker } from '../../shared/board/domain';

let runtimeFor: (
	key: BoardCardKey,
	prepare?: boolean
) => BoardRuntime | null | Promise<BoardRuntime | null> = () => null;
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
	requireBoardEnabled();
	if (
		command.action === 'control' &&
		['accept', 'recover'].includes(command.operation) &&
		!principal
	)
		throw new BoardStorageError(
			'protected-field',
			'Final approval or recovery requires a native human action'
		);
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
	const failed = (reason: string, message = reason): BoardCommandResult => ({
		ok: false,
		error: { code: reason, message, reason },
	});
	if (command.action === 'tick') {
		const results: BoardTickResult[] = [];
		const lookupFailures = new Map<string, BoardStorageError>();
		const lookup = async (key: BoardCardKey, prepare: boolean) => {
			try {
				return await runtimeFor(key, prepare);
			} catch (error) {
				if (
					error instanceof BoardStorageError &&
					['runtime-unavailable', 'owner-conflict', 'owner-identity-unavailable'].includes(
						error.code
					)
				) {
					lookupFailures.set(key.cardId, error);
					return null;
				}
				// A mid-tick toggle must not erase already-returned dispatch receipts.
				// Unexpected preparation/storage/admission errors still propagate.
				if (
					results.some((result) => result.ok) &&
					!isBoardEnabled() &&
					error instanceof Error &&
					['BoardDisabled', 'CueDisabled'].includes(error.message)
				)
					return null;
				throw error;
			}
		};
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
			await yieldToEventLoop();
			const beforePrepare = getBoardStorage().workspace.readCollection(key)?.revision;
			// With no registered workers a card cannot be dispatched.
			// Acquire and validate the owner without probing Git; re-read the card and
			// registry after every async boundary before reporting this wait reason.
			if (selected.has(card.id) && listBoardWorkers(getBoardStorage().db).length === 0) {
				const waitingRuntime = await lookup(key, false);
				if (
					canonicalJson(await prepareBoardWorkspaceQuery(requestedQuery)) !==
						canonicalJson(query) ||
					getBoardStorage().sourceIdentity(target.sourceKey) !== sourceIdentity
				)
					throw new BoardStorageError(
						'stale-revision',
						'Board project alias changed during runtime preparation'
					);
				if (!waitingRuntime) {
					const refusal = lookupFailures.get(card.id);
					if (!results.some((result) => result.ok))
						return failed(refusal?.code ?? 'runtime-unavailable', refusal?.message);
					results.push({
						cardId: card.id,
						ok: false,
						reason: refusal?.code ?? 'runtime-unavailable',
					});
					continue;
				}
				const current = waitingRuntime.storage.workspace.readCollection(key);
				const currentCard = current?.cards.find((c) => c.cardId === card.id);
				if (!current || !currentCard) {
					results.push({ cardId: card.id, ok: false, reason: 'not-found' });
					continue;
				}
				if (current.revision !== beforePrepare) {
					results.push({ cardId: card.id, ok: false, reason: 'stale-revision' });
					continue;
				}
				if (listBoardWorkers(waitingRuntime.storage.db).length === 0) {
					if (currentCard.payload.executionScope === undefined) {
						results.push({ cardId: card.id, ok: false, reason: 'missing-scope' });
						continue;
					}
					const pin = currentCard.payload.assigneeAgentId;
					if (typeof pin !== 'string') {
						results.push({ cardId: card.id, ok: false, reason: 'no-workers' });
						continue;
					}
					// Review handoffs need their native Git proof before evaluation.
					if (currentCard.payload.kind !== 'review') {
						const probe = waitingRuntime.claim(
							{
								...key,
								workerAgentId: pin,
								requestId: canonicalJson([command.operationId, key, pin]),
								readRevision: {
									workspace: waitingRuntime.storage.workspace.readRevision(),
									collection: current.revision,
									card: currentCard.revision,
									registry: waitingRuntime.intakeRevision(),
								},
							},
							true
						);
						if (!probe.ok && probe.reason !== 'registry-changed') {
							results.push({ cardId: card.id, ok: false, reason: probe.reason });
							continue;
						}
					}
				}
			}
			const runtime = await lookup(key, selected.has(card.id));
			if (
				canonicalJson(await prepareBoardWorkspaceQuery(requestedQuery)) !== canonicalJson(query) ||
				getBoardStorage().sourceIdentity(target.sourceKey) !== sourceIdentity
			)
				throw new BoardStorageError(
					'stale-revision',
					'Board project alias changed during runtime preparation'
				);
			if (!runtime) {
				const refusal = lookupFailures.get(card.id);
				if (!results.some((result) => result.ok))
					return failed(refusal?.code ?? 'runtime-unavailable', refusal?.message);
				results.push({
					cardId: card.id,
					ok: false,
					reason: refusal?.code ?? 'runtime-unavailable',
				});
				continue;
			}
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
			if (fresh.payload.executionScope === undefined) {
				results.push({ cardId: card.id, ok: false, reason: 'missing-scope' });
				continue;
			}
			const workers = listBoardWorkers(storage.db);
			const catalog = storage.captureCatalog();
			const eligible = workers.filter(
				(worker) =>
					evaluateClaimWorker(fresh.payload, worker.agentId, {
						...catalog,
						canRelaxStartPolicy: true,
						repositoryIds: catalog.repositories
							.filter((repo) => repo.validated)
							.map((repo) => repo.id),
						workers: workers.map((entry) => ({
							...entry,
							roleRefs: Array.isArray(entry.payload.roleRefs) ? entry.payload.roleRefs : [],
							allowedRepositoryIds: Array.isArray(entry.payload.allowedRepositoryIds)
								? entry.payload.allowedRepositoryIds
								: [],
						})),
					}) !== 'worker-outside-scope'
			);
			// A foreign pin must fail through claim validation, never fall back to the pool.
			const candidates =
				typeof fresh.payload.assigneeAgentId === 'string'
					? [fresh.payload.assigneeAgentId]
					: eligible.map((w) => w.agentId);
			let result: BoardTickResult = {
				cardId: card.id,
				ok: false,
				reason: workers.length && !eligible.length ? 'worker-outside-scope' : 'no-workers',
			};
			for (const workerAgentId of candidates) {
				const claimCommand = {
					...key,
					workerAgentId,
					requestId: canonicalJson([command.operationId, key, workerAgentId]),
					readRevision: {
						workspace: storage.workspace.readRevision(),
						collection: collection.revision,
						card: fresh.revision,
						registry: runtime.intakeRevision(),
					},
				};
				const claim = selected.has(card.id)
					? runtime.dispatch(claimCommand)
					: runtime.claim(claimCommand, 'readiness');
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
	if (command.operation === 'accept') {
		if (!principal)
			throw new BoardStorageError(
				'protected-field',
				'Final approval requires a native human action'
			);
		const work = card.payload as unknown as import('../../shared/board/types').BoardCard;
		const review = runtime.storage.workspace
			.readCollection(key)
			?.cards.find((entry) => entry.cardId === work.workflow?.reviewCardId);
		const handoff = (
			review?.payload as unknown as import('../../shared/board/types').BoardCard | undefined
		)?.reviewHandoff;
		if (!handoff || !(await prepareBoardReviewHandoff(runtime.storage, handoff)))
			return failed('review-artifact-unresolved');
		runtime.acceptWork(key, target.expectedRevision, command.cardRevision, principal);
		return { ok: true, value: { accepted: true } };
	}
	if (command.operation === 'approve') {
		if (!principal)
			throw new BoardStorageError(
				'protected-field',
				'Dispatch approval requires a native human action'
			);
		const approved = runtime.approve(key, target.expectedRevision, command.cardRevision, principal);
		return approved.ok ? { ok: true, value: { accepted: true } } : failed(approved.reason);
	}
	const token =
		command.runToken ??
		(command.operation === 'recover' ? activeBoardRunToken(runtime, key) : undefined);
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
	const expected = { collection: target.expectedRevision, card: command.cardRevision };
	const result =
		command.operation === 'recover'
			? runtime.recover(token, expected, principal)
			: command.operation === 'hold'
				? runtime.hold(token, expected)
				: runtime.resume(token, expected);
	return result.ok
		? { ok: true, value: { accepted: true, runToken: token } }
		: failed(result.reason);
}

/** Resolve the persisted attempt for this exact collection/card, shared by desktop control paths. */
function activeBoardRunToken(
	runtime: BoardRuntime,
	key: import('./board-workspace-storage').BoardCardKey
): import('../../shared/board/commands').BoardRuntimeToken | undefined {
	const row = runtime.storage.db
		.prepare(
			`SELECT specification_json FROM runs
  WHERE collection_key=? AND card_id=? AND outcome_json IS NULL ORDER BY attempt DESC LIMIT 1`
		)
		.get(key.collectionKey, key.cardId) as { specification_json: string } | undefined;
	return row ? JSON.parse(row.specification_json).runToken : undefined;
}

/** Compatibility for the existing desktop Stop button. Resolve only the exact
 * current persistent attempt; never declare a missing process terminated. */
export async function controlBoardRuntimeCard(
	projectRoot: string,
	boardId: string,
	cardId: string,
	operation: 'hold' | 'resume' = 'hold',
	read?: { sourceKey: string; collectionKey: string; revision: number; cardRevision: number }
) {
	const query = await prepareBoardWorkspaceQuery({ projectRoot });
	const entries = queryBoardWorkspace(query).collections.filter((e) => e.board.id === boardId);
	if (entries.length !== 1)
		throw new BoardStorageError('identity-mismatch', 'Ambiguous or missing Board identity');
	const entry = entries[0];
	const key = { sourceKey: entry.sourceKey, collectionKey: entry.collectionKey, cardId };
	if (read && (read.sourceKey !== key.sourceKey || read.collectionKey !== key.collectionKey))
		throw new BoardStorageError('identity-mismatch', 'Board identity changed since read');
	if (read && entry.revision !== read.revision)
		throw new BoardStorageError('stale-revision', 'Board changed since read');
	const runtime = await runtimeFor(key);
	if (!runtime) throw new BoardStorageError('runtime-unavailable', 'Board runtime is unavailable');
	const token = activeBoardRunToken(runtime, key);
	const card = entry.board.cards.find((c) => c.id === cardId);
	if (!card) throw new BoardStorageError('not-found', 'Card not found');
	if (read && card.storageRevision !== read.cardRevision)
		throw new BoardStorageError('stale-revision', 'Card changed since read');
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
