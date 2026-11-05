/** Committed status receipts for the existing Board lifecycle writers. */
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
import { validateBoard } from '../../shared/board/types';
import { captureException } from '../utils/sentry';
import {
	diffCardStatuses,
	snapshotCardStatuses,
	type CardNotification,
	type CardStatusChange,
} from './board-dispatcher';
import type { BoardRunSpecification, BoardRunToken } from './board-claims';
import type { BoardStorageFacade } from './board-storage';
import type { BoardCardKey, BoardCollectionSnapshot } from './board-workspace-storage';

export type BoardTransitionPhase = 'started' | 'result' | 'review-queue' | 'human';
export interface BoardTransitionReceipt {
	readonly key: Readonly<BoardCardKey>;
	readonly change: Readonly<CardStatusChange>;
	readonly revision: Readonly<{ collection: number; beforeCard: number; card: number }>;
	readonly runToken?: Readonly<BoardRunToken>;
	readonly cause: Readonly<{ runId: string; phase: BoardTransitionPhase; commitId: string }>;
	/** Toast data stays separate from metadata-only status/plugin events. */
	readonly notification?: Readonly<CardNotification>;
}
export type BoardTransitionsListener = (receipts: readonly BoardTransitionReceipt[]) => void;

/** Called inside the writer transaction. No listener means no extra projection. */
export function snapshotBoardTransitions(
	storage: BoardStorageFacade,
	key: BoardCardKey,
	listener?: BoardTransitionsListener
): BoardCollectionSnapshot | null {
	return listener ? storage.workspace.readCollection(key) : null;
}

/** The four bounded commit markers live on the existing run lifecycle, not an
 * outbox. A fresh marker distinguishes a rolled-back write from an identical retry.
 * The microtask runs after the synchronous owning transaction, including savepoints.
 * Only this run/phase marker and each affected card's minimum revision matter;
 * unrelated workspace/collection writes must not invalidate committed receipts.
 * Rejected/no-op writes create no marker; existing attempt/approval fences dedupe
 * successful writes across adapters. Nothing is replayed on process restart. */
export function recordBoardTransitions(
	storage: BoardStorageFacade,
	before: BoardCollectionSnapshot | null,
	key: BoardCardKey,
	runId: string,
	phase: BoardTransitionPhase,
	listener?: BoardTransitionsListener
): void {
	if (!before || !listener) return;
	if (!storage.db.inTransaction)
		throw new Error('Board transitions require the writer transaction');
	const after = storage.workspace.readCollection(key);
	if (!after) return;
	const board = validateBoard({ ...after.payload, cards: after.cards.map((card) => card.payload) });
	const old = validateBoard({ ...before.payload, cards: before.cards.map((card) => card.payload) });
	if (!board || !old) throw new Error('Invalid Board during transition capture');
	const changes = diffCardStatuses(board, snapshotCardStatuses(old));
	if (!changes.length) return;
	const row = storage.db
		.prepare(
			'SELECT specification_json, lifecycle_json FROM runs WHERE run_id=? AND collection_key=? AND card_id=?'
		)
		.get(runId, key.collectionKey, key.cardId) as
		| { specification_json: string; lifecycle_json: string | null }
		| undefined;
	if (!row) throw new Error('Board transition requires its bound run');
	const commitId = generateUUID();
	const life = row.lifecycle_json ? JSON.parse(row.lifecycle_json) : { phase: 'finished' };
	storage.db.prepare('UPDATE runs SET lifecycle_json=? WHERE run_id=?').run(
		canonicalJson({
			...life,
			transitionCommits: { ...life.transitionCommits, [phase]: commitId },
		}),
		runId
	);
	const cause = Object.freeze({ runId, phase, commitId });
	const receipts = Object.freeze(
		changes.map((change): BoardTransitionReceipt => {
			const card = board.cards.find((card) => card.id === change.cardId)!;
			const run = card.runs?.at(-1);
			const attempt = run?.runId
				? (storage.db
						.prepare(
							'SELECT specification_json FROM runs WHERE run_id=? AND collection_key=? AND card_id=?'
						)
						.get(run.runId, key.collectionKey, card.id) as
						| { specification_json: string }
						| undefined)
				: undefined;
			const token =
				attempt && (JSON.parse(attempt.specification_json) as BoardRunSpecification).runToken;
			const kind =
				card.kind !== 'review'
					? change.toStatus === 'done'
						? 'done'
						: change.toStatus === 'blocked'
							? 'blocked'
							: ['review', 'ready-for-human'].includes(change.toStatus)
								? 'review'
								: undefined
					: undefined;
			return Object.freeze({
				key: Object.freeze({
					sourceKey: key.sourceKey,
					collectionKey: key.collectionKey,
					cardId: card.id,
				}),
				change: Object.freeze(change),
				revision: Object.freeze({
					collection: after.revision,
					beforeCard: before.cards.find((entry) => entry.cardId === card.id)!.revision,
					card: after.cards.find((entry) => entry.cardId === card.id)!.revision,
				}),
				...(token ? { runToken: Object.freeze({ ...token }) } : {}),
				cause,
				...(kind
					? {
							notification: Object.freeze({
								kind,
								boardId: change.boardId,
								cardId: card.id,
								cardTitle: card.title,
								...(run ? { attempt: run.attempt, outcome: run.outcome } : {}),
								...(run?.workerAgentId ? { workerAgentId: run.workerAgentId } : {}),
								...(run?.summary ? { detail: run.summary } : {}),
								...(run?.worktreeBranch ? { worktreeBranch: run.worktreeBranch } : {}),
							}),
						}
					: {}),
			});
		})
	);
	queueMicrotask(() => {
		try {
			if (!storage.db.open || storage.db.inTransaction) return;
			const committed = storage.db
				.prepare('SELECT specification_json, lifecycle_json FROM runs WHERE run_id=?')
				.get(runId) as typeof row;
			if (
				committed?.specification_json !== row.specification_json ||
				!committed.lifecycle_json ||
				JSON.parse(committed.lifecycle_json).transitionCommits?.[phase] !== commitId
			)
				return;
			const durable = receipts.filter((receipt) => {
				const current = storage.workspace.readCard(receipt.key);
				return current && current.revision >= receipt.revision.card;
			});
			if (durable.length) listener(Object.freeze(durable));
		} catch (error) {
			void captureException(error, { operation: 'board:transitions' });
		}
	});
}
