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
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { logger } from './logger';
import { captureException } from './sentry';

const LOG_CONTEXT = '[HistoryBucketCache]';

/** Bump to invalidate every existing cache entry on disk. */
export const HISTORY_BUCKET_CACHE_VERSION = 1;

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

	constructor(baseDir?: string) {
		this.cacheDir = path.join(baseDir ?? app.getPath('userData'), 'history-cache');
		this.ensureDir();
	}

	private ensureDir(): void {
		if (!fs.existsSync(this.cacheDir)) {
			try {
				fs.mkdirSync(this.cacheDir, { recursive: true });
			} catch (err) {
				logger.warn(`Failed to create cache dir: ${err}`, LOG_CONTEXT);
			}
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
	 */
	get(cacheKey: string, expectedFingerprint: string): CachedBucketData | null {
		const mem = this.memCache.get(cacheKey);
		if (mem && mem.sourceFingerprint === expectedFingerprint) return mem;

		const fp = this.filePathFor(cacheKey);
		if (!fs.existsSync(fp)) return null;

		try {
			const data = JSON.parse(fs.readFileSync(fp, 'utf-8')) as CachedBucketData;
			if (data.version !== HISTORY_BUCKET_CACHE_VERSION) return null;
			if (data.sourceFingerprint !== expectedFingerprint) return null;
			this.memCache.set(cacheKey, data);
			return data;
		} catch (err) {
			logger.warn(`Failed to read cache for ${cacheKey}: ${err}`, LOG_CONTEXT);
			return null;
		}
	}

	set(data: CachedBucketData): void {
		this.memCache.set(data.cacheKey, data);
		try {
			this.ensureDir();
			fs.writeFileSync(this.filePathFor(data.cacheKey), JSON.stringify(data), 'utf-8');
		} catch (err) {
			logger.warn(`Failed to write cache for ${data.cacheKey}: ${err}`, LOG_CONTEXT);
			void captureException(err, {
				operation: 'history-bucket-cache:write',
				cacheKey: data.cacheKey,
			});
		}
	}

	invalidate(cacheKey: string): void {
		this.memCache.delete(cacheKey);
		const fp = this.filePathFor(cacheKey);
		try {
			if (fs.existsSync(fp)) fs.unlinkSync(fp);
		} catch (err) {
			logger.warn(`Failed to delete cache for ${cacheKey}: ${err}`, LOG_CONTEXT);
		}
	}

	clear(): void {
		this.memCache.clear();
		if (!fs.existsSync(this.cacheDir)) return;
		try {
			for (const f of fs.readdirSync(this.cacheDir)) {
				if (f.endsWith('.json')) {
					fs.unlinkSync(path.join(this.cacheDir, f));
				}
			}
		} catch (err) {
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
