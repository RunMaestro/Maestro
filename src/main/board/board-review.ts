/** Source-attempt handoff. Git IO stays outside the write transaction; the exact
 * observed source outcome is checked again inside the atomic capture callback. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { generateUUID } from '../../shared/uuid';
import { evaluateClaimWorker } from '../../shared/board/domain';
import { listBoardWorkers, type BoardCardKey } from './board-workspace-storage';
import type {
	BoardCard,
	BoardCaptureCommand,
	BoardRunArtifact,
	BoardReviewHandoff,
	CardRun,
} from '../../shared/board/types';
import { canonicalJson } from '../../shared/canonicalJson';
import { execGitReadOnly } from '../utils/remote-git';
import {
	recordBoardTransitions,
	snapshotBoardTransitions,
	type BoardTransitionsListener,
} from './board-transitions';
import {
	BoardStorageError,
	captureBoardCard,
	getBoardStorage,
	type BoardStorageFacade,
} from './board-storage';

/** No inferred commit, dirty checkout, detached branch or caller-reported SHA. */
export async function readBoardRunArtifact(
	cwd: string,
	baseCommit?: string
): Promise<BoardRunArtifact | null> {
	const git = await execGitReadOnly(['status', '--porcelain', '--untracked-files=normal'], cwd);
	if (git.exitCode !== 0 || git.stdout.trim()) return null;
	const head = await execGitReadOnly(['rev-parse', '--verify', 'HEAD^{commit}'], cwd);
	const branch = await execGitReadOnly(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
	if (head.exitCode !== 0 || branch.exitCode !== 0 || !/^[a-f0-9]{40}$/i.test(head.stdout.trim()))
		return null;
	const artifact: BoardRunArtifact = {
		worktreePath: fs.realpathSync(cwd),
		branch: branch.stdout.trim(),
		commit: head.stdout.trim(),
	};
	if (baseCommit) {
		if (!/^[a-f0-9]{40}$/i.test(baseCommit)) return null;
		const diff = await execGitReadOnly(
			['diff', '--binary', '--no-ext-diff', baseCommit, artifact.commit, '--'],
			cwd
		);
		const stat = await execGitReadOnly(
			['diff', '--stat', '--no-ext-diff', baseCommit, artifact.commit, '--'],
			cwd
		);
		if (diff.exitCode !== 0 || stat.exitCode !== 0) return null;
		artifact.diff = {
			baseCommit,
			sha256: createHash('sha256').update(diff.stdout).digest('hex'),
			stat: stat.stdout,
		};
	}
	return artifact;
}

export async function captureBoardCardFromHost(command: BoardCaptureCommand, human = false) {
	if (!command.reviewSource) return captureBoardCard(command, human);
	const request = command.reviewSource;
	if (
		!request ||
		typeof request.cardId !== 'string' ||
		!Number.isSafeInteger(request.attempt) ||
		request.attempt < 1
	)
		throw new BoardStorageError('invalid-input', 'Invalid review source attempt');
	const storage = getBoardStorage();
	const board = storage.read(command.projectRoot, command.boardId);
	const key = board.storage!;
	if (
		board.cards.some((card) => card.id === command.card.id) ||
		command.card.kind !== 'review' ||
		!command.card.parents.includes(request.cardId)
	)
		throw new BoardStorageError(
			'protected-field',
			'A review handoff requires a new dependent review card'
		);
	const source = storage.db
		.prepare(
			'SELECT run_id, outcome_json FROM runs WHERE collection_key=? AND card_id=? AND attempt=?'
		)
		.get(key.collectionKey, request.cardId, request.attempt) as
		| { run_id: string; outcome_json: string | null }
		| undefined;
	const outcome = source?.outcome_json ? JSON.parse(source.outcome_json) : null;
	const run = outcome?.cardOutcome?.run as CardRun | undefined;
	const specification = storage.db
		.prepare('SELECT specification_json FROM runs WHERE run_id=?')
		.get(source?.run_id ?? '') as { specification_json: string } | undefined;
	const spec = specification ? JSON.parse(specification.specification_json) : null;
	const work = board.cards.find((card) => card.id === request.cardId);
	if (
		!source ||
		!work ||
		work.kind === 'review' ||
		work.status !== 'review' ||
		!!work.workflow?.reviewCardId ||
		(!!work.workflow?.workRunId && work.workflow.workRunId !== source.run_id) ||
		!command.card.assigneeAgentId ||
		canonicalJson(command.card.executionScope) !== canonicalJson(work.executionScope) ||
		!run?.endedAt ||
		!['done', 'review'].includes(run.outcome ?? '') ||
		!run.artifact ||
		!run.summary?.trim() ||
		spec?.card.repositoryId !== command.card.repositoryId
	)
		throw new BoardStorageError(
			'invalid-input',
			'Review requires a completed source attempt with a clean artifact and reported checks'
		);
	if (spec?.repository?.location?.kind === 'ssh')
		throw new BoardStorageError(
			'legacy-mapping-missing',
			'Remote review artifact requires an explicit remote artifact adapter'
		);
	const artifact = await readBoardRunArtifact(
		run.artifact.worktreePath,
		run.artifact.diff?.baseCommit
	);
	if (!artifact || canonicalJson(artifact) !== canonicalJson(run.artifact))
		throw new BoardStorageError(
			'invalid-input',
			'Source artifact changed or has uncommitted changes'
		);
	const handoff: BoardReviewHandoff = {
		repositoryId: command.card.repositoryId!,
		sourceKey: key.sourceKey,
		collectionKey: key.collectionKey,
		cardId: request.cardId,
		runId: source.run_id,
		attempt: request.attempt,
		artifact,
		checks: run.summary,
	};
	return captureBoardCard(command, human, () => {
		const current = storage.db
			.prepare('SELECT outcome_json FROM runs WHERE run_id=?')
			.get(source.run_id) as { outcome_json: string } | undefined;
		if (current?.outcome_json !== source.outcome_json)
			throw new BoardStorageError(
				'stale-revision',
				'Source run changed while preparing the review'
			);
		const row = storage.db
			.prepare('SELECT payload_json FROM cards WHERE collection_key=? AND id=?')
			.get(key.collectionKey, command.card.id) as { payload_json: string };
		storage.db
			.prepare('UPDATE cards SET payload_json=? WHERE collection_key=? AND id=?')
			.run(
				canonicalJson({ ...JSON.parse(row.payload_json), reviewHandoff: handoff }),
				key.collectionKey,
				command.card.id
			);
		work.reviewerAgentId = command.card.assigneeAgentId;
		work.workflow = {
			...work.workflow,
			version: 1,
			corrections: work.workflow?.corrections ?? 0,
			workRunId: source.run_id,
			reviewCardId: command.card.id,
		};
		writeWorkflowCard(storage, { ...key, cardId: work.id }, work);
	});
}

/** Recheck the bound attempt and checkout before each native claim/preparation. */
export async function prepareBoardReviewHandoff(
	storage: BoardStorageFacade,
	handoff: BoardReviewHandoff
): Promise<string | null> {
	if (!handoff?.artifact || typeof handoff.artifact.worktreePath !== 'string') return null;
	const row = storage.db
		.prepare(
			'SELECT specification_json, outcome_json FROM runs WHERE run_id=? AND collection_key=? AND card_id=? AND attempt=?'
		)
		.get(handoff.runId, handoff.collectionKey, handoff.cardId, handoff.attempt) as
		| { specification_json: string; outcome_json: string | null }
		| undefined;
	if (!row?.outcome_json) return null;
	const spec = JSON.parse(row.specification_json);
	if (spec.repository?.location?.kind === 'ssh') return null;
	const run = JSON.parse(row.outcome_json).cardOutcome?.run;
	if (
		spec.key?.sourceKey !== handoff.sourceKey ||
		spec.card?.repositoryId !== handoff.repositoryId ||
		!run?.artifact ||
		run.summary !== handoff.checks ||
		canonicalJson(run.artifact) !== canonicalJson(handoff.artifact)
	)
		return null;
	const artifact = await readBoardRunArtifact(
		handoff.artifact.worktreePath,
		handoff.artifact.diff?.baseCommit
	);
	return artifact && canonicalJson(artifact) === canonicalJson(handoff.artifact)
		? canonicalJson(handoff)
		: null;
}

/** Workflow writes run inside the caller's existing SQLite transaction. */
function writeWorkflowCard(storage: BoardStorageFacade, key: BoardCardKey, card: BoardCard): void {
	const { storageRevision: _revision, ...payload } = card;
	storage.db
		.prepare('UPDATE cards SET payload_json=?, revision=revision+1 WHERE collection_key=? AND id=?')
		.run(
			canonicalJson({ ...payload, updatedAt: new Date().toISOString() }),
			key.collectionKey,
			key.cardId
		);
	storage.db
		.prepare('UPDATE collections SET revision=revision+1 WHERE collection_key=?')
		.run(key.collectionKey);
	storage.db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
}

/** Preserve the successful attempt; incomplete evidence never enters the review queue.
 * The existing revision-checked To Do request can retry this same card. */
export function recoverIncompleteBoardReview(
	work: BoardCard,
	run: CardRun,
	runId: string
): boolean {
	const missing: ('summary' | 'artifact')[] = [];
	if (!run.summary?.trim()) missing.push('summary');
	if (!run.artifact?.diff) missing.push('artifact');
	if (!missing.length) return false;
	work.status = 'blocked';
	work.workflow = {
		...work.workflow,
		version: 1,
		corrections: work.workflow?.corrections ?? 0,
		workRunId: runId,
		evidenceIncomplete: { runId, missing },
	};
	return true;
}

/** Called by the existing Cue heartbeat and native completion, never a second scheduler.
 * A missing/removed reviewer leaves work in Review. Busy reviewers get a normal queued task. */
export function queueBoardReviews(
	storage: BoardStorageFacade,
	onTransitions?: BoardTransitionsListener
): void {
	storage.db
		.transaction(() => {
			for (const entry of storage.query().collections) {
				for (const work of entry.board.cards) {
					if (work.kind === 'review' || work.status !== 'review' || !work.workflow?.workRunId)
						continue;
					if (work.workflow.reviewCardId) {
						const previous = entry.board.cards.find(
							(card) => card.id === work.workflow!.reviewCardId
						);
						if (
							!previous ||
							previous.assigneeAgentId === work.reviewerAgentId ||
							storage.db
								.prepare('SELECT 1 FROM reservations WHERE collection_key=? AND card_id=?')
								.get(entry.collectionKey, previous.id)
						)
							continue;
						previous.heldByUser = true;
						writeWorkflowCard(storage, { ...entry, cardId: previous.id }, previous);
						work.workflow.reviewCardId = undefined;
						writeWorkflowCard(storage, { ...entry, cardId: work.id }, work);
					}
					const source = storage.db
						.prepare(
							'SELECT outcome_json FROM runs WHERE run_id=? AND collection_key=? AND card_id=?'
						)
						.get(work.workflow.workRunId, entry.collectionKey, work.id) as
						| { outcome_json: string | null }
						| undefined;
					const outcome = source?.outcome_json ? JSON.parse(source.outcome_json) : null;
					const run = outcome?.cardOutcome?.run as CardRun | undefined;
					// Also recover pre-existing successes stranded before a reviewer could be queued.
					if (
						!work.workflow.reviewCardId &&
						run?.runId === work.workflow.workRunId &&
						run?.endedAt &&
						['done', 'review'].includes(run.outcome ?? '') &&
						recoverIncompleteBoardReview(work, run, work.workflow.workRunId)
					) {
						const key = { ...entry, cardId: work.id };
						const before = snapshotBoardTransitions(storage, key, onTransitions);
						writeWorkflowCard(storage, key, work);
						recordBoardTransitions(
							storage,
							before,
							key,
							work.workflow.workRunId,
							'review-queue',
							onTransitions
						);
						continue;
					}
					if (!work.reviewerAgentId) continue;
					if (
						!run?.artifact?.diff ||
						!run.summary?.trim() ||
						!run.endedAt ||
						!['done', 'review'].includes(run.outcome ?? '')
					)
						continue;
					const catalog = storage.captureCatalog();
					const id = generateUUID();
					const review: BoardCard = {
						id,
						title: `Review: ${work.title}`,
						body: 'Review the exact host-bound work artifact and report checks and any confirmed findings.',
						kind: 'review',
						status: 'todo',
						parents: [work.id],
						executionScope: work.executionScope,
						assigneeAgentId: work.reviewerAgentId,
						repositoryId: work.repositoryId,
						workingDirectory: work.workingDirectory,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						workflow: { version: 1, corrections: 0 },
						reviewHandoff: {
							repositoryId: work.repositoryId!,
							sourceKey: entry.sourceKey,
							collectionKey: entry.collectionKey,
							cardId: work.id,
							runId: work.workflow.workRunId,
							attempt: run.attempt,
							artifact: run.artifact,
							checks: run.summary,
						},
						// Review is part of the already authorized work specification, including its reviewer.
						capturePolicy: work.capturePolicy
							? {
									...work.capturePolicy,
									specificationRevision: 0,
									...(work.capturePolicy.grant
										? { grant: { ...work.capturePolicy.grant, specificationRevision: 0 } }
										: {}),
								}
							: undefined,
					};
					const reason = evaluateClaimWorker(review, work.reviewerAgentId, {
						...catalog,
						canRelaxStartPolicy: true,
						repositoryIds: catalog.repositories
							.filter((repo) => repo.validated)
							.map((repo) => repo.id),
						workers: listBoardWorkers(storage.db).map((worker) => ({
							...worker,
							roleRefs: Array.isArray(worker.payload.roleRefs) ? worker.payload.roleRefs : [],
							allowedRepositoryIds: Array.isArray(worker.payload.allowedRepositoryIds)
								? worker.payload.allowedRepositoryIds
								: [],
						})),
					});
					if (reason && !['worker-paused', 'worker-disabled'].includes(reason)) continue;
					storage.db
						.prepare('INSERT INTO cards (collection_key, id, payload_json) VALUES (?, ?, ?)')
						.run(entry.collectionKey, id, canonicalJson(review));
					work.workflow.reviewCardId = id;
					writeWorkflowCard(storage, { ...entry, cardId: work.id }, work);
				}
			}
		})
		.immediate();
}

/** A review result can affect only the exact current work attempt and assigned reviewer. */
export function applyBoardReviewResult(
	storage: BoardStorageFacade,
	key: BoardCardKey,
	review: BoardCard,
	runId: string,
	verdict: 'clean' | 'findings',
	summary: string
): boolean {
	const handoff = review.reviewHandoff;
	if (!handoff || !summary.trim()) return false;
	const collection = storage.workspace.readCollection(key);
	const work = collection?.cards.find((card) => card.cardId === handoff.cardId)
		?.payload as unknown as BoardCard | undefined;
	if (
		!work ||
		work.status !== 'review' ||
		work.workflow?.reviewCardId !== review.id ||
		work.workflow.workRunId !== handoff.runId ||
		work.reviewerAgentId !== review.assigneeAgentId
	)
		return false;
	const catalog = storage.captureCatalog();
	if (
		evaluateClaimWorker(
			review,
			review.assigneeAgentId!,
			{
				...catalog,
				canRelaxStartPolicy: true,
				repositoryIds: catalog.repositories.filter((repo) => repo.validated).map((repo) => repo.id),
				workers: listBoardWorkers(storage.db).map((worker) => ({
					...worker,
					roleRefs: Array.isArray(worker.payload.roleRefs) ? worker.payload.roleRefs : [],
					allowedRepositoryIds: Array.isArray(worker.payload.allowedRepositoryIds)
						? worker.payload.allowedRepositoryIds
						: [],
				})),
			},
			'result'
		)
	)
		return false;
	work.workflow.reviewResult = {
		workRunId: handoff.runId,
		reviewRunId: runId,
		reviewCardId: review.id,
		verdict,
		summary,
	};
	if (verdict === 'clean') work.status = 'ready-for-human';
	else if (work.workflow.corrections < 1) {
		work.workflow.corrections++;
		work.workflow.reviewCardId = undefined;
		work.status = 'todo';
	} else {
		work.status = 'blocked';
		work.workflow.correctionLimitReached = true;
	}
	writeWorkflowCard(storage, { ...key, cardId: work.id }, work);
	return true;
}

/** Explicit final native decision, distinct from start approval and ordinary status requests. */
export function approveBoardWork(
	storage: BoardStorageFacade,
	key: BoardCardKey,
	collectionRevision: number,
	cardRevision: number,
	principal: string,
	onTransitions?: BoardTransitionsListener
): void {
	storage.db
		.transaction(() => {
			const collection = storage.workspace.readCollection(key);
			const row = collection?.cards.find((card) => card.cardId === key.cardId);
			if (!row || collection?.revision !== collectionRevision || row.revision !== cardRevision)
				throw new BoardStorageError('stale-revision', 'Work changed since read');
			const work = row.payload as unknown as BoardCard;
			const result = work.workflow?.reviewResult;
			if (
				!principal ||
				work.status !== 'ready-for-human' ||
				result?.verdict !== 'clean' ||
				work.workflow?.workRunId !== result.workRunId
			)
				throw new BoardStorageError(
					'protected-field',
					'Final approval requires a clean bound review'
				);
			const review = collection.cards.find((card) => card.cardId === result.reviewCardId)
				?.payload as unknown as BoardCard | undefined;
			if (!review?.reviewHandoff || review.reviewHandoff.runId !== result.workRunId)
				throw new BoardStorageError('protected-field', 'Bound review task missing');
			for (const [runId, cardId] of [
				[result.workRunId, work.id],
				[result.reviewRunId, review.id],
			]) {
				const attempt = storage.db
					.prepare(
						'SELECT specification_json, lifecycle_json, outcome_json FROM runs WHERE run_id=? AND collection_key=? AND card_id=?'
					)
					.get(runId, key.collectionKey, cardId) as
					| {
							specification_json: string;
							lifecycle_json: string | null;
							outcome_json: string | null;
					  }
					| undefined;
				const specification = attempt && JSON.parse(attempt.specification_json);
				const lifecycle = attempt?.lifecycle_json && JSON.parse(attempt.lifecycle_json);
				const outcome = attempt?.outcome_json && JSON.parse(attempt.outcome_json);
				if (
					specification?.runToken?.runId !== runId ||
					lifecycle?.phase !== 'finished' ||
					lifecycle.process?.cueRunId !== runId ||
					!lifecycle.launchAuthorized ||
					outcome?.result?.executionStarted !== true ||
					outcome.result.terminationConfirmed !== true
				)
					throw new BoardStorageError(
						'protected-field',
						'Final approval requires native work and review evidence'
					);
			}
			const before = snapshotBoardTransitions(storage, key, onTransitions);
			work.workflow.humanDecision = {
				principal,
				decidedAt: new Date().toISOString(),
				workRunId: result.workRunId,
				reviewRunId: result.reviewRunId,
			};
			work.status = 'done';
			writeWorkflowCard(storage, key, work);
			if (review) {
				review.status = 'done';
				review.workflow = {
					...review.workflow,
					version: 1,
					corrections: review.workflow?.corrections ?? 0,
					humanDecision: work.workflow.humanDecision,
				};
				writeWorkflowCard(storage, { ...key, cardId: review.id }, review);
			}
			recordBoardTransitions(storage, before, key, result.workRunId, 'human', onTransitions);
		})
		.immediate();
}
