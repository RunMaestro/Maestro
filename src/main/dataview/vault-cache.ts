/**
 * The per-root disk cache of a Dataview index (M4, DV-5). One folder per `(root, sshRemoteId)` under
 * `<userData>/dataview-cache/`, named by the SHA-1 of the pair. It holds every file and folder of the
 * vault (link resolution needs the whole file set before any page is read), the starred paths, and each
 * page's RAW parse with the `mtime` and `size` it was parsed at.
 *
 * The folder holds a `manifest.json` (the file set and stars) and {@link DATAVIEW_CACHE_SHARD_COUNT} page
 * shards, `pages-<n>.json`, each page in the shard its path hashes to. A change rewrites the manifest and only
 * the shards of the pages it touched. One file for the whole root came to 457 MB on a 16k-page vault, and
 * every watcher batch stringified and wrote all of it on the main thread: two seconds of a frozen app per
 * change, several times a minute.
 *
 * The files are not written as one atomic unit. That is safe because each page carries its own fingerprint:
 * after a crash between two shard writes, the reconcile that follows every open re-parses what is stale and
 * drops what is gone.
 *
 * Pages are stored before link resolution, as upstream's persister stores them: the same file resolves its
 * links differently once other files appear or vanish, so `VaultIndex` resolves them again on load. Values
 * go through upstream's `Transferable` codec plus `dataviewJsonReplacer`, so dates, durations, links,
 * `Map`, and `Set` survive JSON. See docs/agent-guides/DATAVIEW.md ("Disk cache (DV-5)").
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import { dataviewJsonReplacer, dataviewJsonReviver } from '../../shared/dataview';
import { assertSerializedJsonIsSafe } from '../../shared/jsonUtils';
import { atomicWriteFile, createKeyedWriteQueue } from '../utils/atomic-json-store';
import {
	LOCAL_SESSION_READ_CONCURRENCY,
	mapWithConcurrency,
	yieldToEventLoop,
} from '../utils/concurrency';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = 'Dataview';

/**
 * Bump whenever the cached page data changes shape or derivation: M1 (`extractMetadata`), the vendored
 * `parsePage`, the `Transferable` codec, or this file's layout. A cache with another version is discarded
 * and the root is scanned again; the fingerprint cannot see a parser change. 2: one folder of shards.
 */
export const DATAVIEW_INDEX_CACHE_VERSION = 2;

/** The folder under userData that holds every root's cache folder. */
export const DATAVIEW_CACHE_DIR_NAME = 'dataview-cache';

/**
 * Page shards per root. A 16k-page vault comes to about 2 MB a shard, so one changed page costs a few
 * milliseconds of stringify and write instead of the whole index.
 */
export const DATAVIEW_CACHE_SHARD_COUNT = 256;

/** The file in a root's cache folder that holds the file set and stars. */
export const DATAVIEW_CACHE_MANIFEST_FILE = 'manifest.json';

/** One markdown page as cached: its fingerprint and its raw parse, encoded with `Transferable`. */
export interface CachedPage {
	size: number;
	mtime: number;
	ctime: number;
	/** Indexed with `file.*` fields only (over the size cap); its text was never read. */
	oversized: boolean;
	/** `Transferable.transferable(parseRawPage(...))`. May hold `Map` and `Set`. */
	data: unknown;
}

/** One root's cache as loaded: the manifest with every shard's pages merged in. */
export interface VaultCacheFile {
	version: number;
	/** Kept for debuggability and checked on load: the folder name itself is a hash. */
	root: string;
	sshRemoteId: string | null;
	savedAt: number;
	files: string[];
	folders: string[];
	stars: string[];
	pages: Record<string, CachedPage>;
}

/** The on-disk shape of `manifest.json`. */
interface VaultCacheManifest {
	version: number;
	root: string;
	sshRemoteId: string | null;
	savedAt: number;
	/** Checked on load: pages hash to another shard under another count. */
	shardCount: number;
	files: string[];
	folders: string[];
	stars: string[];
}

/** The on-disk shape of one `pages-<n>.json`. */
interface VaultCacheShard {
	version: number;
	pages: Record<string, CachedPage>;
}

/** One write: the manifest fields, and the full contents of every shard that changed. */
export interface VaultCacheWrite {
	root: string;
	sshRemoteId: string | null;
	files: string[];
	folders: string[];
	stars: string[];
	/** Shard number to every page it holds now. An empty record empties the shard. */
	shards: Map<number, Record<string, CachedPage>>;
	/** Delete every shard first: the index did not load this cache, so no shard on disk is current. */
	replace?: boolean;
}

/** Serializes writes per cache folder: `atomicWriteFile` uses one fixed temp name per target. */
const writes = createKeyedWriteQueue();

/** `<cacheDir>/<sha1 of root + sshRemoteId>`, the root's cache folder. */
export function dataviewCachePath(
	cacheDir: string,
	root: string,
	sshRemoteId: string | null
): string {
	const hash = crypto
		.createHash('sha1')
		.update(`${root}\0${sshRemoteId ?? ''}`)
		.digest('hex');
	return path.join(cacheDir, hash);
}

/**
 * The shard a page lives in: FNV-1a over the path's UTF-16 code units. Stable across runs and cheap enough
 * to compute for every page on every write; not a security hash.
 */
export function dataviewCacheShardOf(pagePath: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < pagePath.length; i++) {
		hash ^= pagePath.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % DATAVIEW_CACHE_SHARD_COUNT;
}

function shardFile(cachePath: string, shard: number): string {
	return path.join(cachePath, `pages-${String(shard).padStart(3, '0')}.json`);
}

/** The single-file cache of version 1, `<cachePath>.json`. Deleted on the first write. */
function legacyCacheFile(cachePath: string): string {
	return `${cachePath}.json`;
}

function isManifest(value: unknown): value is VaultCacheManifest {
	const manifest = value as VaultCacheManifest | null;
	return (
		!!manifest &&
		typeof manifest === 'object' &&
		Array.isArray(manifest.files) &&
		Array.isArray(manifest.folders) &&
		Array.isArray(manifest.stars)
	);
}

function isShard(value: unknown): value is VaultCacheShard {
	const shard = value as VaultCacheShard | null;
	return !!shard && typeof shard === 'object' && !!shard.pages && typeof shard.pages === 'object';
}

/** Read and parse one cache file. Null when it is missing; a read or parse failure is logged and null too. */
async function readCacheJson(file: string, what: string): Promise<unknown> {
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT') {
			logger.warn(`Dataview could not read its ${what} ${file}: ${String(error)}`, LOG_CONTEXT);
		}
		return null;
	}
	try {
		return JSON.parse(text, dataviewJsonReviver);
	} catch (error) {
		logger.warn(`Dataview discarded a corrupt ${what} ${file}: ${String(error)}`, LOG_CONTEXT);
		return null;
	}
}

/**
 * Load the cache for `root`, or null when there is none or it cannot be used: a missing manifest, another
 * version or shard count, another root, or a manifest that does not parse. A shard that is missing or does
 * not parse only drops its pages, which the reconcile after the load parses again. Nothing here throws.
 */
export async function readVaultCache(
	cachePath: string,
	root: string,
	sshRemoteId: string | null
): Promise<VaultCacheFile | null> {
	const manifestFile = path.join(cachePath, DATAVIEW_CACHE_MANIFEST_FILE);
	const manifest = await readCacheJson(manifestFile, 'index cache');
	if (manifest === null) return null;
	if (!isManifest(manifest)) {
		logger.warn(`Dataview discarded a malformed index cache ${manifestFile}`, LOG_CONTEXT);
		return null;
	}
	if (
		manifest.version !== DATAVIEW_INDEX_CACHE_VERSION ||
		manifest.shardCount !== DATAVIEW_CACHE_SHARD_COUNT
	) {
		logger.info(
			`Dataview discarded an index cache from version ${manifest.version} (now ${DATAVIEW_INDEX_CACHE_VERSION}) for ${root}`,
			LOG_CONTEXT
		);
		return null;
	}
	if (manifest.root !== root || (manifest.sshRemoteId ?? null) !== sshRemoteId) {
		logger.warn(
			`Dataview discarded an index cache that belongs to another root: ${cachePath}`,
			LOG_CONTEXT
		);
		return null;
	}

	const shardNumbers = Array.from({ length: DATAVIEW_CACHE_SHARD_COUNT }, (_, shard) => shard);
	const shards = await mapWithConcurrency(
		shardNumbers,
		LOCAL_SESSION_READ_CONCURRENCY,
		async (shard) => {
			const file = shardFile(cachePath, shard);
			const parsed = await readCacheJson(file, 'index cache shard');
			if (parsed === null) return null;
			if (!isShard(parsed) || parsed.version !== DATAVIEW_INDEX_CACHE_VERSION) {
				logger.warn(`Dataview discarded a malformed index cache shard ${file}`, LOG_CONTEXT);
				return null;
			}
			return parsed.pages;
		}
	);
	const pages: Record<string, CachedPage> = {};
	for (const shardPages of shards) if (shardPages) Object.assign(pages, shardPages);

	return {
		version: manifest.version,
		root: manifest.root,
		sshRemoteId: manifest.sshRemoteId ?? null,
		savedAt: manifest.savedAt,
		files: manifest.files,
		folders: manifest.folders,
		stars: manifest.stars,
		pages,
	};
}

/** Compact on purpose: a pretty-printed index of a large vault is several times the size. */
async function writeCacheJson(file: string, value: unknown): Promise<void> {
	const serialized = JSON.stringify(value, dataviewJsonReplacer);
	assertSerializedJsonIsSafe(serialized, file);
	await atomicWriteFile(file, serialized);
}

/**
 * Write the changed shards, then the manifest, each atomically (temp file, then rename), one writer per root
 * at a time, yielding between shards so IPC keeps flowing. Removes the version 1 single-file cache. Failures
 * are logged and reported, never thrown: the in-memory index stays correct, and the next open reconciles.
 */
export function writeVaultCache(cachePath: string, write: VaultCacheWrite): Promise<void> {
	return writes.enqueue(cachePath, async () => {
		try {
			if (write.replace) await fs.rm(cachePath, { recursive: true, force: true });
			await fs.mkdir(cachePath, { recursive: true });
			for (const [shard, pages] of write.shards) {
				const contents: VaultCacheShard = { version: DATAVIEW_INDEX_CACHE_VERSION, pages };
				await writeCacheJson(shardFile(cachePath, shard), contents);
				await yieldToEventLoop();
			}
			const manifest: VaultCacheManifest = {
				version: DATAVIEW_INDEX_CACHE_VERSION,
				root: write.root,
				sshRemoteId: write.sshRemoteId,
				savedAt: Date.now(),
				shardCount: DATAVIEW_CACHE_SHARD_COUNT,
				files: write.files,
				folders: write.folders,
				stars: write.stars,
			};
			await writeCacheJson(path.join(cachePath, DATAVIEW_CACHE_MANIFEST_FILE), manifest);
			await fs.rm(legacyCacheFile(cachePath), { force: true });
		} catch (error) {
			logger.warn(
				`Dataview could not write its index cache ${cachePath}: ${String(error)}`,
				LOG_CONTEXT
			);
			void captureException(error, { operation: 'dataview:writeIndexCache', root: write.root });
		}
	});
}

/**
 * Delete a root's cache folder (a rebuild), and a version 1 file if one is left. It queues behind any write
 * to the same root, so a pending write cannot land after the delete and bring the old index back.
 */
export function deleteVaultCache(cachePath: string): Promise<void> {
	return writes.enqueue(cachePath, async () => {
		await fs.rm(cachePath, { recursive: true, force: true });
		await fs.rm(legacyCacheFile(cachePath), { force: true });
	});
}
