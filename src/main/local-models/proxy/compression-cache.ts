/**
 * The token proxy's content-addressed cache: what each tool result was turned
 * into, keyed by the SHA-256 of the original.
 *
 *   userData/proxy-cache/<hh>/<sha256>.json            the verdict (written last)
 *   userData/proxy-cache/<hh>/<sha256>.original.txt    the text the agent sent
 *   userData/proxy-cache/<hh>/<sha256>.compressed.txt  the text sent in its place
 *
 * (`<hh>` is the first two characters of the hash.)
 *
 * It does two jobs, and both are requirements of the proxy:
 *
 * 1. **The verdict for a block never changes.** A provider caches a request by
 *    its prefix, so a tool result must be the same bytes on every turn it is
 *    sent. The heuristic compressors are pure, but the model tier is not: a
 *    model can be unassigned, time out, or word a summary differently. So the
 *    FIRST verdict for a hash is the one every later request gets, whether it
 *    was `compressed` or `kept`. A newer compressor does not rewrite an old
 *    block either.
 * 2. **Every compressed block is recoverable.** The original is stored beside
 *    what replaced it, so a person can read both.
 *
 * A `kept` verdict stores no text: the block went out as the agent sent it, so
 * there is nothing to compare.
 *
 * **Pruning is by last use, never by age of creation.** An entry that vanished
 * while its conversation is still running would be decided again, and for a
 * block the model wrote (or after an app update changed a compressor) that can
 * mean different bytes mid conversation: the provider's cached prefix breaks
 * and the model sees another version of an earlier result. That risk lasts only
 * while the conversation is live. A provider keeps a cached prefix for an hour
 * at most, so an entry nobody has used for {@link DEFAULT_PRUNE_IDLE_MS} guards
 * nothing, and keeping it forever would keep raw tool output (secrets included)
 * on disk forever. So every use stamps the record's modification time (at most
 * once per {@link TOUCH_INTERVAL_MS}), and {@link CompressionCache.prune}
 * removes entries idle past the limit, then the least recently used ones while
 * the directory is over {@link DEFAULT_PRUNE_MAX_BYTES}. An entry used within
 * {@link MIN_PRUNE_IDLE_MS} is never removed, whatever the size. A conversation
 * resumed after its entries were pruned has its old blocks decided again; its
 * provider cache expired long before, so that costs nothing but the decision.
 *
 * Compressor upgrades apply only to unseen hashes. The record version names
 * the storage layout, not an algorithm revision; keep version-1 records and
 * legacy compressor IDs readable when adding a compressor. Never invalidate
 * old verdicts to activate a newer algorithm.
 *
 * Request eligibility belongs to compressRequestBody: failure/recovery vetoes
 * run before cache lookup and leave all stored files untouched. Eligible
 * requests use resolveBlock's per-hash queue to read before deciding/writing.
 * This store's write is a commit primitive, not a cross-process first-writer
 * lock; callers must not use it to replace an existing verdict.
 */

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
	TOKEN_PROXY_ORIGINAL_RANGE_MAX_BYTES,
	validateTokenProxyOriginalLineRange,
	type TokenProxyCachePruneResult,
	type TokenProxyCacheUsage,
	type TokenProxyOriginalLineRange,
	type TokenProxyOriginalRangeRead,
} from '../../../shared/local-models/token-proxy';
import { atomicWriteFile, atomicWriteJson } from '../../utils/atomic-json-store';
import { logger } from '../../utils/logger';
import { localModelsDataDir } from '../paths';
import type { HeuristicCompressorId } from './compressors';

const LOG_CONTEXT = '[TokenProxy]';

/** The cache root, relative to the data dir. */
export const TOKEN_PROXY_CACHE_DIRNAME = 'proxy-cache';

/**
 * The record layout, not the compressor revision. Do not bump for new algorithms:
 * records with another version are read as absent and would be decided again.
 */
export const COMPRESSION_RECORD_VERSION = 1;

/** Verdicts held in memory, so a request does not read the disk per block. */
const DEFAULT_MEMORY_ENTRIES = 1024;

/** An entry unused for this long is removed by a prune. */
export const DEFAULT_PRUNE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/** Past this size, a prune removes the least recently used entries. */
export const DEFAULT_PRUNE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * An entry used more recently than this is never removed, by any prune. Far
 * longer than a provider keeps a cached prefix, so a live conversation's
 * entries survive even a prune asked for by hand.
 */
export const MIN_PRUNE_IDLE_MS = 24 * 60 * 60 * 1000;

/** How often a use rewrites an entry's last-use stamp. */
export const TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type CompressionCacheUsage = TokenProxyCacheUsage;
export type CompressionCachePruneResult = TokenProxyCachePruneResult;

export interface CompressionCachePruneOptions {
	/** Remove entries unused for longer than this. Never below {@link MIN_PRUNE_IDLE_MS}. */
	maxIdleMs?: number;
	/** Then remove the least recently used until the directory is at most this. */
	maxBytes?: number;
	/** The clock, for tests. */
	now?: number;
}

/** Bound recovery work even when a requested line is absent or unusually long. */
const ORIGINAL_RANGE_MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** Everything that can shorten a block: the heuristics, then the local model. */
export type CompressorId = HeuristicCompressorId | 'model';

interface VerdictBase {
	/** SHA-256 of the original text, in hex. */
	hash: string;
	originalTokens: number;
	createdAt: number;
	/**
	 * Why the model tier did not contribute, when it was tried and failed. The
	 * verdict stands regardless; this is for a person asking why a large block
	 * was only compressed by the heuristics.
	 */
	modelFailure?: string;
}

export type CompressionVerdict =
	| (VerdictBase & {
			outcome: 'compressed';
			/** The exact text sent in place of the original, marker included. */
			text: string;
			compressedTokens: number;
			compressors: CompressorId[];
			/** Hint route/environment hash. Null preserves an unreadable scope as a veto. */
			recoveryScope?: string | null;
	  })
	/** The block is sent as it is: nothing shortened it enough. */
	| (VerdictBase & { outcome: 'kept' });

export interface CompressionCache {
	/** The verdict for a hash, or `null` when none is stored (or it is unreadable). */
	read(hash: string): Promise<CompressionVerdict | null>;
	/**
	 * Commit a previously absent verdict after the caller's serialized read.
	 * For a `compressed` one, persist both texts before publishing the record.
	 * Rejection must not publish the verdict in memory or authorize its use.
	 */
	write(verdict: CompressionVerdict, original: string): Promise<void>;
	/** The text the agent sent, for a `compressed` block. `null` when not stored. */
	readOriginal(hash: string): Promise<string | null>;
	/** Bounded exact lines from that same file; missing is null, invalid/failed reads throw. */
	readOriginal(
		hash: string,
		range: TokenProxyOriginalLineRange
	): Promise<TokenProxyOriginalRangeRead | null>;
	/** Count what the directory holds. */
	usage(): Promise<CompressionCacheUsage>;
	/** Remove idle entries, then least recently used ones past the size cap. */
	prune(options?: CompressionCachePruneOptions): Promise<CompressionCachePruneResult>;
}

export interface CompressionCacheOptions {
	/** The cache directory. Defaults to `proxy-cache` in the Maestro data dir. */
	dir?: () => string;
	/** Verdicts kept in memory. */
	memoryEntries?: number;
}

/** The SHA-256 of a text's UTF-8 bytes, in lowercase hex. */
export function contentHash(text: string): string {
	return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Whether a value is a hash this cache could have written. Also the path guard. */
export function isContentHash(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isTokenCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// Extend alongside CompressorId for new filters; retain legacy IDs so their
// frozen replacement text remains readable without rerunning an algorithm.
const COMPRESSOR_IDS: ReadonlySet<unknown> = new Set<CompressorId>([
	'json',
	'logs',
	'long-lines',
	'model',
	'git-status',
	'git-log',
	'search',
	'test-output',
	'build-output',
	'lint-output',
	'json-table',
]);

/** The record file's shape, as far as every verdict shares it. */
interface StoredRecord {
	outcome: 'kept' | 'compressed';
	originalTokens: number;
	createdAt: number;
	modelFailure?: unknown;
	compressedTokens?: unknown;
	compressors?: unknown;
	recoveryScope?: unknown;
}

/** Whether a parsed record file is a verdict this version wrote for `hash`. */
function isStoredRecord(hash: string, value: unknown): value is StoredRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === COMPRESSION_RECORD_VERSION &&
		record.hash === hash &&
		(record.outcome === 'kept' || record.outcome === 'compressed') &&
		isTokenCount(record.originalTokens) &&
		typeof record.createdAt === 'number'
	);
}

export function createCompressionCache(options: CompressionCacheOptions = {}): CompressionCache {
	const dir = options.dir ?? (() => path.join(localModelsDataDir(), TOKEN_PROXY_CACHE_DIRNAME));
	const memoryEntries = Math.max(1, options.memoryEntries ?? DEFAULT_MEMORY_ENTRIES);
	// Insertion order is recency: a read moves its entry to the end.
	const memory = new Map<string, CompressionVerdict>();

	const entryPath = (hash: string, suffix: string): string =>
		path.join(dir(), hash.slice(0, 2), `${hash}${suffix}`);

	const remember = (verdict: CompressionVerdict): void => {
		memory.delete(verdict.hash);
		memory.set(verdict.hash, verdict);
		if (memory.size > memoryEntries) {
			const oldest = memory.keys().next().value;
			if (oldest !== undefined) memory.delete(oldest);
		}
	};

	// The last use of each hash in this process, and when its record's mtime was
	// last stamped, so a busy block does not rewrite the file on every request.
	const usedAt = new Map<string, number>();
	const stampedAt = new Map<string, number>();
	const touch = (hash: string): void => {
		const now = Date.now();
		usedAt.set(hash, now);
		const last = stampedAt.get(hash);
		if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
		stampedAt.set(hash, now);
		const when = new Date(now);
		// A failed stamp only makes the entry look older to a prune, which still
		// spares anything used within MIN_PRUNE_IDLE_MS of the last good stamp.
		fs.utimes(entryPath(hash, '.json'), when, when).catch((error: unknown) => {
			if (!isMissing(error)) {
				logger.warn('Could not stamp a token proxy cache entry as used', LOG_CONTEXT, {
					hash,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	};

	interface DiskEntry {
		hash: string;
		usedAt: number;
		bytes: number;
		files: string[];
	}

	/** Every entry under the directory, with orphan texts listed separately. */
	async function scan(): Promise<{
		entries: DiskEntry[];
		orphans: { file: string; bytes: number; mtimeMs: number }[];
		bytes: number;
	}> {
		const root = dir();
		let shards: string[];
		try {
			shards = await fs.readdir(root);
		} catch (error) {
			if (isMissing(error)) return { entries: [], orphans: [], bytes: 0 };
			throw error;
		}
		const byHash = new Map<string, DiskEntry>();
		const texts: { hash: string; file: string; bytes: number; mtimeMs: number }[] = [];
		let bytes = 0;
		for (const shard of shards) {
			if (!/^[0-9a-f]{2}$/.test(shard)) continue;
			let names: string[];
			try {
				names = await fs.readdir(path.join(root, shard));
			} catch (error) {
				if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
				throw error;
			}
			for (const name of names) {
				const match = /^([0-9a-f]{64})(\.json|\.original\.txt|\.compressed\.txt)$/.exec(name);
				if (!match || match[1].slice(0, 2) !== shard) continue;
				const file = path.join(root, shard, name);
				let stat: Awaited<ReturnType<typeof fs.stat>>;
				try {
					stat = await fs.stat(file);
				} catch (error) {
					if (isMissing(error)) continue;
					throw error;
				}
				if (!stat.isFile()) continue;
				bytes += stat.size;
				const [, hash, suffix] = match;
				if (suffix === '.json') {
					const entry = byHash.get(hash) ?? { hash, usedAt: 0, bytes: 0, files: [] };
					entry.usedAt = stat.mtimeMs;
					entry.bytes += stat.size;
					// The record first: it is the commit, so removing it first leaves
					// no verdict whose text is gone.
					entry.files.unshift(file);
					byHash.set(hash, entry);
				} else {
					texts.push({ hash, file, bytes: stat.size, mtimeMs: stat.mtimeMs });
				}
			}
		}
		const orphans: { file: string; bytes: number; mtimeMs: number }[] = [];
		for (const text of texts) {
			const entry = byHash.get(text.hash);
			if (entry) {
				entry.bytes += text.bytes;
				entry.files.push(text.file);
			} else {
				orphans.push(text);
			}
		}
		return { entries: [...byHash.values()], orphans, bytes };
	}

	const usageOf = (entries: DiskEntry[], bytes: number): CompressionCacheUsage => ({
		entries: entries.length,
		bytes,
		oldestUseAt: entries.length === 0 ? null : Math.min(...entries.map((entry) => entry.usedAt)),
	});

	async function removeFiles(files: string[]): Promise<void> {
		for (const file of files) {
			try {
				await fs.unlink(file);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
	}

	const unreadable = (hash: string, why: string): null => {
		logger.warn(`Ignoring a token proxy cache entry: ${why}`, LOG_CONTEXT, { hash });
		return null;
	};

	async function readFromDisk(hash: string): Promise<CompressionVerdict | null> {
		let raw: string;
		try {
			raw = await fs.readFile(entryPath(hash, '.json'), 'utf-8');
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			if (error instanceof SyntaxError) return unreadable(hash, 'its record is not JSON');
			throw error;
		}
		if (!isStoredRecord(hash, parsed)) {
			return unreadable(hash, 'its record is not a verdict this version wrote');
		}
		const base: VerdictBase = {
			hash,
			originalTokens: parsed.originalTokens,
			createdAt: parsed.createdAt,
			...(typeof parsed.modelFailure === 'string' ? { modelFailure: parsed.modelFailure } : {}),
		};
		if (parsed.outcome === 'kept') return { ...base, outcome: 'kept' };

		const { compressedTokens } = parsed;
		const compressors = Array.isArray(parsed.compressors)
			? parsed.compressors.filter((id): id is CompressorId => COMPRESSOR_IDS.has(id))
			: [];
		if (!isTokenCount(compressedTokens) || compressors.length === 0) {
			return unreadable(hash, 'its record does not say how it was compressed');
		}
		let text: string;
		try {
			text = await fs.readFile(entryPath(hash, '.compressed.txt'), 'utf-8');
		} catch (error) {
			if (isMissing(error)) return unreadable(hash, 'its compressed text is missing');
			throw error;
		}
		return {
			...base,
			outcome: 'compressed',
			text,
			compressedTokens,
			compressors,
			// Never discard/re-decide a verdict because its scope is unreadable.
			...('recoveryScope' in parsed
				? { recoveryScope: isContentHash(parsed.recoveryScope) ? parsed.recoveryScope : null }
				: {}),
		};
	}

	function readOriginal(hash: string): Promise<string | null>;
	function readOriginal(
		hash: string,
		range: TokenProxyOriginalLineRange
	): Promise<TokenProxyOriginalRangeRead | null>;
	async function readOriginal(
		hash: string,
		range?: TokenProxyOriginalLineRange
	): Promise<string | TokenProxyOriginalRangeRead | null> {
		const requested = range === undefined ? undefined : validateTokenProxyOriginalLineRange(range);
		if (!isContentHash(hash)) return null;
		const file = entryPath(hash, '.original.txt');
		try {
			if (requested === undefined) return await fs.readFile(file, 'utf-8');
			const handle = await fs.open(file, 'r');
			try {
				const stat = await handle.stat();
				if (!stat.isFile()) throw new Error('The cached original is not a regular file.');
				const buffer = Buffer.alloc(64 * 1024);
				const parts: Buffer[] = [];
				let position = 0;
				let line = 1;
				let selectedBytes = 0;
				let lastLine: number | null = null;
				while (position < stat.size && line <= requested.endLine) {
					const length = Math.min(
						buffer.length,
						stat.size - position,
						ORIGINAL_RANGE_MAX_SCAN_BYTES - position
					);
					if (length <= 0) {
						throw new RangeError('Original line range exceeds the 64 MiB scan limit.');
					}
					const { bytesRead } = await handle.read(buffer, 0, length, position);
					if (bytesRead === 0) throw new Error('The cached original ended during range recovery.');
					const chunk = buffer.subarray(0, bytesRead);
					let offset = 0;
					while (offset < bytesRead && line <= requested.endLine) {
						const newline = chunk.indexOf(10, offset);
						const end = newline < 0 ? bytesRead : newline + 1;
						if (line >= requested.startLine) {
							selectedBytes += end - offset;
							if (selectedBytes > TOKEN_PROXY_ORIGINAL_RANGE_MAX_BYTES) {
								throw new RangeError(
									`Original line range exceeds the ${TOKEN_PROXY_ORIGINAL_RANGE_MAX_BYTES}-byte output limit; request fewer or shorter lines.`
								);
							}
							parts.push(Buffer.from(chunk.subarray(offset, end)));
							lastLine = line;
						}
						position += end - offset;
						offset = end;
						if (newline >= 0) line++;
					}
				}
				return {
					text: Buffer.concat(parts, selectedBytes).toString('utf-8'),
					range: {
						hash,
						source: 'original',
						requested,
						returned:
							lastLine === null ? null : { startLine: requested.startLine, endLine: lastLine },
						complete: lastLine === requested.endLine,
						hasMore: position < stat.size,
					},
				};
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	return {
		async read(hash: string): Promise<CompressionVerdict | null> {
			if (!isContentHash(hash)) return null;
			const held = memory.get(hash);
			if (held) {
				remember(held);
				touch(hash);
				return held;
			}
			const verdict = await readFromDisk(hash);
			if (verdict) {
				remember(verdict);
				touch(hash);
			}
			return verdict;
		},

		async write(verdict: CompressionVerdict, original: string): Promise<void> {
			if (!isContentHash(verdict.hash)) {
				throw new Error(`Not a content hash: "${String(verdict.hash)}".`);
			}
			await fs.mkdir(path.dirname(entryPath(verdict.hash, '.json')), { recursive: true });
			const { hash, originalTokens, createdAt, modelFailure } = verdict;
			const record: Record<string, unknown> = {
				version: COMPRESSION_RECORD_VERSION,
				hash,
				outcome: verdict.outcome,
				originalTokens,
				createdAt,
				...(modelFailure !== undefined ? { modelFailure } : {}),
			};
			if (verdict.outcome === 'compressed') {
				// The record is the commit: it is written after both texts, so a
				// crash in between leaves no verdict rather than one with no text.
				await atomicWriteFile(entryPath(hash, '.original.txt'), original);
				await atomicWriteFile(entryPath(hash, '.compressed.txt'), verdict.text);
				record.compressedTokens = verdict.compressedTokens;
				record.compressors = verdict.compressors;
				if (verdict.recoveryScope !== undefined) record.recoveryScope = verdict.recoveryScope;
			}
			await atomicWriteJson(entryPath(hash, '.json'), record);
			remember(verdict);
			// The write itself stamped the record; the next use need not.
			usedAt.set(hash, Date.now());
			stampedAt.set(hash, Date.now());
		},

		readOriginal,

		async usage(): Promise<CompressionCacheUsage> {
			const { entries, bytes } = await scan();
			return usageOf(entries, bytes);
		},

		async prune(pruneOptions: CompressionCachePruneOptions = {}) {
			const now = pruneOptions.now ?? Date.now();
			const maxIdleMs = Math.max(
				MIN_PRUNE_IDLE_MS,
				pruneOptions.maxIdleMs ?? DEFAULT_PRUNE_IDLE_MS
			);
			const maxBytes = Math.max(0, pruneOptions.maxBytes ?? DEFAULT_PRUNE_MAX_BYTES);
			const { entries, orphans, bytes } = await scan();
			let remainingBytes = bytes;
			let removedEntries = 0;
			let removedBytes = 0;
			let removedOrphans = 0;

			const remove = async (entry: DiskEntry): Promise<void> => {
				await removeFiles(entry.files);
				memory.delete(entry.hash);
				usedAt.delete(entry.hash);
				stampedAt.delete(entry.hash);
				removedEntries++;
				removedBytes += entry.bytes;
				remainingBytes -= entry.bytes;
			};

			// Oldest use first, so the size pass removes the least recently used.
			entries.sort((a, b) => a.usedAt - b.usedAt);
			const kept: DiskEntry[] = [];
			for (const entry of entries) {
				const idle = now - entry.usedAt;
				// This process's own record of a use is newer than the file's stamp
				// between stamps, and when a stamp failed.
				const recentlyUsed =
					idle < MIN_PRUNE_IDLE_MS || now - (usedAt.get(entry.hash) ?? 0) < MIN_PRUNE_IDLE_MS;
				if (!recentlyUsed && (idle > maxIdleMs || remainingBytes > maxBytes)) {
					await remove(entry);
				} else {
					kept.push(entry);
				}
			}
			// A text with no record older than a day is a crash leftover; a younger
			// one may be a write in progress, whose record is written last.
			for (const orphan of orphans) {
				if (now - orphan.mtimeMs < MIN_PRUNE_IDLE_MS) continue;
				await removeFiles([orphan.file]);
				removedOrphans++;
				removedBytes += orphan.bytes;
				remainingBytes -= orphan.bytes;
			}
			if (removedEntries > 0 || removedOrphans > 0) {
				logger.info('Pruned the token proxy cache', LOG_CONTEXT, {
					removedEntries,
					removedOrphans,
					removedBytes,
				});
			}
			return {
				removedEntries,
				removedBytes,
				removedOrphans,
				usage: usageOf(kept, remainingBytes),
			};
		},
	};
}

let defaultCache: CompressionCache | null = null;

/** The app's cache, in the Maestro data dir. One per process, so its memory is shared. */
export function getCompressionCache(): CompressionCache {
	defaultCache ??= createCompressionCache();
	return defaultCache;
}
