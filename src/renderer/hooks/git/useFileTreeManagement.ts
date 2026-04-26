import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RightPanelHandle } from '../../components/RightPanel';
import type { Session } from '../../types';
import type { FileNode } from '../../types/fileTree';
import {
	loadFileTree,
	compareFileTrees,
	FileTreeAbortError,
	type FileTreeChanges,
	type SshContext,
	type FileTreeProgress,
	type LocalFileTreeOptions,
} from '../../utils/fileExplorer';
import { fuzzyMatch } from '../../utils/search';
import { gitService } from '../../services/git';
import { logger } from '../../utils/logger';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';
import { useSessionStore } from '../../stores/sessionStore';
import {
	DEFAULT_SSH_REDUCE_ENTRY_CAP_FRACTION,
	FILE_EXPLORER_MIN_ENTRIES,
} from '../../stores/settingsStore';

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
	/** Local file indexing ignore patterns (glob patterns) */
	localIgnorePatterns?: string[];
	/** Whether to honor local .gitignore files */
	localHonorGitignore?: boolean;
	/** Max recursion depth for the file tree scan (applies to local + remote) */
	fileExplorerMaxDepth?: number;
	/** Max file entries per scan before truncating (applies to local + remote) */
	fileExplorerMaxEntries?: number;
	/**
	 * When true, SSH-backed sessions use a fraction of {@link fileExplorerMaxEntries}
	 * as their cap. Disabled by default — local and remote share the same cap.
	 */
	sshReduceEntryCapEnabled?: boolean;
	/** Fraction (0–1) applied to the entry cap for SSH sessions when scaling is enabled. */
	sshReduceEntryCapFraction?: number;
}

/**
 * Return type for useFileTreeManagement hook.
 */
export interface UseFileTreeManagementReturn {
	/** Refresh file tree for a session and return detected changes */
	refreshFileTree: (
		sessionId: string,
		options?: { maxEntriesOverride?: number }
	) => Promise<FileTreeChanges | undefined>;
	/** Refresh both file tree and git state for a session */
	refreshGitFileState: (sessionId: string) => Promise<void>;
	/**
	 * Cancel the in-flight file tree load for a session. Aborts the underlying
	 * recursion so no further readDir calls (including SSH round-trips) are
	 * issued. Safe to call when no load is in flight.
	 */
	cancelFileTreeLoad: (sessionId: string) => void;
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
		localIgnorePatterns,
		localHonorGitignore,
		fileExplorerMaxDepth,
		fileExplorerMaxEntries,
		sshReduceEntryCapEnabled,
		sshReduceEntryCapFraction,
	} = deps;

	// Fall back to the canonical defaults from settingsStore when deps omit these values
	// (e.g. in tests that don't wire the full settings state through).
	const effectiveMaxDepth = fileExplorerMaxDepth ?? 5;
	const effectiveMaxEntries = fileExplorerMaxEntries ?? 100_000;
	const effectiveSshReduceEnabled = sshReduceEntryCapEnabled ?? false;
	const effectiveSshFraction = sshReduceEntryCapFraction ?? DEFAULT_SSH_REDUCE_ENTRY_CAP_FRACTION;

	/**
	 * Resolve the entry cap for a load. SSH sessions get a smaller cap when
	 * "Reduce entry cap on SSH remotes" is enabled — each remote dir is its own
	 * SSH round-trip, so a tighter cap returns sooner on large remote trees.
	 */
	const resolveMaxEntries = useCallback(
		(isSsh: boolean, baseCap: number): number => {
			if (!isSsh || !effectiveSshReduceEnabled) return baseCap;
			return Math.max(FILE_EXPLORER_MIN_ENTRIES, Math.floor(baseCap * effectiveSshFraction));
		},
		[effectiveSshReduceEnabled, effectiveSshFraction]
	);

	const fileTreeFilter = useFileExplorerStore((s) => s.fileTreeFilter);

	// Signal splash screen that the initial file tree load is done (success or error).
	// Only fires once — subsequent loads (refresh, session switch) don't re-signal.
	const initialFileTreeSignaled = useRef(false);
	const signalInitialFileTreeReady = useCallback(() => {
		if (!initialFileTreeSignaled.current) {
			initialFileTreeSignaled.current = true;
			useSessionStore.getState().setInitialFileTreeReady(true);
		}
	}, []);

	// Safety timeouts: dismiss splash screen even if file tree load is still pending.
	// Prevents SSH-configured sessions with unreachable hosts from blocking app startup
	// indefinitely (SSH connect timeout + retries can take 30-60s).
	// The file tree load continues in the background — the user just isn't blocked.
	//
	// Two layers:
	//   1. File-tree budget (5s after sessionsLoaded) — gives the tree load a full 5s
	//      without session restoration eating into the budget.
	//   2. Absolute backstop (8s from mount) — hard ceiling so the splash never blocks
	//      longer than 8s even if session restoration + file tree both stall.
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	useEffect(() => {
		if (!sessionsLoaded) return;
		const timer = setTimeout(() => {
			signalInitialFileTreeReady();
		}, 5000);
		return () => clearTimeout(timer);
	}, [sessionsLoaded, signalInitialFileTreeReady]);

	// Absolute backstop — starts at mount, not gated on anything.
	useEffect(() => {
		const timer = setTimeout(() => {
			signalInitialFileTreeReady();
		}, 8000);
		return () => clearTimeout(timer);
	}, [signalInitialFileTreeReady]);

	// Per-session sequence counters to discard stale file tree loads.
	// Keyed by sessionId so loads for different sessions don't cancel each other.
	// When a newer load starts for the same session, any in-flight load with an
	// older sequence number will discard its result instead of calling setSessions.
	const loadSeqMapRef = useRef<Map<string, number>>(new Map());

	// Per-session AbortControllers for the active file tree load. Used by
	// cancelFileTreeLoad to halt the recursive walk so no further readDir
	// calls (including SSH round-trips) are issued. Replaced on each new load.
	const loadAbortMapRef = useRef<Map<string, AbortController>>(new Map());

	/**
	 * Start a new abort-controlled load for a session. Aborts any prior
	 * in-flight load for the same session and returns a fresh signal.
	 */
	const beginAbortableLoad = useCallback((sessionId: string): AbortSignal => {
		const prior = loadAbortMapRef.current.get(sessionId);
		if (prior) prior.abort();
		const controller = new AbortController();
		loadAbortMapRef.current.set(sessionId, controller);
		return controller.signal;
	}, []);

	const cancelFileTreeLoad = useCallback(
		(sessionId: string) => {
			const controller = loadAbortMapRef.current.get(sessionId);
			if (!controller) return;
			controller.abort();
			loadAbortMapRef.current.delete(sessionId);
			// Clear the loading UI immediately so the user sees the cancel take effect
			// even if the in-flight readDir hasn't resolved yet.
			setSessions((prev) =>
				prev.map((s) =>
					s.id === sessionId
						? {
								...s,
								fileTreeLoading: false,
								fileTreeLoadingProgress: undefined,
							}
						: s
				)
			);
		},
		[setSessions]
	);

	/** Increment and return the next sequence number for a session. */
	const nextSeq = useCallback((sessionId: string): number => {
		const seq = (loadSeqMapRef.current.get(sessionId) || 0) + 1;
		loadSeqMapRef.current.set(sessionId, seq);
		return seq;
	}, []);

	/** Check if a sequence number is stale (a newer load has started for this session). */
	const isStale = useCallback((sessionId: string, seq: number): boolean => {
		return seq !== loadSeqMapRef.current.get(sessionId);
	}, []);

	// Build SSH context options from settings
	const sshContextOptions: SshContextOptions = useMemo(
		() => ({
			ignorePatterns: sshRemoteIgnorePatterns,
			honorGitignore: sshRemoteHonorGitignore,
		}),
		[sshRemoteIgnorePatterns, sshRemoteHonorGitignore]
	);

	// Build local file tree options from settings
	const localOptions: LocalFileTreeOptions | undefined = useMemo(
		() =>
			localIgnorePatterns || localHonorGitignore !== undefined
				? { ignorePatterns: localIgnorePatterns, honorGitignore: localHonorGitignore }
				: undefined,
		[localIgnorePatterns, localHonorGitignore]
	);

	/**
	 * Refresh file tree for a session and return the changes detected.
	 * Uses sessionsRef to avoid dependency on sessions state (prevents timer reset on every session change).
	 * Passes SSH context for remote sessions to enable remote file operations (Phase 2+).
	 */
	const refreshFileTree = useCallback(
		async (
			sessionId: string,
			options?: { maxEntriesOverride?: number }
		): Promise<FileTreeChanges | undefined> => {
			const seq = nextSeq(sessionId);
			// Use sessionsRef to avoid dependency on sessions state (prevents timer reset on every session change)
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) return undefined;

			// Extract SSH context for remote file operations (with ignore patterns)
			const sshContext = getSshContext(session, sshContextOptions);

			// Use projectRoot for file tree (consistent with Files tab header)
			// This ensures the file tree always shows the agent's working directory, not wherever cd'd to
			const treeRoot = session.projectRoot || session.cwd;

			// An explicit override (e.g. "Load all") bypasses SSH scaling — the user
			// has opted into a larger scan and we shouldn't second-guess them.
			const maxEntriesForRefresh =
				options?.maxEntriesOverride ?? resolveMaxEntries(!!sshContext, effectiveMaxEntries);

			try {
				// Fire stats independently — update asynchronously without blocking tree refresh.
				window.maestro.fs
					.directorySize(
						treeRoot,
						sshContext?.sshRemoteId,
						localOptions?.ignorePatterns,
						localOptions?.honorGitignore
					)
					.then((stats) => {
						if (isStale(sessionId, seq)) return;
						setSessions((prev) =>
							prev.map((s) =>
								s.id === sessionId
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
					.catch((err) => {
						logger.warn('directorySize failed during refresh (non-fatal)', 'FileTreeManagement', {
							error: err?.message || 'Unknown error',
						});
					});

				const loadResult = await loadFileTree(
					treeRoot,
					effectiveMaxDepth,
					0,
					sshContext,
					undefined,
					localOptions,
					maxEntriesForRefresh
				);

				// Discard if a newer load started for this session while we were awaiting
				if (isStale(sessionId, seq)) return undefined;

				const oldTree = session.fileTree || [];
				const changes = compareFileTrees(oldTree, loadResult.tree);

				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									fileTree: loadResult.tree,
									fileTreeError: undefined,
									fileTreeTruncated: loadResult.truncated,
									fileTreeLoadedCap: maxEntriesForRefresh,
								}
							: s
					)
				);

				return changes;
			} catch (error) {
				// Refresh failed — log it but preserve the existing file tree.
				// A transient SSH failure shouldn't wipe out a working tree.
				const errorMsg = (error as Error)?.message || 'Unknown error';
				logger.error('File tree refresh error', 'FileTreeManagement', { error: errorMsg });
				// Surface the current failure instead of leaving whatever stale
				// error message was sitting in state (which may be from an
				// outdated code path and mislead the user about the real cause).
				const sessionNow = sessionsRef.current.find((s) => s.id === sessionId);
				const hasUsableTree = !!sessionNow?.fileTree?.length;
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									fileTreeError: hasUsableTree
										? undefined
										: `Cannot access directory: ${treeRoot}\n${errorMsg}`,
								}
							: s
					)
				);
				return undefined;
			}
		},
		[
			sessionsRef,
			setSessions,
			sshContextOptions,
			localOptions,
			nextSeq,
			isStale,
			effectiveMaxDepth,
			effectiveMaxEntries,
			resolveMaxEntries,
		]
	);

	/**
	 * Refresh both file tree and git state for a session.
	 * Loads file tree, checks git repo status, and fetches branches/tags if applicable.
	 * Passes SSH context for remote sessions to enable remote operations (Phase 2+).
	 */
	const refreshGitFileState = useCallback(
		async (sessionId: string) => {
			const seq = nextSeq(sessionId);
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
				// Fire stats independently — update asynchronously without blocking tree/git refresh.
				window.maestro.fs
					.directorySize(
						treeRoot,
						sshContext?.sshRemoteId,
						localOptions?.ignorePatterns,
						localOptions?.honorGitignore
					)
					.then((stats) => {
						if (isStale(sessionId, seq)) return;
						setSessions((prev) =>
							prev.map((s) =>
								s.id === sessionId
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
					.catch((err) => {
						logger.warn(
							'directorySize failed during git refresh (non-fatal)',
							'FileTreeManagement',
							{
								error: err?.message || 'Unknown error',
							}
						);
					});

				const maxEntriesForRefresh = resolveMaxEntries(!!sshContext, effectiveMaxEntries);

				// Refresh file tree and git repo status in parallel
				const [loadResult, isGitRepo] = await Promise.all([
					loadFileTree(
						treeRoot,
						effectiveMaxDepth,
						0,
						sshContext,
						undefined,
						localOptions,
						maxEntriesForRefresh
					),
					gitService.isRepo(gitRoot, sshContext?.sshRemoteId),
				]);

				// Discard if a newer load started for this session while we were awaiting
				if (isStale(sessionId, seq)) return;

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

				// Re-check after additional awaits (branches/tags fetch)
				if (isStale(sessionId, seq)) return;

				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									fileTree: loadResult.tree,
									fileTreeError: undefined,
									fileTreeTruncated: loadResult.truncated,
									fileTreeLoadedCap: maxEntriesForRefresh,
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
				// Refresh failed — log it but preserve the existing file tree.
				// A transient SSH failure shouldn't wipe out a working tree.
				logger.error('Git/file state refresh error', 'FileTreeManagement', {
					error: (error as Error)?.message || 'Unknown error',
				});
			}
		},
		[
			sessions,
			setSessions,
			rightPanelRef,
			sshContextOptions,
			localOptions,
			nextSeq,
			isStale,
			effectiveMaxDepth,
			effectiveMaxEntries,
			resolveMaxEntries,
		]
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
		const session = activeSession;
		if (!session) return;

		// Only load if file tree is empty, not already loading, and hasn't been loaded yet.
		// fileTreeStats is set after successful load, so we use it to detect "loaded but empty".
		// We intentionally do NOT gate on a residual `fileTreeError` here: if an old error was
		// restored from persistence or left over from a previous failed load, the auto-loader
		// should get a fresh attempt so the current code path can try (and either clear or
		// update the error). Otherwise a stale error permanently blocks the panel.
		const hasLoadedOnce = session.fileTreeStats !== undefined;
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

			// Capture session.id for use in async callbacks to avoid stale closure.
			// activeSessionId may change if the user switches sessions while loading,
			// but session.id is stable and always refers to the session we started loading for.
			const sessionId = session.id;

			// Mark as loading before starting
			setSessions((prev) =>
				prev.map((s) =>
					s.id === sessionId
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
						s.id === sessionId
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

			// Increment per-session load sequence so concurrent loads can detect staleness
			const seq = nextSeq(sessionId);

			// Begin a fresh abort-controlled load (cancels any prior in-flight load).
			const abortSignal = beginAbortableLoad(sessionId);

			// For SSH sessions, fire a shallow load (depth 1) first so the root-level
			// tree renders almost instantly (single round-trip), then backfill with
			// the full recursive walk. Local sessions skip the shallow pass since
			// local readdir is fast enough that the overhead isn't worth it.
			if (sshContext) {
				// Shallow pass ignores the entry cap — the whole point is to render
				// the top-level dir fast. The full pass below honors the cap.
				loadFileTree(
					treeRoot,
					1,
					0,
					sshContext,
					undefined,
					localOptions,
					Number.POSITIVE_INFINITY,
					abortSignal
				)
					.then((shallowResult) => {
						if (isStale(sessionId, seq)) return;
						setSessions((prev) =>
							prev.map((s) =>
								s.id === sessionId && s.fileTreeLoading
									? {
											...s,
											fileTree: shallowResult.tree,
											fileTreeError: undefined,
											fileTreeRetryAt: undefined,
										}
									: s
							)
						);
						signalInitialFileTreeReady();
					})
					.catch(() => {
						// Shallow load failed or was aborted — full load handles below
					});
			}

			const maxEntriesForLoad = resolveMaxEntries(!!sshContext, effectiveMaxEntries);

			// Full recursive tree load (with progress callback for SSH)
			const treePromise = sshContext
				? loadFileTree(
						treeRoot,
						effectiveMaxDepth,
						0,
						sshContext,
						onProgress,
						localOptions,
						maxEntriesForLoad,
						abortSignal
					)
				: loadFileTree(
						treeRoot,
						effectiveMaxDepth,
						0,
						sshContext,
						undefined,
						localOptions,
						maxEntriesForLoad,
						abortSignal
					);

			// Fetch stats independently — a directorySize failure (e.g., `du` timeout
			// on large repos over SSH) should not prevent the file tree from loading.
			// Stats update the UI asynchronously after the tree is already displayed.
			window.maestro.fs
				.directorySize(
					treeRoot,
					sshContext?.sshRemoteId,
					localOptions?.ignorePatterns,
					localOptions?.honorGitignore
				)
				.then((stats) => {
					if (isStale(sessionId, seq)) return;
					setSessions((prev) =>
						prev.map((s) =>
							s.id === sessionId
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
				.catch((err) => {
					logger.warn('directorySize failed (non-fatal)', 'FileTreeManagement', {
						error: err?.message || 'Unknown error',
					});
				});

			treePromise
				.then((loadResult) => {
					// Discard if a newer load started for this session while we were awaiting
					if (isStale(sessionId, seq)) {
						// Reset loading state so this session can retry later
						setSessions((prev) =>
							prev.map((s) =>
								s.id === sessionId
									? { ...s, fileTreeLoading: false, fileTreeLoadingProgress: undefined }
									: s
							)
						);
						return;
					}

					setSessions((prev) =>
						prev.map((s) =>
							s.id === sessionId
								? {
										...s,
										fileTree: loadResult.tree,
										fileTreeTruncated: loadResult.truncated,
										fileTreeLoadedCap: maxEntriesForLoad,
										fileTreeError: undefined,
										fileTreeRetryAt: undefined,
										fileTreeLoading: false,
										fileTreeLoadingProgress: undefined,
									}
								: s
						)
					);

					signalInitialFileTreeReady();
				})
				.catch((error) => {
					// Ignore errors from stale loads — a newer load is in progress
					if (isStale(sessionId, seq)) {
						setSessions((prev) =>
							prev.map((s) =>
								s.id === sessionId
									? { ...s, fileTreeLoading: false, fileTreeLoadingProgress: undefined }
									: s
							)
						);
						return;
					}

					// User cancelled — clear loading state but don't surface an error.
					// cancelFileTreeLoad already cleared loading UI; this just guards against
					// the race where the load completes before the cancel state-write lands.
					if (error instanceof FileTreeAbortError) {
						setSessions((prev) =>
							prev.map((s) =>
								s.id === sessionId
									? { ...s, fileTreeLoading: false, fileTreeLoadingProgress: undefined }
									: s
							)
						);
						signalInitialFileTreeReady();
						return;
					}

					logger.error('File tree error', 'FileTreeManagement', {
						error: error?.message || 'Unknown error',
					});
					const errorMsg = error?.message || 'Unknown error';
					setSessions((prev) =>
						prev.map((s) =>
							s.id === sessionId
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

					signalInitialFileTreeReady();
				});
		}
	}, [
		activeSession,
		setSessions,
		sshContextOptions,
		localOptions,
		nextSeq,
		isStale,
		effectiveMaxDepth,
		effectiveMaxEntries,
		resolveMaxEntries,
		signalInitialFileTreeReady,
	]);

	// Cleanup retry timers on unmount
	useEffect(() => {
		return () => {
			retryTimersRef.current.forEach((timerId) => clearTimeout(timerId));
			retryTimersRef.current.clear();
		};
	}, []);

	// Re-scan file tree when local ignore patterns or honor-gitignore setting changes
	// for sessions that have already loaded their tree (the initial-load effect won't re-run
	// because hasLoadedOnce short-circuits it).
	const prevLocalOptionsRef = useRef(localOptions);
	useEffect(() => {
		if (prevLocalOptionsRef.current === localOptions) return;
		prevLocalOptionsRef.current = localOptions;

		if (!activeSessionId) return;
		const session = activeSession;
		if (!session || !session.fileTreeStats) return; // only re-scan already-loaded sessions

		refreshFileTree(activeSessionId);
	}, [activeSessionId, activeSession, localOptions, refreshFileTree]);

	/**
	 * Migration: Fetch stats for sessions that have a file tree but no stats.
	 * This handles sessions restored from before the stats feature was added (Dec 2025).
	 * Only fetches stats - doesn't re-fetch the file tree since it's already loaded.
	 */
	useEffect(() => {
		const session = activeSession;
		if (!session) return;

		// Only migrate if: has file tree, no stats, no error, not loading
		const needsStatsMigration =
			session.fileTree &&
			session.fileTree.length > 0 &&
			session.fileTreeStats === undefined &&
			!session.fileTreeError &&
			!session.fileTreeLoading;

		if (!needsStatsMigration) return;

		// Capture stable session ID for async callback (same stale closure fix as initial load)
		const sessionId = session.id;

		const sshContext = getSshContext(session);
		const treeRoot = session.projectRoot || session.cwd;

		// Fetch stats only (don't re-fetch tree)
		window.maestro.fs
			.directorySize(
				treeRoot,
				sshContext?.sshRemoteId,
				localOptions?.ignorePatterns,
				localOptions?.honorGitignore
			)
			.then((stats) => {
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
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
					sessionId,
				});
			});
	}, [activeSession, setSessions]);

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
		cancelFileTreeLoad,
		filteredFileTree,
	};
}
