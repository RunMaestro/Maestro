/**
 * A cache of async results by key, each kept for `ttlMs`.
 *
 * Concurrent callers of one key share the one promise, so a burst of callers
 * starts the work once. A result `keep()` rejects (a failed probe), and a
 * rejected promise, is dropped as soon as it settles, so the next caller tries
 * again rather than reading a failure for the whole window. With
 * `failureTtlMs`, a failure is kept that long instead (counted from when it
 * settled): a host that cannot be reached is not asked again on every call.
 *
 * Used by the slash-command discovery probes, which spawn a CLI (over SSH for
 * a remote agent) and so must not run on every agent switch.
 */
export interface TtlPromiseCache<T> {
	/** The cached result for `key`, or a new one from `load()`. */
	get(key: string, load: () => Promise<T>): Promise<T>;
	/** Forget every entry (tests). */
	clear(): void;
}

export interface TtlPromiseCacheOptions {
	/** How long a failure (a result `keep()` rejects, or a rejection) is kept; 0 drops it at once. */
	failureTtlMs?: number;
}

export function createTtlPromiseCache<T>(
	ttlMs: number,
	keep: (value: T) => boolean = () => true,
	{ failureTtlMs = 0 }: TtlPromiseCacheOptions = {}
): TtlPromiseCache<T> {
	const entries = new Map<string, { at: number; ttl: number; value: Promise<T> }>();
	return {
		get(key, load) {
			const now = Date.now();
			const hit = entries.get(key);
			if (hit && now - hit.at < hit.ttl) return hit.value;
			const failed = () => {
				const entry = entries.get(key);
				if (entry?.value !== value) return;
				if (failureTtlMs > 0) entries.set(key, { at: Date.now(), ttl: failureTtlMs, value });
				else entries.delete(key);
			};
			const value = load().then(
				(result) => {
					if (!keep(result)) failed();
					return result;
				},
				(error: unknown) => {
					failed();
					throw error;
				}
			);
			entries.set(key, { at: now, ttl: ttlMs, value });
			return value;
		},
		clear() {
			entries.clear();
		},
	};
}
