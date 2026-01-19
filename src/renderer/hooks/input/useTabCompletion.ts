import { useMemo, useCallback } from 'react';
import type { Session } from '../../types';
import type { FileNode } from '../../types/fileTree';

export interface TabCompletionSuggestion {
	value: string;
	type: 'history' | 'file' | 'folder' | 'branch' | 'tag';
	displayText: string;
}

export type TabCompletionFilter = 'all' | 'history' | 'branch' | 'tag' | 'file';

export interface UseTabCompletionReturn {
	getSuggestions: (input: string, filter?: TabCompletionFilter) => TabCompletionSuggestion[];
}

/**
 * Hook for providing tab completion suggestions from:
 * 1. Shell command history
 * 2. Current directory file tree (relative to shell CWD)
 * 3. Git branches and tags (for git commands in git repos)
 *
 * Performance optimizations:
 * - fileNames is memoized to avoid re-traversing tree on every render
 * - shellHistory is memoized separately to avoid recreating on file tree changes
 * - getSuggestions is wrapped in useCallback to maintain referential equality
 */
export function useTabCompletion(session: Session | null): UseTabCompletionReturn {
	// Compute relative path from project root (cwd) to shell working directory (shellCwd)
	const shellRelativePath = useMemo(() => {
		if (!session?.cwd || !session?.shellCwd) return '';

		// Normalize paths
		const projectRoot = session.cwd.replace(/\/$/, '');
		const shellDir = session.shellCwd.replace(/\/$/, '');

		// If shell is at project root, no relative path needed
		if (shellDir === projectRoot) return '';

		// If shell is within project, compute relative path
		if (shellDir.startsWith(projectRoot + '/')) {
			return shellDir.slice(projectRoot.length + 1);
		}

		// Shell is outside project root - can't use file tree
		return null;
	}, [session?.cwd, session?.shellCwd]);

	// Build a flat list of file/folder names from the file tree
	// Filtered to show only files relative to the shell's current working directory
	const fileNames = useMemo(() => {
		if (!session?.fileTree) return [];
		// If shell is outside project, return empty
		if (shellRelativePath === null) return [];

		const names: { name: string; type: 'file' | 'folder'; path: string }[] = [];

		const traverse = (nodes: FileNode[], currentPath = '') => {
			for (const node of nodes) {
				const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
				names.push({
					name: node.name,
					type: node.type,
					path: fullPath,
				});
				if (node.type === 'folder' && node.children) {
					traverse(node.children, fullPath);
				}
			}
		};

		// If we have a relative path, find that subtree first
		if (shellRelativePath) {
			const pathParts = shellRelativePath.split('/');
			let currentNodes: FileNode[] = session.fileTree;

			// Navigate to the shell's current directory in the tree
			for (const part of pathParts) {
				const found = currentNodes.find((n) => n.name === part && n.type === 'folder');
				if (found && found.children) {
					currentNodes = found.children;
				} else {
					// Directory not found in tree - return empty
					return [];
				}
			}

			// Traverse from the shell's current directory
			traverse(currentNodes);
		} else {
			// Shell is at project root - traverse entire tree
			traverse(session.fileTree);
		}

		return names;
	}, [session?.fileTree, shellRelativePath]);

	// Memoize shell history reference to avoid unnecessary getSuggestions re-creation
	const shellHistory = useMemo(() => {
		return session?.shellCommandHistory || [];
	}, [session?.shellCommandHistory]);

	// PERF: Memoize git-related data separately to avoid getSuggestions re-creation
	const isGitRepo = session?.isGitRepo ?? false;
	const gitBranches = useMemo(() => session?.gitBranches || [], [session?.gitBranches]);
	const gitTags = useMemo(() => session?.gitTags || [], [session?.gitTags]);

	// PERF: Only depend on memoized values, NOT the session object itself
	// This prevents callback recreation on every session state change
	const getSuggestions = useCallback(
		(input: string, filter: TabCompletionFilter = 'all'): TabCompletionSuggestion[] => {
			if (!input.trim()) return [];

			const suggestions: TabCompletionSuggestion[] = [];
			const inputLower = input.toLowerCase();
			const seenValues = new Set<string>();

			// Get the last "word" for file/folder completion
			// This handles cases like "cd src/", "cat file", etc.
			const parts = input.split(/\s+/);
			const lastPart = parts[parts.length - 1] || '';
			const prefix = parts.slice(0, -1).join(' ');
			const lastPartLower = lastPart.toLowerCase();

			// 1. Check shell command history for matches
			if (filter === 'all' || filter === 'history') {
				for (const cmd of shellHistory) {
					const cmdLower = cmd.toLowerCase();
					// When specifically filtering to history, show all history items that contain any part of input
					// When showing 'all', only show history that starts with the full input
					const matches =
						filter === 'history'
							? !inputLower || cmdLower.includes(inputLower)
							: cmdLower.startsWith(inputLower);
					if (matches && !seenValues.has(cmd)) {
						seenValues.add(cmd);
						suggestions.push({
							value: cmd,
							type: 'history',
							displayText: cmd,
						});
					}
				}
			}

			// 2. Check git branches and tags (always show in git repos, not just for "git" commands)
			if (isGitRepo) {
				// Add matching branches
				if (filter === 'all' || filter === 'branch') {
					for (const branch of gitBranches) {
						const fullValue = `${prefix} ${branch}`.trim();
						// Show all branches if no filter, or filter by last part
						if (
							(!lastPartLower || branch.toLowerCase().startsWith(lastPartLower)) &&
							!seenValues.has(fullValue)
						) {
							seenValues.add(fullValue);
							suggestions.push({
								value: fullValue,
								type: 'branch',
								displayText: branch,
							});
						}
					}
				}

				// Add matching tags
				if (filter === 'all' || filter === 'tag') {
					for (const tag of gitTags) {
						const fullValue = `${prefix} ${tag}`.trim();
						// Show all tags if no filter, or filter by last part
						if (
							(!lastPartLower || tag.toLowerCase().startsWith(lastPartLower)) &&
							!seenValues.has(fullValue)
						) {
							seenValues.add(fullValue);
							suggestions.push({
								value: fullValue,
								type: 'tag',
								displayText: tag,
							});
						}
					}
				}
			}

			// 3. Check file tree for matches on the last word
			// Handle path-like completions (e.g., "cd src/comp" should match files in src/)
			// Also handle ./ prefix (e.g., "./src" -> "src")
			if (filter === 'all' || filter === 'file') {
				const hasDotSlashPrefix = lastPart.startsWith('./');
				const normalizedLastPart = lastPart.replace(/^\.\//, ''); // Strip leading ./
				const pathParts = normalizedLastPart.split('/');
				let searchInPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
				// Handle edge case where user types "./" alone - treat as root
				if (lastPart === './' || lastPart === '.') {
					searchInPath = '';
				}
				const searchTerm = pathParts[pathParts.length - 1].toLowerCase();

				for (const file of fileNames) {
					// If user is typing a path, only show files in that path
					if (searchInPath) {
						if (!file.path.toLowerCase().startsWith(searchInPath.toLowerCase() + '/')) {
							continue;
						}
						// Check if the remaining part matches
						const remaining = file.path.slice(searchInPath.length + 1);
						const remainingParts = remaining.split('/');
						// Only show immediate children
						if (remainingParts.length !== 1) continue;
						if (!remaining.toLowerCase().startsWith(searchTerm)) continue;
					} else {
						// Top-level search
						if (!file.name.toLowerCase().startsWith(searchTerm)) continue;
						// For top-level, only show top-level items (no / in path)
						if (file.path.includes('/')) continue;
					}

					const completedPath = searchInPath ? `${searchInPath}/${file.name}` : file.name;
					// Preserve the ./ prefix if the user typed it
					const completedPathWithPrefix = hasDotSlashPrefix ? `./${completedPath}` : completedPath;
					const completionPath = completedPathWithPrefix + (file.type === 'folder' ? '/' : '');
					const completionToken = /\s/.test(completionPath)
						? `"${completionPath}"`
						: completionPath;
					const fullValue = prefix ? `${prefix} ${completionToken}` : completionToken;

					if (!seenValues.has(fullValue)) {
						seenValues.add(fullValue);
						suggestions.push({
							value: fullValue,
							type: file.type,
							displayText: completionToken,
						});
					}
				}
			}

			// Sort: history first, then branches, then tags, then folders, then files
			// Within each category, sort alphabetically
			suggestions.sort((a, b) => {
				const typeOrder: Record<string, number> = {
					history: 0,
					branch: 1,
					tag: 2,
					folder: 3,
					file: 4,
				};
				if (typeOrder[a.type] !== typeOrder[b.type]) {
					return typeOrder[a.type] - typeOrder[b.type];
				}
				return a.displayText.localeCompare(b.displayText);
			});

			// Limit to reasonable number (more when showing all types)
			return suggestions.slice(0, 15);
		},
		[fileNames, shellHistory, isGitRepo, gitBranches, gitTags]
	);

	return { getSuggestions };
}
