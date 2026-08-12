/**
 * Path Access Cache
 *
 * Caches positive readability checks for filesystem paths to avoid repeated
 * `fs.accessSync` calls on the same path within a short window. Designed for
 * the SSH validation surfaces ([SshRemoteManager.validateConfig] and
 * [parseSshConfig]) where the same identity-file or `~/.ssh/config` path
 * gets re-checked across consecutive Test Connection clicks or rapid Save
 * operations.
 *
 * Invalidation strategy:
 *   - Positive results (`true`) are cached for `ttlMs`.
 *   - Negative results are NEVER cached. False is the user-actionable error
 *     path: if a user fixes file permissions or writes a missing key and
 *     immediately retries, they must see a fresh check, not a stale `false`.
 *
 * SRP: the cache class itself does not perform the access - callers pass an
 * access function. The default probe is exported alongside (rather than
 * embedded in `check()`) so the cache stays a pure predicate-cache and
 * tests can still inject any boolean function. SOC: production deps in
 * SSH modules import {@link defaultReadableProbe} once instead of each
 * carrying their own try/`accessSync`/catch copy.
 */

import * as fs from 'fs';

export interface PathAccessCacheEntry {
	readable: true;
	checkedAt: number;
}

export const DEFAULT_PATH_ACCESS_TTL_MS = 30_000;

/**
 * Default synchronous read-permission probe. Returns `true` iff the path
 * exists AND is readable by the current process; swallows ENOENT/EACCES/
 * etc. as `false`.
 *
 * Shared by every SSH `defaultDeps` site so the try/`accessSync`/catch
 * pattern lives in exactly one place. Tests that wire their own
 * `checkFileAccess` / `fileExists` predicate via DI bypass this entirely
 * - the helper is only used by production deps.
 */
export function defaultReadableProbe(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

export class PathAccessCache {
	private cache = new Map<string, PathAccessCacheEntry>();
	private readonly ttlMs: number;

	constructor(ttlMs: number = DEFAULT_PATH_ACCESS_TTL_MS) {
		this.ttlMs = ttlMs;
	}

	/**
	 * Returns whether `filePath` is readable. If a cached `true` exists and
	 * is younger than `ttlMs`, returns it without invoking `accessFn`.
	 * Otherwise calls `accessFn(filePath)` and caches `true` results only.
	 */
	check(filePath: string, accessFn: (p: string) => boolean): boolean {
		const cached = this.cache.get(filePath);
		if (cached && Date.now() - cached.checkedAt < this.ttlMs) {
			return true;
		}

		const result = accessFn(filePath);
		if (result) {
			this.cache.set(filePath, { readable: true, checkedAt: Date.now() });
		} else {
			// Drop any stale `true` entry for this path so a previously-readable
			// file that was just removed/permissioned-out doesn't keep returning true.
			this.cache.delete(filePath);
		}
		return result;
	}

	/** Clear all cached entries. Used by tests and on explicit reset. */
	clear(): void {
		this.cache.clear();
	}
}

let instance: PathAccessCache | null = null;

/** Process-wide singleton used by production deps in SSH modules. */
export function getPathAccessCache(): PathAccessCache {
	if (!instance) instance = new PathAccessCache();
	return instance;
}

/** Test seam - replace the singleton with a controllable cache. */
export function setPathAccessCacheForTest(cache: PathAccessCache | null): void {
	instance = cache;
}
