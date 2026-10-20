/**
 * The in-memory half of the vendored `FullIndex` contract (M2): every page with its links resolved, the tag
 * and link indexes, the vault path set, link resolution (M3), stars, `resolvedLinks`, and vault-local CSV
 * sources. The vendored source resolver, query engine, and `PageMetadata.serialize` read these members.
 *
 * Two indexes build on it, so a query source matches the same pages wherever it runs:
 *
 * - the main-process `VaultIndex`, which adds the file system, the disk cache, and the watcher;
 * - the DataviewJS guest (M7), which builds one from the snapshot a `run` message carries
 *   ({@link PageIndex.fromSnapshot}) and answers `dv.pages()`, `dv.page()`, and `dv.io.csv()` from it.
 *
 * Indexing a page mirrors upstream `FullIndex.finish`. Paths are vault-relative POSIX paths. See
 * docs/agent-guides/DATAVIEW.md ("The `FullIndex` contract").
 */

import { Result } from './vendor/api/result';
import { IndexMap, ValueCaseInsensitiveIndexMap } from './vendor/data-index/index';
import type { FullIndex } from './vendor/data-index/index';
import { matchingSourcePaths } from './vendor/data-index/resolver';
import type { Source } from './vendor/data-index/source';
import { parseCsv } from './vendor/data-import/csv';
import type { PageMetadata } from './vendor/data-model/markdown';
import { Transferable } from './vendor/data-model/transferable';
import type { DataObject } from './vendor/data-model/value';
import { finishPage } from './page';
import { createLinkResolver, type LinkResolver } from './resolve';
import type { SandboxIndexSnapshot } from './sandboxProtocol';
import type { DataviewIndexReader } from './types';
import { VaultPaths, buildResolvedLinks } from './vault';

/** How long a parsed CSV source is reused before it is read again (upstream `CsvCache.CACHE_EXPIRY_SECONDS`). */
export const DATAVIEW_CSV_CACHE_MS = 5 * 60 * 1000;

/** Reads a vault file as text, given its vault-relative path. Rejects when the file cannot be read. */
export type VaultTextReader = (path: string) => Promise<string>;

export class PageIndex implements DataviewIndexReader {
	readonly pages = new Map<string, PageMetadata>();
	readonly tags = new ValueCaseInsensitiveIndexMap();
	readonly links = new IndexMap();
	revision = 0;

	prefix: VaultPaths = new VaultPaths();
	readonly csv: FullIndex['csv'];
	readonly starred: FullIndex['starred'];
	readonly metadataCache: FullIndex['metadataCache'];
	readonly vault: FullIndex['vault'];

	protected resolver: LinkResolver | null = null;
	/** Rebuilt lazily after a change; set it to null whenever pages or the file set change. */
	protected resolvedLinks: Record<string, Record<string, number>> | null = null;
	protected stars = new Set<string>();
	protected readonly csvCache = new Map<string, { data: DataObject[]; loadedAt: number }>();

	constructor(private readonly readText: VaultTextReader) {
		// The `FullIndex` members the vendored code reads as plain objects. Arrow functions keep `this`
		// stable however the engine calls them; the getter recomputes `resolvedLinks` only after a change.
		const resolvedLinkTable = () => this.resolvedLinkTable();
		this.csv = { get: (path) => this.loadCsv(path) };
		this.starred = { starred: (path) => this.stars.has(path) };
		this.metadataCache = {
			getFirstLinkpathDest: (linkpath, sourcePath) => {
				const target = this.linkResolver().resolve(linkpath, sourcePath);
				return target === null ? null : { path: target };
			},
			get resolvedLinks() {
				return resolvedLinkTable();
			},
		};
		this.vault = {
			getMarkdownFiles: () => Array.from(this.pages.keys(), (path) => ({ path })),
		};
	}

	/**
	 * The index a snapshot describes, built the way `VaultIndex` installs its disk cache: every raw page
	 * finished against the snapshot's file set (M3), then indexed. `readText` backs CSV sources.
	 */
	static fromSnapshot(snapshot: SandboxIndexSnapshot, readText: VaultTextReader): PageIndex {
		const index = new PageIndex(readText);
		index.revision = snapshot.revision;
		index.prefix = new VaultPaths(snapshot.files, snapshot.folders);
		index.stars = new Set(snapshot.stars);
		const resolver = index.linkResolver();
		for (const { path, data } of snapshot.pages) {
			// `finishPage` mutates its input; `Transferable.value` decodes a fresh copy.
			index.indexPage(path, finishPage(Transferable.value(data), resolver));
		}
		return index;
	}

	getPage(path: string): PageMetadata | undefined {
		return this.pages.get(path);
	}

	/** Every page that links to `path` (the inlink index). */
	inlinks(path: string): string[] {
		return Array.from(this.links.getInverse(path));
	}

	/**
	 * The vault paths a query source matches: tags, folders, `[[link]]` (incoming) and `outgoing([[link]])`,
	 * `csv(...)`, and their `and`, `or`, and negation, exactly as upstream resolves them. `originFile` is the
	 * querying page, which relative links and CSV paths resolve against. A failure carries Dataview's error.
	 */
	pagesForSource(source: Source, originFile = ''): Result<Set<string>, string> {
		return matchingSourcePaths(source, this, originFile);
	}

	/**
	 * The vault path an Obsidian link path names from `sourcePath` (M3), or null when nothing matches. The
	 * same resolution the query engine reaches through `metadataCache.getFirstLinkpathDest`.
	 */
	resolveLink(linkpath: string, sourcePath: string): string | null {
		return this.linkResolver().resolve(linkpath, sourcePath);
	}

	/** Upstream `FullIndex.finish`, after canonicalization: fill the tag and link indexes for one page. */
	protected indexPage(path: string, page: PageMetadata): void {
		this.pages.set(path, page);
		// Delete first: upstream `IndexMap.set` keeps every old inverse entry when the new values contain
		// the key itself (it tests `values.has(key)`, not `values.has(value)`), so a page with a self link
		// (`[[#Heading]]`) would keep stale inlinks forever once it is re-indexed.
		this.tags.delete(path);
		this.tags.set(path, page.fullTags());
		this.links.delete(path);
		this.links.set(path, new Set<string>(page.links.map((link) => link.path)));
	}

	/** Drop one page from `pages` and from the tag and link indexes. */
	protected unindexPage(path: string): void {
		this.pages.delete(path);
		this.tags.delete(path);
		this.links.delete(path);
	}

	protected linkResolver(): LinkResolver {
		if (!this.resolver) this.resolver = createLinkResolver(this.prefix.allFiles());
		return this.resolver;
	}

	private resolvedLinkTable(): Record<string, Record<string, number>> {
		if (!this.resolvedLinks) {
			this.resolvedLinks = buildResolvedLinks(this.pages, (path) => this.prefix.hasFile(path));
		}
		return this.resolvedLinks;
	}

	/**
	 * Upstream `CsvCache.get`, limited to files inside the vault (the guide's CSV trap): URL sources are
	 * refused, and only a path the file set lists is read, so a query cannot reach outside the root.
	 */
	private async loadCsv(path: string): Promise<Result<DataObject[], string>> {
		if (/^(https?|file):\/\//i.test(path)) {
			return Result.failure(
				`Loading CSV data from a URL is not supported in Maestro ('${path}'); use a CSV file inside the vault.`
			);
		}
		const now = Date.now();
		const cached = this.csvCache.get(path);
		if (cached && now - cached.loadedAt <= DATAVIEW_CSV_CACHE_MS)
			return Result.success(cached.data);

		if (!this.prefix.hasFile(path))
			return Result.failure(`Failed to load data from path '${path}'.`);
		try {
			const data = parseCsv(await this.readText(path));
			this.csvCache.set(path, { data, loadedAt: now });
			return Result.success(data);
		} catch {
			return Result.failure(`Failed to load data from path '${path}'.`);
		}
	}
}
