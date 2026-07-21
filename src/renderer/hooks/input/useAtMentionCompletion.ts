import { useMemo, useCallback, useState, useEffect } from 'react';
import type { Session } from '../../types';
import type { FileNode } from '../../types/fileTree';
import type { AutoRunTreeNode } from '../batch/useAutoRunHandlers';
import { fuzzyMatchWithScore } from '../../utils/search';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';

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
 * PERF: Maximum number of file tree entries to flatten.
 * For repos with 100k+ files, unbounded traversal creates a massive array
 * that blocks the main thread. 50k entries is more than enough for
 * meaningful @mention suggestions while keeping traversal fast.
 * Breadth-first-like order naturally prioritizes shallower (more relevant) files.
 */
const MAX_FILE_TREE_ENTRIES = 50_000;

/**
 * PERF: Maximum number of results to return from fuzzy search.
 */
const MAX_SUGGESTION_RESULTS = 15;

/**
 * PERF: Once this many exact substring matches are found (and we have MAX_SUGGESTION_RESULTS),
 * stop searching. Exact matches score highest in fuzzyMatchWithScore (they receive a +50
 * bonus in search.ts), so once we have 50 exact substring matches the top-15 results are
 * virtually guaranteed to be optimal - any remaining files would only contribute weaker
 * fuzzy-only matches that cannot outscore them. 50 provides a comfortable margin over
 * MAX_SUGGESTION_RESULTS (15) to account for score ties and type-based sorting.
 */
const EARLY_EXIT_EXACT_MATCH_THRESHOLD = 50;

/**
 * Hook for providing @ mention file completion in AI mode.
 * Uses fuzzy matching to find files in the project tree and Auto Run folder.
 *
 * PERF: Prefer calling with no args. Then this hook subscribes only to
 * non-streaming fields (fileTree, cwd, autoRunFolderPath). Passing a Session
 * (or null) keeps the injected-session API for tests and PromptComposerModal;
 * when injected, store selectors return stable sentinels so streaming updates
 * do not re-render through those subscriptions.
 */
export function useAtMentionCompletion(session?: Session | null): UseAtMentionCompletionReturn {
	const injected = session !== undefined;

	const storeFileTree = useSessionStore((s) =>
		injected ? undefined : selectActiveSession(s)?.fileTree
	);
	const storeCwd = useSessionStore((s) => (injected ? undefined : selectActiveSession(s)?.cwd));
	const storeAutoRunFolderPath = useSessionStore((s) =>
		injected ? undefined : selectActiveSession(s)?.autoRunFolderPath
	);

	const fileTree = injected ? session?.fileTree : storeFileTree;
	const sessionCwd = injected ? session?.cwd : storeCwd;
	const autoRunFolderPath = injected ? session?.autoRunFolderPath : storeAutoRunFolderPath;

	// State for Auto Run folder files (fetched asynchronously)
	const [autoRunFiles, setAutoRunFiles] = useState<
		{ name: string; type: 'file' | 'folder'; path: string }[]
	>([]);

	// Fetch Auto Run folder files when the path changes
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
	// PERF: Capped at MAX_FILE_TREE_ENTRIES to avoid blocking the main thread on huge repos
	const projectFiles = useMemo(() => {
		if (!fileTree) return [];

		const files: { name: string; type: 'file' | 'folder'; path: string }[] = [];

		const traverse = (nodes: FileNode[], currentPath = '') => {
			for (const node of nodes) {
				if (files.length >= MAX_FILE_TREE_ENTRIES) return;

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

		traverse(fileTree);
		return files;
	}, [fileTree]);

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

			// PERF: When no filter (user just typed @), skip all fuzzy matching
			// and return the first N files directly. Avoids 200k+ no-op fuzzyMatchWithScore calls.
			if (!filter) {
				const results: AtMentionSuggestion[] = [];
				for (let i = 0; i < Math.min(allFiles.length, MAX_SUGGESTION_RESULTS); i++) {
					const file = allFiles[i];
					results.push({
						value: file.path,
						type: file.type,
						displayText: file.name,
						fullPath: file.path,
						score: 0,
						source: file.source,
					});
				}
				// Sort the small result set (sorting 15 items is essentially free)
				results.sort((a, b) => {
					if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
					return a.displayText.localeCompare(b.displayText);
				});
				return results;
			}

			const suggestions: AtMentionSuggestion[] = [];
			const filterLower = filter.toLowerCase();
			let exactSubstringMatchCount = 0;

			for (const file of allFiles) {
				// Match against both file name and full path
				const nameMatch = fuzzyMatchWithScore(file.name, filter);
				const pathMatch = fuzzyMatchWithScore(file.path, filter);

				// Use the better of the two scores
				const bestMatch = nameMatch.score > pathMatch.score ? nameMatch : pathMatch;

				if (bestMatch.matches) {
					suggestions.push({
						value: file.path,
						type: file.type,
						displayText: file.name,
						fullPath: file.path,
						score: bestMatch.score,
						source: file.source,
					});

					// Track exact substring matches for early exit
					if (
						file.name.toLowerCase().includes(filterLower) ||
						file.path.toLowerCase().includes(filterLower)
					) {
						exactSubstringMatchCount++;
					}

					// PERF: Early exit - once we have enough high-quality exact substring
					// matches and enough total results, further searching through remaining
					// files would only yield lower-scoring fuzzy matches.
					if (
						exactSubstringMatchCount >= EARLY_EXIT_EXACT_MATCH_THRESHOLD &&
						suggestions.length >= MAX_SUGGESTION_RESULTS
					) {
						break;
					}
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
			return suggestions.slice(0, MAX_SUGGESTION_RESULTS);
		},
		[allFiles]
	);

	return { getSuggestions };
}
