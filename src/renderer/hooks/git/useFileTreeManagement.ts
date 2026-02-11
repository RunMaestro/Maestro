import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RightPanelHandle } from '../../components/RightPanel';
import type { Session } from '../../types';
import type { FileNode } from '../../types/fileTree';
import {
	loadFileTree,
	compareFileTrees,
	type FileTreeChanges,
	type SshContext,
	type FileTreeProgress,
} from '../../utils/fileExplorer';
import { fuzzyMatch } from '../../utils/search';
import { gitService } from '../../services/git';
import { logger } from '../../utils/logger';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';

/**
 * Retry delay for file tree errors (20 seconds).
 * After an error, we wait this long before attempting to reload.
 */
const FILE_TREE_RETRY_DELAY_MS = 20000;

/**
 * Options for building SSH context
 */
interface SshContextOptions {
	/** Glob patterns to ignore when indexing remote files */
	ignorePatterns?: string[];
	/** Whether to honor .gitignore files on remote hosts */
	honorGitignore?: boolean;
}

/**
 * Extract SSH context from session for remote file operations.
 * Returns undefined if no SSH remote is configured.
 *
 * Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
 * we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
 */
function getSshContext(session: Session, options?: SshContextOptions): SshContext | undefined {
	// First check if there's a spawned sshRemoteId (set by agent spawn)
	let sshRemoteId: string | undefined = session.sshRemoteId;

	// Fall back to sessionSshRemoteConfig if enabled and has a valid remoteId
	// Note: remoteId can be `null` per the type definition, so we explicitly check for truthiness
	if (
		!sshRemoteId &&
		session.sessionSshRemoteConfig?.enabled &&
		session.sessionSshRemoteConfig?.remoteId
	) {
		sshRemoteId = session.sessionSshRemoteConfig.remoteId;
	}

	logger.debug('getSshContext: session.sshRemoteId', 'FileTreeManagement', {
		sshRemoteId: session.sshRemoteId,
	});
	logger.debug('getSshContext: session.sessionSshRemoteConfig', 'FileTreeManagement', {
		sessionSshRemoteConfig: session.sessionSshRemoteConfig,
	});
	logger.debug('getSshContext: resolved sshRemoteId', 'FileTreeManagement', { sshRemoteId });

	if (!sshRemoteId) {
		logger.debug(
			'getSshContext: No SSH remote ID found, returning undefined',
			'FileTreeManagement'
		);
		return undefined;
	}

	const context: SshContext = {
		sshRemoteId,
		remoteCwd: session.remoteCwd || session.sessionSshRemoteConfig?.workingDirOverride,
		ignorePatterns: options?.ignorePatterns,
		honorGitignore: options?.honorGitignore,
	};
	logger.debug('getSshContext: Returning context', 'FileTreeManagement', context);
	return context;
}

export type { RightPanelHandle } from '../../components/RightPanel';
export type { SshContext } from '../../utils/fileExplorer';

/**
 * Dependencies for the useFileTreeManagement hook.
 */
export interface UseFileTreeManagementDeps {
	/** Current sessions array */
	sessions: Session[];
	/** Ref to sessions for accessing latest state without triggering effect re-runs */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Currently active session ID */
	activeSessionId: string | null;
	/** Currently active session (derived from sessions) */
	activeSession: Session | null;
	/** Ref to RightPanel for refreshing history */
	rightPanelRef: React.RefObject<RightPanelHandle | null>;
	/** SSH remote ignore patterns (glob patterns) */
	sshRemoteIgnorePatterns?: string[];
	/** Whether to honor .gitignore files on remote hosts */
	sshRemoteHonorGitignore?: boolean;
}

/**
 * Return type for useFileTreeManagement hook.
 */
export interface UseFileTreeManagementReturn {
	/** Refresh file tree for a session and return detected changes */
	refreshFileTree: (sessionId: string) => Promise<FileTreeChanges | undefined>;
	/** Refresh both file tree and git state for a session */
	refreshGitFileState: (sessionId: string) => Promise<void>;
	/** Filtered file tree based on current filter */
	filteredFileTree: FileNode[];
}

/**
 * Hook for file tree management operations.
 *
 * Handles:
 * - Loading file trees for sessions
 * - Refreshing file trees and detecting changes
 * - Refreshing git status (branches, tags, repo detection)
 * - Filtering file trees based on search query
 *
 * @param deps - Hook dependencies
 * @returns File tree management functions and computed values
 */
export function useFileTreeManagement(
	deps: UseFileTreeManagementDeps
): UseFileTreeManagementReturn {
	const {
		sessions,
		sessionsRef,
		setSessions,
		activeSessionId,
		activeSession,
		rightPanelRef,
		sshRemoteIgnorePatterns,
		sshRemoteHonorGitignore,
	} = deps;

	const fileTreeFilter = useFileExplorerStore((s) => s.fileTreeFilter);

	// Build SSH context options from settings
	const sshContextOptions: SshContextOptions = useMemo(
		() => ({
			ignorePatterns: sshRemoteIgnorePatterns,
			honorGitignore: sshRemoteHonorGitignore,
		}),
		[sshRemoteIgnorePatterns, sshRemoteHonorGitignore]
	);

	/**
	 * Refresh file tree for a session and return the changes detected.
	 * Uses sessionsRef to avoid dependency on sessions state (prevents timer reset on every session change).
	 * Passes SSH context for remote sessions to enable remote file operations (Phase 2+).
	 */
	const refreshFileTree = useCallback(
		async (sessionId: string): Promise<FileTreeChanges | undefined> => {
			// Use sessionsRef to avoid dependency on sessions state (prevents timer reset on every session change)
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) return undefined;

			// Extract SSH context for remote file operations (with ignore patterns)
			const sshContext = getSshContext(session, sshContextOptions);

			// Use projectRoot for file tree (consistent with Files tab header)
			// This ensures the file tree always shows the agent's working directory, not wherever cd'd to
			const treeRoot = session.projectRoot || session.cwd;

			try {
				// Fetch tree and stats in parallel
				// Pass SSH context for remote file operations
				const [newTree, stats] = await Promise.all([
					loadFileTree(treeRoot, 10, 0, sshContext),
					window.maestro.fs.directorySize(treeRoot, sshContext?.sshRemoteId),
				]);
				const oldTree = session.fileTree || [];
				const changes = compareFileTrees(oldTree, newTree);

				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									fileTree: newTree,
									fileTreeError: undefined,
									fileTreeStats: {
										fileCount: stats.fileCount,
										folderCount: stats.folderCount,
										totalSize: stats.totalSize,
									},
								}
							: s
					)
				);

				return changes;
			} catch (error) {
				logger.error('File tree refresh error', 'FileTreeManagement', {
					error: (error as Error)?.message || 'Unknown error',
				});
				const errorMsg = (error as Error)?.message || 'Unknown error';
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									fileTree: [],
									fileTreeError: `Cannot access directory: ${treeRoot}\n${errorMsg}`,
									fileTreeRetryAt: Date.now() + FILE_TREE_RETRY_DELAY_MS,
									fileTreeStats: undefined,
								}
							: s
					)
				);
				return undefined;
			}
		},
		[sessionsRef, setSessions, sshContextOptions]
	);

	/**
	 * Refresh both file tree and git state for a session.
	 * Loads file tree, checks git repo status, and fetches branches/tags if applicable.
	 * Passes SSH context for remote sessions to enable remote operations (Phase 2+).
	 */
	const refreshGitFileState = useCallback(
		async (sessionId: string) => {
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) return;

			// Use projectRoot for file tree (consistent with Files tab header)
			// Git operations use the appropriate directory based on terminal mode
			const treeRoot = session.projectRoot || session.cwd;
			const gitRoot =
				session.inputMode === 'terminal' ? session.shellCwd || session.cwd : session.cwd;

			// Extract SSH context for remote file/git operations (with ignore patterns)
			const sshContext = getSshContext(session, sshContextOptions);

			try {
				// Refresh file tree, stats, git repo status, branches, and tags in parallel
				// Pass SSH context for remote file operations
				const [tree, stats, isGitRepo] = await Promise.all([
					loadFileTree(treeRoot, 10, 0, sshContext),
					window.maestro.fs.directorySize(treeRoot, sshContext?.sshRemoteId),
					gitService.isRepo(gitRoot, sshContext?.sshRemoteId),
				]);

				let gitBranches: string[] | undefined;
				let gitTags: string[] | undefined;
				let gitRefsCacheTime: number | undefined;

				if (isGitRepo) {
					[gitBranches, gitTags] = await Promise.all([
						gitService.getBranches(gitRoot, sshContext?.sshRemoteId),
						gitService.getTags(gitRoot, sshContext?.sshRemoteId),
					]);
					gitRefsCacheTime = Date.now();
				}

				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									fileTree: tree,
									fileTreeError: undefined,
									fileTreeStats: {
										fileCount: stats.fileCount,
										folderCount: stats.folderCount,
										totalSize: stats.totalSize,
									},
									isGitRepo,
									gitBranches,
									gitTags,
									gitRefsCacheTime,
								}
							: s
					)
				);

				// Also refresh history panel (reload from disk first to bypass electron-store cache)
				await window.maestro.history.reload();
				rightPanelRef.current?.refreshHistoryPanel();
			} catch (error) {
				logger.error('Git/file state refresh error', 'FileTreeManagement', {
					error: (error as Error)?.message || 'Unknown error',
				});
				const errorMsg = (error as Error)?.message || 'Unknown error';
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									fileTree: [],
									fileTreeError: `Cannot access directory: ${treeRoot}\n${errorMsg}`,
									fileTreeRetryAt: Date.now() + FILE_TREE_RETRY_DELAY_MS,
									fileTreeStats: undefined,
								}
							: s
					)
				);
			}
		},
		[sessions, setSessions, rightPanelRef, sshContextOptions]
	);

	// Ref to track pending retry timers per session
	const retryTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

	/**
	 * Load file tree when active session changes.
	 * Only loads if file tree is empty AND not in error backoff period.
	 * Passes SSH context for remote sessions to enable remote operations (Phase 2+).
	 * Shows streaming progress updates during loading (useful for slow SSH connections).
	 */
	useEffect(() => {
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;

		// Only load if file tree is empty, not already loading, and hasn't been loaded yet
		// fileTreeStats is set after successful load, so we use it to detect "loaded but empty"
		const hasLoadedOnce =
			session.fileTreeStats !== undefined || session.fileTreeError !== undefined;
		if (
			(!session.fileTree || session.fileTree.length === 0) &&
			!session.fileTreeLoading &&
			!hasLoadedOnce
		) {
			// Check if we're in a retry backoff period
			if (session.fileTreeRetryAt && Date.now() < session.fileTreeRetryAt) {
				// Schedule retry when backoff expires (if not already scheduled)
				if (!retryTimersRef.current.has(session.id)) {
					const delay = session.fileTreeRetryAt - Date.now();
					const timerId = setTimeout(() => {
						retryTimersRef.current.delete(session.id);
						// Clear the retry time to allow the effect to trigger reload
						setSessions((prev) =>
							prev.map((s) => (s.id === session.id ? { ...s, fileTreeRetryAt: undefined } : s))
						);
					}, delay);
					retryTimersRef.current.set(session.id, timerId);
				}
				return; // Don't load now, wait for retry timer
			}

			// Extract SSH context for remote file operations (with ignore patterns)
			const sshContext = getSshContext(session, sshContextOptions);

			// Use projectRoot for file tree (consistent with Files tab header)
			const treeRoot = session.projectRoot || session.cwd;

			// Mark as loading before starting
			setSessions((prev) =>
				prev.map((s) =>
					s.id === activeSessionId
						? {
								...s,
								fileTreeLoading: true,
								fileTreeLoadingProgress: undefined,
							}
						: s
				)
			);

			// Progress callback for streaming updates during SSH load
			const onProgress = (progress: FileTreeProgress) => {
				setSessions((prev) =>
					prev.map((s) =>
						s.id === activeSessionId
							? {
									...s,
									fileTreeLoadingProgress: {
										directoriesScanned: progress.directoriesScanned,
										filesFound: progress.filesFound,
										currentDirectory: progress.currentDirectory,
									},
								}
							: s
					)
				);
			};

			// Load tree with progress callback for SSH sessions
			const treePromise = sshContext
				? loadFileTree(treeRoot, 10, 0, sshContext, onProgress)
				: loadFileTree(treeRoot, 10, 0, sshContext);

			Promise.all([treePromise, window.maestro.fs.directorySize(treeRoot, sshContext?.sshRemoteId)])
				.then(([tree, stats]) => {
					setSessions((prev) =>
						prev.map((s) =>
							s.id === activeSessionId
								? {
										...s,
										fileTree: tree,
										fileTreeError: undefined,
										fileTreeRetryAt: undefined,
										fileTreeLoading: false,
										fileTreeLoadingProgress: undefined,
										fileTreeStats: {
											fileCount: stats.fileCount,
											folderCount: stats.folderCount,
											totalSize: stats.totalSize,
										},
									}
								: s
						)
					);
				})
				.catch((error) => {
					logger.error('File tree error', 'FileTreeManagement', {
						error: error?.message || 'Unknown error',
					});
					const errorMsg = error?.message || 'Unknown error';
					setSessions((prev) =>
						prev.map((s) =>
							s.id === activeSessionId
								? {
										...s,
										fileTree: [],
										fileTreeError: `Cannot access directory: ${treeRoot}\n${errorMsg}`,
										fileTreeRetryAt: Date.now() + FILE_TREE_RETRY_DELAY_MS,
										fileTreeLoading: false,
										fileTreeLoadingProgress: undefined,
										fileTreeStats: undefined,
									}
								: s
						)
					);
				});
		}
	}, [activeSessionId, sessions, setSessions, sshContextOptions]);

	// Cleanup retry timers on unmount
	useEffect(() => {
		return () => {
			retryTimersRef.current.forEach((timerId) => clearTimeout(timerId));
			retryTimersRef.current.clear();
		};
	}, []);

	/**
	 * Migration: Fetch stats for sessions that have a file tree but no stats.
	 * This handles sessions restored from before the stats feature was added (Dec 2025).
	 * Only fetches stats - doesn't re-fetch the file tree since it's already loaded.
	 */
	useEffect(() => {
		const session = sessions.find((s) => s.id === activeSessionId);
		if (!session) return;

		// Only migrate if: has file tree, no stats, no error, not loading
		const needsStatsMigration =
			session.fileTree &&
			session.fileTree.length > 0 &&
			session.fileTreeStats === undefined &&
			!session.fileTreeError &&
			!session.fileTreeLoading;

		if (!needsStatsMigration) return;

		// No ignore patterns needed for stats-only fetch
		const sshContext = getSshContext(session);
		const treeRoot = session.projectRoot || session.cwd;

		// Fetch stats only (don't re-fetch tree)
		window.maestro.fs
			.directorySize(treeRoot, sshContext?.sshRemoteId)
			.then((stats) => {
				setSessions((prev) =>
					prev.map((s) =>
						s.id === activeSessionId
							? {
									...s,
									fileTreeStats: {
										fileCount: stats.fileCount,
										folderCount: stats.folderCount,
										totalSize: stats.totalSize,
									},
								}
							: s
					)
				);
			})
			.catch((error) => {
				// Stats fetch failed - log but don't set error state (tree is still valid)
				logger.warn('Stats migration failed', 'FileTreeManagement', {
					error: error?.message || 'Unknown error',
					sessionId: activeSessionId,
				});
			});
	}, [activeSessionId, sessions, setSessions]);

	/**
	 * Filter file tree based on search query.
	 * Uses fuzzy matching on file/folder names.
	 */
	const filteredFileTree = useMemo(() => {
		if (!activeSession || !fileTreeFilter || !activeSession.fileTree) {
			return activeSession?.fileTree || [];
		}

		const filterTree = (nodes: FileNode[]): FileNode[] => {
			return nodes.reduce((acc: FileNode[], node) => {
				const matchesFilter = fuzzyMatch(node.name, fileTreeFilter);

				if (node.type === 'folder' && node.children) {
					const filteredChildren = filterTree(node.children);
					// Include folder if it matches or has matching children
					if (matchesFilter || filteredChildren.length > 0) {
						acc.push({
							...node,
							children: filteredChildren,
						});
					}
				} else if (node.type === 'file' && matchesFilter) {
					acc.push(node);
				}

				return acc;
			}, []);
		};

		return filterTree(activeSession.fileTree);
	}, [activeSession, fileTreeFilter]);

	return {
		refreshFileTree,
		refreshGitFileState,
		filteredFileTree,
	};
}
