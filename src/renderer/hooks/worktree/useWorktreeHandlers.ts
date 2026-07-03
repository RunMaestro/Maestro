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
import {
	isRecentlyCreatedWorktreePath,
	normalizePath,
	sessionMatchesWorktreeRoot,
} from '../../utils/worktreeDedup';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

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
	handleCreateWorktree: (branchName: string, baseBranch?: string) => Promise<void>;
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

/**
 * Resolve the canonical main-repo root for a path, normalized for comparison.
 *
 * Uses `worktreeInfo` (not `getRepoRoot`) so that when the path is itself a
 * worktree, we get the *main* repo root (parent of `--git-common-dir`) rather
 * than the worktree's own toplevel. This is what we need to verify that a
 * scanned subdir actually belongs to the parent agent's repository.
 *
 * Returns null in two cases:
 *  - "Not a git repo / no repoRoot" — explicit signal from `worktreeInfo`.
 *    Callers fall back to the legacy "trust the basePath" behavior.
 *  - Unexpected exception (IPC failure, etc.) — we return null *and* report
 *    the error to Sentry + the logger. Without that signal, a regressed IPC
 *    would silently disable the repo-root guard and re-introduce the
 *    wrong-parent attachment bug with no production trace.
 */
async function resolveRepoRoot(path: string, sshRemoteId?: string): Promise<string | null> {
	try {
		const info = await window.maestro.git.worktreeInfo(path, sshRemoteId);
		if (!info.success || !info.exists || !info.repoRoot) return null;
		return normalizePath(info.repoRoot);
	} catch (err) {
		logger.error(
			`[WorktreeScan] resolveRepoRoot failed for ${path}:`,
			undefined,
			err instanceof Error ? err.message : String(err)
		);
		captureException(err, { extra: { path, sshRemoteId, source: 'resolveRepoRoot' } });
		return null;
	}
}

// buildWorktreeSession and BuildWorktreeSessionParams are imported from ../../utils/worktreeSession
// normalizePath and sessionMatchesWorktreeRoot are imported from ../../utils/worktreeDedup

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

					// Same repo-identity guard as scanWorktreeConfigs: if the user just
					// pointed this agent at a basePath that contains worktrees from a
					// different repo, skip those subdirs instead of attaching them.
					const parentRepoRoot = await resolveRepoRoot(activeSession.cwd, parentSshRemoteId);

					for (const subdir of gitSubdirs) {
						// Skip main/master/HEAD branches — they're typically the main repo
						if (isSkippableBranch(subdir.branch)) continue;

						// Repo-identity check (mirrors scanWorktreeConfigs). Falls back to
						// legacy behavior when either side can't be resolved.
						if (
							parentRepoRoot &&
							subdir.repoRoot &&
							normalizePath(subdir.repoRoot) !== parentRepoRoot
						) {
							continue;
						}

						// Skip a path spawnWorktreeAgentAndDispatch is still building the
						// owning child for (mirrors the chokidar + rescan paths).
						if (isRecentlyCreatedWorktreePath(subdir.path)) continue;

						// Check if session already exists (read latest state each iteration).
						// Both checks are scoped to THIS parent: with per-parent ownership a
						// same-repo sibling can hold its own child at the same cwd/branch, so
						// a global match would wrongly skip this parent and leave it without a
						// child until a later rescan (no chokidar add fires for an existing
						// directory). Mirrors the per-parent dedup in scanWorktreeConfigs.
						const latestSessions = useSessionStore.getState().sessions;
						const existingByBranch = latestSessions.find(
							(s) => s.parentSessionId === activeSession.id && s.worktreeBranch === subdir.branch
						);
						if (existingByBranch) continue;

						// Also check by path (normalize for comparison), scoped to this parent.
						const normalizedSubdirPath = normalizePath(subdir.path);
						const existingByPath = latestSessions.find(
							(s) =>
								s.parentSessionId === activeSession.id &&
								normalizePath(s.cwd) === normalizedSubdirPath
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

				// If the branch was already attached to another worktree on disk,
				// open that existing path instead of failing the user's flow.
				const actualPath = result.existingPath || worktreePath;
				const reusedExisting = !!result.alreadyExisted && !!result.existingPath;

				// If we ended up using a different path, drop the original mark and
				// avoid re-marking — there was nothing newly created on disk to race with.
				if (reusedExisting) {
					recentlyCreatedWorktreePathsRef.current.delete(normalizedCreatedPath);
				}

				// If a session for the existing worktree path already exists, focus it
				// and skip the duplicate creation. Done before fetchGitInfo so we don't
				// pay for an unnecessary git round-trip when there's nothing to build.
				if (reusedExisting) {
					const normalizedActual = normalizePath(actualPath);
					const existingSession = useSessionStore
						.getState()
						.sessions.find((s) => sessionMatchesWorktreeRoot(s, normalizedActual));
					if (existingSession) {
						useSessionStore.getState().setActiveSessionId(existingSession.id);
						notifyToast({
							type: 'info',
							title: 'Worktree Already Open',
							message: branchName,
						});
						return;
					}
				}

				// Fetch git info for the worktree (pass SSH remote ID for remote sessions)
				const gitInfo = await fetchGitInfo(actualPath, sshRemoteId);

				const worktreeSession = buildWorktreeSession({
					parentSession: activeSession,
					path: actualPath,
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
					type: reusedExisting ? 'info' : 'success',
					title: reusedExisting ? 'Worktree Already Existed' : 'Worktree Created',
					message: reusedExisting ? `Opened existing worktree at ${actualPath}` : branchName,
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

	const handleCreateWorktree = useCallback(async (branchName: string, baseBranch?: string) => {
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
			// Create the worktree via git (pass SSH remote ID for remote sessions).
			// baseBranch is honored only when the named branch doesn't already exist
			// — see git.ts handler for the full semantics.
			const result = await window.maestro.git.worktreeSetup(
				createWtSession.cwd,
				worktreePath,
				branchName,
				sshRemoteId,
				baseBranch
			);

			if (!result.success) {
				throw new Error(result.error || 'Failed to create worktree');
			}

			// If the branch was already attached to another worktree on disk,
			// open that existing path instead of failing the user's flow.
			const actualPath = result.existingPath || worktreePath;
			const reusedExisting = !!result.alreadyExisted && !!result.existingPath;

			if (reusedExisting) {
				recentlyCreatedWorktreePathsRef.current.delete(normalizedCreatedPath);
			}

			// If a session for the existing worktree path already exists, focus it
			// and skip the duplicate creation.
			if (reusedExisting) {
				const normalizedActual = normalizePath(actualPath);
				const existingSession = useSessionStore
					.getState()
					.sessions.find((s) => sessionMatchesWorktreeRoot(s, normalizedActual));
				if (existingSession) {
					useSessionStore.getState().setActiveSessionId(existingSession.id);
					notifyToast({
						type: 'info',
						title: 'Worktree Already Open',
						message: branchName,
					});
					return;
				}
			}

			// Fetch git info for the worktree (pass SSH remote ID for remote sessions)
			const gitInfo = await fetchGitInfo(actualPath, sshRemoteId);

			const worktreeSession = buildWorktreeSession({
				parentSession: createWtSession,
				path: actualPath,
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
				type: reusedExisting ? 'info' : 'success',
				title: reusedExisting ? 'Worktree Already Existed' : 'Worktree Created',
				message: reusedExisting ? `Opened existing worktree at ${actualPath}` : branchName,
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
		// Children that no longer exist on disk — surfaced as "Worktree Removed".
		const staleSessionIds: string[] = [];
		// Children whose cwd still exists but belongs to a different repo. Surfaced
		// as "Worktree Re-assigned" instead of "Worktree Removed" so the user isn't
		// told their worktree was deleted (it wasn't — it just attaches to the
		// correct parent on the next scan / chokidar event).
		const reassignedSessionIds: string[] = [];

		for (const parentSession of sessionsWithWorktreeConfig) {
			try {
				const sshRemoteId = getSshRemoteId(parentSession);
				const scanResult = await window.maestro.git.scanWorktreeDirectory(
					parentSession.worktreeConfig!.basePath,
					sshRemoteId
				);
				const { gitSubdirs, scanFailed } = scanResult;

				// Resolve the parent's main repo root once so we can verify each scanned
				// subdir actually belongs to *this* parent's repository. Without this,
				// two parents whose basePaths overlap (or a basePath that contains
				// worktrees from a different repo) would race — whichever parent's loop
				// iterates first would grab every worktree, producing the "worktrees
				// re-added under a wrong agent" bug after a wipe + restart.
				const parentRepoRoot = await resolveRepoRoot(parentSession.cwd, sshRemoteId);

				// Detect additions
				for (const subdir of gitSubdirs) {
					if (isSkippableBranch(subdir.branch)) continue;

					// Skip a path that spawnWorktreeAgentAndDispatch just created and is
					// still building the owning child for (mirrors the chokidar listener's
					// guard). Without this, a startup/visibility rescan that lands inside
					// that window would fan the Maestro-launched worktree out under every
					// same-repo parent, re-creating the wrong-parent attribution - and it
					// matters most on SSH, where chokidar is unavailable and the rescan is
					// the only discovery path.
					if (isRecentlyCreatedWorktreePath(subdir.path)) continue;

					// Repo-identity check: if we know both the parent's repo root and the
					// subdir's repo root, skip subdirs that don't match. If either is
					// missing (parent isn't a git repo, or git couldn't resolve the
					// subdir's common-dir), fall back to the legacy "trust the basePath"
					// behavior so we don't break setups that worked before.
					if (
						parentRepoRoot &&
						subdir.repoRoot &&
						normalizePath(subdir.repoRoot) !== parentRepoRoot
					) {
						continue;
					}

					const normalizedSubdirPath = normalizePath(subdir.path);
					const latestSessions = useSessionStore.getState().sessions;
					// Sessions queued for stale-removal or re-assignment are about to be
					// detached at the end of this scan, so they must NOT block other
					// parents in the same pass from creating the correct child. Without
					// this, in the overlapping-basePath recovery case parent A would
					// queue a wrong-agent child for detachment and parent B would skip
					// the same path because the (about-to-be-removed) session still
					// matches by cwd in the store.
					const stalePending = new Set([...staleSessionIds, ...reassignedSessionIds]);
					// Per-parent dedup (mirrors the chokidar watcher path): only THIS
					// parent's own child at this path/branch blocks a re-add. A same-repo
					// sibling's child at the same cwd must NOT stop this parent from
					// getting its own child, otherwise a restart/visibility rescan would
					// collapse the per-parent fan-out the live watcher produces.
					const existingSession = latestSessions.find((s) => {
						if (stalePending.has(s.id)) return false;
						if (s.parentSessionId !== parentSession.id) return false;
						return (
							sessionMatchesWorktreeRoot(s, normalizedSubdirPath) ||
							s.worktreeBranch === subdir.branch
						);
					});
					if (existingSession) continue;

					if (
						newWorktreeSessions.some(
							(s) =>
								s.parentSessionId === parentSession.id &&
								normalizePath(s.cwd) === normalizedSubdirPath
						)
					) {
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
					// Build a quick lookup from normalized subdir path → its repoRoot,
					// so we can detect children that exist on disk but were attached to
					// the wrong parent (the worktrees-under-wrong-agent recovery case).
					const subdirByPath = new Map<string, { repoRoot: string | null }>();
					for (const d of gitSubdirs) {
						subdirByPath.set(normalizePath(d.path), { repoRoot: d.repoRoot });
					}
					const diskPaths = new Set(subdirByPath.keys());
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
							const childPath = normalizePath(child.cwd);
							if (!diskPaths.has(childPath)) {
								staleSessionIds.push(child.id);
								continue;
							}
							// Detach children whose cwd points at a worktree of a different
							// repo than this parent. Without this, after the worktree-wipe
							// bug the wrong-agent children would never get re-attached to
							// the correct parent (the existing-session dedup would block it).
							const subdirRepoRoot = subdirByPath.get(childPath)?.repoRoot ?? null;
							if (
								parentRepoRoot &&
								subdirRepoRoot &&
								normalizePath(subdirRepoRoot) !== parentRepoRoot
							) {
								logger.warn(
									`[WorktreeScan] Detaching ${child.id} from ${parentSession.id}: child cwd ${child.cwd} belongs to repo ${subdirRepoRoot}, not parent's repo ${parentRepoRoot}`
								);
								reassignedSessionIds.push(child.id);
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

		// Apply removals BEFORE additions so the additions' cwd-dedup doesn't see
		// soon-to-be-detached wrong-agent children and filter out the correct
		// re-attached child. Without this ordering the same-pass recovery
		// (parent A flags wrong-agent child stale, parent B creates the correct
		// child for the same cwd) would silently drop the new child.
		if (staleSessionIds.length > 0 || reassignedSessionIds.length > 0) {
			const staleSet = new Set(staleSessionIds);
			const reassignedSet = new Set(reassignedSessionIds);
			const removalSet = new Set([...staleSessionIds, ...reassignedSessionIds]);
			useSessionStore.getState().setSessions((prev) => {
				const removed = prev.filter((s) => removalSet.has(s.id));
				for (const s of removed) {
					if (reassignedSet.has(s.id)) {
						notifyToast({
							type: 'info',
							title: 'Worktree Re-assigned',
							message: s.worktreeBranch || s.name,
						});
					} else if (staleSet.has(s.id)) {
						notifyToast({
							type: 'info',
							title: 'Worktree Removed',
							message: s.worktreeBranch || s.name,
						});
					}
				}
				return prev.filter((s) => !removalSet.has(s.id));
			});
		}

		if (newWorktreeSessions.length > 0) {
			useSessionStore.getState().setSessions((prev) => {
				// Per-parent existing-path set: a worktree already owned by parent A must
				// not block parent B's own child at the same cwd (matches the per-parent
				// discovery model). Key on parentSessionId|cwd so only a true same-parent
				// duplicate is dropped, guarding against a race between the check above
				// and this commit.
				const existingKeys = new Set(
					prev
						.filter((s) => s.parentSessionId)
						.map((s) => `${s.parentSessionId}|${normalizePath(s.cwd)}`)
				);
				const trulyNew = newWorktreeSessions.filter(
					(s) => !existingKeys.has(`${s.parentSessionId}|${normalizePath(s.cwd)}`)
				);
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
			// Per-parent dedup: only skip if THIS watching agent already owns a child
			// for this worktree. Each agent in the repo runs its own watcher over the
			// shared basePath and fires its own discovery event, so scoping the dedup
			// to the firing parent lets every agent in the cwd pick up the new worktree
			// as its own child, instead of the first watcher to fire claiming it
			// globally and the others silently dropping it.
			const existingForParent = latestSessions.find(
				(s) =>
					s.parentSessionId === sessionId &&
					(sessionMatchesWorktreeRoot(s, normalizedWorktreePath) ||
						s.worktreeBranch === worktree.branch)
			);
			if (existingForParent) return;

			const sshRemoteId = getSshRemoteId(parentSession);

			// Repo-identity check: chokidar fires for every new directory under the
			// watched basePath, including ones that turn out to be worktrees of a
			// *different* repo. Without this guard, those would be attached to the
			// wrong parent agent (matching the periodic-scan logic above).
			const [parentRepoRoot, discoveredInfo] = await Promise.all([
				resolveRepoRoot(parentSession.cwd, sshRemoteId),
				// Unexpected IPC errors here are reported to Sentry rather than
				// silently nulled out — otherwise a regressed worktreeInfo would
				// disable the repo-root guard for chokidar discoveries with no
				// production signal. An explicit "not a repo" still resolves to
				// `info.success=false` and falls through to the legacy fallback.
				window.maestro.git.worktreeInfo(worktree.path, sshRemoteId).catch((err) => {
					logger.error(
						`[WorktreeWatcher] worktreeInfo failed for ${worktree.path}:`,
						undefined,
						err instanceof Error ? err.message : String(err)
					);
					captureException(err, {
						extra: {
							path: worktree.path,
							sshRemoteId,
							source: 'onWorktreeDiscovered',
						},
					});
					return null;
				}),
			]);
			const discoveredRepoRoot =
				discoveredInfo && discoveredInfo.success && discoveredInfo.repoRoot
					? normalizePath(discoveredInfo.repoRoot)
					: null;
			if (parentRepoRoot && discoveredRepoRoot && discoveredRepoRoot !== parentRepoRoot) {
				logger.warn(
					`[WT-DEBUG] SKIPPED: discovered worktree ${worktree.path} belongs to repo ${discoveredRepoRoot}, not parent's repo ${parentRepoRoot}`
				);
				return;
			}

			const { defaultSaveToHistory: savToHist, defaultShowThinking: showThink } =
				useSettingsStore.getState();
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
				// Per-parent guard (mirrors the existingForParent check above): another
				// agent may already own a child at this cwd, but THIS parent should
				// still get its own. Only collapse if this same parent raced to add a
				// duplicate between the check above and here.
				if (
					prev.some(
						(s) =>
							s.parentSessionId === sessionId && normalizePath(s.cwd) === normalizedWorktreePath
					)
				)
					return prev;
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
