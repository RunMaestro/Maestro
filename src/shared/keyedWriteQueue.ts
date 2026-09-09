/**
 * Per-key serialization of async work: two callers racing on the same entity
 * lose an update, and giving each key its own promise chain makes that
 * unreachable while leaving different keys concurrent.
 *
 * It lives in `shared/` rather than beside `atomicWriteJson` because BOTH
 * processes need it and the renderer cannot import a module that pulls in
 * `fs/promises`. `src/main/utils/atomic-json-store.ts` re-exports it, so every
 * main-process caller keeps its existing import. Same hoist, for the same
 * reason, as `assertSerializedJsonIsSafe` in `src/shared/jsonUtils.ts`.
 */

/** Enqueue an async callback, serialized against others sharing the same key. */
export interface KeyedWriteQueue {
	enqueue<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Create an independent per-key write queue. Each key (e.g. a session id) gets
 * its own promise chain, so callers mutating the same file run strictly one at
 * a time while different keys still run concurrently. Queue entries are cleaned
 * up once settled to keep the backing Map bounded in long-lived processes.
 */
export function createKeyedWriteQueue(): KeyedWriteQueue {
	const queues = new Map<string, Promise<void>>();

	function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = queues.get(key) ?? Promise.resolve();
		// Run fn regardless of whether the prior write resolved or rejected.
		const next = prev.then(fn, fn);
		const settled = next.then(
			() => {},
			() => {}
		);
		queues.set(key, settled);
		settled.then(() => {
			if (queues.get(key) === settled) {
				queues.delete(key);
			}
		});
		return next;
	}

	return { enqueue };
}
