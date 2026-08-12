/**
 * Session Info Cache
 *
 * Disk-backed (with an in-memory hot path) cache of PARSED session metadata,
 * keyed by a cheap per-file fingerprint. It exists because every agent's
 * `listSessions()` has the same shape: enumerate a folder of transcripts, then
 * read and parse each one to recover tokens/cost/preview. The enumeration is
 * cheap (readdir + stat); the parse is not - a machine with thousands of Claude
 * sessions is several GB of JSONL, and re-reading all of it on every call is
 * what made the Cost & Tokens dashboard take many seconds to render, every time.
 *
 * The invariant: a transcript file is append-only, so `mtimeMs + size` is a
 * sufficient change signal. Unchanged files are served from cache and never
 * touched; only new or grown files are parsed. That makes the steady-state cost
 * proportional to what actually changed since the last call rather than to the
 * whole history, mirroring the fingerprint approach already used by
 * `history-bucket-cache.ts` and `token-usage-cache.ts`.
 *
 * Entries are stored per SCOPE (typically one project's transcript folder) so a
 * write only rewrites the sessions of the folder that changed instead of one
 * monolithic file.
 *
 * Adopting this from a storage implementation is ~10 lines: stat the files you
 * were about to parse, hand {@link SessionInfoCache.resolve} a ref per file plus
 * the parse function you already have, and attach your own mutable metadata
 * (origin, starred, session name) to what comes back. Do NOT cache that mutable
 * metadata: it changes without the transcript changing, so the fingerprint
 * would not catch it.
 */

import * as path from 'path';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { isExpectedSessionReadError } from '../utils/session-read-errors';
import { atomicWriteFile, createKeyedWriteQueue } from '../utils/atomic-json-store';
import { mapWithConcurrency, LOCAL_SESSION_READ_CONCURRENCY } from '../utils/concurrency';
import type { AgentSessionInfo } from '../agents/session-storage';

const LOG_CONTEXT = '[SessionInfoCache]';

/**
 * Bump to discard every persisted entry (e.g. when `AgentSessionInfo` gains a
 * field that existing cached entries would be missing).
 */
export const SESSION_INFO_CACHE_VERSION = 1;

/** One source file to resolve: its identity within the scope plus its fingerprint. */
export interface SessionFileRef {
	/** Stable identity of the file within its scope - normally the absolute path. */
	key: string;
	/** Cheap change signal from {@link fileFingerprint}. */
	fingerprint: string;
}

interface CachedSessionInfo {
	fingerprint: string;
	info: AgentSessionInfo;
}

/** On-disk shape of one scope's cache file. */
interface SessionInfoCacheFile {
	version: number;
	agentId: string;
	/** Kept for debuggability - the file name itself is a hash. */
	scopeKey: string;
	savedAt: number;
	entries: Record<string, CachedSessionInfo>;
}

/** Options for a single {@link SessionInfoCache.resolve} pass. */
export interface ResolveOptions {
	/**
	 * Drop cached entries whose key is absent from `refs`, so deleted transcripts
	 * don't accumulate. Only safe when `refs` covers the ENTIRE scope - a
	 * paginated caller passing one page must leave this off or it would evict
	 * every session outside that page.
	 */
	prune?: boolean;
	/** Parallel parses on a cache miss. Defaults to {@link LOCAL_SESSION_READ_CONCURRENCY}. */
	concurrency?: number;
}

/** Fingerprint a source file from the stats an enumeration already returns. */
export function fileFingerprint(sizeBytes: number, mtimeMs: number): string {
	return `${mtimeMs}-${sizeBytes}`;
}

/**
 * Per-agent cache of parsed {@link AgentSessionInfo}, partitioned into scopes.
 *
 * Returned infos are the cached objects themselves, not copies: callers must
 * treat them as frozen and layer their own fields on with a spread rather than
 * mutating in place.
 */
export class SessionInfoCache {
	private readonly agentId: string;
	private readonly dir: string;
	private readonly scopes = new Map<string, Map<string, CachedSessionInfo>>();
	/** In-flight scope loads, so concurrent callers share one disk read. */
	private readonly loading = new Map<string, Promise<Map<string, CachedSessionInfo>>>();
	/** Serializes writes per scope file so two resolves can't clobber each other. */
	private readonly writes = createKeyedWriteQueue();

	constructor(agentId: string, baseDir?: string) {
		this.agentId = agentId;
		this.dir = path.join(
			baseDir ?? path.join(app.getPath('userData'), 'stats-cache'),
			'session-info',
			agentId
		);
	}

	/** Hash the scope key so the file name stays bounded and filesystem-safe. */
	private filePathFor(scopeKey: string): string {
		const hash = crypto.createHash('sha256').update(scopeKey).digest('hex').slice(0, 32);
		return path.join(this.dir, `${hash}.json`);
	}

	/** Load (once) the entries for a scope. A missing or stale file yields an empty map. */
	private async loadScope(scopeKey: string): Promise<Map<string, CachedSessionInfo>> {
		const cached = this.scopes.get(scopeKey);
		if (cached) return cached;

		const inflight = this.loading.get(scopeKey);
		if (inflight) return inflight;

		const load = (async (): Promise<Map<string, CachedSessionInfo>> => {
			const entries = new Map<string, CachedSessionInfo>();
			try {
				const raw = await fsp.readFile(this.filePathFor(scopeKey), 'utf-8');
				const parsed = JSON.parse(raw) as SessionInfoCacheFile;
				if (parsed.version === SESSION_INFO_CACHE_VERSION && parsed.entries) {
					for (const [key, entry] of Object.entries(parsed.entries)) {
						entries.set(key, entry);
					}
				}
			} catch (error) {
				// A missing file is the expected cold-start case; a corrupt one just
				// costs a reparse. Neither should break listing, so both degrade to an
				// empty scope. The rest of the environmental set (EACCES/EPERM on a
				// userData dir we cannot read, EISDIR, ...) is the same MAESTRO-YH
				// boundary the transcript reads guard, so it stays local too.
				if (!isExpectedSessionReadError(error)) {
					logger.warn(`Failed to read cache for scope ${scopeKey}`, LOG_CONTEXT, { error });
					void captureException(error, { operation: 'sessionInfoCache:read', scopeKey });
				}
			}
			this.scopes.set(scopeKey, entries);
			return entries;
		})();

		this.loading.set(scopeKey, load);
		try {
			return await load;
		} finally {
			this.loading.delete(scopeKey);
		}
	}

	/** Persist one scope to disk. Failures are logged, never thrown at the caller. */
	private async persistScope(scopeKey: string): Promise<void> {
		const entries = this.scopes.get(scopeKey);
		if (!entries) return;
		const payload: SessionInfoCacheFile = {
			version: SESSION_INFO_CACHE_VERSION,
			agentId: this.agentId,
			scopeKey,
			savedAt: Date.now(),
			entries: Object.fromEntries(entries),
		};
		try {
			await fsp.mkdir(this.dir, { recursive: true });
			await atomicWriteFile(this.filePathFor(scopeKey), JSON.stringify(payload));
		} catch (error) {
			logger.warn(`Failed to write cache for scope ${scopeKey}`, LOG_CONTEXT, { error });
			void captureException(error, { operation: 'sessionInfoCache:write', scopeKey });
		}
	}

	/**
	 * Resolve every ref to its parsed info, parsing only the ones whose
	 * fingerprint changed.
	 *
	 * @param scopeKey - Partition key, normally the folder the files live in.
	 * @param refs - One entry per source file, in the order results should come back.
	 * @param parse - Parses a single file on a cache miss. `null` means "skip this
	 *   file" (unreadable, oversized, empty) and is not cached, so a later call
	 *   retries it.
	 * @returns The parsed infos in `refs` order, with skipped files omitted.
	 */
	async resolve(
		scopeKey: string,
		refs: SessionFileRef[],
		parse: (ref: SessionFileRef) => Promise<AgentSessionInfo | null>,
		options?: ResolveOptions
	): Promise<AgentSessionInfo[]> {
		const entries = await this.loadScope(scopeKey);

		const resolved: (AgentSessionInfo | null)[] = new Array(refs.length).fill(null);
		const misses: { ref: SessionFileRef; index: number }[] = [];

		refs.forEach((ref, index) => {
			const hit = entries.get(ref.key);
			if (hit && hit.fingerprint === ref.fingerprint) {
				resolved[index] = hit.info;
			} else {
				misses.push({ ref, index });
			}
		});

		let dirty = false;

		if (misses.length > 0) {
			const parsed = await mapWithConcurrency(
				misses,
				options?.concurrency ?? LOCAL_SESSION_READ_CONCURRENCY,
				({ ref }) => parse(ref)
			);
			parsed.forEach((info, i) => {
				const { ref, index } = misses[i];
				if (!info) return;
				entries.set(ref.key, { fingerprint: ref.fingerprint, info });
				resolved[index] = info;
				dirty = true;
			});
		}

		if (options?.prune) {
			const live = new Set(refs.map((ref) => ref.key));
			for (const key of entries.keys()) {
				if (!live.has(key)) {
					entries.delete(key);
					dirty = true;
				}
			}
		}

		if (dirty) {
			// Serialized per scope, and awaited so a caller that immediately exits
			// (CLI, quit) doesn't drop the write.
			await this.writes.enqueue(scopeKey, () => this.persistScope(scopeKey));
		}

		if (misses.length > 0) {
			logger.debug(
				`Scope ${scopeKey}: ${refs.length - misses.length} cached, ${misses.length} parsed`,
				LOG_CONTEXT
			);
		}

		return resolved.filter((info): info is AgentSessionInfo => info !== null);
	}

	/** Forget a scope's in-memory entries and delete its file. Primarily for tests/reset. */
	async invalidate(scopeKey: string): Promise<void> {
		this.scopes.delete(scopeKey);
		try {
			await fsp.unlink(this.filePathFor(scopeKey));
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				logger.warn(`Failed to delete cache for scope ${scopeKey}`, LOG_CONTEXT, { error });
			}
		}
	}
}

const instances = new Map<string, SessionInfoCache>();

/** Shared per-agent cache instance. */
export function getSessionInfoCache(agentId: string): SessionInfoCache {
	let instance = instances.get(agentId);
	if (!instance) {
		instance = new SessionInfoCache(agentId);
		instances.set(agentId, instance);
	}
	return instance;
}

/** Test seam: swap in a cache with a temp base dir, or reset with `null`. */
export function setSessionInfoCacheForTest(agentId: string, cache: SessionInfoCache | null): void {
	if (cache) {
		instances.set(agentId, cache);
	} else {
		instances.delete(agentId);
	}
}
