import {
	getAllFolderPaths as getAllFolderPathsShared,
	walkTreePartitioned,
} from '../../shared/treeUtils';
import { isImageFile } from '../../shared/gitUtils';
import { shouldIgnore, parseGitignoreContent, LOCAL_IGNORE_DEFAULTS } from '../../shared/globUtils';
import { logger } from './logger';

/**
 * Check if a file should be opened in external app based on extension
 */
export function shouldOpenExternally(filename: string): boolean {
	// Images that can be previewed inline should NOT open externally
	if (isImageFile(filename)) {
		return false;
	}

	const ext = filename.split('.').pop()?.toLowerCase();
	// File types that should open in default system app
	const externalExtensions = [
		// Documents
		'pdf',
		'doc',
		'docx',
		'xls',
		'xlsx',
		'ppt',
		'pptx',
		// Images that can't be previewed inline (raw formats, etc.)
		'tiff',
		'tif',
		'heic',
		'heif',
		// macOS/iOS specific
		'icns',
		'car',
		'actool',
		// Design files
		'psd',
		'ai',
		'sketch',
		'fig',
		'xd',
		// Video
		'mp4',
		'mov',
		'avi',
		'mkv',
		'webm',
		'wmv',
		'flv',
		'm4v',
		// Audio
		'mp3',
		'wav',
		'flac',
		'aac',
		'm4a',
		'ogg',
		'wma',
		// Archives
		'zip',
		'tar',
		'gz',
		'7z',
		'rar',
		'bz2',
		'xz',
		'tgz',
		// Executables/binaries
		'exe',
		'dmg',
		'app',
		'deb',
		'rpm',
		'msi',
		'pkg',
		'bin',
		// Compiled/object files
		'o',
		'a',
		'so',
		'dylib',
		'dll',
		'class',
		'pyc',
		'pyo',
		// Database files
		'db',
		'sqlite',
		'sqlite3',
		// Fonts
		'ttf',
		'otf',
		'woff',
		'woff2',
		'eot',
		// Other binary formats
		'iso',
		'img',
		'vmdk',
		'vdi',
	];
	return externalExtensions.includes(ext || '');
}

export interface FileTreeNode {
	name: string;
	type: 'file' | 'folder';
	children?: FileTreeNode[];
}

/**
 * SSH context for remote file operations
 */
export interface SshContext {
	/** SSH remote config ID */
	sshRemoteId?: string;
	/** Remote working directory */
	remoteCwd?: string;
	/** Glob patterns to ignore when indexing (for SSH remotes) */
	ignorePatterns?: string[];
	/** Whether to honor .gitignore files on remote */
	honorGitignore?: boolean;
}

/**
 * Progress callback for streaming file tree loading updates.
 * Provides real-time feedback during slow SSH directory walks.
 */
export interface FileTreeProgress {
	/** Total directories scanned so far */
	directoriesScanned: number;
	/** Total files found so far */
	filesFound: number;
	/** Current directory being scanned */
	currentDirectory: string;
	/** Partial tree built so far (can be used for progressive display) */
	partialTree?: FileTreeNode[];
}

export type FileTreeProgressCallback = (progress: FileTreeProgress) => void;

/**
 * Internal state for tracking progress during recursive file tree loading.
 */
interface LoadingState {
	directoriesScanned: number;
	filesFound: number;
	onProgress?: FileTreeProgressCallback;
	/** Effective ignore patterns (user patterns + gitignore if enabled) */
	ignorePatterns: string[];
	/** Whether this is an SSH remote context */
	isRemote: boolean;
	/** Max file entries before we stop walking. Folders do not count. */
	maxEntries: number;
	/**
	 * Files counted toward the entry cap. Files inside an always-visible subtree
	 * (e.g. `.maestro`) are excluded so prioritized content can never starve
	 * sibling directories of their budget.
	 */
	budgetUsed: number;
	/** True once we've hit the entry cap and started skipping further files. */
	truncated: boolean;
	/** Optional abort signal — when aborted, the recursion stops issuing new readDir calls. */
	signal?: AbortSignal;
}

/** Thrown when a file tree load is aborted via {@link AbortSignal}. */
export class FileTreeAbortError extends Error {
	constructor() {
		super('File tree load aborted');
		this.name = 'FileTreeAbortError';
	}
}

/**
 * Result returned by {@link loadFileTree}. Wraps the tree with metadata so
 * callers can detect when the scan was truncated by the entry cap.
 */
export interface FileTreeLoadResult {
	/** The loaded file tree (sorted, folders first). */
	tree: FileTreeNode[];
	/** True if the scan stopped early because the entry cap was reached. */
	truncated: boolean;
	/** Total file entries observed during the scan (may exceed maxEntries by the last batch). */
	filesFound: number;
}

/** Files that should always appear in the file tree regardless of ignore patterns */
const ALWAYS_VISIBLE_FILES = new Set(['.maestro']);

/** Options for local (non-SSH) file tree loading */
export interface LocalFileTreeOptions {
	/** Glob patterns to ignore. When provided, replaces LOCAL_IGNORE_DEFAULTS. */
	ignorePatterns?: string[];
	/** Whether to parse and honor the root .gitignore file (default: false). */
	honorGitignore?: boolean;
}

/**
 * Load file tree from directory recursively.
 *
 * Applies two independent limits:
 * - `maxDepth` — hard cap on recursion depth. Enforced the same way at every
 *   level.
 * - `maxEntries` — soft cap on the number of file entries (folders are not
 *   counted). Once reached, further files are skipped and the returned result
 *   is flagged `truncated`. Pass `Infinity` to disable.
 *
 * Entries listed in {@link ALWAYS_VISIBLE_FILES} (e.g. `.maestro`) are
 * processed before other entries at every level and walked with an unlimited
 * budget — their files do not count toward `maxEntries`. This guarantees that
 * project-critical content survives even on SSH remotes where the cap has
 * been reduced.
 *
 * @param dirPath - The directory path to load
 * @param maxDepth - Maximum recursion depth (default: 5)
 * @param currentDepth - Current recursion depth (internal use)
 * @param sshContext - Optional SSH context for remote file operations
 * @param onProgress - Optional callback for progress updates (useful for SSH)
 * @param localOptions - Optional configuration for local (non-SSH) scans
 * @param maxEntries - Maximum number of file entries to load before truncating
 *   (default: `Infinity`, meaning no cap). Callers that surface results to the
 *   user should pass the `fileExplorerMaxEntries` setting.
 */
export async function loadFileTree(
	dirPath: string,
	maxDepth = 5,
	currentDepth = 0,
	sshContext?: SshContext,
	onProgress?: FileTreeProgressCallback,
	localOptions?: LocalFileTreeOptions,
	maxEntries: number = Number.POSITIVE_INFINITY,
	signal?: AbortSignal
): Promise<FileTreeLoadResult> {
	const isRemote = Boolean(sshContext?.sshRemoteId);

	// Build effective ignore patterns
	let ignorePatterns: string[] = [];

	if (isRemote) {
		// For remote: use configurable patterns from settings
		ignorePatterns = sshContext?.ignorePatterns || [];

		// If honor gitignore is enabled, try to fetch and parse the remote .gitignore
		if (sshContext?.honorGitignore && sshContext?.sshRemoteId) {
			try {
				const gitignorePatterns = await fetchRemoteGitignorePatterns(
					dirPath,
					sshContext.sshRemoteId
				);
				ignorePatterns = [...ignorePatterns, ...gitignorePatterns];
			} catch {
				// Silently ignore - .gitignore may not exist or be readable
			}
		}
	} else {
		// For local: use configurable patterns from settings, falling back to hardcoded defaults
		ignorePatterns = localOptions?.ignorePatterns ?? LOCAL_IGNORE_DEFAULTS;

		// If honor gitignore is enabled, try to parse the local .gitignore
		if (localOptions?.honorGitignore) {
			try {
				const content = await window.maestro.fs.readFile(`${dirPath}/.gitignore`);
				if (content) {
					ignorePatterns = [...ignorePatterns, ...parseGitignoreContent(content)];
				}
			} catch {
				// .gitignore may not exist or be readable — not an error
			}
		}
	}

	// Initialize loading state at the top level
	const state: LoadingState = {
		directoriesScanned: 0,
		filesFound: 0,
		onProgress,
		ignorePatterns,
		isRemote,
		maxEntries: maxEntries > 0 ? maxEntries : Number.POSITIVE_INFINITY,
		budgetUsed: 0,
		truncated: false,
		signal,
	};

	const tree = await loadFileTreeRecursive(dirPath, maxDepth, currentDepth, sshContext, state);
	return { tree, truncated: state.truncated, filesFound: state.filesFound };
}

/**
 * Fetch and parse .gitignore patterns from a remote directory.
 * @param dirPath - The remote directory path
 * @param sshRemoteId - The SSH remote config ID
 * @returns Array of gitignore patterns (simplified name-based matching)
 */
async function fetchRemoteGitignorePatterns(
	dirPath: string,
	sshRemoteId: string
): Promise<string[]> {
	try {
		const content = await window.maestro.fs.readFile(`${dirPath}/.gitignore`, sshRemoteId);
		return content ? parseGitignoreContent(content) : [];
	} catch {
		return [];
	}
}

/**
 * Internal recursive implementation with shared state for progress tracking.
 *
 * @param unlimitedBudget When true, the entry cap is bypassed for this subtree
 *   and its descendants. Used to fully load always-visible directories like
 *   `.maestro` even when the SSH-reduced cap has been reached elsewhere.
 */
async function loadFileTreeRecursive(
	dirPath: string,
	maxDepth: number,
	currentDepth: number,
	sshContext: SshContext | undefined,
	state: LoadingState,
	unlimitedBudget: boolean = false
): Promise<FileTreeNode[]> {
	if (currentDepth >= maxDepth) return [];
	if (state.signal?.aborted) throw new FileTreeAbortError();

	try {
		const entries = await window.maestro.fs.readDir(dirPath, sshContext?.sshRemoteId);
		if (state.signal?.aborted) throw new FileTreeAbortError();
		const tree: FileTreeNode[] = [];

		// Update progress: we've scanned a directory
		state.directoriesScanned++;

		// Report progress with current directory being scanned
		if (state.onProgress) {
			state.onProgress({
				directoriesScanned: state.directoriesScanned,
				filesFound: state.filesFound,
				currentDirectory: dirPath,
			});
		}

		// Track seen names to deduplicate entries (guards against edge cases
		// where the OS or IPC layer returns the same entry more than once).
		const seen = new Set<string>();

		// Process always-visible directories (e.g. `.maestro`) first so they're
		// loaded ahead of bulk content — important on SSH where each dir is its
		// own round-trip and the entry cap may be reduced.
		const orderedEntries = [...entries].sort((a, b) => {
			const aPriority = a.isDirectory && ALWAYS_VISIBLE_FILES.has(a.name) ? 0 : 1;
			const bPriority = b.isDirectory && ALWAYS_VISIBLE_FILES.has(b.name) ? 0 : 1;
			return aPriority - bPriority;
		});

		for (const entry of orderedEntries) {
			const normalizedName = entry.name.normalize('NFC');
			if (seen.has(normalizedName)) {
				logger.warn('[loadFileTree] readDir returned duplicate entry:', undefined, [
					entry.name,
					'in',
					dirPath,
				]);
				continue;
			}
			seen.add(normalizedName);

			// Skip entries that match ignore patterns (but never hide always-visible files)
			if (!ALWAYS_VISIBLE_FILES.has(entry.name) && shouldIgnore(entry.name, state.ignorePatterns)) {
				continue;
			}

			// Always-visible directories propagate unlimited-budget to descendants so
			// e.g. all of `.maestro/playbooks/**` survives the cap.
			const childUnlimited =
				unlimitedBudget || (entry.isDirectory && ALWAYS_VISIBLE_FILES.has(entry.name));

			if (entry.isDirectory) {
				if (state.signal?.aborted) throw new FileTreeAbortError();
				// Wrap child directory reads in try/catch so a single failing
				// subdirectory (permissions, spaces in name over SSH, broken
				// symlinks, etc.) doesn't kill the entire tree walk.
				let children: FileTreeNode[] = [];
				if (childUnlimited || state.budgetUsed < state.maxEntries) {
					try {
						children = await loadFileTreeRecursive(
							`${dirPath}/${entry.name}`,
							maxDepth,
							currentDepth + 1,
							sshContext,
							state,
							childUnlimited
						);
					} catch (childErr) {
						// Re-throw aborts so the whole walk stops; skip unreadable child
						// directories so a single failing subdir doesn't kill the walk.
						if (childErr instanceof FileTreeAbortError) throw childErr;
					}
				} else {
					// Cap hit before we could recurse: fold this in as an empty placeholder
					// so the user still sees that the folder exists.
					state.truncated = true;
				}
				tree.push({
					name: entry.name,
					type: 'folder',
					children,
				});
			} else if (entry.isFile) {
				if (!unlimitedBudget && state.budgetUsed >= state.maxEntries) {
					state.truncated = true;
					// Stop adding files at this level; siblings in deeper dirs
					// also short-circuit via the directory guard above.
					continue;
				}
				if (!unlimitedBudget) state.budgetUsed++;
				state.filesFound++;
				tree.push({
					name: entry.name,
					type: 'file',
				});

				// Report progress periodically for files (every 10 files to avoid too many updates)
				if (state.onProgress && state.filesFound % 10 === 0) {
					state.onProgress({
						directoriesScanned: state.directoriesScanned,
						filesFound: state.filesFound,
						currentDirectory: dirPath,
					});
				}
			}
		}

		return tree.sort((a, b) => {
			// Folders first, then alphabetically
			if (a.type === 'folder' && b.type !== 'folder') return -1;
			if (a.type !== 'folder' && b.type === 'folder') return 1;
			return a.name.localeCompare(b.name);
		});
	} catch (error) {
		if (error instanceof FileTreeAbortError) throw error;
		logger.error('Error loading file tree:', undefined, error);
		throw error; // Propagate error to be caught by caller
	}
}

/**
 * Get all folder paths from a file tree recursively
 * @see {@link getAllFolderPathsShared} from shared/treeUtils for the underlying implementation
 */
export function getAllFolderPaths(nodes: FileTreeNode[], currentPath = ''): string[] {
	return getAllFolderPathsShared(nodes, currentPath);
}

/**
 * Build a hierarchical {@link FileTreeNode} array from flat lists of directory
 * and file paths. Paths must be relative (no leading `/` or `./`) and use `/`
 * as separator. Used by the SSH batched-find loader to assemble the tree from
 * the flat output of `find`.
 *
 * Folders without an explicit parent in the directory list are attached to the
 * root — this can happen when `excludePaths` prunes a parent or when the entry
 * cap drops mid-tree files whose ancestor dirs are still listed.
 */
export function buildTreeFromPaths(directories: string[], files: string[]): FileTreeNode[] {
	const folderMap = new Map<string, FileTreeNode>();
	const root: FileTreeNode[] = [];

	const basenameOf = (p: string): string => {
		const i = p.lastIndexOf('/');
		return i >= 0 ? p.slice(i + 1) : p;
	};
	const parentOf = (p: string): string => {
		const i = p.lastIndexOf('/');
		return i >= 0 ? p.slice(0, i) : '';
	};

	// Sort dirs by depth (path with fewer slashes first) so parents exist before
	// children try to attach.
	const sortedDirs = [...directories].sort((a, b) => {
		const da = a.split('/').length;
		const db = b.split('/').length;
		if (da !== db) return da - db;
		return a.localeCompare(b);
	});

	for (const dirPath of sortedDirs) {
		if (!dirPath) continue;
		if (folderMap.has(dirPath)) continue;
		const node: FileTreeNode = {
			name: basenameOf(dirPath).normalize('NFC'),
			type: 'folder',
			children: [],
		};
		folderMap.set(dirPath, node);

		const parent = parentOf(dirPath);
		if (parent === '') {
			root.push(node);
		} else {
			const parentNode = folderMap.get(parent);
			if (parentNode && parentNode.children) {
				parentNode.children.push(node);
			} else {
				root.push(node);
			}
		}
	}

	for (const filePath of files) {
		if (!filePath) continue;
		const fileNode: FileTreeNode = {
			name: basenameOf(filePath).normalize('NFC'),
			type: 'file',
		};
		const parent = parentOf(filePath);
		if (parent === '') {
			root.push(fileNode);
		} else {
			const parentNode = folderMap.get(parent);
			if (parentNode && parentNode.children) {
				parentNode.children.push(fileNode);
			} else {
				root.push(fileNode);
			}
		}
	}

	const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
		nodes.sort((a, b) => {
			if (a.type === 'folder' && b.type !== 'folder') return -1;
			if (a.type !== 'folder' && b.type === 'folder') return 1;
			return a.name.localeCompare(b.name);
		});
		for (const n of nodes) if (n.children) sortNodes(n.children);
		return nodes;
	};
	return sortNodes(root);
}

/**
 * Splice a `.maestro` subtree (loaded in its own phase) into the rest-of-tree
 * result. The rest tree should have been loaded with `excludePaths: ['.maestro']`
 * so it doesn't already contain `.maestro` — this helper guards against that
 * anyway by filtering it out.
 */
export function spliceMaestroIntoTree(
	restTree: FileTreeNode[],
	maestroChildren: FileTreeNode[] | undefined
): FileTreeNode[] {
	const filtered = restTree.filter((n) => n.name !== '.maestro');
	if (maestroChildren && maestroChildren.length > 0) {
		filtered.push({
			name: '.maestro',
			type: 'folder',
			children: maestroChildren,
		});
	}
	return filtered.sort((a, b) => {
		if (a.type === 'folder' && b.type !== 'folder') return -1;
		if (a.type !== 'folder' && b.type === 'folder') return 1;
		return a.name.localeCompare(b.name);
	});
}

/** Options for {@link loadFileTreeRemoteBatched}. */
export interface RemoteBatchedLoadOptions {
	/** Hard depth cap (passed to `find -maxdepth`). */
	maxDepth: number;
	/** Soft cap on file entries (folders are always complete to maxDepth). */
	maxEntries: number;
	/** Glob name patterns to prune server-side via `find -name`. */
	ignorePatterns: string[];
	/** Whether to fetch and merge the remote root `.gitignore`. */
	honorGitignore: boolean;
	/** Required SSH remote ID. */
	sshRemoteId: string;
	/** Aborts pending phases when fired. */
	signal?: AbortSignal;
	/** Progress callback — fired at phase boundaries. */
	onProgress?: FileTreeProgressCallback;
	/**
	 * Optional callback fired when an intermediate phase completes, so the
	 * renderer can paint partial results before the final phase resolves.
	 * Called with: ('maestro', maestroSubtree) and ('rest', restTree).
	 */
	onPhase?: (
		phase: 'maestro' | 'rest',
		partial: { maestro?: FileTreeNode[]; rest?: FileTreeNode[] }
	) => void;
}

/**
 * Load a remote file tree using batched `find` calls.
 *
 * Issues two SSH round-trips total:
 *  1. **Maestro phase** — enumerate `<root>/.maestro` (unlimited budget). Loads
 *     first because `.maestro` drives Cue, playbooks, and other features that
 *     should be available as soon as possible.
 *  2. **Rest phase** — enumerate the rest of the tree with the file cap and
 *     `.maestro` pruned out (we already have it).
 *
 * Replaces the per-directory recursive `readDir` walk that issued one SSH call
 * per remote directory (hundreds of calls on a moderately-sized project).
 *
 * The shallow top-level paint is **not** handled here — the caller fires that
 * separately for instant first paint, then awaits this for the full result.
 */
export async function loadFileTreeRemoteBatched(
	rootPath: string,
	options: RemoteBatchedLoadOptions
): Promise<FileTreeLoadResult> {
	const {
		maxDepth,
		maxEntries,
		ignorePatterns,
		honorGitignore,
		sshRemoteId,
		signal,
		onProgress,
		onPhase,
	} = options;

	if (signal?.aborted) throw new FileTreeAbortError();

	let effectiveIgnorePatterns = ignorePatterns;
	if (honorGitignore) {
		try {
			const gitignorePatterns = await fetchRemoteGitignorePatterns(rootPath, sshRemoteId);
			effectiveIgnorePatterns = [...effectiveIgnorePatterns, ...gitignorePatterns];
		} catch {
			// .gitignore may not exist or be readable — not an error
		}
	}

	if (signal?.aborted) throw new FileTreeAbortError();

	const partial: { maestro?: FileTreeNode[]; rest?: FileTreeNode[] } = {};

	// Phase 1: .maestro subtree (unlimited budget). May fail benignly if the
	// directory doesn't exist (most projects without Maestro state). The whole
	// phase is best-effort: a missing or unreadable `.maestro` should not block
	// the rest of the tree from loading.
	if (onProgress) {
		onProgress({
			directoriesScanned: 0,
			filesFound: 0,
			currentDirectory: `${rootPath}/.maestro`,
		});
	}
	let maestroChildren: FileTreeNode[] = [];
	let maestroDirsScanned = 0;
	let maestroFilesFound = 0;
	try {
		const maestroResult = await window.maestro.fs.listTreeRemote(
			`${rootPath}/.maestro`,
			sshRemoteId,
			{
				maxDepth,
				ignorePatterns: [],
				maxFiles: undefined,
			}
		);
		if (signal?.aborted) throw new FileTreeAbortError();
		maestroChildren = buildTreeFromPaths(maestroResult.directories, maestroResult.files);
		maestroDirsScanned = maestroResult.directories.length;
		maestroFilesFound = maestroResult.files.length;
		partial.maestro = maestroChildren;
		onPhase?.('maestro', partial);
	} catch (err) {
		if (err instanceof FileTreeAbortError) throw err;
		// .maestro missing/unreadable — log and continue with empty subtree
		logger.debug('[loadFileTreeRemoteBatched] .maestro phase failed:', undefined, err);
	}

	// Phase 2: rest of tree with .maestro pruned and file cap applied.
	if (onProgress) {
		onProgress({
			directoriesScanned: maestroDirsScanned,
			filesFound: maestroFilesFound,
			currentDirectory: rootPath,
		});
	}
	const restResult = await window.maestro.fs.listTreeRemote(rootPath, sshRemoteId, {
		maxDepth,
		ignorePatterns: effectiveIgnorePatterns,
		excludePaths: ['.maestro'],
		maxFiles: maxEntries > 0 && Number.isFinite(maxEntries) ? maxEntries : undefined,
	});
	if (signal?.aborted) throw new FileTreeAbortError();

	const restTree = buildTreeFromPaths(restResult.directories, restResult.files);
	partial.rest = restTree;
	onPhase?.('rest', partial);

	const finalTree = spliceMaestroIntoTree(restTree, maestroChildren);
	const totalFiles = maestroFilesFound + restResult.files.length;

	if (onProgress) {
		onProgress({
			directoriesScanned: maestroDirsScanned + restResult.directories.length,
			filesFound: totalFiles,
			currentDirectory: rootPath,
		});
	}

	return { tree: finalTree, truncated: restResult.truncated, filesFound: totalFiles };
}

export interface FlatTreeNode extends FileTreeNode {
	fullPath: string;
	isFolder: boolean;
}

/**
 * Flatten file tree for keyboard navigation
 */
export function flattenTree(
	nodes: FileTreeNode[],
	expandedSet: Set<string>,
	currentPath = ''
): FlatTreeNode[] {
	let result: FlatTreeNode[] = [];
	nodes.forEach((node) => {
		const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
		const isFolder = node.type === 'folder';
		result.push({ ...node, fullPath, isFolder });

		if (isFolder && expandedSet.has(fullPath) && node.children) {
			result = result.concat(flattenTree(node.children, expandedSet, fullPath));
		}
	});
	return result;
}

export interface FileTreeChanges {
	totalChanges: number;
	newFiles: number;
	newFolders: number;
	removedFiles: number;
	removedFolders: number;
}

/**
 * Helper to collect all paths from a file tree
 * @see {@link walkTreePartitioned} from shared/treeUtils for the underlying implementation
 */
function collectPaths(
	nodes: FileTreeNode[],
	currentPath = ''
): { files: Set<string>; folders: Set<string> } {
	return walkTreePartitioned(nodes, currentPath);
}

/**
 * Compare two file trees and count the differences
 */
export function compareFileTrees(
	oldTree: FileTreeNode[],
	newTree: FileTreeNode[]
): FileTreeChanges {
	const oldPaths = collectPaths(oldTree);
	const newPaths = collectPaths(newTree);

	// Count new items (in new but not in old)
	let newFiles = 0;
	let newFolders = 0;
	for (const file of newPaths.files) {
		if (!oldPaths.files.has(file)) newFiles++;
	}
	for (const folder of newPaths.folders) {
		if (!oldPaths.folders.has(folder)) newFolders++;
	}

	// Count removed items (in old but not in new)
	let removedFiles = 0;
	let removedFolders = 0;
	for (const file of oldPaths.files) {
		if (!newPaths.files.has(file)) removedFiles++;
	}
	for (const folder of oldPaths.folders) {
		if (!newPaths.folders.has(folder)) removedFolders++;
	}

	return {
		totalChanges: newFiles + newFolders + removedFiles + removedFolders,
		newFiles,
		newFolders,
		removedFiles,
		removedFolders,
	};
}

/**
 * Remove a node from the file tree at the given path.
 * Returns a new tree with the node removed.
 * @param tree - The file tree to modify
 * @param relativePath - Path relative to tree root (e.g., "folder/file.txt")
 * @returns New tree with the node removed, or original tree if path not found
 */
export function removeNodeFromTree(tree: FileTreeNode[], relativePath: string): FileTreeNode[] {
	const parts = relativePath.split('/').filter(Boolean);
	if (parts.length === 0) return tree;

	const targetName = parts[parts.length - 1];
	const parentParts = parts.slice(0, -1);

	// If at root level, filter out the target
	if (parentParts.length === 0) {
		return tree.filter((node) => node.name !== targetName);
	}

	// Navigate to parent and remove from there
	return tree.map((node) => {
		if (node.name === parentParts[0]) {
			if (parentParts.length === 1) {
				// This node is the parent - remove target from children
				return {
					...node,
					children: node.children?.filter((child) => child.name !== targetName),
				};
			}
			// Keep navigating
			return {
				...node,
				children: node.children
					? removeNodeFromTree(node.children, parentParts.slice(1).concat(targetName).join('/'))
					: undefined,
			};
		}
		return node;
	});
}

/**
 * Rename a node in the file tree at the given path.
 * Returns a new tree with the node renamed and re-sorted.
 * @param tree - The file tree to modify
 * @param relativePath - Path relative to tree root (e.g., "folder/oldname.txt")
 * @param newName - The new name for the node
 * @returns New tree with the node renamed, or original tree if path not found
 */
export function renameNodeInTree(
	tree: FileTreeNode[],
	relativePath: string,
	newName: string
): FileTreeNode[] {
	const parts = relativePath.split('/').filter(Boolean);
	if (parts.length === 0) return tree;

	const targetName = parts[parts.length - 1];
	const parentParts = parts.slice(0, -1);

	const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
		return [...nodes].sort((a, b) => {
			if (a.type === 'folder' && b.type !== 'folder') return -1;
			if (a.type !== 'folder' && b.type === 'folder') return 1;
			return a.name.localeCompare(b.name);
		});
	};

	// If at root level, rename and re-sort
	if (parentParts.length === 0) {
		const renamed = tree.map((node) =>
			node.name === targetName ? { ...node, name: newName } : node
		);
		return sortNodes(renamed);
	}

	// Navigate to parent and rename there
	return tree.map((node) => {
		if (node.name === parentParts[0]) {
			if (parentParts.length === 1) {
				// This node is the parent - rename target in children
				const renamed = node.children?.map((child) =>
					child.name === targetName ? { ...child, name: newName } : child
				);
				return {
					...node,
					children: renamed ? sortNodes(renamed) : undefined,
				};
			}
			// Keep navigating
			return {
				...node,
				children: node.children
					? renameNodeInTree(
							node.children,
							parentParts.slice(1).concat(targetName).join('/'),
							newName
						)
					: undefined,
			};
		}
		return node;
	});
}

/**
 * Count files and folders in a tree node recursively.
 * Used to update stats when a node is removed.
 */
export function countNodesInTree(nodes: FileTreeNode[]): {
	fileCount: number;
	folderCount: number;
} {
	let fileCount = 0;
	let folderCount = 0;

	const count = (nodeList: FileTreeNode[]) => {
		for (const node of nodeList) {
			if (node.type === 'folder') {
				folderCount++;
				if (node.children) {
					count(node.children);
				}
			} else {
				fileCount++;
			}
		}
	};

	count(nodes);
	return { fileCount, folderCount };
}

/**
 * Find a node in the tree by path.
 * @param tree - The file tree to search
 * @param relativePath - Path relative to tree root
 * @returns The node if found, undefined otherwise
 */
export function findNodeInTree(
	tree: FileTreeNode[],
	relativePath: string
): FileTreeNode | undefined {
	const parts = relativePath.split('/').filter(Boolean);
	if (parts.length === 0) return undefined;

	let current: FileTreeNode[] = tree;
	for (let i = 0; i < parts.length; i++) {
		const node = current.find((n) => n.name === parts[i]);
		if (!node) return undefined;
		if (i === parts.length - 1) return node;
		if (!node.children) return undefined;
		current = node.children;
	}
	return undefined;
}
