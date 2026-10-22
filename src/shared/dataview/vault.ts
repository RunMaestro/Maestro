/**
 * Pure pieces of the `FullIndex` contract (M2) that need no file system: the vault path set behind
 * `prefix`, the Bookmarks flattening behind `starred`, and the `resolvedLinks` table behind
 * `metadataCache`. The main-process `VaultIndex` builds on them, and the sandbox guest (M7) can build the
 * same members over an index snapshot. See docs/agent-guides/DATAVIEW.md ("The `FullIndex` contract").
 *
 * Paths are vault-relative POSIX paths without a leading slash; the vault root is `''`.
 */

import type { FullIndex, StarredEntry } from './vendor/data-index/index';
import type { PageMetadata } from './vendor/data-model/markdown';
import { getParentFolder } from './vendor/util/normalize';

/** Whether Obsidian indexes `path` as a markdown page: `.md` only, as `getMarkdownFiles()` does. */
export function isMarkdownPagePath(path: string): boolean {
	return path.toLowerCase().endsWith('.md');
}

/**
 * Every file and folder of a vault, any extension. Implements `FullIndex.prefix` with upstream's
 * `PrefixIndex` semantics: lookups are exact and case-sensitive, and `''` (or `/`) is the vault root.
 */
export class VaultPaths implements Readonly<FullIndex['prefix']> {
	private readonly files = new Set<string>();
	private readonly folders = new Set<string>();

	constructor(files: Iterable<string> = [], folders: Iterable<string> = []) {
		for (const folder of folders) this.addFolder(folder);
		for (const file of files) this.addFile(file);
	}

	/** Add a file and every folder above it. */
	addFile(path: string): void {
		this.files.add(path);
		this.addFolder(getParentFolder(path));
	}

	/** Add a folder (an empty one included) and every folder above it. */
	addFolder(path: string): void {
		for (let folder = path; folder !== '' && !this.folders.has(folder); ) {
			this.folders.add(folder);
			folder = getParentFolder(folder);
		}
	}

	/** Remove a file. Its folders stay, as an emptied folder does on disk. */
	removeFile(path: string): boolean {
		return this.files.delete(path);
	}

	/** Remove a folder and everything under it. */
	removeFolder(path: string): void {
		const under = `${path}/`;
		this.folders.delete(path);
		for (const folder of [...this.folders])
			if (folder.startsWith(under)) this.folders.delete(folder);
		for (const file of [...this.files]) if (file.startsWith(under)) this.files.delete(file);
	}

	hasFile(path: string): boolean {
		return this.files.has(path);
	}

	/** Every file path, in insertion order. */
	allFiles(): string[] {
		return [...this.files];
	}

	/** Every folder path, in insertion order. */
	allFolders(): string[] {
		return [...this.folders];
	}

	/** An independent copy, for building the next file set while queries still read this one. */
	clone(): VaultPaths {
		return new VaultPaths(this.files, this.folders);
	}

	get fileCount(): number {
		return this.files.size;
	}

	/** Every file under the folder `prefix` (recursively), optionally filtered. Empty for a non-folder. */
	get(prefix: string, filter?: (path: string) => boolean): Set<string> {
		const folder = rootless(prefix);
		if (folder !== '' && !this.folders.has(folder)) return new Set();
		const under = folder === '' ? '' : `${folder}/`;
		const result = new Set<string>();
		for (const file of this.files) {
			if (file.startsWith(under) && (!filter || filter(file))) result.add(file);
		}
		return result;
	}

	/** Whether `path` names a file or a folder. */
	pathExists(path: string): boolean {
		const target = rootless(path);
		return target === '' || this.files.has(target) || this.folders.has(target);
	}

	/** Whether `prefix` names a folder. */
	nodeExists(prefix: string): boolean {
		const folder = rootless(prefix);
		return folder === '' || this.folders.has(folder);
	}

	/** Upstream `PrefixIndex.resolveRelative`: `path` against `origin`'s folder when that file exists. */
	resolveRelative(path: string, origin?: string): string {
		if (!origin) return path;
		else if (path.startsWith('/')) return path.substring(1);

		const relativePath = getParentFolder(origin) + '/' + path;
		if (this.pathExists(relativePath)) return relativePath;
		else return path;
	}
}

/** Obsidian's `getAbstractFileByPath(path || "/")`: `/` is the root. */
function rootless(path: string): string {
	return path === '/' ? '' : path;
}

/**
 * The file paths starred in Obsidian's Bookmarks core plugin, given the parsed contents of
 * `.obsidian/bookmarks.json` (`{ items: StarredEntry[] }`). Ported from upstream `StarredCache.fetch`,
 * which reads the same items from the running plugin: group children are flattened level by level and only
 * `file` entries count. Anything malformed yields an empty set.
 */
export function starredPathsFromBookmarks(bookmarks: unknown): Set<string> {
	let items = (bookmarks as { items?: unknown } | null | undefined)?.items as
		| StarredEntry[]
		| undefined;
	if (!Array.isArray(items)) return new Set();

	// Retrieve all grouped (nested) items, returning a flat array
	const flattenItems = (items: StarredEntry[]): StarredEntry[] => {
		let children: StarredEntry[] = [];

		return items
			.map((i) => {
				if (i && i.type == 'group' && Array.isArray(i.items) && i.items.length) {
					children = [...children, ...i.items];
				}
				return i;
			})
			.concat(children.length ? flattenItems(children) : children);
	};

	items = flattenItems(items);

	return new Set(
		items
			.filter(
				(l): l is { type: 'file'; path: string; title: string } =>
					!!l && l.type === 'file' && typeof (l as { path?: unknown }).path === 'string'
			)
			.map((l) => l.path)
	);
}

/**
 * Obsidian's `metadataCache.resolvedLinks`: for EVERY page, the existing files it links to with a count
 * per target, and `{}` for a page with no resolved links. The vendored resolver reads a missing key as
 * "file not found" for `outgoing([[X]])`, so no page may be left out. Page links are already resolved by
 * `PageMetadata.canonicalize`; a link counts when its path names an existing vault file.
 */
export function buildResolvedLinks(
	pages: Iterable<[string, PageMetadata]>,
	fileExists: (path: string) => boolean
): Record<string, Record<string, number>> {
	const resolved: Record<string, Record<string, number>> = {};
	for (const [path, page] of pages) {
		const targets: Record<string, number> = {};
		for (const link of page.links) {
			if (fileExists(link.path)) targets[link.path] = (targets[link.path] ?? 0) + 1;
		}
		resolved[path] = targets;
	}
	return resolved;
}
