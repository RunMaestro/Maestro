/**
 * Local file tree walker (main process).
 *
 * The renderer used to build the local file tree itself, recursing with one
 * `fs:readDir` IPC round-trip per directory. That is fine for a small project
 * and pathological for a large one: a 700-folder vault costs 700 sequential
 * round-trips, each of which has to be scheduled on a renderer main thread that
 * is also rendering a streaming agent transcript. The walk itself takes under
 * 100ms of real filesystem work, so the round-trips - not the disk - were the
 * entire cost, and the Files panel could sit on "Loading files..." for minutes.
 *
 * This module does the same walk in one call, mirroring what the SSH path
 * already gets from its batched `find` loader. `fs:directorySize` has always
 * walked the whole tree here in a single call, which is why the footer counts
 * appeared while the tree above them was still spinning.
 *
 * The traversal rules match the renderer's former implementation exactly:
 * ignore patterns, an optional root `.gitignore`, a depth cap, a soft entry cap
 * that folders are exempt from, and an always-visible `.maestro` subtree that
 * is loaded in full regardless of the cap.
 */

import fs from 'fs/promises';
import path from 'path';
import { shouldIgnore, parseGitignoreContent, LOCAL_IGNORE_DEFAULTS } from '../../shared/globUtils';
import { resolveDirentType } from './dirent-utils';
import { logger } from './logger';

/** Directories that are always loaded, whatever the ignore patterns or entry cap say. */
const ALWAYS_VISIBLE_FILES = new Set(['.maestro']);

/** A node in the local file tree. Structurally identical to the renderer's `FileTreeNode`. */
export interface LocalTreeNode {
	name: string;
	type: 'file' | 'folder';
	children?: LocalTreeNode[];
}

/** Options accepted by {@link walkLocalFileTree}. */
export interface WalkLocalFileTreeOptions {
	/** Hard recursion depth cap. */
	maxDepth: number;
	/**
	 * Soft cap on file entries. Folders never count against it, and files inside
	 * an always-visible subtree are exempt. Non-finite means unlimited.
	 */
	maxEntries?: number;
	/** Ignore patterns. When omitted, {@link LOCAL_IGNORE_DEFAULTS} applies. */
	ignorePatterns?: string[];
	/** Whether to merge the root `.gitignore` into the ignore patterns. */
	honorGitignore?: boolean;
}

/** Result of a local file tree scan. */
export interface LocalTreeScanResult {
	/** The loaded tree, sorted folders-first then alphabetically at every level. */
	tree: LocalTreeNode[];
	/** True when the entry cap stopped the scan early. */
	truncated: boolean;
	/** Total file entries added to the tree. */
	filesFound: number;
	/** Total directories read. */
	directoriesScanned: number;
}

interface WalkState {
	ignorePatterns: string[];
	maxDepth: number;
	maxEntries: number;
	budgetUsed: number;
	filesFound: number;
	directoriesScanned: number;
	truncated: boolean;
}

/**
 * Walk a local directory tree and return it as a nested node list.
 *
 * A failure reading the root directory throws so the caller can surface it. A
 * failure reading any child directory is swallowed and that folder comes back
 * empty, so one unreadable subdirectory cannot cost the user the whole tree.
 */
export async function walkLocalFileTree(
	rootPath: string,
	options: WalkLocalFileTreeOptions
): Promise<LocalTreeScanResult> {
	let ignorePatterns = options.ignorePatterns ?? LOCAL_IGNORE_DEFAULTS;

	if (options.honorGitignore) {
		try {
			const content = await fs.readFile(path.join(rootPath, '.gitignore'), 'utf-8');
			if (content) {
				ignorePatterns = [...ignorePatterns, ...parseGitignoreContent(content)];
			}
		} catch {
			// .gitignore may not exist or be readable - not an error
		}
	}

	const maxEntries =
		typeof options.maxEntries === 'number' && options.maxEntries > 0
			? options.maxEntries
			: Number.POSITIVE_INFINITY;

	const state: WalkState = {
		ignorePatterns,
		maxDepth: options.maxDepth,
		maxEntries,
		budgetUsed: 0,
		filesFound: 0,
		directoriesScanned: 0,
		truncated: false,
	};

	const tree = await walkDirectory(rootPath, 0, state, false);

	return {
		tree,
		truncated: state.truncated,
		filesFound: state.filesFound,
		directoriesScanned: state.directoriesScanned,
	};
}

/**
 * @param unlimitedBudget When true this subtree and its descendants ignore the
 *   entry cap. Set for always-visible directories like `.maestro`, whose
 *   contents drive Cue and Auto Run and must never be truncated away.
 */
async function walkDirectory(
	dirPath: string,
	depth: number,
	state: WalkState,
	unlimitedBudget: boolean
): Promise<LocalTreeNode[]> {
	if (depth >= state.maxDepth) return [];

	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	state.directoriesScanned++;

	// Read always-visible directories first so they are loaded before the entry
	// cap can be spent on bulk content elsewhere.
	const ordered = [...entries].sort((a, b) => {
		const aPriority = ALWAYS_VISIBLE_FILES.has(a.name) ? 0 : 1;
		const bPriority = ALWAYS_VISIBLE_FILES.has(b.name) ? 0 : 1;
		return aPriority - bPriority;
	});

	// Guards against an OS or filesystem edge case handing back the same entry twice.
	const seen = new Set<string>();
	const tree: LocalTreeNode[] = [];

	for (const entry of ordered) {
		const name = entry.name.normalize('NFC');
		if (seen.has(name)) {
			logger.warn('readdir returned a duplicate entry', 'FileTreeWalk', { name, dirPath });
			continue;
		}
		seen.add(name);

		if (!ALWAYS_VISIBLE_FILES.has(entry.name) && shouldIgnore(entry.name, state.ignorePatterns)) {
			continue;
		}

		const fullPath = path.join(dirPath, entry.name);
		// Symlinks are classified by their target, so a linked directory is walked
		// rather than dropped.
		const resolved = await resolveDirentType(entry, fullPath);
		const childUnlimited =
			unlimitedBudget || (resolved.isDirectory && ALWAYS_VISIBLE_FILES.has(entry.name));

		if (resolved.isDirectory) {
			let children: LocalTreeNode[] = [];
			if (childUnlimited || state.budgetUsed < state.maxEntries) {
				try {
					children = await walkDirectory(fullPath, depth + 1, state, childUnlimited);
				} catch {
					// Unreadable subdirectory (permissions, broken mount): keep the
					// folder visible and empty rather than failing the whole walk.
				}
			} else {
				// Cap hit before we could descend: show the folder so the user knows
				// it exists, with nothing under it.
				state.truncated = true;
			}
			tree.push({ name, type: 'folder', children });
		} else if (resolved.isFile || resolved.isBrokenSymlink) {
			if (!childUnlimited && state.budgetUsed >= state.maxEntries) {
				state.truncated = true;
				continue;
			}
			if (!childUnlimited) state.budgetUsed++;
			state.filesFound++;
			tree.push({ name, type: 'file' });
		}
	}

	return tree.sort((a, b) => {
		if (a.type === 'folder' && b.type !== 'folder') return -1;
		if (a.type !== 'folder' && b.type === 'folder') return 1;
		return a.name.localeCompare(b.name);
	});
}
