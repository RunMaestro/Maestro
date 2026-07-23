/**
 * Token-Usage Cache
 *
 * Disk-backed (with in-memory hot path) cache of per-session token breakdowns
 * for the Cost & Tokens dashboard. Each agent's session storage parses its
 * transcript into per-session (and per-model) token totals; that parse is the
 * expensive step once a machine accumulates thousands of sessions, so we cache
 * the derived {@link SessionTokenBreakdown} keyed by a cheap source fingerprint.
 *
 * Cache invalidation is per-session: the fingerprint is the session's
 * `modifiedAt` + `sizeBytes` (from `AgentSessionInfo`). When a session grows or
 * is touched, its fingerprint changes and the accessor re-derives just that
 * session; every unchanged session is served from cache. This mirrors the
 * fingerprint approach in `history-bucket-cache.ts`.
 *
 * Note: the enumeration step (`listSessions`) still reads a project's files as a
 * unit - there is no uniform, cheap per-file change signal across the five
 * agents. The accessor pairs this cache with a short in-memory TTL and
 * stale-while-revalidate at the IPC layer so the UI stays instant; this cache is
 * what makes a cold restart cheap (unchanged sessions are never re-derived).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import type { SessionTokenBreakdown } from '../../../shared/tokenUsage';

const LOG_CONTEXT = '[TokenUsageCache]';

/**
 * Bump to invalidate every persisted entry (e.g. when the breakdown shape
 * changes). v2 added `accountKey` to `SessionTokenBreakdown`.
 */
export const TOKEN_USAGE_CACHE_VERSION = 2;

/** One cached session: the fingerprint it was derived at plus the derived breakdown. */
interface CachedSession {
	fingerprint: string;
	breakdown: SessionTokenBreakdown;
}

/** On-disk shape. */
interface TokenUsageCacheFile {
	version: number;
	savedAt: number;
	sessions: Record<string, CachedSession>;
}

/** Stable cache key for a session across agents. */
export function tokenCacheKey(agentType: string, sessionId: string): string {
	return `${agentType}:${sessionId}`;
}

/** Fingerprint a session from the cheap metadata `listSessions` already returns. */
export function sessionFingerprint(modifiedAt: string, sizeBytes: number): string {
	return `${modifiedAt}-${sizeBytes}`;
}

/**
 * In-memory map backed by a single JSON file under `userData`. Lazy-loaded on
 * first access; writes are batched via {@link persist}.
 */
export class TokenUsageCache {
	private readonly mem = new Map<string, CachedSession>();
	private readonly filePath: string;
	private loaded = false;
	private dirty = false;

	constructor(filePath?: string) {
		this.filePath = filePath ?? path.join(app.getPath('userData'), 'token-usage-cache.json');
	}

	/** Load the cache from disk once. Safe to call repeatedly. */
	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = await fsp.readFile(this.filePath, 'utf-8');
			const parsed = JSON.parse(raw) as TokenUsageCacheFile;
			if (parsed.version !== TOKEN_USAGE_CACHE_VERSION || !parsed.sessions) {
				logger.debug('Cache version mismatch; starting empty', LOG_CONTEXT);
				return;
			}
			for (const [key, entry] of Object.entries(parsed.sessions)) {
				this.mem.set(key, entry);
			}
			logger.debug(`Loaded ${this.mem.size} cached session breakdowns`, LOG_CONTEXT);
		} catch (error) {
			// Missing file on first run is expected; anything else is worth a breadcrumb.
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				void captureException(error);
			}
		}
	}

	/** Return the cached entry for a session if its fingerprint still matches. */
	get(key: string, fingerprint: string): SessionTokenBreakdown | undefined {
		const entry = this.mem.get(key);
		return entry && entry.fingerprint === fingerprint ? entry.breakdown : undefined;
	}

	/** Store a freshly derived breakdown for a session. */
	set(key: string, fingerprint: string, breakdown: SessionTokenBreakdown): void {
		this.mem.set(key, { fingerprint, breakdown });
		this.dirty = true;
	}

	/**
	 * Drop cache entries whose key is not in `liveKeys` (sessions deleted on disk),
	 * so the file doesn't grow unbounded. Returns the number pruned.
	 */
	prune(liveKeys: Set<string>): number {
		let pruned = 0;
		for (const key of this.mem.keys()) {
			if (!liveKeys.has(key)) {
				this.mem.delete(key);
				pruned++;
			}
		}
		if (pruned > 0) this.dirty = true;
		return pruned;
	}

	/** Persist to disk if anything changed since the last write. */
	async persist(): Promise<void> {
		if (!this.dirty) return;
		const payload: TokenUsageCacheFile = {
			version: TOKEN_USAGE_CACHE_VERSION,
			savedAt: Date.now(),
			sessions: Object.fromEntries(this.mem),
		};
		try {
			await fsp.writeFile(this.filePath, JSON.stringify(payload), 'utf-8');
			this.dirty = false;
		} catch (error) {
			void captureException(error);
		}
	}
}

let singleton: TokenUsageCache | null = null;

/** Shared cache instance for the token-usage accessor. */
export function getTokenUsageCache(): TokenUsageCache {
	if (!singleton) singleton = new TokenUsageCache();
	return singleton;
}

/** Test seam: swap or reset the singleton. */
export function setTokenUsageCacheForTest(cache: TokenUsageCache | null): void {
	singleton = cache;
}
