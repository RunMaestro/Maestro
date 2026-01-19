/**
 * IPC Wrapper Utility
 *
 * Provides a utility for wrapping IPC calls with consistent error handling patterns.
 * Reduces boilerplate in service files by abstracting try-catch patterns.
 *
 * Used by: git.ts, process.ts
 *
 * @example
 * // For methods that return a default value on error (swallow errors):
 * const getStatus = createIpcMethod({
 *   call: () => window.maestro.git.status(cwd),
 *   errorContext: 'Git status',
 *   defaultValue: { files: [] },
 * });
 *
 * @example
 * // For methods that rethrow errors (propagate errors):
 * const spawn = createIpcMethod({
 *   call: () => window.maestro.process.spawn(config),
 *   errorContext: 'Process spawn',
 *   rethrow: true,
 * });
 */

/**
 * Options for createIpcMethod when errors should be swallowed
 * and a default value returned instead.
 */
export interface IpcMethodOptionsWithDefault<T> {
	/** The IPC call to execute */
	call: () => Promise<T>;
	/** Context string for error logging (e.g., 'Git status', 'Process spawn') */
	errorContext: string;
	/** Default value to return on error */
	defaultValue: T;
	/** Optional transform function to process the result */
	transform?: (result: T) => T;
	rethrow?: false;
}

/**
 * Options for createIpcMethod when errors should be rethrown.
 */
export interface IpcMethodOptionsRethrow<T> {
	/** The IPC call to execute */
	call: () => Promise<T>;
	/** Context string for error logging (e.g., 'Git status', 'Process spawn') */
	errorContext: string;
	/** Set to true to rethrow errors after logging */
	rethrow: true;
	/** Optional transform function to process the result */
	transform?: (result: T) => T;
	defaultValue?: never;
}

export type IpcMethodOptions<T> = IpcMethodOptionsWithDefault<T> | IpcMethodOptionsRethrow<T>;

/**
 * Creates an IPC method with standardized error handling.
 *
 * Two modes of operation:
 * 1. With `defaultValue`: Errors are logged and swallowed, returning the default value.
 *    Use this for read operations where failures can be gracefully handled.
 *
 * 2. With `rethrow: true`: Errors are logged and rethrown.
 *    Use this for write operations where callers need to know about failures.
 *
 * @param options - Configuration for the IPC method
 * @returns Promise resolving to the result or default value
 *
 * @example
 * // Swallow errors, return default
 * const branches = await createIpcMethod({
 *   call: () => window.maestro.git.branches(cwd),
 *   errorContext: 'Git branches',
 *   defaultValue: [],
 * });
 *
 * @example
 * // Rethrow errors to caller
 * await createIpcMethod({
 *   call: () => window.maestro.process.kill(sessionId),
 *   errorContext: 'Process kill',
 *   rethrow: true,
 * });
 */
export async function createIpcMethod<T>(options: IpcMethodOptions<T>): Promise<T> {
	try {
		const result = await options.call();
		return options.transform ? options.transform(result) : result;
	} catch (error) {
		console.error(`${options.errorContext} error:`, error);
		if (options.rethrow) {
			throw error;
		}
		return options.defaultValue as T;
	}
}

// ============================================================================
// IPC Cache
// ============================================================================

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

/**
 * Simple in-memory cache for IPC results.
 * Reduces redundant IPC calls for data that changes infrequently.
 */
class IpcCache {
	private cache = new Map<string, CacheEntry<unknown>>();
	private defaultTTL = 30000; // 30 seconds

	/**
	 * Get cached data or fetch fresh data if cache is stale/missing.
	 *
	 * @param key - Unique cache key
	 * @param fetcher - Function to fetch fresh data
	 * @param ttl - Time-to-live in milliseconds (default: 30s)
	 * @returns Cached or fresh data
	 *
	 * @example
	 * const configs = await ipcCache.getOrFetch(
	 *   'ssh-configs',
	 *   () => window.maestro.sshRemote.getConfigs(),
	 *   30000
	 * );
	 */
	async getOrFetch<T>(key: string, fetcher: () => Promise<T>, ttl?: number): Promise<T> {
		const entry = this.cache.get(key) as CacheEntry<T> | undefined;
		const effectiveTTL = ttl ?? this.defaultTTL;
		const now = Date.now();

		if (entry && now - entry.timestamp < effectiveTTL) {
			return entry.data;
		}

		const data = await fetcher();
		this.cache.set(key, { data, timestamp: now });
		return data;
	}

	/**
	 * Invalidate a specific cache entry.
	 * Call this when you know the underlying data has changed.
	 */
	invalidate(key: string): void {
		this.cache.delete(key);
	}

	/**
	 * Invalidate all cache entries matching a prefix.
	 * Useful for invalidating related data (e.g., all 'ssh-*' entries).
	 */
	invalidatePrefix(prefix: string): void {
		for (const key of this.cache.keys()) {
			if (key.startsWith(prefix)) {
				this.cache.delete(key);
			}
		}
	}

	/**
	 * Clear all cached data.
	 */
	clear(): void {
		this.cache.clear();
	}
}

/**
 * Singleton IPC cache instance.
 * Use this to cache frequently-accessed IPC data.
 */
export const ipcCache = new IpcCache();
