/** The existing Cue heartbeat owns central intake. Desktop and CLI attach to
 * these same per-card runtime adapters; storage, owner and run service are shared. */
import { yieldToEventLoop } from '../utils/concurrency';
import { refreshBoardSources } from './board-source-host';
import { queueBoardReviews } from './board-review';
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
import type { BoardClaimHostContext, BoardRunSpecification } from './board-claims';
import { BoardRuntime, type BoardRunService, type BoardRuntimeLock } from './board-runtime';
import { executeBoardRuntimeCommand } from './board-runtime-host';
import { BoardStorageError, type BoardStorageFacade } from './board-storage';
import type { BoardTickResult } from '../../shared/board/commands';
import type { BoardCardKey } from './board-workspace-storage';
import type { BoardTransitionsListener } from './board-transitions';

/** Native IO evidence belongs to one runtime lookup and its launch attempt. */
export type BoardPreparedContext = Pick<BoardClaimHostContext, 'repository' | 'reviewArtifact'>;

export interface BoardCueHostDeps {
	storage: () => BoardStorageFacade;
	lock: () => BoardRuntimeLock | null;
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
		const lock = this.deps.lock();
		if (!lock || !lock.verify().ok) return null;
		const id = canonicalJson([key, lock.info]);
		// Control-only lookups may reuse the adapter. A preparation must never
		// overwrite evidence being consumed by another asynchronous lookup.
		if (!prepare && this.runtimes.has(id)) return this.runtimes.get(id)!;
		let prepared: BoardPreparedContext = prepare
			? await this.deps.prepare(key)
			: { repository: null, reviewArtifact: null };
		const service: BoardRunService = {
			...this.deps.service,
			spawn: (spec, hooks) => {
				// Revoke this attempt's previous evidence before fresh launch IO.
				prepared = { repository: null, reviewArtifact: null };
				const task = this.deps
					.prepare(spec.key)
					.then((fresh) => {
						prepared = fresh;
						return this.deps.service.spawn(spec, hooks);
					})
					.finally(() => this.tasks.delete(task));
				this.tasks.add(task);
				this.deps.onTask?.(task);
				return task;
			},
		};
		const runtime = new BoardRuntime(
			this.deps.storage(),
			lock,
			() => this.deps.context(key, prepared),
			service,
			this.deps.ownerLiveness,
			this.deps.onChanged,
			this.deps.onCompleted,
			this.deps.onTransitions
		);
		const acquired = runtime.acquire();
		if (!acquired.ok) {
			// Keep the admission failure visible to intake and future native probes.
			if (acquired.reason === 'owner-identity-unavailable') {
				this.deps.onWait(key, acquired.reason);
				throw new BoardStorageError(
					acquired.reason,
					'Board owner identity unavailable; native host proof is required'
				);
			}
			return null;
		}
		this.runtimes.set(id, runtime);
		return runtime;
	};

	async tick(): Promise<void> {
		await refreshBoardSources();
		// All registered sources, including projects without an open Left Bar agent.
		const storage = this.deps.storage();
		queueBoardReviews(storage, this.deps.onTransitions);
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
			const runtime = await this.runtimeFor(spec.key);
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
