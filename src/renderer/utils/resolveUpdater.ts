/**
 * Resolves the direct-value and functional-updater forms accepted by renderer stores.
 *
 * Functional values are intentionally treated as updaters, matching React's setState
 * contract used by the stores.
 */
export function resolveUpdater<T>(valueOrUpdater: T | ((previous: T) => T), previous: T): T {
	return typeof valueOrUpdater === 'function'
		? (valueOrUpdater as (previous: T) => T)(previous)
		: valueOrUpdater;
}
