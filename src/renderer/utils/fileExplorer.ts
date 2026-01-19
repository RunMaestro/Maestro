import {
	getAllFolderPaths as getAllFolderPathsShared,
	walkTreePartitioned,
} from '../../shared/treeUtils';
import { isImageFile } from '../../shared/gitUtils';

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
}

/**
 * Load file tree from directory recursively
 * @param dirPath - The directory path to load
 * @param maxDepth - Maximum recursion depth (default: 10)
 * @param currentDepth - Current recursion depth (internal use)
 * @param sshContext - Optional SSH context for remote file operations
 * @param onProgress - Optional callback for progress updates (useful for SSH)
 */
export async function loadFileTree(
	dirPath: string,
	maxDepth = 10,
	currentDepth = 0,
	sshContext?: SshContext,
	onProgress?: FileTreeProgressCallback
): Promise<FileTreeNode[]> {
	// Initialize loading state at the top level
	const state: LoadingState = {
		directoriesScanned: 0,
		filesFound: 0,
		onProgress,
	};

	return loadFileTreeRecursive(dirPath, maxDepth, currentDepth, sshContext, state);
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

	try {
		const entries = await window.maestro.fs.readDir(dirPath, sshContext?.sshRemoteId);
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

		for (const entry of entries) {
			// Skip common ignore patterns (but allow hidden files/directories starting with .)
			if (entry.name === 'node_modules' || entry.name === '__pycache__') {
				continue;
			}

			if (entry.isDirectory) {
				const children = await loadFileTreeRecursive(
					`${dirPath}/${entry.name}`,
					maxDepth,
					currentDepth + 1,
					sshContext,
					state
				);
				tree.push({
					name: entry.name,
					type: 'folder',
					children,
				});
			} else if (entry.isFile) {
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
		console.error('Error loading file tree:', error);
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
