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
import type { Session } from '../../types';
import { getModalActions, useModalStore } from '../../stores/modalStore';
import { useSessionStore, updateSessionWith } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { gitService } from '../../services/git';
import { notifyToast } from '../../stores/notificationStore';
import { buildWorktreeSession } from '../../utils/worktreeSession';
import { isRecentlyCreatedWorktreePath } from '../../utils/worktreeDedup';
import { logger } from '../../utils/logger';

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
	refreshWorktreeState: () => Promise<void>;
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

/** Normalize file path for comparison: convert backslashes to forward slashes, collapse duplicate slashes, and remove trailing slash. */
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

// buildWorktreeSession and BuildWorktreeSessionParams are imported from ../../utils/worktreeSession

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
				.filter((s) => s.worktreeConfig?.basePath)
				.map((s) => `${s.id}|${s.worktreeConfig!.basePath}|${s.worktreeConfig!.watchEnabled}`)
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
		updateSessionWith(sessionId, (s) => ({
			...s,
			worktreesExpanded: !(s.worktreesExpanded ?? true),
		}));
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
			useSessionStore.getState().updateSession(activeSession.id, { worktreeConfig: config });

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

						// Also check by path (normalize for comparison)
						const normalizedSubdirPath = normalizePath(subdir.path);
						const existingByPath = latestSessions.find(
							(s) => normalizePath(s.cwd) === normalizedSubdirPath
						);
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
						useSessionStore.getState().updateSession(activeSession.id, { worktreesExpanded: true });
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
				logger.error('Failed to scan for worktrees:', undefined, err);
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

			// Mark path BEFORE creating on disk so the file watcher never races ahead of the ref.
			// Without this, a slow fetchGitInfo (>500ms debounce) lets the chokidar event fire while
			// the ref is still empty, causing a duplicate session from the watcher.
			const normalizedCreatedPath = normalizePath(worktreePath);
			recentlyCreatedWorktreePathsRef.current.add(normalizedCreatedPath);
			setTimeout(
				() => recentlyCreatedWorktreePathsRef.current.delete(normalizedCreatedPath),
				10000
			);

			try {
				// Create the worktree via git (pass SSH remote ID for remote sessions)
				const result = await window.maestro.git.worktreeSetup(
					activeSession.cwd,
					worktreePath,
					branchName,
					sshRemoteId
				);

				if (!result.success) {
					// Creation failed — remove from ref so the path isn't permanently blocked
					recentlyCreatedWorktreePathsRef.current.delete(normalizedCreatedPath);
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

				// Single setSessions call: add child + expand parent (avoids transient state + extra IPC write)
				useSessionStore
					.getState()
					.setSessions((prev) => [
						...prev.map((s) => (s.id === activeSession.id ? { ...s, worktreesExpanded: true } : s)),
						worktreeSession,
					]);

				// Auto-focus the new worktree session
				useSessionStore.getState().setActiveSessionId(worktreeSession.id);

				notifyToast({
					type: 'success',
					title: 'Worktree Created',
					message: branchName,
				});
			} catch (err) {
				recentlyCreatedWorktreePathsRef.current.delete(normalizedCreatedPath);
				logger.error('[WorktreeConfig] Failed to create worktree:', undefined, err);
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

		// Mark path BEFORE creating on disk so the file watcher never races ahead of the ref.
		// Without this, a slow fetchGitInfo (>500ms debounce) lets the chokidar event fire while
		// the ref is still empty, causing a duplicate session from the watcher.
		const normalizedCreatedPath = normalizePath(worktreePath);
		recentlyCreatedWorktreePathsRef.current.add(normalizedCreatedPath);
		setTimeout(() => recentlyCreatedWorktreePathsRef.current.delete(normalizedCreatedPath), 10000);

		try {
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

			// Auto-focus the new worktree session
			useSessionStore.getState().setActiveSessionId(worktreeSession.id);

			notifyToast({
				type: 'success',
				title: 'Worktree Created',
				message: branchName,
			});
		} catch (err) {
			recentlyCreatedWorktreePathsRef.current.delete(normalizedCreatedPath);
			throw err;
		}
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

	// Shared scan logic: discovers new worktrees in configured basePath directories,
	// adds them as child sessions, and removes child sessions whose worktree directories
	// no longer exist on disk. Used by startup scan, visibility-change rescan, and manual refresh.
	const scanWorktreeConfigs = useCallback(async () => {
		const currentSessions = useSessionStore.getState().sessions;
		const { defaultSaveToHistory: savToHist, defaultShowThinking: showThink } =
			useSettingsStore.getState();

		const sessionsWithWorktreeConfig = currentSessions.filter(
			(s) => s.worktreeConfig?.basePath && !s.parentSessionId
		);

		if (sessionsWithWorktreeConfig.length === 0) return;

		const newWorktreeSessions: Session[] = [];
		const staleSessionIds: string[] = [];

		for (const parentSession of sessionsWithWorktreeConfig) {
			try {
				const sshRemoteId = getSshRemoteId(parentSession);
				const scanResult = await window.maestro.git.scanWorktreeDirectory(
					parentSession.worktreeConfig!.basePath,
					sshRemoteId
				);
				const { gitSubdirs, scanFailed } = scanResult;

				// Detect additions
				for (const subdir of gitSubdirs) {
					if (isSkippableBranch(subdir.branch)) continue;

					const normalizedSubdirPath = normalizePath(subdir.path);
					const latestSessions = useSessionStore.getState().sessions;
					const existingSession = latestSessions.find((s) => {
						const normalizedCwd = normalizePath(s.cwd);
						return (
							normalizedCwd === normalizedSubdirPath ||
							(s.parentSessionId === parentSession.id && s.worktreeBranch === subdir.branch)
						);
					});
					if (existingSession) continue;

					if (newWorktreeSessions.some((s) => normalizePath(s.cwd) === normalizedSubdirPath)) {
						continue;
					}

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

				// Detect removals: child sessions whose cwd is no longer in scan results.
				//
				// Guards against false-positive bulk removals (the bug that produced a
				// stack of "Worktree Removed" toasts on Linux/Windows when a transient
				// scan failure or symlinked basePath caused gitSubdirs to come back empty):
				//   1. If the scan flagged itself as failed, trust nothing — skip.
				//   2. If the scan returned zero subdirs while child sessions exist, treat
				//      that as suspicious and skip. A real "user removed every worktree"
				//      case is rare and will be surfaced one at a time via chokidar
				//      unlinkDir events instead.
				if (scanFailed) {
					logger.warn(
						`[WorktreeScan] Skipping removal phase for ${parentSession.worktreeConfig!.basePath} — scan failed`
					);
				} else {
					const diskPaths = new Set(gitSubdirs.map((d) => normalizePath(d.path)));
					const latestSessions = useSessionStore.getState().sessions;
					const childSessions = latestSessions.filter(
						(s) => s.parentSessionId === parentSession.id
					);
					if (gitSubdirs.length === 0 && childSessions.length > 0) {
						logger.warn(
							`[WorktreeScan] Skipping removal phase for ${parentSession.worktreeConfig!.basePath} — scan returned zero subdirs but ${childSessions.length} child sessions exist (suspicious)`
						);
					} else {
						for (const child of childSessions) {
							if (!diskPaths.has(normalizePath(child.cwd))) {
								staleSessionIds.push(child.id);
							}
						}
					}
				}
			} catch (err) {
				logger.error(
					`[WorktreeScan] Error scanning ${parentSession.worktreeConfig!.basePath}:`,
					undefined,
					err
				);
			}
		}

		if (newWorktreeSessions.length > 0) {
			useSessionStore.getState().setSessions((prev) => {
				const currentPaths = new Set(prev.map((s) => normalizePath(s.cwd)));
				const trulyNew = newWorktreeSessions.filter((s) => !currentPaths.has(normalizePath(s.cwd)));
				if (trulyNew.length === 0) return prev;
				return [...prev, ...trulyNew];
			});

			const parentIds = new Set(newWorktreeSessions.map((s) => s.parentSessionId));
			useSessionStore
				.getState()
				.setSessions((prev) =>
					prev.map((s) => (parentIds.has(s.id) ? { ...s, worktreesExpanded: true } : s))
				);
		}

		if (staleSessionIds.length > 0) {
			const staleSet = new Set(staleSessionIds);
			useSessionStore.getState().setSessions((prev) => {
				const removed = prev.filter((s) => staleSet.has(s.id));
				for (const s of removed) {
					notifyToast({
						type: 'info',
						title: 'Worktree Removed',
						message: s.worktreeBranch || s.name,
					});
				}
				return prev.filter((s) => !staleSet.has(s.id));
			});
		}
	}, []);

	// Effect 1: Startup worktree config scan
	// Restores worktree sub-agents after app restart by scanning configured directories
	useEffect(() => {
		if (!sessionsLoaded) return;

		const timer = setTimeout(scanWorktreeConfigs, 500);
		return () => clearTimeout(timer);
	}, [sessionsLoaded, scanWorktreeConfigs]);

	// Effect 2: File watcher + visibility-change rescan for worktree directories
	// Chokidar provides immediate detection; visibility-change rescan is a fallback
	// for worktrees created while the watcher was down or via external tools.
	useEffect(() => {
		const currentSessions = useSessionStore.getState().sessions;
		const watchableSessions = currentSessions.filter(
			(s) => s.worktreeConfig?.basePath && s.worktreeConfig?.watchEnabled
		);

		// TODO: Remove debug logging after worktree detection is confirmed working
		logger.warn(
			`[WT-DEBUG] Effect 2 running. watchableSessions=${watchableSessions.length}, key=${worktreeConfigKey}`
		);
		for (const s of watchableSessions) {
			logger.warn(`[WT-DEBUG]   → will watch: ${s.id} at ${s.worktreeConfig!.basePath}`);
		}

		// Start chokidar watchers, logging failures so they don't go silent
		for (const session of watchableSessions) {
			window.maestro.git
				.watchWorktreeDirectory(session.id, session.worktreeConfig!.basePath)
				.then((result) => {
					logger.warn(`[WT-DEBUG] watchWorktreeDirectory result:`, undefined, result);
					if (!result.success) {
						logger.error(
							`[WorktreeWatcher] Failed to start watcher for ${session.worktreeConfig!.basePath}:`,
							undefined,
							result.error
						);
					}
				})
				.catch((err) => {
					logger.error(`[WorktreeWatcher] IPC error starting watcher:`, undefined, err);
				});
		}

		// Set up listener for discovered worktrees (from chokidar)
		const cleanupListener = window.maestro.git.onWorktreeDiscovered(async (data) => {
			const { sessionId, worktree } = data;
			logger.warn(`[WT-DEBUG] onWorktreeDiscovered fired:`, undefined, { sessionId, worktree });

			if (
				recentlyCreatedWorktreePathsRef.current.has(normalizePath(worktree.path)) ||
				isRecentlyCreatedWorktreePath(worktree.path)
			) {
				logger.warn(`[WT-DEBUG] SKIPPED: recently created path`);
				return;
			}

			if (isSkippableBranch(worktree.branch)) {
				logger.warn(`[WT-DEBUG] SKIPPED: skippable branch ${worktree.branch}`);
				return;
			}

			const latestSessions = useSessionStore.getState().sessions;

			const parentSession = latestSessions.find((s) => s.id === sessionId);
			if (!parentSession) return;

			const normalizedWorktreePath = normalizePath(worktree.path);
			const existingSession = latestSessions.find((s) => {
				const normalizedCwd = normalizePath(s.cwd);
				return (
					normalizedCwd === normalizedWorktreePath ||
					(s.parentSessionId === sessionId && s.worktreeBranch === worktree.branch)
				);
			});
			if (existingSession) return;

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
				if (prev.some((s) => normalizePath(s.cwd) === normalizedWorktreePath)) return prev;
				return [...prev, worktreeSession];
			});

			useSessionStore.getState().updateSession(sessionId, { worktreesExpanded: true });

			notifyToast({
				type: 'success',
				title: 'New Worktree Discovered',
				message: worktree.branch || worktree.name,
			});
		});

		// Listen for worktree removals (e.g., git worktree remove from CLI)
		const cleanupRemovalListener = window.maestro.git.onWorktreeRemoved((data) => {
			const { sessionId, worktreePath } = data;
			logger.warn(`[WT-DEBUG] onWorktreeRemoved fired:`, undefined, { sessionId, worktreePath });

			const normalizedRemovedPath = normalizePath(worktreePath);

			useSessionStore.getState().setSessions((prev) => {
				const childToRemove = prev.find(
					(s) => s.parentSessionId === sessionId && normalizePath(s.cwd) === normalizedRemovedPath
				);
				if (!childToRemove) return prev;

				notifyToast({
					type: 'info',
					title: 'Worktree Removed',
					message: childToRemove.worktreeBranch || childToRemove.name,
				});

				return prev.filter((s) => s.id !== childToRemove.id);
			});
		});

		// Visibility-change rescan: detects worktrees created by CLI or external tools
		// while the app was in the background or if the chokidar watcher missed the event.
		const handleVisibilityChange = () => {
			if (!document.hidden && watchableSessions.length > 0) {
				scanWorktreeConfigs();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			cleanupListener();
			cleanupRemovalListener();
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			for (const session of watchableSessions) {
				window.maestro.git.unwatchWorktreeDirectory(session.id);
			}
		};
	}, [worktreeConfigKey, defaultSaveToHistory, scanWorktreeConfigs]);

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
							const normalizedSubdirPath2 = normalizePath(subdir.path);
							const existingSession = currentSessions2.find(
								(s) =>
									normalizePath(s.cwd) === normalizedSubdirPath2 ||
									normalizePath(s.projectRoot || '') === normalizedSubdirPath2
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
						logger.error(
							`[WorktreeScanner] Error scanning ${session.worktreeParentPath}:`,
							undefined,
							error
						);
					}
				}

				// Add all new sessions in a single update (uses functional update to get fresh state)
				if (newSessionsToAdd.length > 0) {
					useSessionStore.getState().setSessions((prev) => {
						// Double-check against current state to avoid duplicates
						const currentPaths = new Set(prev.map((s) => normalizePath(s.cwd)));
						const trulyNew = newSessionsToAdd.filter(
							(s) => !currentPaths.has(normalizePath(s.cwd))
						);
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
		refreshWorktreeState: scanWorktreeConfigs,
	};
}
