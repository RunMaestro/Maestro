/**
 * Shared tree traversal utilities for file trees
 *
 * These utilities provide common patterns for walking tree structures,
 * reducing duplication across the codebase.
 *
 * @example Basic usage - collect all file paths
 * ```typescript
 * const paths = walkTree(fileTree, {
 *   onFile: (node, path) => path,
 * });
 * ```
 *
 * @example Collect files with metadata
 * ```typescript
 * const entries = walkTree(fileTree, {
 *   onFile: (node, path) => ({ relativePath: path, filename: node.name }),
 * });
 * ```
 *
 * @example Collect files and folders separately
 * ```typescript
 * const result = walkTreePartitioned(fileTree);
 * // result.files: Set<string>
 * // result.folders: Set<string>
 * ```
 */

/**
 * Base interface for tree nodes - compatible with both FileNode and FileTreeNode
 */
export interface TreeNode {
	name: string;
	type: 'file' | 'folder';
	children?: TreeNode[];
}

/**
 * Options for walkTree function
 */
export interface WalkTreeOptions<T, N extends TreeNode = TreeNode> {
	/**
	 * Called for each file node. Return a value to include in results, or undefined to skip.
	 */
	onFile?: (node: N, path: string) => T | undefined;
	/**
	 * Called for each folder node. Return a value to include in results, or undefined to skip.
	 */
	onFolder?: (node: N, path: string) => T | undefined;
	/**
	 * Initial path prefix (default: '')
	 */
	basePath?: string;
}

/**
 * Walk a tree structure recursively, collecting results from callbacks
 *
 * This is a generic tree walker that can be used to:
 * - Build flat indexes of all files/folders
 * - Collect paths matching certain criteria
 * - Transform tree data into other structures
 *
 * @param nodes - Array of tree nodes to walk
 * @param options - Callbacks and configuration
 * @returns Array of collected results (non-undefined values from callbacks)
 *
 * @example Collect all file paths
 * ```typescript
 * const filePaths = walkTree(tree, {
 *   onFile: (_, path) => path,
 * });
 * ```
 *
 * @example Collect all folder paths
 * ```typescript
 * const folderPaths = walkTree(tree, {
 *   onFolder: (_, path) => path,
 * });
 * ```
 *
 * @example Build file index with metadata
 * ```typescript
 * const index = walkTree(tree, {
 *   onFile: (node, path) => ({
 *     relativePath: path,
 *     filename: node.name,
 *     extension: node.name.split('.').pop(),
 *   }),
 * });
 * ```
 */
export function walkTree<T, N extends TreeNode = TreeNode>(
	nodes: N[],
	options: WalkTreeOptions<T, N>
): T[] {
	const { onFile, onFolder, basePath = '' } = options;
	const results: T[] = [];

	function walk(nodeList: N[], currentPath: string): void {
		for (const node of nodeList) {
			const nodePath = currentPath ? `${currentPath}/${node.name}` : node.name;

			if (node.type === 'file') {
				if (onFile) {
					const result = onFile(node, nodePath);
					if (result !== undefined) {
						results.push(result);
					}
				}
			} else if (node.type === 'folder') {
				if (onFolder) {
					const result = onFolder(node, nodePath);
					if (result !== undefined) {
						results.push(result);
					}
				}
				if (node.children) {
					walk(node.children as N[], nodePath);
				}
			}
		}
	}

	walk(nodes, basePath);
	return results;
}

/**
 * Result of walkTreePartitioned - files and folders collected separately
 */
export interface PartitionedPaths {
	files: Set<string>;
	folders: Set<string>;
}

/**
 * Walk a tree and partition paths into files and folders
 *
 * This is a convenience function for the common pattern of collecting
 * file and folder paths separately into Sets.
 *
 * @param nodes - Array of tree nodes to walk
 * @param basePath - Optional initial path prefix
 * @returns Object with `files` and `folders` Sets containing full paths
 *
 * @example
 * ```typescript
 * const { files, folders } = walkTreePartitioned(fileTree);
 * console.log(`Found ${files.size} files in ${folders.size} folders`);
 * ```
 */
export function walkTreePartitioned<N extends TreeNode = TreeNode>(
	nodes: N[],
	basePath = ''
): PartitionedPaths {
	const files = new Set<string>();
	const folders = new Set<string>();

	walkTree<void, N>(nodes, {
		basePath,
		onFile: (_, path) => {
			files.add(path);
		},
		onFolder: (_, path) => {
			folders.add(path);
		},
	});

	return { files, folders };
}

/**
 * Get all file paths from a tree
 *
 * Convenience function equivalent to:
 * ```typescript
 * walkTree(nodes, { onFile: (_, path) => path })
 * ```
 *
 * Note: This is a public convenience wrapper, though currently only used in tests.
 * Kept for API completeness alongside getAllFolderPaths.
 *
 * @param nodes - Array of tree nodes
 * @param basePath - Optional initial path prefix
 * @returns Array of file paths
 */
export function getAllFilePaths<N extends TreeNode = TreeNode>(
	nodes: N[],
	basePath = ''
): string[] {
	return walkTree<string, N>(nodes, {
		basePath,
		onFile: (_, path) => path,
	});
}

/**
 * Get all folder paths from a tree
 *
 * Convenience function equivalent to:
 * ```typescript
 * walkTree(nodes, { onFolder: (_, path) => path })
 * ```
 *
 * @param nodes - Array of tree nodes
 * @param basePath - Optional initial path prefix
 * @returns Array of folder paths
 */
export function getAllFolderPaths<N extends TreeNode = TreeNode>(
	nodes: N[],
	basePath = ''
): string[] {
	return walkTree<string, N>(nodes, {
		basePath,
		onFolder: (_, path) => path,
	});
}

/**
 * Entry with path and filename for building file indexes
 */
export interface FilePathEntry {
	/** Relative path from tree root */
	relativePath: string;
	/** Just the filename */
	filename: string;
}

/**
 * Build a flat index of all files in the tree
 *
 * Creates an array of entries with relativePath and filename,
 * useful for quick file lookups and wiki-style link resolution.
 *
 * @param nodes - Array of tree nodes
 * @param basePath - Optional initial path prefix
 * @returns Array of FilePathEntry objects
 *
 * @example
 * ```typescript
 * const entries = buildFileIndex(fileTree);
 * const allPaths = new Set(entries.map(e => e.relativePath));
 * ```
 */
export function buildFileIndex<N extends TreeNode = TreeNode>(
	nodes: N[],
	basePath = ''
): FilePathEntry[] {
	return walkTree<FilePathEntry, N>(nodes, {
		basePath,
		onFile: (node, path) => ({
			relativePath: path,
			filename: node.name,
		}),
	});
}
