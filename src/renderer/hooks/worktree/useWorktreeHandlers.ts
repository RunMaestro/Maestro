/**
 * useWorktreeHandlers — extracted from App.tsx (Phase 2D)
 *
 * Owns all worktree-related handlers, effects, refs, and memoized values.
 * Reads from Zustand stores directly — no parameters needed.
 *
 * Handlers:
 *   - Modal open/close for worktree config, create, delete
 *   - Save/disable worktree config (scan + session creation)
 *   - Create/delete worktree sessions
 *   - Toggle worktree expansion in the left bar
 *
 * Effects:
 *   - Startup scan: restores worktree sub-agents from worktreeConfig on app load
 *   - File watcher: real-time detection of new worktrees via filesystem events
 *   - Legacy scanner: polls for worktrees using old worktreeParentPath model
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Session, AITab, ThinkingMode } from '../../types';
import { getModalActions, useModalStore } from '../../stores/modalStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { gitService } from '../../services/git';
import { notifyToast } from '../../stores/notificationStore';
import { generateId } from '../../utils/ids';

// ============================================================================
// Return type
// ============================================================================

export interface WorktreeHandlersReturn {
	handleOpenWorktreeConfig: () => void;
	handleQuickCreateWorktree: (session: Session) => void;
	handleOpenWorktreeConfigSession: (session: Session) => void;
	handleDeleteWorktreeSession: (session: Session) => void;
	handleToggleWorktreeExpanded: (sessionId: string) => void;
	handleCloseWorktreeConfigModal: () => void;
	handleSaveWorktreeConfig: (config: { basePath: string; watchEnabled: boolean }) => Promise<void>;
	handleDisableWorktreeConfig: () => void;
	handleCreateWorktreeFromConfig: (branchName: string, basePath: string) => Promise<void>;
	handleCloseCreateWorktreeModal: () => void;
	handleCreateWorktree: (branchName: string) => Promise<void>;
	handleCloseDeleteWorktreeModal: () => void;
	handleConfirmDeleteWorktree: () => void;
	handleConfirmAndDeleteWorktreeOnDisk: () => Promise<void>;
}

// ============================================================================
// Private helpers
// ============================================================================

/** Extract SSH remote ID from a session (checks both runtime and config). */
function getSshRemoteId(session: Session): string | undefined {
	return session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
}

/** Fetch git branches and tags for a path, with optional SSH remote support. */
async function fetchGitInfo(
	path: string,
	sshRemoteId?: string
): Promise<{
	gitBranches?: string[];
	gitTags?: string[];
	gitRefsCacheTime?: number;
}> {
	try {
		const [gitBranches, gitTags] = await Promise.all([
			gitService.getBranches(path, sshRemoteId),
			gitService.getTags(path, sshRemoteId),
		]);
		return { gitBranches, gitTags, gitRefsCacheTime: Date.now() };
	} catch {
		return {};
	}
}

/** Check if a branch name should be skipped (main, master, HEAD). */
function isSkippableBranch(branch: string | null | undefined): boolean {
	return branch === 'main' || branch === 'master' || branch === 'HEAD';
}

/**
 * Build a worktree Session object, consolidating the repeated construction
 * pattern (~60 lines each, repeated 5x in the original App.tsx).
 *
 * Two modes determined by the presence of `worktreeParentPath`:
 * - New model: sets `parentSessionId`, `worktreeBranch`, `customContextWindow`,
 *   `nudgeMessage`, `autoRunFolderPath`. Shell log says "Worktree Session Ready."
 *   `inputMode` derived from `toolType`.
 * - Legacy model: sets `worktreeParentPath` (no `parentSessionId`). Shell log says
 *   "Shell Session Ready." `inputMode` copied directly from parent. Does NOT set
 *   `customContextWindow`, `nudgeMessage`, `autoRunFolderPath`.
 */
interface BuildWorktreeSessionParams {
	parentSession: Session;
	path: string;
	branch?: string | null;
	name: string;
	gitBranches?: string[];
	gitTags?: string[];
	gitRefsCacheTime?: number;
	defaultSaveToHistory: boolean;
	defaultShowThinking: ThinkingMode;
	/** Legacy worktreeParentPath to inherit — presence triggers legacy mode. */
	worktreeParentPath?: string;
}

function buildWorktreeSession(params: BuildWorktreeSessionParams): Session {
	const newId = generateId();
	const initialTabId = generateId();
	const isLegacy = !!params.worktreeParentPath;

	const initialTab: AITab = {
		id: initialTabId,
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory: params.defaultSaveToHistory,
		showThinking: params.defaultShowThinking,
	};

	return {
		id: newId,
		name: params.name,
		groupId: params.parentSession.groupId,
		toolType: params.parentSession.toolType,
		state: 'idle',
		cwd: params.path,
		fullPath: params.path,
		projectRoot: params.path,
		isGitRepo: true,
		gitBranches: params.gitBranches,
		gitTags: params.gitTags,
		gitRefsCacheTime: params.gitRefsCacheTime,
		// New model: link to parent via parentSessionId
		// Legacy model: no parentSessionId (uses worktreeParentPath instead)
		parentSessionId: isLegacy ? undefined : params.parentSession.id,
		worktreeBranch: isLegacy ? undefined : params.branch || undefined,
		worktreeParentPath: params.worktreeParentPath,
		// Inherit SSH configuration from parent session
		sessionSshRemoteConfig: params.parentSession.sessionSshRemoteConfig,
		aiLogs: [],
		shellLogs: [
			{
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: isLegacy ? 'Shell Session Ready.' : 'Worktree Session Ready.',
			},
		],
		workLog: [],
		contextUsage: 0,
		// Legacy: inherits inputMode directly from parent
		// New model: derives from toolType
		inputMode: isLegacy
			? params.parentSession.inputMode
			: params.parentSession.toolType === 'terminal'
				? 'terminal'
				: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3000 + Math.floor(Math.random() * 100),
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: params.path,
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [initialTab],
		activeTabId: initialTabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: initialTabId }],
		unifiedClosedTabHistory: [],
		customPath: params.parentSession.customPath,
		customArgs: params.parentSession.customArgs,
		customEnvVars: params.parentSession.customEnvVars,
		customModel: params.parentSession.customModel,
		// New model inherits these; legacy does not
		customContextWindow: isLegacy ? undefined : params.parentSession.customContextWindow,
		nudgeMessage: isLegacy ? undefined : params.parentSession.nudgeMessage,
		autoRunFolderPath: isLegacy ? undefined : params.parentSession.autoRunFolderPath,
	} as Session;
}

// ============================================================================
// Hook
// ============================================================================

export function useWorktreeHandlers(): WorktreeHandlersReturn {
	// ---------------------------------------------------------------------------
	// Reactive subscriptions
	// ---------------------------------------------------------------------------
	// Full sessions array is needed here: worktreeConfigKey derives from all sessions'
	// worktreeConfig fields, and the git info effect iterates parent sessions. A narrower
	// selector would require a custom equality fn that's more complex than the current approach.
	const sessions = useSessionStore((s) => s.sessions);
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const defaultSaveToHistory = useSettingsStore((s) => s.defaultSaveToHistory);

	// ---------------------------------------------------------------------------
	// Refs
	// ---------------------------------------------------------------------------
	const recentlyCreatedWorktreePathsRef = useRef(new Set<string>());

	// ---------------------------------------------------------------------------
	// Memoized values
	// ---------------------------------------------------------------------------
	// Stable dependency key for the worktree file-watcher effect below — only re-runs
	// when a session's worktreeConfig actually changes (not on every sessions array mutation).
	// Uses | delimiter to avoid false collisions (session IDs are UUIDs, paths don't contain |).
	const worktreeConfigKey = useMemo(
		() =>
			sessions
				.map((s) => `${s.id}|${s.worktreeConfig?.basePath}|${s.worktreeConfig?.watchEnabled}`)
				.join('\n'),
		[sessions]
	);

	// Whether any sessions still use the legacy worktreeParentPath model (for legacy scanner effect).
	const hasLegacyWorktreeSessions = useMemo(
		() => sessions.some((s) => s.worktreeParentPath),
		[sessions]
	);

	// ---------------------------------------------------------------------------
	// Quick-access handlers
	// ---------------------------------------------------------------------------

	const handleOpenWorktreeConfig = useCallback(() => {
		getModalActions().setWorktreeConfigModalOpen(true);
	}, []);

	const handleQuickCreateWorktree = useCallback((session: Session) => {
		getModalActions().setCreateWorktreeSession(session);
	}, []);

	const handleOpenWorktreeConfigSession = useCallback((session: Session) => {
		useSessionStore.getState().setActiveSessionId(session.id);
		getModalActions().setWorktreeConfigModalOpen(true);
	}, []);

	const handleDeleteWorktreeSession = useCallback((session: Session) => {
		getModalActions().setDeleteWorktreeSession(session);
	}, []);

	const handleToggleWorktreeExpanded = useCallback((sessionId: string) => {
		useSessionStore
			.getState()
			.setSessions((prev) =>
				prev.map((s) =>
					s.id === sessionId ? { ...s, worktreesExpanded: !(s.worktreesExpanded ?? true) } : s
				)
			);
	}, []);

	// ---------------------------------------------------------------------------
	// Modal handlers
	// ---------------------------------------------------------------------------

	const handleCloseWorktreeConfigModal = useCallback(() => {
		getModalActions().setWorktreeConfigModalOpen(false);
	}, []);

	const handleSaveWorktreeConfig = useCallback(
		async (config: { basePath: string; watchEnabled: boolean }) => {
			const { sessions: currentSessions, activeSessionId } = useSessionStore.getState();
			const activeSession = currentSessions.find((s) => s.id === activeSessionId);
			if (!activeSession) return;
			const { defaultSaveToHistory: savToHist, defaultShowThinking: showThink } =
				useSettingsStore.getState();

			// Save the config first
			useSessionStore
				.getState()
				.setSessions((prev) =>
					prev.map((s) => (s.id === activeSession.id ? { ...s, worktreeConfig: config } : s))
				);

			// Scan for worktrees and create sub-agent sessions
			const parentSshRemoteId = getSshRemoteId(activeSession);
			try {
				const scanResult = await window.maestro.git.scanWorktreeDirectory(
					config.basePath,
					parentSshRemoteId
				);
				const { gitSubdirs } = scanResult;

				if (gitSubdirs.length > 0) {
					const newWorktreeSessions: Session[] = [];

					for (const subdir of gitSubdirs) {
						// Skip main/master/HEAD branches — they're typically the main repo
						if (isSkippableBranch(subdir.branch)) continue;

						// Check if session already exists (read latest state each iteration)
						const latestSessions = useSessionStore.getState().sessions;
						const existingByBranch = latestSessions.find(
							(s) => s.parentSessionId === activeSession.id && s.worktreeBranch === subdir.branch
						);
						if (existingByBranch) continue;

						// Also check by path
						const existingByPath = latestSessions.find((s) => s.cwd === subdir.path);
						if (existingByPath) continue;

						const gitInfo = await fetchGitInfo(subdir.path, parentSshRemoteId);

						newWorktreeSessions.push(
							buildWorktreeSession({
								parentSession: activeSession,
								path: subdir.path,
								branch: subdir.branch,
								name: subdir.branch || subdir.name,
								defaultSaveToHistory: savToHist,
								defaultShowThinking: showThink,
								...gitInfo,
							})
						);
					}

					if (newWorktreeSessions.length > 0) {
						useSessionStore.getState().setSessions((prev) => [...prev, ...newWorktreeSessions]);
						// Expand worktrees on parent
						useSessionStore
							.getState()
							.setSessions((prev) =>
								prev.map((s) => (s.id === activeSession.id ? { ...s, worktreesExpanded: true } : s))
							);
						notifyToast({
							type: 'success',
							title: 'Worktrees Discovered',
							message: `Found ${newWorktreeSessions.length} worktree sub-agent${
								newWorktreeSessions.length > 1 ? 's' : ''
							}`,
						});
					}
				}
			} catch (err) {
				console.error('Failed to scan for worktrees:', err);
			}
		},
		[]
	);

	const handleDisableWorktreeConfig = useCallback(() => {
		const { sessions: currentSessions, activeSessionId } = useSessionStore.getState();
		const activeSession = currentSessions.find((s) => s.id === activeSessionId);
		if (!activeSession) return;

		// Count worktree children that will be removed
		const worktreeChildCount = currentSessions.filter(
			(s) => s.parentSessionId === activeSession.id
		).length;

		useSessionStore.getState().setSessions((prev) =>
			prev
				// Remove all worktree children of this parent
				.filter((s) => s.parentSessionId !== activeSession.id)
				// Clear worktree config on the parent
				.map((s) =>
					s.id === activeSession.id
						? { ...s, worktreeConfig: undefined, worktreeParentPath: undefined }
						: s
				)
		);

		const childMessage =
			worktreeChildCount > 0
				? ` Removed ${worktreeChildCount} worktree sub-agent${worktreeChildCount > 1 ? 's' : ''}.`
				: '';

		notifyToast({
			type: 'success',
			title: 'Worktrees Disabled',
			message: `Worktree configuration cleared for this agent.${childMessage}`,
		});
	}, []);

	const handleCreateWorktreeFromConfig = useCallback(
		async (branchName: string, basePath: string) => {
			const { sessions: currentSessions, activeSessionId } = useSessionStore.getState();
			const activeSession = currentSessions.find((s) => s.id === activeSessionId);
			if (!activeSession || !basePath) {
				notifyToast({
					type: 'error',
					title: 'Error',
					message: 'No worktree directory configured',
				});
				return;
			}
			const { defaultSaveToHistory: savToHist, defaultShowThinking: showThink } =
				useSettingsStore.getState();

			const worktreePath = `${basePath}/${branchName}`;

			// Get SSH remote ID for remote worktree operations
			// Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
			// we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
			const sshRemoteId = getSshRemoteId(activeSession);

			try {
				// Create the worktree via git (pass SSH remote ID for remote sessions)
				const result = await window.maestro.git.worktreeSetup(
					activeSession.cwd,
					worktreePath,
					branchName,
					sshRemoteId
				);

				if (!result.success) {
					throw new Error(result.error || 'Failed to create worktree');
				}

				// Fetch git info for the worktree (pass SSH remote ID for remote sessions)
				const gitInfo = await fetchGitInfo(worktreePath, sshRemoteId);

				const worktreeSession = buildWorktreeSession({
					parentSession: activeSession,
					path: worktreePath,
					branch: branchName,
					name: branchName,
					defaultSaveToHistory: savToHist,
					defaultShowThinking: showThink,
					...gitInfo,
				});

				// Mark path so the file watcher discovery handler skips it
				recentlyCreatedWorktreePathsRef.current.add(worktreePath);
				setTimeout(() => recentlyCreatedWorktreePathsRef.current.delete(worktreePath), 10000);

				// Single setSessions call: add child + expand parent (avoids transient state + extra IPC write)
				useSessionStore
					.getState()
					.setSessions((prev) => [
						...prev.map((s) => (s.id === activeSession.id ? { ...s, worktreesExpanded: true } : s)),
						worktreeSession,
					]);

				notifyToast({
					type: 'success',
					title: 'Worktree Created',
					message: branchName,
				});
			} catch (err) {
				console.error('[WorktreeConfig] Failed to create worktree:', err);
				notifyToast({
					type: 'error',
					title: 'Failed to Create Worktree',
					message: err instanceof Error ? err.message : String(err),
				});
				throw err; // Re-throw so the modal can show the error
			}
		},
		[]
	);

	const handleCloseCreateWorktreeModal = useCallback(() => {
		getModalActions().setCreateWorktreeModalOpen(false);
		getModalActions().setCreateWorktreeSession(null);
	}, []);

	const handleCreateWorktree = useCallback(async (branchName: string) => {
		const createWtSession = useModalStore.getState().getData('createWorktree')?.session ?? null;
		if (!createWtSession) return;
		const { defaultSaveToHistory: savToHist, defaultShowThinking: showThink } =
			useSettingsStore.getState();

		// Determine base path: use configured path or default to parent directory
		const basePath =
			createWtSession.worktreeConfig?.basePath ||
			createWtSession.cwd.replace(/\/[^/]+$/, '') + '/worktrees';

		const worktreePath = `${basePath}/${branchName}`;

		// Get SSH remote ID for remote worktree operations
		// Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH sessions,
		// we must fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH Remote Sessions".
		const sshRemoteId = getSshRemoteId(createWtSession);

		// Create the worktree via git (pass SSH remote ID for remote sessions)
		const result = await window.maestro.git.worktreeSetup(
			createWtSession.cwd,
			worktreePath,
			branchName,
			sshRemoteId
		);

		if (!result.success) {
			throw new Error(result.error || 'Failed to create worktree');
		}

		// Fetch git info for the worktree (pass SSH remote ID for remote sessions)
		const gitInfo = await fetchGitInfo(worktreePath, sshRemoteId);

		const worktreeSession = buildWorktreeSession({
			parentSession: createWtSession,
			path: worktreePath,
			branch: branchName,
			name: branchName,
			defaultSaveToHistory: savToHist,
			defaultShowThinking: showThink,
			...gitInfo,
		});

		// Mark path so the file watcher discovery handler skips it
		recentlyCreatedWorktreePathsRef.current.add(worktreePath);
		setTimeout(() => recentlyCreatedWorktreePathsRef.current.delete(worktreePath), 10000);

		// Single setSessions call: add child + expand parent + save config (avoids transient state + extra IPC writes)
		const needsConfig = !createWtSession.worktreeConfig?.basePath;
		useSessionStore.getState().setSessions((prev) => [
			...prev.map((s) => {
				if (s.id !== createWtSession.id) return s;
				const updates: Partial<Session> = { worktreesExpanded: true };
				if (needsConfig) {
					updates.worktreeConfig = { basePath, watchEnabled: true };
				}
				return { ...s, ...updates };
			}),
			worktreeSession,
		]);

		notifyToast({
			type: 'success',
			title: 'Worktree Created',
			message: branchName,
		});
	}, []);

	const handleCloseDeleteWorktreeModal = useCallback(() => {
		getModalActions().setDeleteWorktreeModalOpen(false);
		getModalActions().setDeleteWorktreeSession(null);
	}, []);

	const handleConfirmDeleteWorktree = useCallback(() => {
		const deleteWtSession = useModalStore.getState().getData('deleteWorktree')?.session ?? null;
		if (!deleteWtSession) return;
		// Remove the session but keep the worktree on disk
		useSessionStore
			.getState()
			.setSessions((prev) => prev.filter((s) => s.id !== deleteWtSession.id));
	}, []);

	const handleConfirmAndDeleteWorktreeOnDisk = useCallback(async () => {
		const deleteWtSession = useModalStore.getState().getData('deleteWorktree')?.session ?? null;
		if (!deleteWtSession) return;
		// Remove the session AND delete the worktree from disk
		const result = await window.maestro.git.removeWorktree(deleteWtSession.cwd, true);
		if (!result.success) {
			throw new Error(result.error || 'Failed to remove worktree');
		}
		useSessionStore
			.getState()
			.setSessions((prev) => prev.filter((s) => s.id !== deleteWtSession.id));
	}, []);

	// ---------------------------------------------------------------------------
	// Effects
	// ---------------------------------------------------------------------------

	// Effect 1: Startup worktree config scan
	// Restores worktree sub-agents after app restart by scanning configured directories
	useEffect(() => {
		if (!sessionsLoaded) return;

		const scanWorktreeConfigsOnStartup = async () => {
			const currentSessions = useSessionStore.getState().sessions;
			const { defaultSaveToHistory: savToHist, defaultShowThinking: showThink } =
				useSettingsStore.getState();

			// Find sessions that have worktreeConfig with basePath (only parent sessions)
			const sessionsWithWorktreeConfig = currentSessions.filter(
				(s) => s.worktreeConfig?.basePath && !s.parentSessionId
			);

			if (sessionsWithWorktreeConfig.length === 0) return;

			const newWorktreeSessions: Session[] = [];

			for (const parentSession of sessionsWithWorktreeConfig) {
				try {
					// Get SSH remote ID for remote git operations
					const sshRemoteId = getSshRemoteId(parentSession);
					const scanResult = await window.maestro.git.scanWorktreeDirectory(
						parentSession.worktreeConfig!.basePath,
						sshRemoteId
					);
					const { gitSubdirs } = scanResult;

					for (const subdir of gitSubdirs) {
						// Skip main/master/HEAD branches
						if (isSkippableBranch(subdir.branch)) continue;

						// Check if a session already exists for this worktree
						// Normalize paths for comparison (remove trailing slashes)
						const normalizedSubdirPath = subdir.path.replace(/\/+$/, '');
						const existingSession = currentSessions.find((s) => {
							const normalizedCwd = s.cwd.replace(/\/+$/, '');
							// Check if same path (regardless of parent) or same branch under same parent
							return (
								normalizedCwd === normalizedSubdirPath ||
								(s.parentSessionId === parentSession.id && s.worktreeBranch === subdir.branch)
							);
						});
						if (existingSession) continue;

						// Also check in sessions we're about to add
						if (
							newWorktreeSessions.some((s) => s.cwd.replace(/\/+$/, '') === normalizedSubdirPath)
						) {
							continue;
						}

						// Fetch git info (via SSH for remote sessions)
						const gitInfo = await fetchGitInfo(subdir.path, sshRemoteId);

						newWorktreeSessions.push(
							buildWorktreeSession({
								parentSession,
								path: subdir.path,
								branch: subdir.branch,
								name: subdir.branch || subdir.name,
								defaultSaveToHistory: savToHist,
								defaultShowThinking: showThink,
								...gitInfo,
							})
						);
					}
				} catch (err) {
					console.error(
						`[WorktreeStartup] Error scanning ${parentSession.worktreeConfig!.basePath}:`,
						err
					);
				}
			}

			if (newWorktreeSessions.length > 0) {
				useSessionStore.getState().setSessions((prev) => {
					// Double-check to avoid duplicates
					const currentPaths = new Set(prev.map((s) => s.cwd));
					const trulyNew = newWorktreeSessions.filter((s) => !currentPaths.has(s.cwd));
					if (trulyNew.length === 0) return prev;
					return [...prev, ...trulyNew];
				});

				// Expand worktrees on parent sessions
				const parentIds = new Set(newWorktreeSessions.map((s) => s.parentSessionId));
				useSessionStore
					.getState()
					.setSessions((prev) =>
						prev.map((s) => (parentIds.has(s.id) ? { ...s, worktreesExpanded: true } : s))
					);
			}
		};

		// Run once on startup with a small delay to let UI settle
		const timer = setTimeout(scanWorktreeConfigsOnStartup, 500);
		return () => clearTimeout(timer);
	}, [sessionsLoaded]); // Only run once when sessions are loaded

	// Effect 2: File watcher for worktree directories — provides immediate detection
	// This is more efficient than polling and gives real-time results
	useEffect(() => {
		// Find sessions that have worktreeConfig with watchEnabled
		const currentSessions = useSessionStore.getState().sessions;
		const watchableSessions = currentSessions.filter(
			(s) => s.worktreeConfig?.basePath && s.worktreeConfig?.watchEnabled
		);

		// Start watchers for each session
		for (const session of watchableSessions) {
			window.maestro.git.watchWorktreeDirectory(session.id, session.worktreeConfig!.basePath);
		}

		// Set up listener for discovered worktrees
		const cleanup = window.maestro.git.onWorktreeDiscovered(async (data) => {
			const { sessionId, worktree } = data;

			// Skip worktrees that were just manually created (prevents duplicate UI entries)
			if (recentlyCreatedWorktreePathsRef.current.has(worktree.path)) {
				return;
			}

			// Skip main/master/HEAD branches (already filtered by main process, but double-check)
			if (isSkippableBranch(worktree.branch)) {
				return;
			}

			// Get current sessions to check for duplicates
			const latestSessions = useSessionStore.getState().sessions;

			// Find the parent session
			const parentSession = latestSessions.find((s) => s.id === sessionId);
			if (!parentSession) return;

			// Check if session already exists for this worktree
			// Normalize paths for comparison (remove trailing slashes)
			const normalizedWorktreePath = worktree.path.replace(/\/+$/, '');
			const existingSession = latestSessions.find((s) => {
				const normalizedCwd = s.cwd.replace(/\/+$/, '');
				// Check if same path (regardless of parent) or same branch under same parent
				return (
					normalizedCwd === normalizedWorktreePath ||
					(s.parentSessionId === sessionId && s.worktreeBranch === worktree.branch)
				);
			});
			if (existingSession) return;

			// Create new worktree session
			const { defaultSaveToHistory: savToHist, defaultShowThinking: showThink } =
				useSettingsStore.getState();
			const sshRemoteId = getSshRemoteId(parentSession);
			const gitInfo = await fetchGitInfo(worktree.path, sshRemoteId);

			const worktreeSession = buildWorktreeSession({
				parentSession,
				path: worktree.path,
				branch: worktree.branch,
				name: worktree.branch || worktree.name,
				defaultSaveToHistory: savToHist,
				defaultShowThinking: showThink,
				...gitInfo,
			});

			useSessionStore.getState().setSessions((prev) => {
				// Double-check to avoid duplicates
				if (prev.some((s) => s.cwd === worktree.path)) return prev;
				return [...prev, worktreeSession];
			});

			// Expand parent's worktrees
			useSessionStore
				.getState()
				.setSessions((prev) =>
					prev.map((s) => (s.id === sessionId ? { ...s, worktreesExpanded: true } : s))
				);

			notifyToast({
				type: 'success',
				title: 'New Worktree Discovered',
				message: worktree.branch || worktree.name,
			});
		});

		// Cleanup: stop watchers and remove listener
		return () => {
			cleanup();
			for (const session of watchableSessions) {
				window.maestro.git.unwatchWorktreeDirectory(session.id);
			}
		};
	}, [
		// Re-run when worktreeConfig changes on any session
		worktreeConfigKey,
		defaultSaveToHistory,
	]);

	// Effect 3: Legacy scanner for sessions using old worktreeParentPath
	// TODO: Remove after migration to new parent/child model (use worktreeConfig with file watchers instead)
	// PERFORMANCE: Only scan on app focus (visibility change) instead of continuous polling
	// This avoids blocking the main thread every 30 seconds during active use
	useEffect(() => {
		if (!hasLegacyWorktreeSessions) return;

		// Track if we're currently scanning to avoid overlapping scans
		let isScanning = false;

		const scanWorktreeParents = async () => {
			if (isScanning) return;
			isScanning = true;

			try {
				// Find sessions that have worktreeParentPath set (legacy model)
				const latestSessions = useSessionStore.getState().sessions;
				const { defaultSaveToHistory: savToHist, defaultShowThinking: showThink } =
					useSettingsStore.getState();
				const worktreeParentSessions = latestSessions.filter((s) => s.worktreeParentPath);
				if (worktreeParentSessions.length === 0) return;

				// Collect all new sessions to add in a single batch (avoids stale closure issues)
				const newSessionsToAdd: Session[] = [];
				// Track paths we're about to add to avoid duplicates within this scan
				const pathsBeingAdded = new Set<string>();

				for (const session of worktreeParentSessions) {
					try {
						// Get SSH remote ID for parent session (check both runtime and config)
						const parentSshRemoteId = getSshRemoteId(session);
						const result = await window.maestro.git.scanWorktreeDirectory(
							session.worktreeParentPath!,
							parentSshRemoteId
						);
						const { gitSubdirs } = result;

						for (const subdir of gitSubdirs) {
							// Skip if this path was manually removed by the user
							const currentRemovedPaths = useSessionStore.getState().removedWorktreePaths;
							if (currentRemovedPaths.has(subdir.path)) {
								continue;
							}

							// Skip if session already exists (check current sessions)
							const currentSessions2 = useSessionStore.getState().sessions;
							const existingSession = currentSessions2.find(
								(s) => s.cwd === subdir.path || s.projectRoot === subdir.path
							);
							if (existingSession) {
								continue;
							}

							// Skip if we're already adding this path in this scan batch
							if (pathsBeingAdded.has(subdir.path)) {
								continue;
							}

							// Found a new worktree — prepare session creation
							pathsBeingAdded.add(subdir.path);

							const sessionName = subdir.branch ? `${subdir.name} (${subdir.branch})` : subdir.name;

							// Fetch git info (with SSH support)
							const gitInfo = await fetchGitInfo(subdir.path, parentSshRemoteId);

							newSessionsToAdd.push(
								buildWorktreeSession({
									parentSession: session,
									path: subdir.path,
									branch: subdir.branch,
									name: sessionName,
									defaultSaveToHistory: savToHist,
									defaultShowThinking: showThink,
									worktreeParentPath: session.worktreeParentPath,
									...gitInfo,
								})
							);
						}
					} catch (error) {
						console.error(`[WorktreeScanner] Error scanning ${session.worktreeParentPath}:`, error);
					}
				}

				// Add all new sessions in a single update (uses functional update to get fresh state)
				if (newSessionsToAdd.length > 0) {
					useSessionStore.getState().setSessions((prev) => {
						// Double-check against current state to avoid duplicates
						const currentPaths = new Set(prev.map((s) => s.cwd));
						const trulyNew = newSessionsToAdd.filter((s) => !currentPaths.has(s.cwd));
						if (trulyNew.length === 0) return prev;
						return [...prev, ...trulyNew];
					});

					for (const session of newSessionsToAdd) {
						notifyToast({
							type: 'success',
							title: 'New Worktree Discovered',
							message: session.name,
						});
					}
				}
			} finally {
				isScanning = false;
			}
		};

		// Scan once on mount
		scanWorktreeParents();

		// Scan when app regains focus (visibility change) instead of polling
		// This is much more efficient — only scans when user returns to app
		const handleVisibilityChange = () => {
			if (!document.hidden) {
				scanWorktreeParents();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [hasLegacyWorktreeSessions, defaultSaveToHistory]);

	// ---------------------------------------------------------------------------
	// Return
	// ---------------------------------------------------------------------------

	return {
		handleOpenWorktreeConfig,
		handleQuickCreateWorktree,
		handleOpenWorktreeConfigSession,
		handleDeleteWorktreeSession,
		handleToggleWorktreeExpanded,
		handleCloseWorktreeConfigModal,
		handleSaveWorktreeConfig,
		handleDisableWorktreeConfig,
		handleCreateWorktreeFromConfig,
		handleCloseCreateWorktreeModal,
		handleCreateWorktree,
		handleCloseDeleteWorktreeModal,
		handleConfirmDeleteWorktree,
		handleConfirmAndDeleteWorktreeOnDisk,
	};
}
