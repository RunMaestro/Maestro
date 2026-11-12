/**
 * useCachedResource - stale-while-revalidate data for surfaces that unmount.
 *
 * A modal that fetches into `useState` starts from nothing every time it opens:
 * close the Usage Dashboard, reopen it, and every chart is a skeleton again
 * while the same data is fetched a second time. This keeps the last result per
 * key at MODULE scope, so a remount renders it on the first frame and then
 * refreshes it in place.
 *
 * Three properties the callers rely on:
 * - **Shared per key.** Every consumer of a key reads one entry, and concurrent
 *   fetches of a key share one promise, so three panels asking for the same
 *   payload cost one IPC round trip.
 * - **Data survives a failed refresh.** An error is reported beside the last
 *   good data rather than replacing it; `loading` is true only while there is
 *   nothing to show yet.
 * - **Revalidate on mount.** Cached data is a starting point, never the answer:
 *   every mount (and key change) fetches again.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

interface ResourceState<T> {
	data: T | undefined;
	error: string | null;
	fetching: boolean;
	/** When `data` was last replaced (ms since epoch); 0 when never. */
	fetchedAt: number;
}

const EMPTY: ResourceState<never> = { data: undefined, error: null, fetching: false, fetchedAt: 0 };

const states = new Map<string, ResourceState<unknown>>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<unknown>>();
/** Bumped by a clear, so a fetch started before it cannot repopulate the cache. */
let generation = 0;

function getState<T>(key: string): ResourceState<T> {
	return (states.get(key) as ResourceState<T> | undefined) ?? EMPTY;
}

function setState<T>(key: string, patch: Partial<ResourceState<T>>): void {
	states.set(key, { ...getState<T>(key), ...patch });
	listeners.get(key)?.forEach((notify) => notify());
}

function subscribeKey(key: string, notify: () => void): () => void {
	let set = listeners.get(key);
	if (!set) {
		set = new Set();
		listeners.set(key, set);
	}
	set.add(notify);
	return () => {
		set.delete(notify);
		if (set.size === 0) listeners.delete(key);
	};
}

/** The cached value for a key, if any (no fetch). */
export function readCachedResource<T>(key: string): T | undefined {
	return getState<T>(key).data;
}

/**
 * Fetch a key now and store the result. Joins a fetch already in flight for the
 * same key. Never rejects: a failure is recorded on the entry (and passed to
 * `onError`), and the previous data stays.
 */
export function revalidateCachedResource<T>(
	key: string,
	fetcher: () => Promise<T>,
	onError?: (error: unknown) => void
): Promise<void> {
	const existing = inflight.get(key);
	if (existing) return existing.then(() => undefined);

	const startedIn = generation;
	setState<T>(key, { fetching: true });
	const promise = fetcher()
		.then((data) => {
			if (startedIn !== generation) return;
			setState<T>(key, { data, error: null, fetching: false, fetchedAt: Date.now() });
		})
		.catch((error: unknown) => {
			if (startedIn !== generation) return;
			onError?.(error);
			setState<T>(key, {
				error: error instanceof Error ? error.message : String(error),
				fetching: false,
			});
		})
		.finally(() => {
			if (inflight.get(key) === promise) inflight.delete(key);
		});
	inflight.set(key, promise);
	return promise;
}

/** Drop every cached entry (tests). */
export function clearCachedResources(): void {
	generation++;
	states.clear();
	inflight.clear();
}

export interface UseCachedResourceOptions {
	/** When false, read the cache but do not fetch. Defaults to true. */
	enabled?: boolean;
	/** Called once per failed fetch, e.g. to report it. */
	onError?: (error: unknown) => void;
}

export interface UseCachedResourceResult<T> {
	data: T | undefined;
	error: string | null;
	/** Nothing to show yet and a fetch is pending. */
	loading: boolean;
	/** A fetch is running while older data is on screen. */
	refreshing: boolean;
	/** When `data` was fetched (ms since epoch); 0 when never. */
	fetchedAt: number;
	/** Fetch again with the hook's fetcher. */
	refresh: () => Promise<void>;
}

/**
 * Read `key` from the module cache and revalidate it with `fetcher` on mount and
 * whenever the key changes. A `null` key reads nothing and fetches nothing.
 */
export function useCachedResource<T>(
	key: string | null,
	fetcher: () => Promise<T>,
	options: UseCachedResourceOptions = {}
): UseCachedResourceResult<T> {
	const { enabled = true } = options;
	// The fetcher and error handler are usually inline closures; reading them
	// through refs keeps `refresh` stable so the mount effect fires on key
	// changes only, not on every render.
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;
	const onErrorRef = useRef(options.onError);
	onErrorRef.current = options.onError;

	const subscribe = useCallback(
		(notify: () => void) => (key ? subscribeKey(key, notify) : () => {}),
		[key]
	);
	const state = useSyncExternalStore(subscribe, () => (key ? getState<T>(key) : EMPTY));

	const refresh = useCallback(
		() =>
			key
				? revalidateCachedResource(key, () => fetcherRef.current(), onErrorRef.current)
				: Promise.resolve(),
		[key]
	);

	useEffect(() => {
		if (enabled) void refresh();
	}, [enabled, refresh]);

	const hasData = state.data !== undefined;
	return {
		data: state.data as T | undefined,
		error: state.error,
		// Before the mount effect has run there is no fetch in flight yet, but one
		// is about to start, so a never-fetched enabled key still reads as loading.
		// A retry after a failure is loading again, not still failed.
		loading: !hasData && (state.fetching || (!state.error && enabled && key !== null)),
		refreshing: hasData && state.fetching,
		fetchedAt: state.fetchedAt,
		refresh,
	};
}
