import { useMemo, useCallback } from 'react';
import type { Session } from '../../types';
import type { FileNode } from '../../types/fileTree';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { SHELL_COMMAND_PREFIX } from '../../utils/shellCommandInput';

export interface TabCompletionSuggestion {
	value: string;
	type: 'history' | 'file' | 'folder' | 'branch' | 'tag';
	displayText: string;
}

export type TabCompletionFilter = 'all' | 'history' | 'branch' | 'tag' | 'file';

/**
 * PERF: Maximum number of file tree entries to flatten.
 * Mirrors the cap in useAtMentionCompletion to avoid blocking the main thread
 * on repos with 100k+ files.
 */
const MAX_FILE_TREE_ENTRIES = 50_000;

/** Stable empty tree so `storeFileTree ?? EMPTY_FILE_TREE` does not allocate per render. */
const EMPTY_FILE_TREE: FileNode[] = [];

export interface UseTabCompletionReturn {
	/**
	 * @param input       - the command line as typed (no `!` - command mode
	 *                      consumes the bang on entry)
	 * @param filter      - which suggestion category to draw from
	 * @param commandMode - true when completing the AI composer's command mode
	 *                      rather than a terminal tab. Passed explicitly because
	 *                      the two surfaces resolve against different roots and
	 *                      different histories, and the text no longer says which.
	 */
	getSuggestions: (
		input: string,
		filter?: TabCompletionFilter,
		commandMode?: boolean
	) => TabCompletionSuggestion[];
}

/**
 * Non-streaming session fields used for tab completion.
 * Callers must not rely on a full Session with logs / tokens.
 */
export type TabCompletionSessionFields = Pick<
	Session,
	| 'cwd'
	| 'shellCwd'
	| 'fileTree'
	| 'shellCommandHistory'
	| 'aiCommandHistory'
	| 'isGitRepo'
	| 'gitBranches'
	| 'gitTags'
>;

function pickTabCompletionFields(session: Session): TabCompletionSessionFields {
	return {
		cwd: session.cwd,
		shellCwd: session.shellCwd,
		fileTree: session.fileTree,
		shellCommandHistory: session.shellCommandHistory,
		aiCommandHistory: session.aiCommandHistory,
		isGitRepo: session.isGitRepo,
		gitBranches: session.gitBranches,
		gitTags: session.gitTags,
	};
}

/**
 * Flatten a file tree into `{ name, type, path }` entries, capped at
 * MAX_FILE_TREE_ENTRIES so a 100k-file repo can't block the main thread.
 */
function flattenFileTree(
	nodes: FileNode[]
): { name: string; type: 'file' | 'folder'; path: string }[] {
	const names: { name: string; type: 'file' | 'folder'; path: string }[] = [];

	const traverse = (children: FileNode[], currentPath = '') => {
		for (const node of children) {
			if (names.length >= MAX_FILE_TREE_ENTRIES) return;

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

	traverse(nodes);
	return names;
}

/**
 * Hook for providing tab completion suggestions from:
 * 1. Command history
 * 2. File tree (relative to shell CWD in terminal mode, project root in command mode)
 * 3. Git branches and tags (for git commands in git repos)
 *
 * Serves BOTH shell surfaces, told apart by the `commandMode` argument (the
 * text can't say which - a command line looks the same either way):
 * - **Terminal mode** - completes against `shellCwd` and the session's shell
 *   command history.
 * - **Command mode** - the AI composer's `!` mode. Those commands run at the
 *   agent's `cwd` (not `shellCwd`, which only terminal mode's `cd` moves), so
 *   completion resolves from the project root and draws history from the bang
 *   entries in `aiCommandHistory`.
 *
 * Suggestion values are plain command lines in both cases - command mode
 * consumes the `!` on entry, so it is not part of the text being completed.
 *
 * PERF: Prefer calling with no args. Then this hook subscribes only to
 * non-streaming fields on the active session (cwd, shellCwd, fileTree,
 * shellCommandHistory, aiCommandHistory, isGitRepo, gitBranches, gitTags).
 * Passing a Session (or null) keeps the injected-session API for tests and
 * other call sites; when injected, store selectors return stable sentinels so
 * streaming updates do not re-render through those subscriptions.
 *
 * Performance optimizations:
 * - file lists are memoized to avoid re-traversing the tree on every render
 * - history lists are memoized separately to avoid recreating on file tree changes
 * - getSuggestions is wrapped in useCallback to maintain referential equality
 */
export function useTabCompletion(session?: Session | null): UseTabCompletionReturn {
	const injected = session !== undefined;

	// Narrow store selectors (ignored when a session is injected). When injected,
	// each selector returns a stable undefined so Object.is bails out on stream
	// updates and this hook does not re-render solely due to store notifications.
	const storeCwd = useSessionStore((s) => (injected ? undefined : selectActiveSession(s)?.cwd));
	const storeShellCwd = useSessionStore((s) =>
		injected ? undefined : selectActiveSession(s)?.shellCwd
	);
	const storeFileTree = useSessionStore((s) =>
		injected ? undefined : selectActiveSession(s)?.fileTree
	);
	const storeShellHistory = useSessionStore((s) =>
		injected ? undefined : selectActiveSession(s)?.shellCommandHistory
	);
	const storeAiCommandHistory = useSessionStore((s) =>
		injected ? undefined : selectActiveSession(s)?.aiCommandHistory
	);
	const storeIsGitRepo = useSessionStore((s) =>
		injected ? undefined : selectActiveSession(s)?.isGitRepo
	);
	const storeGitBranches = useSessionStore((s) =>
		injected ? undefined : selectActiveSession(s)?.gitBranches
	);
	const storeGitTags = useSessionStore((s) =>
		injected ? undefined : selectActiveSession(s)?.gitTags
	);

	const fields: TabCompletionSessionFields | null = injected
		? session
			? pickTabCompletionFields(session)
			: null
		: {
				cwd: storeCwd ?? '',
				shellCwd: storeShellCwd,
				fileTree: storeFileTree ?? EMPTY_FILE_TREE,
				shellCommandHistory: storeShellHistory,
				aiCommandHistory: storeAiCommandHistory,
				isGitRepo: storeIsGitRepo ?? false,
				gitBranches: storeGitBranches,
				gitTags: storeGitTags,
			};

	// Compute relative path from project root (cwd) to shell working directory (shellCwd)
	const shellRelativePath = useMemo(() => {
		if (!fields?.cwd || !fields?.shellCwd) return '';

		// Normalize paths
		const projectRoot = fields.cwd.replace(/\/$/, '');
		const shellDir = fields.shellCwd.replace(/\/$/, '');

		// If shell is at project root, no relative path needed
		if (shellDir === projectRoot) return '';

		// If shell is within project, compute relative path
		if (shellDir.startsWith(projectRoot + '/')) {
			return shellDir.slice(projectRoot.length + 1);
		}

		// Shell is outside project root - can't use file tree
		return null;
	}, [fields?.cwd, fields?.shellCwd]);

	// Flat list from the project root. This is what command mode (`!cmd`) uses,
	// because bang commands always run at the agent's cwd - terminal mode's `cd`
	// moves shellCwd, not the agent's cwd.
	const rootFileNames = useMemo(() => {
		if (!fields?.fileTree) return [];
		return flattenFileTree(fields.fileTree);
	}, [fields?.fileTree]);

	// Build a flat list of file/folder names from the file tree
	// Filtered to show only files relative to the shell's current working directory
	const fileNames = useMemo(() => {
		if (!fields?.fileTree) return [];
		// If shell is outside project, return empty
		if (shellRelativePath === null) return [];
		// Shell is at project root - reuse the root list rather than re-flattening
		if (!shellRelativePath) return rootFileNames;

		const pathParts = shellRelativePath.split('/');
		let currentNodes: FileNode[] = fields.fileTree;

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

		return flattenFileTree(currentNodes);
	}, [fields?.fileTree, shellRelativePath, rootFileNames]);

	// Memoize shell history reference to avoid unnecessary getSuggestions re-creation
	const shellHistory = useMemo(() => {
		return fields?.shellCommandHistory || [];
	}, [fields?.shellCommandHistory]);

	// Command-mode history: the `!`-prefixed entries recorded in aiCommandHistory,
	// stored with the bang stripped so they match a command body directly.
	const commandModeHistory = useMemo(() => {
		return (fields?.aiCommandHistory || [])
			.filter((cmd) => cmd.startsWith(SHELL_COMMAND_PREFIX))
			.map((cmd) => cmd.slice(SHELL_COMMAND_PREFIX.length).trim())
			.filter(Boolean);
	}, [fields?.aiCommandHistory]);

	// PERF: Memoize git-related data separately to avoid getSuggestions re-creation
	const isGitRepo = fields?.isGitRepo ?? false;
	const gitBranches = useMemo(() => fields?.gitBranches || [], [fields?.gitBranches]);
	const gitTags = useMemo(() => fields?.gitTags || [], [fields?.gitTags]);

	// PERF: Only depend on memoized values, NOT the session object itself
	// This prevents callback recreation on every session state change
	const getSuggestions = useCallback(
		(
			input: string,
			filter: TabCompletionFilter = 'all',
			isCommandMode = false
		): TabCompletionSuggestion[] => {
			// An empty command mode line is a valid starting point - it means "show
			// me what I've run". Empty input in a terminal has nothing to go on.
			const isEmptyCommandLine = isCommandMode && !input.trim();
			if (!input.trim() && !isEmptyCommandLine) return [];

			const history = isCommandMode ? commandModeHistory : shellHistory;
			const files = isCommandMode ? rootFileNames : fileNames;

			const suggestions: TabCompletionSuggestion[] = [];
			const inputLower = input.toLowerCase();
			const seenValues = new Set<string>();

			// Get the last "word" for file/folder completion
			// This handles cases like "cd src/", "cat file", etc.
			const parts = input.split(/\s+/);
			const lastPart = parts[parts.length - 1] || '';
			const prefix = parts.slice(0, -1).join(' ');
			const lastPartLower = lastPart.toLowerCase();

			// 1. Check command history for matches
			if (filter === 'all' || filter === 'history') {
				for (const cmd of history) {
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
			// Skipped on a bare `!`: at the command-word position with nothing typed,
			// a list of branch names is noise - recent commands are what's wanted.
			if (isGitRepo && !isEmptyCommandLine) {
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
			if ((filter === 'all' || filter === 'file') && !isEmptyCommandLine) {
				const hasDotSlashPrefix = lastPart.startsWith('./');
				const normalizedLastPart = lastPart.replace(/^\.\//, ''); // Strip leading ./
				const pathParts = normalizedLastPart.split('/');
				let searchInPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
				// Handle edge case where user types "./" alone - treat as root
				if (lastPart === './' || lastPart === '.') {
					searchInPath = '';
				}
				const searchTerm = pathParts[pathParts.length - 1].toLowerCase();

				for (const file of files) {
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
		[fileNames, rootFileNames, shellHistory, commandModeHistory, isGitRepo, gitBranches, gitTags]
	);

	return { getSuggestions };
}
