/**
 * The per-root disk cache of a Dataview index (M4, DV-5). One JSON file per `(root, sshRemoteId)` under
 * `<userData>/dataview-cache/`, named by the SHA-1 of the pair. It holds every file and folder of the
 * vault (link resolution needs the whole file set before any page is read), the starred paths, and each
 * page's RAW parse with the `mtime` and `size` it was parsed at.
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
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = 'Dataview';

/**
 * Bump whenever the cached page data changes shape or derivation: M1 (`extractMetadata`), the vendored
 * `parsePage`, the `Transferable` codec, or this file's layout. A cache with another version is discarded
 * and the root is scanned again; the fingerprint cannot see a parser change.
 */
export const DATAVIEW_INDEX_CACHE_VERSION = 1;

/** The folder under userData that holds every root's cache file. */
export const DATAVIEW_CACHE_DIR_NAME = 'dataview-cache';

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

/** The on-disk shape of one root's cache. */
export interface VaultCacheFile {
	version: number;
	/** Kept for debuggability and checked on load: the file name itself is a hash. */
	root: string;
	sshRemoteId: string | null;
	savedAt: number;
	files: string[];
	folders: string[];
	stars: string[];
	pages: Record<string, CachedPage>;
}

/** Serializes writes per cache file: `atomicWriteFile` uses one fixed temp name per target. */
const writes = createKeyedWriteQueue();

/** `<cacheDir>/<sha1 of root + sshRemoteId>.json`. */
export function dataviewCacheFilePath(
	cacheDir: string,
	root: string,
	sshRemoteId: string | null
): string {
	const hash = crypto
		.createHash('sha1')
		.update(`${root}\0${sshRemoteId ?? ''}`)
		.digest('hex');
	return path.join(cacheDir, `${hash}.json`);
}

function isCacheFile(value: unknown): value is VaultCacheFile {
	const file = value as VaultCacheFile | null;
	return (
		!!file &&
		typeof file === 'object' &&
		Array.isArray(file.files) &&
		Array.isArray(file.folders) &&
		Array.isArray(file.stars) &&
		!!file.pages &&
		typeof file.pages === 'object'
	);
}

/**
 * Load the cache for `root`, or null when there is none or it cannot be used: a missing file, another
 * version, another root, or anything that does not parse. A bad cache only costs a rescan, so nothing here
 * throws.
 */
export async function readVaultCache(
	file: string,
	root: string,
	sshRemoteId: string | null
): Promise<VaultCacheFile | null> {
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT') {
			logger.warn(`Dataview could not read its index cache ${file}: ${String(error)}`, LOG_CONTEXT);
		}
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text, dataviewJsonReviver);
	} catch (error) {
		logger.warn(`Dataview discarded a corrupt index cache ${file}: ${String(error)}`, LOG_CONTEXT);
		return null;
	}
	if (!isCacheFile(parsed)) {
		logger.warn(`Dataview discarded a malformed index cache ${file}`, LOG_CONTEXT);
		return null;
	}
	if (parsed.version !== DATAVIEW_INDEX_CACHE_VERSION) {
		logger.info(
			`Dataview discarded an index cache from version ${parsed.version} (now ${DATAVIEW_INDEX_CACHE_VERSION}) for ${root}`,
			LOG_CONTEXT
		);
		return null;
	}
	if (parsed.root !== root || (parsed.sshRemoteId ?? null) !== sshRemoteId) {
		logger.warn(
			`Dataview discarded an index cache that belongs to another root: ${file}`,
			LOG_CONTEXT
		);
		return null;
	}
	return parsed;
}

/**
 * Write the cache atomically (temp file, then rename), one writer per file at a time. Failures are logged
 * and reported, never thrown: the in-memory index stays correct, and the next open rescans.
 */
export function writeVaultCache(file: string, cache: VaultCacheFile): Promise<void> {
	return writes.enqueue(file, async () => {
		try {
			// Compact on purpose: a pretty-printed index of a large vault is several times the size.
			const serialized = JSON.stringify(cache, dataviewJsonReplacer);
			assertSerializedJsonIsSafe(serialized, file);
			await fs.mkdir(path.dirname(file), { recursive: true });
			await atomicWriteFile(file, serialized);
		} catch (error) {
			logger.warn(
				`Dataview could not write its index cache ${file}: ${String(error)}`,
				LOG_CONTEXT
			);
			void captureException(error, { operation: 'dataview:writeIndexCache', root: cache.root });
		}
	});
}

/**
 * Delete a root's cache file (a rebuild). It queues behind any write to the same file, so a pending write
 * cannot land after the delete and bring the old index back.
 */
export function deleteVaultCache(file: string): Promise<void> {
	return writes.enqueue(file, () => fs.rm(file, { force: true }));
}
