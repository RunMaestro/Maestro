/**
 * History Bucket Cache
 *
 * Disk-backed (with in-memory hot path) cache for activity-graph bucket
 * aggregations. The graph view in the History panels needs to be
 * "all-encompassing" — it always covers the full history, regardless of how
 * the entry list below is paginated. Recomputing those buckets on every
 * lookback flip or fresh load gets expensive once a project's history grows
 * past tens of thousands of entries (especially the unified view across all
 * sessions), so we persist the result keyed by source-file fingerprint.
 *
 * Cache invalidation: when the underlying file's `mtimeMs`/`size` changes
 * (i.e. a new entry is appended), the cache misses and the caller is
 * expected to recompute and re-`set()`.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { logger } from './logger';
import { captureException } from './sentry';

const LOG_CONTEXT = '[HistoryBucketCache]';

/** Bump to invalidate every existing cache entry on disk. */
export const HISTORY_BUCKET_CACHE_VERSION = 2;

/**
 * Single bucket of the activity graph — counts of each entry type within the
 * bucket's time slice. Mirrors `GraphBucket` in director-notes / ActivityGraph
 * so all three layers (cache, IPC, renderer) share the same shape.
 */
export interface CachedGraphBucket {
	auto: number;
	user: number;
	cue: number;
}

/**
 * What the cache stores per (cacheKey, sourceFingerprint) pair.
 */
export interface CachedBucketData {
	version: number;
	cacheKey: string;
	/**
	 * Composite of file `mtimeMs` + `size` (single-session) or a hash thereof
	 * across many files (unified view). On miss the entry must be recomputed.
	 */
	sourceFingerprint: string;
	bucketCount: number;
	buckets: CachedGraphBucket[];
	/** Unix ms of the earliest entry observed in the source set. */
	earliestTimestamp: number;
	/** Unix ms of the latest entry observed in the source set. */
	latestTimestamp: number;
	totalCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	/**
	 * Per-host entry counts within the same window the buckets cover. Key
	 * is the entry's `hostname`, or the synthetic `"__local__"` for entries
	 * with no hostname (i.e. written by this machine's per-session store).
	 */
	hostCounts: Record<string, number>;
	/** Unix ms when the cache entry was written. */
	computedAt: number;
}

/**
 * Singleton cache. In-memory `Map` answers same-process repeats without
 * touching disk; disk persists across app restarts so cold starts skip
 * recomputation when the source files are unchanged.
 */
export class HistoryBucketCache {
	private cacheDir: string;
	private memCache = new Map<string, CachedBucketData>();
	/**
	 * Tracks in-flight disk reads so concurrent get() calls for the same
	 * key share one readFile rather than racing. Cleared as soon as the
	 * read settles. Important on the cold-cache path where the activity
	 * graph and the unified history view can both hit the same key in
	 * the same tick.
	 */
	private inflightReads = new Map<string, Promise<CachedBucketData | null>>();

	constructor(baseDir?: string) {
		this.cacheDir = path.join(baseDir ?? app.getPath('userData'), 'history-cache');
		// Note: directory creation is deferred to the first set() so the
		// constructor stays sync. get() tolerates a missing dir by returning
		// null on read failure.
	}

	private async ensureDir(): Promise<void> {
		try {
			await fsp.mkdir(this.cacheDir, { recursive: true });
		} catch (err) {
			logger.warn(`Failed to create cache dir: ${err}`, LOG_CONTEXT);
		}
	}

	/** Hash the cache key to keep filenames bounded and filesystem-safe. */
	private filePathFor(cacheKey: string): string {
		const hash = crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 32);
		return path.join(this.cacheDir, `${hash}.json`);
	}

	/**
	 * Returns cached data only if `expectedFingerprint` matches what was stored.
	 * Otherwise returns null — caller should recompute and call `set()`.
	 *
	 * Warm path (in-memory hit): returns synchronously-resolved promise; no
	 * disk I/O. Cold path: reads via fs/promises so it doesn't block other
	 * IPC handlers behind a sync read while the activity graph initializes.
	 */
	async get(cacheKey: string, expectedFingerprint: string): Promise<CachedBucketData | null> {
		const mem = this.memCache.get(cacheKey);
		if (mem && mem.sourceFingerprint === expectedFingerprint) return mem;

		// De-dupe in-flight reads for the same key. Without this, a renderer
		// that asks for the same bucket twice in quick succession (e.g. graph
		// + summary panel) would issue two parallel disk reads.
		const existing = this.inflightReads.get(cacheKey);
		if (existing) {
			const data = await existing;
			if (data && data.sourceFingerprint === expectedFingerprint) return data;
			return null;
		}

		const fp = this.filePathFor(cacheKey);
		const readPromise = (async (): Promise<CachedBucketData | null> => {
			try {
				const raw = await fsp.readFile(fp, 'utf-8');
				const data = JSON.parse(raw) as CachedBucketData;
				if (data.version !== HISTORY_BUCKET_CACHE_VERSION) return null;
				this.memCache.set(cacheKey, data);
				return data;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') return null; // cold-cache miss is expected
				logger.warn(`Failed to read cache for ${cacheKey}: ${err}`, LOG_CONTEXT);
				return null;
			}
		})();
		this.inflightReads.set(cacheKey, readPromise);
		try {
			const data = await readPromise;
			if (data && data.sourceFingerprint !== expectedFingerprint) return null;
			return data;
		} finally {
			this.inflightReads.delete(cacheKey);
		}
	}

	async set(data: CachedBucketData): Promise<void> {
		this.memCache.set(data.cacheKey, data);
		try {
			await this.ensureDir();
			await fsp.writeFile(this.filePathFor(data.cacheKey), JSON.stringify(data), 'utf-8');
		} catch (err) {
			logger.warn(`Failed to write cache for ${data.cacheKey}: ${err}`, LOG_CONTEXT);
			void captureException(err, {
				operation: 'history-bucket-cache:write',
				cacheKey: data.cacheKey,
			});
		}
	}

	async invalidate(cacheKey: string): Promise<void> {
		this.memCache.delete(cacheKey);
		const fp = this.filePathFor(cacheKey);
		try {
			await fsp.unlink(fp);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return; // already gone is fine
			logger.warn(`Failed to delete cache for ${cacheKey}: ${err}`, LOG_CONTEXT);
		}
	}

	async clear(): Promise<void> {
		this.memCache.clear();
		try {
			const entries = await fsp.readdir(this.cacheDir);
			await Promise.all(
				entries
					.filter((f) => f.endsWith('.json'))
					.map((f) => fsp.unlink(path.join(this.cacheDir, f)).catch(() => undefined))
			);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return; // cache dir doesn't exist yet — nothing to clear
			logger.warn(`Failed to clear cache dir: ${err}`, LOG_CONTEXT);
		}
	}

	getCacheDir(): string {
		return this.cacheDir;
	}
}

/**
 * Fingerprint a single file from its mtime + size. `'missing'` for files
 * that don't exist so the cache invalidates if the file is later created.
 */
export function fileFingerprint(filePath: string): string {
	try {
		const stat = fs.statSync(filePath);
		return `${stat.mtimeMs}-${stat.size}`;
	} catch {
		return 'missing';
	}
}

/**
 * Composite fingerprint over many files. Stable under reordering by sorting
 * paths first; the hash is short enough to keep cache keys compact.
 */
export function multiFileFingerprint(filePaths: string[]): string {
	const sorted = [...filePaths].sort();
	const parts = sorted.map((fp) => `${fp}:${fileFingerprint(fp)}`);
	return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

let instance: HistoryBucketCache | null = null;

export function getHistoryBucketCache(): HistoryBucketCache {
	if (!instance) instance = new HistoryBucketCache();
	return instance;
}

/** Test seam — replace the singleton. */
export function setHistoryBucketCacheForTest(cache: HistoryBucketCache | null): void {
	instance = cache;
}
