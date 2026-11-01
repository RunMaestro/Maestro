/** The existing Cue heartbeat owns central intake. Desktop and CLI attach to
 * these same per-card runtime adapters; storage, owner and run service are shared. */
import { refreshBoardSources } from './board-source-host';
import type { DataDirLock } from '../../shared/maestro-lib/runtime/data-dir-lock';
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
import type { BoardClaimHostContext, BoardRunSpecification } from './board-claims';
import { BoardRuntime, type BoardRunService } from './board-runtime';
import { executeBoardRuntimeCommand } from './board-runtime-host';
import type { BoardStorageFacade } from './board-storage';
import type { BoardTickResult } from '../../shared/board/commands';
import type { BoardCardKey } from './board-workspace-storage';

export interface BoardCueHostDeps {
	storage: () => BoardStorageFacade;
	lock: () => Pick<DataDirLock, 'info' | 'verify'> | null;
	context: (key: BoardCardKey) => Omit<BoardClaimHostContext, 'owner'>;
	prepare: (key: BoardCardKey) => Promise<void>;
	service: BoardRunService;
	ownerLiveness: (identity: string) => 'alive' | 'dead' | 'unknown';
	onChanged?: () => void;
	onCompleted?: (spec: BoardRunSpecification) => void;
	onTask?: (task: Promise<unknown>) => void;
	onWait: (key: BoardCardKey, reason: string) => void;
}

export class BoardCueHost {
	private runtimes = new Map<string, BoardRuntime>();
	private tasks = new Set<Promise<unknown>>();
	constructor(private readonly deps: BoardCueHostDeps) {}

	readonly runtimeFor = async (key: BoardCardKey): Promise<BoardRuntime | null> => {
		const lock = this.deps.lock();
		if (!lock || !lock.verify().ok) return null;
		await this.deps.prepare(key);
		const id = canonicalJson([key, lock.info]);
		let runtime = this.runtimes.get(id);
		if (!runtime) {
			const service: BoardRunService = {
				...this.deps.service,
				spawn: (spec, hooks) => {
					const task = this.deps
						.prepare(spec.key)
						.then(() => this.deps.service.spawn(spec, hooks))
						.finally(() => this.tasks.delete(task));
					this.tasks.add(task);
					this.deps.onTask?.(task);
					return task;
				},
			};
			runtime = new BoardRuntime(
				this.deps.storage(),
				lock,
				() => this.deps.context(key),
				service,
				this.deps.ownerLiveness,
				this.deps.onChanged,
				this.deps.onCompleted
			);
			if (!runtime.acquire().ok) return null;
			this.runtimes.set(id, runtime);
		}
		return runtime;
	};

	async tick(): Promise<void> {
		await refreshBoardSources();
		// All registered sources, including projects without an open Left Bar agent.
		const storage = this.deps.storage();
		for (const initial of storage.query().collections) {
			const entry = storage
				.query({ sourceKey: initial.sourceKey })
				.collections.find((c) => c.collectionKey === initial.collectionKey);
			if (!entry) continue;
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
