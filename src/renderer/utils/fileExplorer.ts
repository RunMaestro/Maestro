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
 */
async function loadFileTreeRecursive(
	dirPath: string,
	maxDepth: number,
	currentDepth: number,
	sshContext: SshContext | undefined,
	state: LoadingState
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

		for (const entry of entries) {
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

			if (entry.isDirectory) {
				if (state.signal?.aborted) throw new FileTreeAbortError();
				// Wrap child directory reads in try/catch so a single failing
				// subdirectory (permissions, spaces in name over SSH, broken
				// symlinks, etc.) doesn't kill the entire tree walk.
				let children: FileTreeNode[] = [];
				if (state.filesFound < state.maxEntries) {
					try {
						children = await loadFileTreeRecursive(
							`${dirPath}/${entry.name}`,
							maxDepth,
							currentDepth + 1,
							sshContext,
							state
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
				if (state.filesFound >= state.maxEntries) {
					state.truncated = true;
					// Stop adding files at this level; siblings in deeper dirs
					// also short-circuit via the directory guard above.
					continue;
				}
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
