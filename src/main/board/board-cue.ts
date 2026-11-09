import { isBoardEnabled, requireBoardEnabled } from './board-feature';
/** The existing Cue heartbeat owns central intake. Desktop and CLI attach to
 * these same per-card runtime adapters; storage, owner and run service are shared. */
import { yieldToEventLoop } from '../utils/concurrency';
import { refreshBoardSources } from './board-source-host';
import { queueBoardReviews } from './board-review';
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
import { evaluateClaimWorker, persistedCaptureInput } from '../../shared/board/domain';
import { usesOwnBoardRepository } from '../../shared/board/worker-options';
import type { BoardCard } from '../../shared/board/types';
import { listBoardWorkers } from './board-workspace-storage';
import type { BoardClaimHostContext, BoardRunSpecification } from './board-claims';
import { BoardRuntime, type BoardRunService, type BoardRuntimeLock } from './board-runtime';
import { executeBoardRuntimeCommand } from './board-runtime-host';
import { BoardStorageError, type BoardStorageFacade } from './board-storage';
import type { BoardTickResult } from '../../shared/board/commands';
import type { BoardCardKey } from './board-workspace-storage';
import type { BoardTransitionsListener } from './board-transitions';
import {
	prepareBoardRepositoryAccess,
	currentBoardRepositoryAccess,
	type BoardRepositoryObservation,
} from './board-repository-access';

/** Native IO evidence belongs to one runtime lookup and its launch attempt. */
export type BoardPreparedContext = Pick<BoardClaimHostContext, 'repository' | 'reviewArtifact'>;

export interface BoardCueHostDeps {
	storage: () => BoardStorageFacade;
	lock: () => BoardRuntimeLock | null | Promise<BoardRuntimeLock | null>;
	context: (
		key: BoardCardKey,
		prepared: BoardPreparedContext
	) => Omit<BoardClaimHostContext, 'owner'>;
	prepare: (key: BoardCardKey) => Promise<BoardPreparedContext>;
	service: BoardRunService;
	ownerLiveness: (identity: string) => 'alive' | 'dead' | 'unknown';
	onChanged?: () => void;
	onCompleted?: (spec: BoardRunSpecification) => void;
	onTransitions?: BoardTransitionsListener;
	onTask?: (task: Promise<unknown>) => void;
	onWait: (key: BoardCardKey, reason: string) => void;
}

export class BoardCueHost {
	private runtimes = new Map<string, BoardRuntime>();
	private tasks = new Set<Promise<unknown>>();
	constructor(private readonly deps: BoardCueHostDeps) {}

	readonly runtimeFor = async (key: BoardCardKey, prepare = true): Promise<BoardRuntime | null> => {
		requireBoardEnabled();
		const lock = await this.deps.lock();
		requireBoardEnabled();
		if (!lock)
			throw new BoardStorageError(
				'runtime-unavailable',
				'Board runtime unavailable: native Cue ownership is not held by this process'
			);
		const verified = lock.verify();
		if (!verified.ok)
			throw new BoardStorageError(
				'owner-conflict',
				'Board runtime refused: native Cue ownership could not be verified'
			);
		const id = canonicalJson([key, lock.info]);
		// Control-only lookups may reuse the adapter. A preparation must never
		// overwrite evidence being consumed by another asynchronous lookup.
		if (!prepare && this.runtimes.has(id)) return this.runtimes.get(id)!;
		let repositoryAccess: BoardRepositoryObservation | undefined;
		// Probe selection only. Authority still comes from native Git and the complete
		// claim checks; unrelated agents/repositories do not enter this start's IO path.
		const repositoryAgents = () => {
			const storage = this.deps.storage();
			const card = storage.workspace
				.readCollection(key)
				?.cards.find((card) => card.cardId === key.cardId)?.payload;
			if (!card) return [];
			const catalog = storage.captureCatalog();
			const workers = listBoardWorkers(storage.db).map((worker) => ({
				...worker,
				roleRefs: Array.isArray(worker.payload.roleRefs) ? worker.payload.roleRefs : [],
				allowedRepositoryIds: Array.isArray(worker.payload.allowedRepositoryIds)
					? worker.payload.allowedRepositoryIds
					: [],
			}));
			const candidates = new Set(
				workers
					.filter((worker) => {
						if (!usesOwnBoardRepository(worker.payload)) return false;
						if (worker.agentId === card.reviewerAgentId) return true;
						const reason = evaluateClaimWorker(
							persistedCaptureInput(card as unknown as BoardCard, card),
							worker.agentId,
							{
								...catalog,
								canRelaxStartPolicy: true,
								workers,
								repositoryIds: catalog.repositories
									.filter((repo) => repo.validated)
									.map((repo) => repo.id),
							},
							'result'
						);
						return reason === null || reason === 'worker-repository-mismatch';
					})
					.map((worker) => worker.agentId)
			);
			return storage.repositoryAgents().filter((agent) => candidates.has(agent.id));
		};
		const prepareAttempt = async (target: BoardCardKey) => {
			const fresh = await this.deps.prepare(target);
			requireBoardEnabled();
			const storage = this.deps.storage();
			repositoryAccess = await prepareBoardRepositoryAccess(
				repositoryAgents(),
				storage.captureCatalog().repositories.filter((repo) => repo.id === fresh.repository?.id)
			);
			requireBoardEnabled();
			return fresh;
		};
		let prepared: BoardPreparedContext = prepare
			? await prepareAttempt(key)
			: { repository: null, reviewArtifact: null };
		const service: BoardRunService = {
			...this.deps.service,
			spawn: (spec, hooks) => {
				requireBoardEnabled();
				// Revoke this attempt's previous evidence before fresh launch IO.
				prepared = { repository: null, reviewArtifact: null };
				repositoryAccess = undefined;
				const task = prepareAttempt(spec.key)
					.then((fresh) => {
						requireBoardEnabled();
						prepared = fresh;
						return this.deps.service.spawn(spec, hooks);
					})
					.finally(() => this.tasks.delete(task));
				this.tasks.add(task);
				this.deps.onTask?.(task);
				return task;
			},
		};
		requireBoardEnabled();
		const runtime = new BoardRuntime(
			this.deps.storage(),
			lock,
			() => {
				const context = this.deps.context(key, prepared);
				const storage = this.deps.storage();
				return {
					...context,
					ownRepositoryIds: currentBoardRepositoryAccess(
						repositoryAccess,
						repositoryAgents(),
						storage
							.captureCatalog()
							.repositories.filter((repo) => repo.id === context.repository?.id)
					),
				};
			},
			service,
			this.deps.ownerLiveness,
			this.deps.onChanged,
			this.deps.onCompleted,
			this.deps.onTransitions
		);
		const acquired = runtime.acquire();
		if (!acquired.ok) {
			this.deps.onWait(key, acquired.reason);
			// Keep the admission failure visible to intake and future native probes.
			if (acquired.reason === 'owner-identity-unavailable') {
				throw new BoardStorageError(
					acquired.reason,
					'Board owner identity unavailable; native host proof is required'
				);
			}
			throw new BoardStorageError(acquired.reason, 'Board runtime refused: ' + acquired.reason);
		}
		this.runtimes.set(id, runtime);
		return runtime;
	};

	async tick(): Promise<void> {
		if (!isBoardEnabled()) return;
		await refreshBoardSources();
		if (!isBoardEnabled()) return;
		// All registered sources, including projects without an open Left Bar agent.
		const storage = this.deps.storage();
		const awaitingReview = storage
			.query()
			.collections.flatMap((entry) => entry.board.cards)
			.filter(
				(card) => card.status === 'review' && !!card.reviewerAgentId && !!card.workflow?.workRunId
			);
		const reviewers = new Set(awaitingReview.map((card) => card.reviewerAgentId));
		const repositories = new Set(awaitingReview.map((card) => card.repositoryId));
		const reviewRepositories = storage
			.captureCatalog()
			.repositories.filter((repo) => repositories.has(repo.id));
		const reviewAgents = () =>
			storage.repositoryAgents().filter((agent) => reviewers.has(agent.id));
		const reviewAccess = await prepareBoardRepositoryAccess(reviewAgents(), reviewRepositories);
		if (!isBoardEnabled()) return;
		queueBoardReviews(
			storage,
			this.deps.onTransitions,
			currentBoardRepositoryAccess(
				reviewAccess,
				reviewAgents(),
				storage.captureCatalog().repositories.filter((repo) => repositories.has(repo.id))
			)
		);
		for (const initial of storage.query().collections) {
			await yieldToEventLoop();
			const entry = storage.workspace.readCollection(initial);
			if (!entry || entry.archived) continue;
			const result = await executeBoardRuntimeCommand({
				action: 'tick',
				operationId: generateUUID(),
				target: {
					sourceKey: entry.sourceKey,
					collectionKey: entry.collectionKey,
					expectedRevision: entry.revision,
				},
			});
			if (!result.ok) {
				this.deps.onWait({ ...entry, cardId: '*' }, result.error.code);
			} else if (Array.isArray(result.value)) {
				for (const card of result.value as BoardTickResult[]) {
					if (!card.ok)
						this.deps.onWait({ ...entry, cardId: card.cardId }, card.reason ?? 'waiting');
				}
			}
		}
		// Legacy uncertain runs have migration_worker_holds, not runtime tokens.
		// Only the durable reservation identifies attempts owned by this runtime.
		for (const row of storage.db
			.prepare(
				`SELECT runs.specification_json FROM runs
          JOIN reservations ON reservations.run_id = runs.run_id
          WHERE runs.outcome_json IS NULL`
			)
			.all() as { specification_json: string }[]) {
			const spec = JSON.parse(row.specification_json) as BoardRunSpecification;
			const runtime = await this.runtimeFor(spec.key, false);
			runtime?.reconcile(spec.runToken);
		}
	}

	async settle(): Promise<void> {
		await Promise.allSettled([...this.tasks]);
	}
	stop(): void {
		const stopped = new Set<string>();
		for (const runtime of this.runtimes.values()) {
			for (const row of runtime.storage.db
				.prepare(
					`SELECT runs.specification_json FROM runs
          JOIN reservations ON reservations.run_id = runs.run_id
          WHERE runs.outcome_json IS NULL`
				)
				.all() as { specification_json: string }[]) {
				const spec = JSON.parse(row.specification_json) as BoardRunSpecification;
				if (
					spec.owner.processIdentity === runtime.processIdentity &&
					!stopped.has(spec.runToken.runId)
				) {
					stopped.add(spec.runToken.runId);
					runtime.hold(spec.runToken);
				}
			}
		}
	}
}
