/**
 * A cache of async results by key, each kept for `ttlMs`.
 *
 * Concurrent callers of one key share the one promise, so a burst of callers
 * starts the work once. A result `keep()` rejects (a failed probe), and a
 * rejected promise, is dropped as soon as it settles, so the next caller tries
 * again rather than reading a failure for the whole window.
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

export function createTtlPromiseCache<T>(
	ttlMs: number,
	keep: (value: T) => boolean = () => true
): TtlPromiseCache<T> {
	const entries = new Map<string, { at: number; value: Promise<T> }>();
	return {
		get(key, load) {
			const now = Date.now();
			const hit = entries.get(key);
			if (hit && now - hit.at < ttlMs) return hit.value;
			const forget = () => {
				if (entries.get(key)?.value === value) entries.delete(key);
			};
			const value = load().then(
				(result) => {
					if (!keep(result)) forget();
					return result;
				},
				(error: unknown) => {
					forget();
					throw error;
				}
			);
			entries.set(key, { at: now, value });
			return value;
		},
		clear() {
			entries.clear();
		},
	};
}
