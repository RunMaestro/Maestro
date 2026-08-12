import { useCallback, useMemo } from 'react';
import type { FileNode } from '../../../types/fileTree';
import { logger } from '../../../utils/logger';
import { MAESTRO_DIR } from '../../../../shared/maestro-paths';
import type { FlattenedNode } from '../types';

interface UseFileTreeFlattenArgs {
	filteredFileTree: FileNode[];
	fileTreeFilter: string;
	fileExplorerExpanded: string[] | undefined;
	showHiddenFiles: boolean;
}

interface UseFileTreeFlattenResult {
	displayTree: FileNode[];
	flattenedTree: FlattenedNode[];
}

export function useFileTreeFlatten({
	filteredFileTree,
	fileTreeFilter,
	fileExplorerExpanded,
	showHiddenFiles,
}: UseFileTreeFlattenArgs): UseFileTreeFlattenResult {
	// Filter hidden files from the tree based on showHiddenFiles setting.
	// Invariant: `.maestro` is ALWAYS visible regardless of the dotfiles toggle -
	// it's the project's Maestro workspace (playbooks, cue config, etc.) and
	// hiding it strands users who don't realize their config is "hidden". This
	// has regressed before; if you change the dotfile filter, keep the carve-out.
	const filterHiddenFiles = useCallback(
		(nodes: FileNode[]): FileNode[] => {
			if (!nodes) return [];
			if (showHiddenFiles) return nodes;
			return nodes
				.filter((node) => !node.name.startsWith('.') || node.name === MAESTRO_DIR)
				.map((node) => ({
					...node,
					children: node.children ? filterHiddenFiles(node.children) : undefined,
				}));
		},
		[showHiddenFiles]
	);

	const displayTree = useMemo(() => {
		return filterHiddenFiles(filteredFileTree || []);
	}, [filteredFileTree, filterHiddenFiles]);

	// Flatten tree for virtualization - only includes visible nodes (respects expanded state).
	// When filtering, auto-expand all folders to show matches.
	const flattenedTree = useMemo(() => {
		const expandedSet = new Set(fileExplorerExpanded || []);
		const isFiltering = fileTreeFilter.length > 0;
		const result: FlattenedNode[] = [];
		const seenPaths = new Set<string>();
		let globalIndex = 0;

		const flatten = (nodes: FileNode[], currentPath = '', depth = 0) => {
			// Guard: deduplicate sibling nodes by name within the same parent
			const seenNames = new Set<string>();
			for (const node of nodes) {
				const normalizedName = node.name.normalize('NFC');
				if (seenNames.has(normalizedName)) {
					logger.warn('[FileExplorer] Duplicate sibling skipped:', undefined, [
						currentPath,
						node.name,
					]);
					continue;
				}
				seenNames.add(normalizedName);

				const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;

				// Guard: skip duplicate paths to prevent React key collisions
				if (seenPaths.has(fullPath)) {
					logger.warn('[FileExplorer] Duplicate path skipped:', undefined, fullPath);
					continue;
				}
				seenPaths.add(fullPath);

				result.push({ node, path: fullPath, depth, globalIndex });
				globalIndex++;

				// When filtering, auto-expand all folders to reveal matches.
				// Otherwise, only include children if folder is manually expanded.
				const shouldShowChildren =
					node.type === 'folder' && node.children && (isFiltering || expandedSet.has(fullPath));

				if (shouldShowChildren) {
					flatten(node.children!, fullPath, depth + 1);
				}
			}
		};

		flatten(displayTree);
		return result;
	}, [displayTree, fileExplorerExpanded, fileTreeFilter]);

	return { displayTree, flattenedTree };
}
