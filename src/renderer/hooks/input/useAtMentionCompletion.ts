import { useMemo, useCallback, useState, useEffect } from 'react';
import type { Session } from '../../types';
import type { FileNode } from '../../types/fileTree';
import type { AutoRunTreeNode } from '../batch/useAutoRunHandlers';
import { fuzzyMatchWithScore } from '../../utils/search';

export interface AtMentionSuggestion {
	value: string; // Full path to insert
	type: 'file' | 'folder';
	displayText: string; // Display name (filename)
	fullPath: string; // Full relative path
	score: number; // For sorting by relevance
	source?: 'project' | 'autorun'; // Source of the file for disambiguation
}

export interface UseAtMentionCompletionReturn {
	getSuggestions: (filter: string) => AtMentionSuggestion[];
}

/**
 * Hook for providing @ mention file completion in AI mode.
 * Uses fuzzy matching to find files in the project tree and Auto Run folder.
 */
export function useAtMentionCompletion(session: Session | null): UseAtMentionCompletionReturn {
	// State for Auto Run folder files (fetched asynchronously)
	const [autoRunFiles, setAutoRunFiles] = useState<
		{ name: string; type: 'file' | 'folder'; path: string }[]
	>([]);

	// Fetch Auto Run folder files when the path changes
	const autoRunFolderPath = session?.autoRunFolderPath;
	const sessionCwd = session?.cwd;

	useEffect(() => {
		// Clear if no Auto Run folder configured
		if (!autoRunFolderPath) {
			setAutoRunFiles([]);
			return;
		}

		// Check if Auto Run folder is already within the project tree
		// If so, skip fetching since those files are already in fileTree
		if (sessionCwd && autoRunFolderPath.startsWith(sessionCwd + '/')) {
			setAutoRunFiles([]);
			return;
		}

		// Fetch the Auto Run folder contents
		let cancelled = false;

		const fetchAutoRunFiles = async () => {
			try {
				const result = await window.maestro.autorun.listDocs(autoRunFolderPath);
				if (cancelled) return;

				if (result.success && result.tree) {
					const files: { name: string; type: 'file' | 'folder'; path: string }[] = [];

					// Traverse the Auto Run tree (similar to fileTree traversal)
					const traverse = (nodes: AutoRunTreeNode[], _currentPath = '') => {
						for (const node of nodes) {
							// Auto Run tree already has the path property, but we need to add .md extension for files
							const displayPath = node.type === 'file' ? `${node.path}.md` : node.path;
							files.push({
								name: node.type === 'file' ? `${node.name}.md` : node.name,
								type: node.type,
								path: displayPath,
							});
							if (node.type === 'folder' && node.children) {
								traverse(node.children, displayPath);
							}
						}
					};

					traverse(result.tree);
					setAutoRunFiles(files);
				} else {
					setAutoRunFiles([]);
				}
			} catch {
				// Silently fail - folder might not exist yet
				if (!cancelled) {
					setAutoRunFiles([]);
				}
			}
		};

		fetchAutoRunFiles();

		return () => {
			cancelled = true;
		};
	}, [autoRunFolderPath, sessionCwd]);

	// Build a flat list of all files/folders from the file tree
	const projectFiles = useMemo(() => {
		if (!session?.fileTree) return [];

		const files: { name: string; type: 'file' | 'folder'; path: string }[] = [];

		const traverse = (nodes: FileNode[], currentPath = '') => {
			for (const node of nodes) {
				const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
				files.push({
					name: node.name,
					type: node.type,
					path: fullPath,
				});
				if (node.type === 'folder' && node.children) {
					traverse(node.children, fullPath);
				}
			}
		};

		traverse(session.fileTree);
		return files;
	}, [session?.fileTree]);

	// Combine project files with Auto Run files
	const allFiles = useMemo(() => {
		// If no Auto Run files, just return project files
		if (autoRunFiles.length === 0) {
			return projectFiles.map((f) => ({ ...f, source: 'project' as const }));
		}

		// Combine both, marking Auto Run files with their source
		const combined = [
			...projectFiles.map((f) => ({ ...f, source: 'project' as const })),
			...autoRunFiles.map((f) => ({ ...f, source: 'autorun' as const })),
		];

		return combined;
	}, [projectFiles, autoRunFiles]);

	// PERF: Only depend on allFiles, NOT session - session dependency causes
	// this callback to be recreated on every session state change, which
	// invalidates memoized suggestions in App.tsx and causes cascading re-renders
	const getSuggestions = useCallback(
		(filter: string): AtMentionSuggestion[] => {
			// Early return if no files available (allFiles is empty when session is null)
			if (allFiles.length === 0) return [];

			const suggestions: AtMentionSuggestion[] = [];

			for (const file of allFiles) {
				// Match against both file name and full path
				const nameMatch = fuzzyMatchWithScore(file.name, filter);
				const pathMatch = fuzzyMatchWithScore(file.path, filter);

				// Use the better of the two scores
				const bestMatch = nameMatch.score > pathMatch.score ? nameMatch : pathMatch;

				if (bestMatch.matches || !filter) {
					suggestions.push({
						value: file.path,
						type: file.type,
						displayText: file.name,
						fullPath: file.path,
						score: bestMatch.score,
						source: file.source,
					});
				}
			}

			// Sort by score (highest first), then alphabetically
			suggestions.sort((a, b) => {
				if (b.score !== a.score) {
					return b.score - a.score;
				}
				// Within same score, prefer files over folders, then alphabetical
				if (a.type !== b.type) {
					return a.type === 'file' ? -1 : 1;
				}
				return a.displayText.localeCompare(b.displayText);
			});

			// Limit to reasonable number
			return suggestions.slice(0, 15);
		},
		[allFiles]
	);

	return { getSuggestions };
}
