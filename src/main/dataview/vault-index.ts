/**
 * The Dataview index for ONE vault root (M2, D2, DV-3). It implements the vendored `FullIndex` contract, so
 * the vendored source resolver, query engine, and `PageMetadata.serialize` run against it unchanged. The
 * in-memory members come from the shared `PageIndex` (`src/shared/dataview/pageIndex.ts`), which the
 * DataviewJS guest builds from a snapshot too, so a source matches the same pages in both:
 *
 * - `pages`: path to `PageMetadata`, built by `parsePage` (M1, the vendored parser, then M3 link resolution).
 * - `tags`: path to its tags plus their parent tags (`fullTags()`), with a case-insensitive inverse.
 * - `links`: path to its outlink paths; the inverse is the inlink index (`file.inlinks`).
 * - `prefix`: the folder index over every vault file, any extension.
 * - `metadataCache`, `vault`, `csv`, `starred`: the Obsidian services the engine reaches for.
 *
 * This class adds what only main has: file access through a `VaultFs` (so a local root and an SSH root index
 * the same way), the disk cache, and the watcher or poller.
 *
 * Freshness (DV-5, M4, M5): `open()` serves the disk cache at once and reconciles in the background,
 * re-parsing only pages whose `mtime` or `size` changed. A local root is then watched with chokidar (one
 * batch per 250 ms burst); a remote root is reconciled every 30 s. Every update, whatever its source, runs
 * one at a time and swaps in as ONE change. A page's links resolve again whenever a file they could name
 * appears or vanishes. See docs/agent-guides/DATAVIEW.md (section 2, "The `FullIndex` contract" and M2).
 */

import {
	PageIndex,
	VaultPaths,
	Transferable,
	createLinkResolver,
	finishPage,
	isMarkdownPagePath,
	linkPathKey,
	linkTargetKeys,
	parseRawPage,
	starredPathsFromBookmarks,
	type DataviewWatchMode,
	type LinkResolver,
	type PageMetadata,
	type PageParseWarning,
	type SandboxIndexSnapshot,
} from '../../shared/dataview';
import { LOCAL_SESSION_READ_CONCURRENCY, yieldToEventLoop } from '../utils/concurrency';
import { mapWithConcurrency } from '../../shared/concurrency';
import { logger } from '../utils/logger';
import {
	dataviewCacheFilePath,
	DATAVIEW_INDEX_CACHE_VERSION,
	readVaultCache,
	writeVaultCache,
	type CachedPage,
	type VaultCacheFile,
} from './vault-cache';
import {
	VAULT_BOOKMARKS_PATH,
	isIndexedVaultPath,
	type VaultEntryStat,
	type VaultFileStat,
	type VaultFs,
} from './vault-fs';
import { VAULT_MARKER_DIR } from './vault-root';
import { createVaultWatcher, type VaultWatcher } from './vault-watcher';

const LOG_CONTEXT = 'Dataview';

/** Files parsed per batch. The index yields to the event loop between batches so IPC keeps flowing. */
export const DATAVIEW_PARSE_BATCH_SIZE = 16;

/**
 * Pages larger than this are indexed with their `file.*` fields only (name, path, size, times): their
 * text is never read, so one huge export cannot stall the main thread.
 */
export const DATAVIEW_MAX_INDEXED_FILE_BYTES = 2 * 1024 * 1024;

/** Pages re-resolved per batch (decode the cached parse, resolve links) between event-loop yields. */
export const DATAVIEW_FINISH_BATCH_SIZE = 256;

/** How often a remote root is reconciled by `mtime` and `size`, since chokidar cannot watch over SSH. */
export const DATAVIEW_REMOTE_POLL_MS = 30 * 1000;

/** Changes within this window share one cache write; serializing a large index is not free. */
export const DATAVIEW_CACHE_WRITE_DEBOUNCE_MS = 1000;

/** How the index learns about changes after `open()`. */
export type VaultWatchMode = DataviewWatchMode;

/** One index change: the new revision and every page path whose data may differ. */
export interface VaultIndexChange {
	revision: number;
	changedPaths: string[];
}

export type VaultIndexListener = (change: VaultIndexChange) => void;

/** What the last full scan (a reconcile against the whole file system) did. */
export interface VaultScanStats {
	pageCount: number;
	/** Pages read and parsed by this scan; every other page was unchanged and kept. */
	parsedCount: number;
	/** Pages indexed with `file.*` fields only because they exceed {@link DATAVIEW_MAX_INDEXED_FILE_BYTES}. */
	oversizedCount: number;
	/** Pages whose read failed (deleted mid-scan, permissions); they keep what the index had, if anything. */
	failedCount: number;
	durationMs: number;
	finishedAt: number;
}

export interface VaultIndexOptions {
	/** Receives parse warnings (invalid frontmatter and similar). Defaults to a debug log line. */
	onWarning?: (warning: PageParseWarning) => void;
	/** The folder holding cache files (`<userData>/dataview-cache`). Without it nothing is kept on disk. */
	cacheDir?: string;
	/** Whether `open()` starts the watcher (local) or the poller (remote). Defaults to true. */
	watch?: boolean;
}

/** One page read and parsed: what the cache keeps, and the page with its links resolved. */
interface ParsedPage {
	entry: CachedPage;
	page: PageMetadata;
}

/** One update, ready to swap in. */
interface IndexUpdate {
	paths: VaultPaths;
	resolver: LinkResolver;
	parsed: Map<string, ParsedPage>;
	removed: Set<string>;
	stars: Set<string>;
	/** Write the cache afterwards. False when the update IS the cache. */
	persist: boolean;
}

export class VaultIndex extends PageIndex {
	/** Stats of the last finished full scan, or null before the first one. */
	lastScan: VaultScanStats | null = null;
	/** Whether `open()` served the disk cache instead of waiting for a scan. */
	cacheHit = false;
	/** The cache file of this root, or null when the index keeps nothing on disk. */
	readonly cacheFile: string | null;

	/** Path to its cached raw parse, the source of truth the pages are finished from. */
	private readonly entries = new Map<string, CachedPage>();
	private readonly listeners = new Set<VaultIndexListener>();
	private readonly onWarning: (warning: PageParseWarning) => void;
	private readonly watchEnabled: boolean;
	/** Every update (open, scan, watcher batch) chains here, so two never interleave. */
	private updates: Promise<void> = Promise.resolve();
	private scanInFlight: Promise<VaultScanStats> | null = null;
	private opening: Promise<void> | null = null;
	private watcher: VaultWatcher | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private cacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
	private cacheDirty = false;
	private disposed = false;

	constructor(
		readonly fs: VaultFs,
		options: VaultIndexOptions = {}
	) {
		super((path) => fs.readText(path));
		this.cacheFile = options.cacheDir
			? dataviewCacheFilePath(options.cacheDir, fs.root, fs.sshRemoteId)
			: null;
		this.watchEnabled = options.watch ?? true;
		this.onWarning =
			options.onWarning ??
			((warning) =>
				logger.debug(
					`Dataview parse warning in ${warning.path}:${warning.line + 1}: ${warning.message}`,
					LOG_CONTEXT
				));
	}

	/** The vault root as the platform spells it. */
	get root(): string {
		return this.fs.root;
	}

	/** How changes reach the index now: a chokidar watcher, the remote poll, or nothing yet. */
	get watchMode(): VaultWatchMode {
		if (this.watcher) return 'chokidar';
		return this.pollTimer ? 'poll' : 'none';
	}

	/** Resolves once the watcher has finished its initial walk (at once when there is no watcher). */
	get watcherReady(): Promise<void> {
		return this.watcher?.ready ?? Promise.resolve();
	}

	/** Subscribe to index changes. Returns the unsubscribe function. */
	onChange(listener: VaultIndexListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Make the index usable and keep it fresh (DV-5). With a valid disk cache the cached pages are served at
	 * once and a full reconcile runs in the background; without one, this waits for the first scan. Then the
	 * root is watched (local) or polled (remote). Concurrent calls share one open. Throws when the root
	 * cannot be listed and there is no cache; a later call tries again.
	 */
	open(): Promise<void> {
		if (!this.opening) {
			this.opening = this.runOpen().catch((error) => {
				this.opening = null;
				void this.stopWatching();
				throw error;
			});
		}
		return this.opening;
	}

	private async runOpen(): Promise<void> {
		const cached = this.cacheFile
			? await readVaultCache(this.cacheFile, this.root, this.fs.sshRemoteId)
			: null;
		// Watch before the first scan, so a change made during it is applied right after it.
		this.startWatching();
		if (cached) {
			await this.exclusive(() => this.installCache(cached));
			this.cacheHit = true;
			this.scan().catch((error) =>
				logger.warn(
					`Dataview could not reconcile ${this.root} after loading its cache: ${String(error)}`,
					LOG_CONTEXT
				)
			);
		} else {
			await this.scan();
		}
	}

	/**
	 * Reconcile the whole vault with the file system: list it, re-parse only the pages whose `mtime` or
	 * `size` differ from what the index holds, drop the pages that are gone, and swap the result in as ONE
	 * change (none when nothing differs). Concurrent calls share one scan. Throws when the root cannot be
	 * listed; a single unreadable page is counted and keeps what the index had.
	 */
	scan(): Promise<VaultScanStats> {
		if (!this.scanInFlight) {
			this.scanInFlight = this.exclusive(() => this.runScan()).finally(() => {
				this.scanInFlight = null;
			});
		}
		return this.scanInFlight;
	}

	/**
	 * Apply one batch of changed vault-relative paths (a watcher burst): stat each one, re-parse the pages
	 * whose fingerprint changed, and drop what is gone, a folder's pages included. Without a per-path stat
	 * (a remote root) this runs a full scan instead.
	 */
	applyChangedPaths(relPaths: string[]): Promise<void> {
		if (this.disposed || relPaths.length === 0) return Promise.resolve();
		if (!this.fs.stat) return this.scan().then(() => undefined);
		return this.exclusive(() => this.runPathBatch(relPaths));
	}

	/**
	 * Stop watching and polling, and write any pending cache change. Waits for the update in flight. The
	 * index keeps answering queries with what it has, but no longer changes.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.stopWatching();
		await this.updates;
		if (this.cacheWriteTimer) clearTimeout(this.cacheWriteTimer);
		this.cacheWriteTimer = null;
		await this.flushCache();
		this.listeners.clear();
	}

	/**
	 * The index as a DataviewJS run sees it (D4): every file, folder, and star, and each page's cached raw
	 * parse, from which the guest rebuilds the index the way {@link installCache} does. Taken synchronously,
	 * so it is one revision, never half of an update.
	 */
	jsSnapshot(): SandboxIndexSnapshot {
		return {
			revision: this.revision,
			files: this.prefix.allFiles(),
			folders: this.prefix.allFolders(),
			stars: [...this.stars],
			pages: Array.from(this.entries, ([path, entry]) => ({
				path,
				data: entry.data as Record<string, unknown>,
			})),
		};
	}

	/** Write the cache now if anything changed since the last write. */
	async flushCache(): Promise<void> {
		if (!this.cacheFile || !this.cacheDirty) return;
		this.cacheDirty = false;
		await writeVaultCache(this.cacheFile, this.cacheSnapshot());
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.updates.then(fn);
		this.updates = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	private startWatching(): void {
		if (!this.watchEnabled || this.disposed || this.watcher || this.pollTimer) return;
		if (this.fs.sshRemoteId) {
			this.pollTimer = setInterval(() => {
				this.scan().catch((error) =>
					logger.warn(`Dataview could not poll ${this.root}: ${String(error)}`, LOG_CONTEXT)
				);
			}, DATAVIEW_REMOTE_POLL_MS);
			this.pollTimer.unref?.();
			return;
		}
		this.watcher = createVaultWatcher({
			root: this.root,
			onChange: (relPaths) => {
				this.applyChangedPaths(relPaths).catch((error) =>
					logger.warn(
						`Dataview could not apply changes under ${this.root}: ${String(error)}`,
						LOG_CONTEXT
					)
				);
			},
			onError: (error) =>
				logger.warn(`Dataview watcher error under ${this.root}: ${String(error)}`, LOG_CONTEXT),
		});
	}

	private async stopWatching(): Promise<void> {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = null;
		const watcher = this.watcher;
		this.watcher = null;
		await watcher?.close();
	}

	/** Serve a loaded cache: every page finished against the cached file set. */
	private async installCache(cache: VaultCacheFile): Promise<void> {
		const paths = new VaultPaths(cache.files, cache.folders);
		const resolver = createLinkResolver(paths.allFiles());
		const parsed = new Map<string, ParsedPage>();
		await this.forEachBatch(
			Object.entries(cache.pages),
			DATAVIEW_FINISH_BATCH_SIZE,
			([path, entry]) => {
				parsed.set(path, { entry, page: finishPage(Transferable.value(entry.data), resolver) });
			}
		);
		this.commit({
			paths,
			resolver,
			parsed,
			removed: new Set(),
			stars: new Set(cache.stars),
			persist: false,
		});
	}

	private async runScan(): Promise<VaultScanStats> {
		const startedAt = Date.now();
		const listing = await this.fs.list();

		// Links resolve against the new file set, so a page linking to a file added since the last scan
		// resolves on this pass.
		const paths = new VaultPaths(listing.files, listing.folders);
		const resolver = createLinkResolver(paths.allFiles());
		const stale = [...listing.stats].filter(([path, stat]) => !this.isFresh(path, stat));
		const removed = new Set([...this.entries.keys()].filter((path) => !listing.stats.has(path)));

		const { parsed, failedCount } = await this.parseAll(stale, resolver);
		const stars = await this.readStars();
		this.csvCache.clear();
		await this.finishAndCommit({ paths, resolver, parsed, removed, stars, persist: true });

		let oversizedCount = 0;
		for (const entry of this.entries.values()) if (entry.oversized) oversizedCount++;
		const finishedAt = Date.now();
		this.lastScan = {
			pageCount: this.pages.size,
			parsedCount: parsed.size,
			oversizedCount,
			failedCount,
			durationMs: finishedAt - startedAt,
			finishedAt,
		};
		return this.lastScan;
	}

	private async runPathBatch(relPaths: string[]): Promise<void> {
		if (this.disposed || !this.fs.stat) return;
		const stat = this.fs.stat.bind(this.fs);
		const stats = await mapWithConcurrency(
			relPaths,
			LOCAL_SESSION_READ_CONCURRENCY,
			async (relPath): Promise<VaultEntryStat | null | undefined> => {
				try {
					return await stat(relPath);
				} catch (error) {
					// Unreadable right now (a lock, permissions): leave the path as the index has it.
					logger.debug(`Dataview could not stat ${relPath}: ${String(error)}`, LOG_CONTEXT);
					return undefined;
				}
			}
		);

		const paths = this.prefix.clone();
		const removed = new Set<string>();
		const stale: [string, VaultFileStat][] = [];
		let starsChanged = false;
		relPaths.forEach((relPath, i) => {
			const entry = stats[i];
			this.csvCache.delete(relPath);
			if (relPath === VAULT_BOOKMARKS_PATH || relPath === VAULT_MARKER_DIR) {
				starsChanged = true;
				return;
			}
			if (!isIndexedVaultPath(relPath) || entry === undefined) return;

			// A path that is gone, or that turned from a file into a folder, drops its old self first.
			if (entry === null || entry.kind === 'folder') {
				if (paths.hasFile(relPath)) {
					paths.removeFile(relPath);
					if (this.entries.has(relPath)) removed.add(relPath);
				} else if (entry === null && paths.nodeExists(relPath)) {
					const under = `${relPath}/`;
					for (const path of this.entries.keys()) if (path.startsWith(under)) removed.add(path);
					paths.removeFolder(relPath);
				}
				if (entry?.kind === 'folder') paths.addFolder(relPath);
				return;
			}
			paths.addFile(relPath);
			if (isMarkdownPagePath(relPath) && !this.isFresh(relPath, entry))
				stale.push([relPath, entry]);
		});

		const resolver = createLinkResolver(paths.allFiles());
		const { parsed } = await this.parseAll(stale, resolver);
		const stars = starsChanged ? await this.readStars() : this.stars;
		await this.finishAndCommit({ paths, resolver, parsed, removed, stars, persist: true });
	}

	/** Whether the index already holds `path` parsed at this `mtime` and `size`. */
	private isFresh(path: string, stat: VaultFileStat): boolean {
		const entry = this.entries.get(path);
		return !!entry && entry.mtime === stat.mtime && entry.size === stat.size;
	}

	/** Read and parse pages in bounded batches, yielding between them so IPC keeps flowing. */
	private async parseAll(
		pages: [string, VaultFileStat][],
		resolver: LinkResolver
	): Promise<{ parsed: Map<string, ParsedPage>; failedCount: number }> {
		const parsed = new Map<string, ParsedPage>();
		let failedCount = 0;
		for (let start = 0; start < pages.length; start += DATAVIEW_PARSE_BATCH_SIZE) {
			const batch = pages.slice(start, start + DATAVIEW_PARSE_BATCH_SIZE);
			const results = await Promise.all(
				batch.map(([path, stat]) => this.readAndParse(path, stat, resolver))
			);
			results.forEach((result, i) => {
				if (result === null) failedCount++;
				else parsed.set(batch[i][0], result);
			});
			await yieldToEventLoop();
		}
		return { parsed, failedCount };
	}

	/** Read one page and parse it; oversized pages skip the read. Null when the read fails. */
	private async readAndParse(
		path: string,
		stat: VaultFileStat,
		resolver: LinkResolver
	): Promise<ParsedPage | null> {
		const oversized = stat.size > DATAVIEW_MAX_INDEXED_FILE_BYTES;
		let content = '';
		if (!oversized) {
			try {
				content = await this.fs.readText(path);
			} catch (error) {
				logger.debug(`Dataview skipped unreadable page ${path}: ${String(error)}`, LOG_CONTEXT);
				return null;
			}
		}
		const raw = parseRawPage(
			{ path, content, ctime: stat.ctime, mtime: stat.mtime, size: stat.size },
			{ onWarning: this.onWarning }
		);
		// Encode before finishing: `finishPage` mutates the raw page in place.
		const entry: CachedPage = {
			size: stat.size,
			mtime: stat.mtime,
			ctime: stat.ctime,
			oversized,
			data: Transferable.transferable(raw),
		};
		return { entry, page: finishPage(raw, resolver) };
	}

	/**
	 * Re-resolve the unchanged pages a file-set change can affect, then commit. A link can only start or
	 * stop resolving to a file that shares its last path segment (`linkTargetKeys`), so only pages holding
	 * such a link are finished again, from their cached raw parse.
	 */
	private async finishAndCommit(update: IndexUpdate): Promise<void> {
		const keys = new Set<string>();
		for (const path of update.paths.allFiles())
			if (!this.prefix.hasFile(path)) for (const key of linkTargetKeys(path)) keys.add(key);
		for (const path of this.prefix.allFiles())
			if (!update.paths.hasFile(path)) for (const key of linkTargetKeys(path)) keys.add(key);

		if (keys.size > 0) {
			const affected: [string, CachedPage][] = [];
			for (const [path, page] of this.pages) {
				if (update.parsed.has(path) || update.removed.has(path)) continue;
				if (page.links.some((link) => keys.has(linkPathKey(link.path))))
					affected.push([path, this.entries.get(path)!]);
			}
			await this.forEachBatch(affected, DATAVIEW_FINISH_BATCH_SIZE, ([path, entry]) => {
				update.parsed.set(path, {
					entry,
					page: finishPage(Transferable.value(entry.data), update.resolver),
				});
			});
		}
		this.commit(update, keys.size > 0);
	}

	/**
	 * Swap an update in, synchronously, so a query never sees half of it. The change names every page set
	 * or removed, every page whose inlinks moved with them, and every page whose star flipped.
	 */
	private commit(update: IndexUpdate, filesChanged = true): void {
		const changed = new Set<string>();
		const noteLinkTargets = (path: string) => {
			for (const target of this.links.get(path)) changed.add(target);
		};

		for (const path of update.removed) {
			noteLinkTargets(path);
			this.unindexPage(path);
			this.entries.delete(path);
			changed.add(path);
		}
		for (const [path, { entry, page }] of update.parsed) {
			noteLinkTargets(path);
			this.entries.set(path, entry);
			this.indexPage(path, page);
			noteLinkTargets(path);
			changed.add(path);
		}
		for (const path of update.stars) if (!this.stars.has(path)) changed.add(path);
		for (const path of this.stars) if (!update.stars.has(path)) changed.add(path);

		this.prefix = update.paths;
		this.resolver = update.resolver;
		this.stars = update.stars;

		const changedPages = [...changed].filter(
			(path) => this.pages.has(path) || update.removed.has(path)
		);
		if (changedPages.length > 0) this.touch(changedPages);
		if (update.persist && (changedPages.length > 0 || filesChanged)) this.scheduleCacheWrite();
	}

	/** Run `fn` over `items` in batches, yielding to the event loop between them. */
	private async forEachBatch<T>(items: T[], size: number, fn: (item: T) => void): Promise<void> {
		for (let start = 0; start < items.length; start += size) {
			for (const item of items.slice(start, start + size)) fn(item);
			if (start + size < items.length) await yieldToEventLoop();
		}
	}

	private scheduleCacheWrite(): void {
		if (!this.cacheFile) return;
		this.cacheDirty = true;
		if (this.cacheWriteTimer || this.disposed) return;
		this.cacheWriteTimer = setTimeout(() => {
			this.cacheWriteTimer = null;
			void this.flushCache();
		}, DATAVIEW_CACHE_WRITE_DEBOUNCE_MS);
		this.cacheWriteTimer.unref?.();
	}

	private cacheSnapshot(): VaultCacheFile {
		return {
			version: DATAVIEW_INDEX_CACHE_VERSION,
			root: this.root,
			sshRemoteId: this.fs.sshRemoteId,
			savedAt: Date.now(),
			files: this.prefix.allFiles(),
			folders: this.prefix.allFolders(),
			stars: [...this.stars],
			pages: Object.fromEntries(this.entries),
		};
	}

	/** The starred paths from `.obsidian/bookmarks.json`; empty when it is missing or malformed. */
	private async readStars(): Promise<Set<string>> {
		let text: string;
		try {
			text = await this.fs.readText(VAULT_BOOKMARKS_PATH);
		} catch {
			return new Set();
		}
		try {
			return starredPathsFromBookmarks(JSON.parse(text));
		} catch {
			return new Set();
		}
	}

	/** Bump the revision and tell every listener which paths changed. */
	private touch(changedPaths: string[]): void {
		this.revision += 1;
		this.resolvedLinks = null;
		const change: VaultIndexChange = { revision: this.revision, changedPaths };
		for (const listener of [...this.listeners]) {
			try {
				listener(change);
			} catch (error) {
				// One broken subscriber must not starve the others; report it and keep going.
				logger.error(`Dataview change listener failed: ${String(error)}`, LOG_CONTEXT);
			}
		}
	}
}
