/**
 * Periodic saves for a long scan that mutates a cache in place, so a scan the
 * user kills part way resumes from the last checkpoint instead of from zero.
 *
 * Shared by the global stats scan, the per-project stats scan, and the session
 * info cache. Its own module rather than a member of `statsCache.ts` so the
 * session info cache does not have to depend on the stats cache to use it.
 */

/** How often a long scan saves its cache part way through. */
export const STATS_CACHE_CHECKPOINT_INTERVAL_MS = 5000;

export interface CacheCheckpointer {
	/** Save if the interval has passed and no save is in flight. Never throws. */
	maybe(): void;
	/** Wait for an in-flight save. Call before the final save: both write the same temp file. */
	settle(): Promise<void>;
}

/**
 * Periodic saves for a scan that mutates its cache in place. `save` must
 * swallow its own failures (both cache savers do); a checkpoint that fails is
 * simply a lost checkpoint, and the final save still runs.
 */
export function createCacheCheckpointer(
	save: () => Promise<void>,
	intervalMs: number = STATS_CACHE_CHECKPOINT_INTERVAL_MS
): CacheCheckpointer {
	let lastSavedAt = Date.now();
	let inFlight: Promise<void> | null = null;
	return {
		maybe() {
			if (inFlight || Date.now() - lastSavedAt < intervalMs) return;
			lastSavedAt = Date.now();
			inFlight = save().finally(() => {
				inFlight = null;
			});
		},
		async settle() {
			await inFlight;
		},
	};
}
