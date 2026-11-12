/**
 * useWorktreeHandlers - extracted from App.tsx (Phase 2D)
 *
 * Owns all worktree-related handlers, effects, refs, and memoized values.
 * Reads from Zustand stores directly - no parameters needed.
 *
 * Handlers:
 *   - Modal open/close for worktree config, create, delete
 *   - Save/disable worktree config (scan + session creation)
 *   - Create/delete worktree sessions
 *   - Toggle worktree expansion in the left bar
 *
 * Effects (auto-discovery - only in the lifecycle-owning renderer, see
 * `UseWorktreeHandlersDeps.isLifecycleOwner`):
 *   - Startup scan: restores worktree sub-agents from worktreeConfig on app load
 *   - File watcher: real-time detection of new worktrees via filesystem events
 *   - Legacy scanner: polls for worktrees using old worktreeParentPath model
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Session, SessionWorktreeConfig } from '../../types';
import type { PRDetails } from '../../components/CreatePRModal';
import type { RightPanelHandle } from '../../components/RightPanel';
import { getModalActions, useModalStore } from '../../stores/modalStore';
import {
	useSessionStore,
	updateSessionWith,
	selectActiveSession,
	selectSessionById,
} from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { gitService } from '../../services/git';
import { notifyToast } from '../../stores/notificationStore';
import { buildWorktreeSession } from '../../utils/worktreeSession';
import { isPathAtOrUnderRoot } from '../../../shared/worktreePaths';
import {
	isRecentlyCreatedWorktreePath,
	normalizePath,
	sessionMatchesWorktreeRoot,
} from '../../utils/worktreeDedup';
import { runWorktreeSetupScript } from '../../utils/worktreeSetupScript';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { generateId } from '../../utils/ids';

// ============================================================================
// Dependencies
// ============================================================================

export interface UseWorktreeHandlersDeps {
	rightPanelRef?: React.RefObject<RightPanelHandle | null>;
	/**
	 * Whether THIS renderer owns worktree auto-discovery (the startup scan, the
	 * chokidar watcher, and the legacy scanner). Defaults to true so isolation
	 * tests and single-renderer callers keep today's behaviour.
	 *
	 * The same App runs in every Electron window AND in every connected
	 * web-desktop browser client, and `worktree:discovered` is BROADCAST to all
	 * of them (see the MULTI-WINDOW INVARIANT in `main/utils/safe-send.ts`). Only
	 * the primary desktop window may own discovery; secondary Electron windows
	 * and web clients pass false here.
	 * Discovery is not an idempotent read: each renderer answers it by building
	 * a child session with a freshly generated id, and persistence ships
	 * incremental `sessions:setMany` diffs, so every non-owning renderer adds one
	 * permanent duplicate agent per worktree - same parent, same path, same
	 * provider (issue #1506). It also owns the watcher LIFECYCLE, and the main
	 * process keys watchers by session id: a second renderer registering one
	 * closes the first, and that renderer unmounting (a closed browser tab) stops
	 * the watch for everybody.
	 *
	 * User-initiated worktree handlers are deliberately NOT gated - a web-desktop
	 * user must still be able to create and delete worktrees.
	 *
	 * App derives this from both runtime type and `WindowContext.isMainWindow`.
	 */
	isLifecycleOwner?: boolean;
}

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
	handleSaveWorktreeConfig: (config: SessionWorktreeConfig) => Promise<void>;
	handleDisableWorktreeConfig: () => void;
	handleCreateWorktreeFromConfig: (branchName: string, basePath: string) => Promise<void>;
	handleCloseCreateWorktreeModal: () => void;
	handleCreateWorktree: (branchName: string, baseBranch?: string) => Promise<void>;
	handleCloseDeleteWorktreeModal: () => void;
	handleConfirmDeleteWorktree: () => void;
	handleConfirmAndDeleteWorktreeOnDisk: () => Promise<void>;
	handlePRCreated: (prDetails: PRDetails) => Promise<void>;
	refreshWorktreeState: () => Promise<void>;
}

// ============================================================================
// Private helpers
// ============================================================================

/** Extract SSH remote ID, optionally inheriting a worktree parent's comparison target. */
function getSshRemoteId(session: Session, inheritParent = false): string | undefined {
	// Runtime SSH fields describe the last spawn and can survive a config change.
	// An explicit local config must also prevent inheritance from the parent.
	const config = session.sessionSshRemoteConfig;
	if (config) return config.enabled ? config.remoteId || undefined : undefined;
	const remoteId = session.sshRemoteId || undefined;
	if (remoteId || !inheritParent || !session.parentSessionId) return remoteId;
	const parent = useSessionStore.getState().sessions.find((s) => s.id === session.parentSessionId);
	// Generated children copy the parent's config. A child without one remains
	// local when its parent is later configured for SSH; only legacy state inherits.
	return parent && !parent.sessionSshRemoteConfig ? getSshRemoteId(parent) : undefined;
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
 *  - "Not a git repo / no repoRoot" - explicit signal from `worktreeInfo`.
 *    Callers fall back to the legacy "trust the basePath" behavior.
 *  - Unexpected exception (IPC failure, etc.) - we return null *and* report
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

/** Read SSH worktrees from Git's repository registry rather than a partial directory scan. */
async function scanConfiguredWorktrees(
	parentSession: Session,
	basePath: string,
	sshRemoteId?: string
): Promise<
	Awaited<ReturnType<typeof window.maestro.git.scanWorktreeDirectory>> & {
		normalizeSessionPath: (path: string) => string;
		normalizeWorktreePath: (path: string) => string;
		confirmedMissingSessionIds: Set<string>;
		registeredWorktreePaths: Set<string>;
		unresolvedSessionIds: Set<string>;
		isScanCurrent: () => boolean;
		isCurrentScannedSession: (session: Session) => boolean;
		isRecentlyCreated: (path: string) => boolean;
	}
> {
	const childSessions = useSessionStore
		.getState()
		.sessions.filter((s) => s.parentSessionId === parentSession.id);
	const parentIdentity = {
		cwd: parentSession.cwd,
		basePath,
		sshRemoteId,
		configuredSshEnabled: parentSession.sessionSshRemoteConfig?.enabled,
		configuredSshRemoteId: parentSession.sessionSshRemoteConfig?.remoteId,
	};
	const childIdentities = new Map(
		childSessions.map((child) => [
			child.id,
			{
				cwd: child.cwd,
				parentSessionId: child.parentSessionId,
				sshRemoteId: getSshRemoteId(child),
				configuredSshEnabled: child.sessionSshRemoteConfig?.enabled,
				configuredSshRemoteId: child.sessionSshRemoteConfig?.remoteId,
			},
		])
	);
	// A registry snapshot cannot establish absence for children created or
	// retargeted while its asynchronous probes and discovery are in flight.
	const isScanCurrent = () => {
		const parent = useSessionStore.getState().sessions.find((s) => s.id === parentSession.id);
		return (
			!!parent &&
			parent.cwd === parentIdentity.cwd &&
			parent.worktreeConfig?.basePath === parentIdentity.basePath &&
			getSshRemoteId(parent) === parentIdentity.sshRemoteId &&
			parent.sessionSshRemoteConfig?.enabled === parentIdentity.configuredSshEnabled &&
			parent.sessionSshRemoteConfig?.remoteId === parentIdentity.configuredSshRemoteId
		);
	};
	const isCurrentScannedSession = (session: Session) => {
		const identity = childIdentities.get(session.id);
		return (
			!!identity &&
			isScanCurrent() &&
			session.cwd === identity.cwd &&
			session.parentSessionId === identity.parentSessionId &&
			getSshRemoteId(session) === identity.sshRemoteId &&
			session.sessionSshRemoteConfig?.enabled === identity.configuredSshEnabled &&
			session.sessionSshRemoteConfig?.remoteId === identity.configuredSshRemoteId
		);
	};
	if (!isScanCurrent()) {
		const normalize = (path: string) => normalizePath(path, !!sshRemoteId);
		return {
			gitSubdirs: [],
			normalizeSessionPath: normalize,
			normalizeWorktreePath: normalize,
			confirmedMissingSessionIds: new Set(),
			registeredWorktreePaths: new Set(),
			unresolvedSessionIds: new Set(childSessions.map((session) => session.id)),
			isScanCurrent,
			isCurrentScannedSession,
			isRecentlyCreated: isRecentlyCreatedWorktreePath,
		};
	}
	const protectedChildIds = new Set(
		childSessions
			.filter((session) => {
				return typeof session.cwd !== 'string' || getSshRemoteId(session, true) !== sshRemoteId;
			})
			.map((session) => session.id)
	);
	if (!sshRemoteId) {
		const scan = await window.maestro.git.scanWorktreeDirectory(basePath, sshRemoteId);
		const unresolvedPaths = Array.isArray(scan.unresolvedPaths) ? [...scan.unresolvedPaths] : [];
		const malformedMetadata =
			scan.unresolvedPaths !== undefined &&
			(!Array.isArray(scan.unresolvedPaths) ||
				unresolvedPaths.some((path) => typeof path !== 'string'));
		let unknownEntry = false;
		const gitSubdirs = scan.gitSubdirs.filter((subdir) => {
			if (!subdir || typeof subdir.path !== 'string') {
				unknownEntry = true;
				return false;
			}
			if (
				(subdir.branch != null && typeof subdir.branch !== 'string') ||
				(subdir.repoRoot != null && typeof subdir.repoRoot !== 'string') ||
				(subdir.name !== undefined && typeof subdir.name !== 'string')
			) {
				unresolvedPaths.push(subdir.path);
				return false;
			}
			return true;
		});
		const unresolvedSessionIds = new Set(
			childSessions
				.filter(
					(session) =>
						protectedChildIds.has(session.id) ||
						unknownEntry ||
						malformedMetadata ||
						(unresolvedPaths.length > 0 &&
							!isPathAtOrUnderRoot(normalizePath(session.cwd), normalizePath(basePath))) ||
						unresolvedPaths?.some((path) => {
							const candidate = normalizePath(session.cwd);
							const root = normalizePath(path);
							return candidate === root || candidate.startsWith(root === '' ? '/' : root + '/');
						})
				)
				.map((session) => session.id)
		);
		return {
			...scan,
			isScanCurrent,
			isCurrentScannedSession,
			gitSubdirs,
			isRecentlyCreated: isRecentlyCreatedWorktreePath,
			normalizeSessionPath: normalizePath,
			normalizeWorktreePath: normalizePath,
			confirmedMissingSessionIds: new Set(),
			registeredWorktreePaths: new Set(gitSubdirs.map((subdir) => normalizePath(subdir.path))),
			unresolvedSessionIds,
		};
	}

	const sessionPaths = childSessions.filter((s) => typeof s.cwd === 'string').map((s) => s.cwd);
	const {
		worktrees,
		resolvedCwd,
		resolvedBasePath,
		resolvedSessionPaths,
		missingSessionPaths,
		unresolvedSessionPaths,
	} = await window.maestro.git.listWorktrees(
		parentSession.cwd,
		sshRemoteId,
		basePath,
		sessionPaths
	);
	if (!Array.isArray(worktrees) || worktrees.length === 0) {
		throw new Error('Could not list remote worktrees');
	}
	const isPhysicalPath = (path: unknown): path is string =>
		typeof path === 'string' && /^\/[^\r\n\0]*$/.test(path);
	if (!isPhysicalPath(resolvedCwd) || !isPhysicalPath(resolvedBasePath)) {
		throw new Error('Could not resolve remote worktree paths');
	}

	const base = normalizePath(resolvedBasePath, true);
	const parent = normalizePath(resolvedCwd, true);
	const configuredBase = normalizePath(basePath, true);
	const unresolvedPaths = new Set<string>();
	const resolvedPaths: Record<string, string> = Object.create(null);
	if (resolvedSessionPaths !== undefined) {
		if (
			typeof resolvedSessionPaths !== 'object' ||
			resolvedSessionPaths === null ||
			Array.isArray(resolvedSessionPaths)
		) {
			sessionPaths.forEach((path) => unresolvedPaths.add(path));
		} else {
			for (const [path, resolved] of Object.entries(resolvedSessionPaths)) {
				if (!sessionPaths.includes(path)) continue;
				if (isPhysicalPath(resolved)) resolvedPaths[path] = resolved;
				else unresolvedPaths.add(path);
			}
		}
	}
	const missingPaths = new Set<string>();
	for (const [status, paths] of [
		['missing', missingSessionPaths],
		['unresolved', unresolvedSessionPaths],
	] as const) {
		if (paths === undefined) continue;
		if (!Array.isArray(paths)) {
			sessionPaths.forEach((path) => unresolvedPaths.add(path));
			continue;
		}
		for (const path of paths) {
			if (typeof path !== 'string' || !sessionPaths.includes(path)) {
				// An unidentifiable metadata error preserves existing chats, while
				// still allowing trustworthy registry entries to be discovered.
				sessionPaths.forEach((candidate) => unresolvedPaths.add(candidate));
			} else if (status === 'missing' && resolvedPaths[path]) {
				missingPaths.add(path);
			} else {
				unresolvedPaths.add(path);
			}
		}
	}
	for (const path of sessionPaths) {
		const hasKnownPrefix = [configuredBase, base].some((root) => isPathAtOrUnderRoot(path, root));
		if ((!hasKnownPrefix || /(^|\/)\.{1,2}(\/|$)/.test(path)) && !resolvedPaths[path]) {
			unresolvedPaths.add(path);
		}
	}
	const normalizeSessionPath = (path: string): string => {
		if (resolvedPaths[path]) return normalizePath(resolvedPaths[path], true);
		const candidate = normalizePath(path, true);
		if (!isPathAtOrUnderRoot(candidate, configuredBase)) return candidate;
		// Preserve literal POSIX backslashes and case when rebasing aliases.
		return normalizePath(base + '/' + candidate.slice(configuredBase.length), true);
	};
	const validWorktrees: typeof worktrees = [];
	let unknownRegistryIdentity = false;
	for (const worktree of worktrees) {
		if (!worktree || typeof worktree.path !== 'string') {
			sessionPaths.forEach((path) => unresolvedPaths.add(path));
			continue;
		}
		if (
			!isPhysicalPath(worktree.path) ||
			(worktree.resolvedPath !== undefined && !isPhysicalPath(worktree.resolvedPath)) ||
			[worktree.pathUnresolved, worktree.pathMissing, worktree.isPrunable].some(
				(flag) => flag !== undefined && typeof flag !== 'boolean'
			) ||
			(worktree.branch != null && typeof worktree.branch !== 'string') ||
			typeof worktree.isBare !== 'boolean'
		) {
			// A record with an identifiable path affects only its matching child.
			const registryIdentities = new Set([
				normalizePath(worktree.path, true),
				...(isPhysicalPath(worktree.resolvedPath)
					? [normalizePath(worktree.resolvedPath, true)]
					: []),
				...(resolvedPaths[worktree.path]
					? [normalizePath(resolvedPaths[worktree.path], true)]
					: []),
			]);
			if (worktree.resolvedPath !== undefined && !isPhysicalPath(worktree.resolvedPath)) {
				unknownRegistryIdentity = true;
			}
			let matchedChild = false;
			for (const child of childSessions) {
				if (typeof child.cwd !== 'string') continue;
				if (
					child.cwd === worktree.path ||
					registryIdentities.has(normalizeSessionPath(child.cwd))
				) {
					matchedChild = true;
					unresolvedPaths.add(child.cwd);
				}
			}
			if (!isPhysicalPath(worktree.path) && !matchedChild) {
				sessionPaths.forEach((path) => unresolvedPaths.add(path));
			}
			continue;
		}
		if (worktree.pathUnresolved && !worktree.isBare) unknownRegistryIdentity = true;
		validWorktrees.push(worktree);
	}
	// Registry membership establishes whether a saved child remains attached.
	// The configured base limits discovery, not the lifetime of existing chats.
	const registeredWorktrees = validWorktrees.filter(
		(worktree) =>
			!worktree.isBare &&
			normalizePath(worktree.resolvedPath || worktree.path, true) !== parent &&
			normalizePath(worktree.path, true) !== normalizePath(parentSession.cwd, true)
	);
	const registeredWorktreePaths = new Set(
		registeredWorktrees.flatMap((worktree) => [
			normalizePath(worktree.path, true),
			normalizeSessionPath(worktree.path),
			normalizePath(worktree.resolvedPath || worktree.path, true),
		])
	);
	const creationAliases = new Map<string, string[]>();
	const gitSubdirs = registeredWorktrees
		.filter((worktree) => !worktree.isPrunable && !worktree.pathMissing && !worktree.pathUnresolved)
		.map((worktree) => {
			const path =
				worktree.resolvedPath ||
				resolvedPaths[worktree.path] ||
				(configuredBase !== base && isPathAtOrUnderRoot(worktree.path, configuredBase)
					? normalizeSessionPath(worktree.path)
					: worktree.path);
			const normalized = normalizePath(path, true);
			// Launchers mark the requested spelling while the registry resolves it
			// physically. Keep both spellings so scans respect an in-flight creation.
			const aliases = [worktree.path];
			if (isPathAtOrUnderRoot(normalized, base)) {
				aliases.push(normalizePath(`${configuredBase}/${normalized.slice(base.length)}`, true));
			}
			creationAliases.set(normalized, aliases);
			return { ...worktree, path };
		})
		.filter((worktree) => isPathAtOrUnderRoot(worktree.path, base))
		// A detached worktree has no branch in the registry. The local scan skips it
		// (rev-parse --abbrev-ref answers HEAD), so SSH does not discover one either.
		// Retention reads registeredWorktreePaths, so an existing child that became
		// detached stays attached.
		.filter((worktree) => worktree.branch != null)
		.map((worktree) => ({
			path: worktree.path,
			name: normalizePath(worktree.path, true).split('/').pop() || worktree.path,
			isWorktree: true,
			branch: worktree.branch,
			repoRoot: null,
		}));
	const unresolvedSessionIds = new Set(
		childSessions
			.filter(
				(session) =>
					protectedChildIds.has(session.id) ||
					unresolvedPaths.has(session.cwd) ||
					(unknownRegistryIdentity &&
						!registeredWorktreePaths.has(normalizeSessionPath(session.cwd)))
			)
			.map((session) => session.id)
	);
	const confirmedMissingSessionIds = new Set(
		childSessions
			.filter(
				(session) =>
					!unresolvedSessionIds.has(session.id) &&
					missingPaths.has(session.cwd) &&
					!registeredWorktreePaths.has(normalizePath(resolvedPaths[session.cwd], true))
			)
			.map((session) => session.id)
	);
	if (unresolvedPaths.size > 0) {
		logger.warn('[WorktreeScan] Preserving unresolved remote worktree children:', undefined, [
			...unresolvedPaths,
		]);
	}
	return {
		isScanCurrent,
		isCurrentScannedSession,
		isRecentlyCreated: (path) =>
			[path, ...(creationAliases.get(normalizePath(path, true)) ?? [])].some(
				isRecentlyCreatedWorktreePath
			),
		normalizeSessionPath,
		normalizeWorktreePath: (path) => normalizePath(path, true),
		confirmedMissingSessionIds,
		registeredWorktreePaths,
		unresolvedSessionIds,
		gitSubdirs,
	};
}

// buildWorktreeSession and BuildWorktreeSessionParams are imported from ../../utils/worktreeSession
// normalizePath and sessionMatchesWorktreeRoot are imported from ../../utils/worktreeDedup

const EMPTY_RIGHT_PANEL_REF: React.RefObject<RightPanelHandle | null> = { current: null };

// ============================================================================
// Hook
// ============================================================================

export function useWorktreeHandlers(deps: UseWorktreeHandlersDeps = {}): WorktreeHandlersReturn {
	const { rightPanelRef = EMPTY_RIGHT_PANEL_REF, isLifecycleOwner = true } = deps;
	// ---------------------------------------------------------------------------
	// Reactive subscriptions
	// ---------------------------------------------------------------------------
	// PERF: Do not subscribe to the full sessions array. Streaming log/token flushes
	// would wake App via this hook. Effects only need worktreeConfig / legacy-path
	// signatures (and sessionsLoaded); handlers/scans read via getState().
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const defaultSaveToHistory = useSettingsStore((s) => s.defaultSaveToHistory);

	// ---------------------------------------------------------------------------
	// Refs
	// ---------------------------------------------------------------------------
	const recentlyCreatedWorktreePathsRef = useRef(new Set<string>());
	const unresolvedWorktreeSessionIdsRef = useRef(new Set<string>());

	// ---------------------------------------------------------------------------
	// Memoized values
	// ---------------------------------------------------------------------------
	// Stable dependency key for the worktree file-watcher effect below - only re-runs
	// when a session's worktreeConfig or SSH target changes (not on every sessions array mutation).
	// Uses | delimiter to avoid false collisions (session IDs are UUIDs, paths don't contain |).
	const worktreeConfigKey = useSessionStore((s) =>
		s.sessions
			.filter((sess) => sess.worktreeConfig?.basePath)
			.map(
				(sess) =>
					`${sess.id}|${sess.worktreeConfig!.basePath}|${sess.worktreeConfig!.watchEnabled}|${getSshRemoteId(sess) || ''}`
			)
			.join('\n')
	);

	// Whether any sessions still use the legacy worktreeParentPath model (for legacy scanner effect).
	const hasLegacyWorktreeSessions = useSessionStore((s) =>
		s.sessions.some((sess) => Boolean(sess.worktreeParentPath))
	);

	// ---------------------------------------------------------------------------
	// Refs
	// ---------------------------------------------------------------------------

	// ---------------------------------------------------------------------------
	// Quick-access handlers
	// ---------------------------------------------------------------------------

	/**
	 * The agent the Worktree Config modal is acting on.
	 *
	 * Opened from the Left Bar's right-click menu it carries an explicit target;
	 * opened from the header or Settings it carries none and follows the active
	 * agent. Every callback below has to resolve it the SAME way the modal host
	 * does, or Save would write the config onto a different agent than the one
	 * named in the dialog.
	 */
	const resolveWorktreeConfigTarget = useCallback((): Session | undefined => {
		const { sessions: currentSessions, activeSessionId } = useSessionStore.getState();
		const pinnedId = useModalStore.getState().getData('worktreeConfig')?.session?.id;
		// Re-read from the store rather than trusting the captured snapshot: the
		// payload was stamped when the modal opened and the agent may have
		// changed since.
		return currentSessions.find((s) => s.id === (pinnedId ?? activeSessionId));
	}, []);

	const handleOpenWorktreeConfig = useCallback(() => {
		getModalActions().setWorktreeConfigModalOpen(true);
	}, []);

	const handleQuickCreateWorktree = useCallback((session: Session) => {
		getModalActions().setCreateWorktreeSession(session);
	}, []);

	const handleOpenWorktreeConfigSession = useCallback((session: Session) => {
		// Pass the right-clicked agent through rather than force-activating it.
		// Opening a config dialog must not change which agent is selected: the
		// activation was a side effect the user never asked for, and it silently
		// retargeted every other surface bound to the active agent.
		getModalActions().setWorktreeConfigSession(session);
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

	const handleSaveWorktreeConfig = useCallback(async (config: SessionWorktreeConfig) => {
		const activeSession = resolveWorktreeConfigTarget();
		if (!activeSession) return;
		const { defaultSaveToHistory: savToHist, defaultShowThinking: showThink } =
			useSettingsStore.getState();

		// Save the config first
		useSessionStore.getState().updateSession(activeSession.id, { worktreeConfig: config });

		// Scan for worktrees and create sub-agent sessions
		const parentSshRemoteId = getSshRemoteId(activeSession);
		try {
			const scanResult = await scanConfiguredWorktrees(
				activeSession,
				config.basePath,
				parentSshRemoteId
			);
			const {
				gitSubdirs,
				normalizeSessionPath,
				normalizeWorktreePath,
				confirmedMissingSessionIds,
				unresolvedSessionIds,
				isScanCurrent,
				isCurrentScannedSession,
				isRecentlyCreated,
			} = scanResult;
			if (!isScanCurrent()) return;
			for (const session of useSessionStore.getState().sessions) {
				if (session.parentSessionId === activeSession.id) {
					unresolvedWorktreeSessionIdsRef.current.delete(session.id);
				}
			}
			unresolvedSessionIds.forEach((id) => unresolvedWorktreeSessionIdsRef.current.add(id));

			// Explicitly missing SSH children must not block replacements by branch
			// or path. Ordinary config saves keep their existing discovery behavior.
			if (confirmedMissingSessionIds.size > 0) {
				useSessionStore.getState().setSessions((prev) =>
					prev.filter((session) => {
						if (!confirmedMissingSessionIds.has(session.id) || !isCurrentScannedSession(session))
							return true;
						notifyToast({
							type: 'info',
							title: 'Worktree Removed',
							message: session.worktreeBranch || session.name,
						});
						return false;
					})
				);
			}

			if (gitSubdirs.length > 0) {
				const newWorktreeSessions: Session[] = [];

				// Same repo-identity guard as scanWorktreeConfigs: if the user just
				// pointed this agent at a basePath that contains worktrees from a
				// different repo, skip those subdirs instead of attaching them.
				const parentRepoRoot = parentSshRemoteId
					? null // The SSH worktree registry is already scoped to this repository.
					: await resolveRepoRoot(activeSession.cwd);

				for (const subdir of gitSubdirs) {
					try {
						// Skip main/master/HEAD branches - they're typically the main repo
						if (isSkippableBranch(subdir.branch)) continue;
						if (isRecentlyCreated(subdir.path)) continue;

						// Repo-identity check (mirrors scanWorktreeConfigs). Falls back to
						// legacy behavior when either side can't be resolved.
						if (
							parentRepoRoot &&
							subdir.repoRoot &&
							normalizePath(subdir.repoRoot) !== parentRepoRoot
						) {
							continue;
						}

						// Check if session already exists (read latest state each iteration)
						const latestSessions = useSessionStore.getState().sessions;
						const existingByBranch =
							parentSshRemoteId || subdir.branch == null
								? undefined
								: latestSessions.find(
										(s) =>
											!unresolvedSessionIds.has(s.id) &&
											s.parentSessionId === activeSession.id &&
											getSshRemoteId(s, true) === parentSshRemoteId &&
											s.worktreeBranch === subdir.branch
									);
						if (existingByBranch) continue;

						// Each parent owns its own child, including when siblings share a path.
						// A child of this parent already at the path blocks a second one even
						// when it still carries the remote the parent was retargeted away from.
						const normalizedSubdirPath = normalizeWorktreePath(subdir.path);
						const existingByPath = latestSessions.find(
							(s) =>
								typeof s.cwd === 'string' &&
								s.parentSessionId === activeSession.id &&
								(normalizeWorktreePath(s.cwd) === normalizedSubdirPath ||
									(getSshRemoteId(s, true) === parentSshRemoteId &&
										((!parentSshRemoteId && sessionMatchesWorktreeRoot(s, normalizedSubdirPath)) ||
											(!unresolvedSessionIds.has(s.id) &&
												normalizeSessionPath(s.cwd) === normalizedSubdirPath))))
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
					} catch (err) {
						logger.error(
							'[WorktreeScan] Failed to process worktree ' + subdir?.path + ':',
							undefined,
							err
						);
						captureException(err, { extra: { path: subdir?.path, source: 'worktreeDiscovery' } });
					}
				}

				if (newWorktreeSessions.length > 0 && isScanCurrent()) {
					const unmarkedSessions = newWorktreeSessions.filter((s) => !isRecentlyCreated(s.cwd));
					if (unmarkedSessions.length === 0) return;
					useSessionStore.getState().setSessions((prev) => [...prev, ...unmarkedSessions]);
					// Expand worktrees on parent
					useSessionStore.getState().updateSession(activeSession.id, { worktreesExpanded: true });
					notifyToast({
						type: 'success',
						title: 'Worktrees Discovered',
						message: `Found ${unmarkedSessions.length} worktree sub-agent${
							unmarkedSessions.length > 1 ? 's' : ''
						}`,
					});
				}
			}
		} catch (err) {
			logger.error('Failed to scan for worktrees:', undefined, err);
		}
	}, []);

	const handleDisableWorktreeConfig = useCallback(() => {
		const { sessions: currentSessions } = useSessionStore.getState();
		const activeSession = resolveWorktreeConfigTarget();
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
					// Creation failed - remove from ref so the path isn't permanently blocked
					recentlyCreatedWorktreePathsRef.current.delete(normalizedCreatedPath);
					throw new Error(result.error || 'Failed to create worktree');
				}

				// If the branch was already attached to another worktree on disk,
				// open that existing path instead of failing the user's flow.
				const actualPath = result.existingPath || worktreePath;
				const reusedExisting = !!result.alreadyExisted && !!result.existingPath;

				// If we ended up using a different path, drop the original mark and
				// avoid re-marking - there was nothing newly created on disk to race with.
				if (reusedExisting) {
					recentlyCreatedWorktreePathsRef.current.delete(normalizedCreatedPath);
				} else if (result.created) {
					// Fresh worktree on disk - bootstrap it with the agent's setup script.
					await runWorktreeSetupScript({
						parentSession: activeSession,
						mainRepoPath: activeSession.cwd,
						worktreePath,
						branchName,
						sshRemoteId,
					});
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
			// - see git.ts handler for the full semantics.
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
			} else if (result.created) {
				// Fresh worktree on disk - bootstrap it with the agent's setup script.
				await runWorktreeSetupScript({
					parentSession: createWtSession,
					mainRepoPath: createWtSession.cwd,
					worktreePath,
					branchName,
					baseBranch,
					sshRemoteId,
				});
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
						// Spread the existing config so a setup script survives a
						// quick-create that only fills in the missing basePath.
						updates.worktreeConfig = { ...s.worktreeConfig, basePath, watchEnabled: true };
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

	const handlePRCreated = useCallback(
		async (prDetails: PRDetails) => {
			const createPRSession = useModalStore.getState().getData('createPR')?.session ?? null;
			const activeSession = selectActiveSession(useSessionStore.getState());
			// The creation can land long after its form closed, by which point
			// `createPRSession` is null and the active agent may be someone else -
			// so the run's own agent id wins when it has one.
			const session =
				(prDetails.sessionId
					? selectSessionById(prDetails.sessionId)(useSessionStore.getState())
					: null) ||
				createPRSession ||
				activeSession;
			notifyToast({
				type: 'success',
				title: 'Pull Request Created',
				message: prDetails.title,
				actionUrl: prDetails.url,
				actionLabel: prDetails.url,
				sessionId: session?.id,
			});
			if (session) {
				await window.maestro.history.add({
					id: generateId(),
					type: 'USER',
					timestamp: Date.now(),
					summary: `Created PR: ${prDetails.title}`,
					fullResponse: [
						`**Pull Request:** [${prDetails.title}](${prDetails.url})`,
						`**Branch:** ${prDetails.sourceBranch} → ${prDetails.targetBranch}`,
						prDetails.description ? `**Description:** ${prDetails.description}` : '',
					]
						.filter(Boolean)
						.join('\n\n'),
					projectPath: session.projectRoot || session.cwd,
					sessionId: session.id,
					sessionName: session.name,
				});
				rightPanelRef.current?.refreshHistoryPanel();
			}
			getModalActions().setCreatePRSession(null);
		},
		[rightPanelRef]
	);

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
		// Children that no longer exist on disk - surfaced as "Worktree Removed".
		const staleSessionIds: string[] = [];
		const removalGuards = new Map<string, (session: Session) => boolean>();
		const scanGuards = new Map<string, () => boolean>();
		const creationGuards = new Map<string, (path: string) => boolean>();
		const sessionPathNormalizers = new Map<string, (session: Session) => string>();
		// Children whose cwd still exists but belongs to a different repo. Surfaced
		// as "Worktree Re-assigned" instead of "Worktree Removed" so the user isn't
		// told their worktree was deleted (it wasn't - it just attaches to the
		// correct parent on the next scan / chokidar event).
		const reassignedSessionIds: string[] = [];
		const unresolvedSessionIds = new Set<string>();

		for (const parentSession of sessionsWithWorktreeConfig) {
			try {
				const sshRemoteId = getSshRemoteId(parentSession);
				const scanResult = await scanConfiguredWorktrees(
					parentSession,
					parentSession.worktreeConfig!.basePath,
					sshRemoteId
				);
				const {
					gitSubdirs,
					scanFailed,
					normalizeSessionPath,
					normalizeWorktreePath,
					confirmedMissingSessionIds,
					registeredWorktreePaths,
					unresolvedSessionIds: parentUnresolvedSessionIds,
					isScanCurrent,
					isCurrentScannedSession,
					isRecentlyCreated,
				} = scanResult;
				if (!isScanCurrent()) continue;
				scanGuards.set(parentSession.id, isScanCurrent);
				creationGuards.set(parentSession.id, isRecentlyCreated);
				sessionPathNormalizers.set(parentSession.id, (session) =>
					parentUnresolvedSessionIds.has(session.id)
						? normalizeWorktreePath(session.cwd)
						: normalizeSessionPath(session.cwd)
				);
				parentUnresolvedSessionIds.forEach((id) => unresolvedSessionIds.add(id));
				for (const session of useSessionStore.getState().sessions) {
					if (session.parentSessionId === parentSession.id) {
						unresolvedWorktreeSessionIdsRef.current.delete(session.id);
					}
				}
				parentUnresolvedSessionIds.forEach((id) => unresolvedWorktreeSessionIdsRef.current.add(id));
				for (const child of useSessionStore.getState().sessions) {
					if (confirmedMissingSessionIds.has(child.id) && isCurrentScannedSession(child)) {
						staleSessionIds.push(child.id);
						removalGuards.set(child.id, isCurrentScannedSession);
					}
				}

				// Resolve the parent's main repo root once so we can verify each scanned
				// subdir actually belongs to *this* parent's repository. Without this,
				// two parents whose basePaths overlap (or a basePath that contains
				// worktrees from a different repo) would race - whichever parent's loop
				// iterates first would grab every worktree, producing the "worktrees
				// re-added under a wrong agent" bug after a wipe + restart.
				const parentRepoRoot = sshRemoteId
					? null // The SSH worktree registry is already scoped to this repository.
					: await resolveRepoRoot(parentSession.cwd);
				if (sshRemoteId) {
					// Only absence from the complete repository registry makes a
					// resolved SSH child stale, regardless of the discovery base.
					for (const child of useSessionStore.getState().sessions) {
						if (
							child.parentSessionId === parentSession.id &&
							isCurrentScannedSession(child) &&
							!parentUnresolvedSessionIds.has(child.id) &&
							!confirmedMissingSessionIds.has(child.id) &&
							!registeredWorktreePaths.has(normalizeSessionPath(child.cwd))
						) {
							staleSessionIds.push(child.id);
							removalGuards.set(child.id, isCurrentScannedSession);
						}
					}
				}

				// Detect additions
				for (const subdir of gitSubdirs) {
					try {
						if (isSkippableBranch(subdir.branch)) continue;
						if (isRecentlyCreated(subdir.path)) continue;

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

						const normalizedSubdirPath = normalizeWorktreePath(subdir.path);
						const latestSessions = useSessionStore.getState().sessions;
						// Children queued for removal must not block a replacement under
						// this parent. Recheck their guards in case a concurrent update
						// made a queued removal stale.
						const queuedRemovals = new Set([...staleSessionIds, ...reassignedSessionIds]);
						const stalePending = new Set(
							latestSessions
								.filter((s) => queuedRemovals.has(s.id) && removalGuards.get(s.id)?.(s))
								.map((s) => s.id)
						);
						const existingSession = latestSessions.find((s) => {
							if (typeof s.cwd !== 'string' || stalePending.has(s.id)) return false;
							if (s.parentSessionId !== parentSession.id) return false;
							// A child already at this path blocks a second one even when it still
							// carries the remote the parent was retargeted away from.
							if (normalizeWorktreePath(s.cwd) === normalizedSubdirPath) return true;
							if (getSshRemoteId(s, true) !== sshRemoteId) return false;
							if (!sshRemoteId && sessionMatchesWorktreeRoot(s, normalizedSubdirPath)) return true;
							if (unresolvedSessionIds.has(s.id)) return false;
							const normalizedCwd = normalizeSessionPath(s.cwd);
							return (
								normalizedCwd === normalizedSubdirPath ||
								(!sshRemoteId && subdir.branch != null && s.worktreeBranch === subdir.branch)
							);
						});
						if (existingSession) continue;

						if (
							newWorktreeSessions.some(
								(s) =>
									s.parentSessionId === parentSession.id &&
									getSshRemoteId(s, true) === sshRemoteId &&
									normalizeWorktreePath(s.cwd) === normalizedSubdirPath
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
					} catch (err) {
						logger.error(
							'[WorktreeScan] Failed to process worktree ' + subdir?.path + ':',
							undefined,
							err
						);
						captureException(err, { extra: { path: subdir?.path, source: 'worktreeDiscovery' } });
					}
				}

				// Detect removals: child sessions whose cwd is no longer in scan results.
				//
				// Guards against false-positive bulk removals (the bug that produced a
				// stack of "Worktree Removed" toasts on Linux/Windows when a transient
				// scan failure or symlinked basePath caused gitSubdirs to come back empty):
				//   1. If the scan flagged itself as failed, trust nothing - skip.
				//   2. If the scan returned zero subdirs while child sessions exist, treat
				//      that as suspicious and skip. A real "user removed every worktree"
				//      case is rare and will be surfaced one at a time via chokidar
				//      unlinkDir events instead.
				if (scanFailed) {
					logger.warn(
						`[WorktreeScan] Skipping removal phase for ${parentSession.worktreeConfig!.basePath} - scan failed`
					);
				} else {
					// Build a quick lookup from normalized subdir path → its repoRoot,
					// so we can detect children that exist on disk but were attached to
					// the wrong parent (the worktrees-under-wrong-agent recovery case).
					const subdirByPath = new Map<string, { repoRoot: string | null }>();
					for (const d of gitSubdirs) {
						subdirByPath.set(normalizeWorktreePath(d.path), { repoRoot: d.repoRoot });
					}
					const diskPaths = sshRemoteId ? registeredWorktreePaths : new Set(subdirByPath.keys());
					const latestSessions = useSessionStore.getState().sessions;
					const childSessions = latestSessions.filter(
						(s) => s.parentSessionId === parentSession.id && isCurrentScannedSession(s)
					);
					if (gitSubdirs.length === 0 && childSessions.length > 0 && !sshRemoteId) {
						logger.warn(
							`[WorktreeScan] Skipping removal phase for ${parentSession.worktreeConfig!.basePath} - scan returned zero subdirs but ${childSessions.length} child sessions exist (suspicious)`
						);
					} else {
						for (const child of childSessions) {
							if (parentUnresolvedSessionIds.has(child.id)) continue;
							const childPath = normalizeSessionPath(child.cwd);
							if (!diskPaths.has(childPath)) {
								staleSessionIds.push(child.id);
								removalGuards.set(child.id, isCurrentScannedSession);
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
								removalGuards.set(child.id, isCurrentScannedSession);
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

		// Apply removals before additions so stale children cannot block their
		// replacements. Each mutation still checks the captured scan context.
		if (staleSessionIds.length > 0 || reassignedSessionIds.length > 0) {
			const staleSet = new Set(staleSessionIds);
			const reassignedSet = new Set(reassignedSessionIds);
			const removalSet = new Set([...staleSessionIds, ...reassignedSessionIds]);
			useSessionStore.getState().setSessions((prev) => {
				const removed = prev.filter((s) => removalSet.has(s.id) && removalGuards.get(s.id)?.(s));
				const currentRemovalIds = new Set(removed.map((s) => s.id));
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
				return prev.filter((s) => !currentRemovalIds.has(s.id));
			});
		}

		if (newWorktreeSessions.length > 0) {
			useSessionStore.getState().setSessions((prev) => {
				const pathKey = (session: Session) => {
					const remoteId = getSshRemoteId(session, true);
					const normalizeSession = session.parentSessionId
						? sessionPathNormalizers.get(session.parentSessionId)
						: undefined;
					return JSON.stringify([
						session.parentSessionId,
						remoteId || null,
						normalizeSession ? normalizeSession(session) : normalizePath(session.cwd, !!remoteId),
					]);
				};
				const currentPaths = new Set(prev.filter((s) => typeof s.cwd === 'string').map(pathKey));
				// Children copy the parent's remote at creation, so after a retarget an
				// existing child at the same path still names the old remote. The path
				// alone decides whether this parent already has a child there.
				const rawPathKey = (session: Session) =>
					JSON.stringify([
						session.parentSessionId,
						normalizePath(session.cwd, !!getSshRemoteId(session, true)),
					]);
				const currentRawPaths = new Set(
					prev.filter((s) => typeof s.cwd === 'string' && s.parentSessionId).map(rawPathKey)
				);
				const trulyNew = newWorktreeSessions.filter(
					(s) =>
						!!s.parentSessionId &&
						!!scanGuards.get(s.parentSessionId)?.() &&
						!creationGuards.get(s.parentSessionId)?.(s.cwd) &&
						!currentPaths.has(pathKey(s)) &&
						!currentRawPaths.has(rawPathKey(s))
				);
				if (trulyNew.length === 0) return prev;
				return [...prev, ...trulyNew];
			});

			const parentIds = new Set(newWorktreeSessions.map((s) => s.parentSessionId));
			useSessionStore
				.getState()
				.setSessions((prev) =>
					prev.map((s) =>
						parentIds.has(s.id) && scanGuards.get(s.id)?.() ? { ...s, worktreesExpanded: true } : s
					)
				);
		}
	}, []);

	// Effect 1: Startup worktree config scan
	// Restores worktree sub-agents after app restart by scanning configured directories
	useEffect(() => {
		if (!isLifecycleOwner || !sessionsLoaded) return;

		const timer = setTimeout(scanWorktreeConfigs, 500);
		return () => clearTimeout(timer);
	}, [isLifecycleOwner, sessionsLoaded, scanWorktreeConfigs]);

	// Effect 2: File watcher + visibility-change rescan for worktree directories
	// Chokidar provides immediate detection; visibility-change rescan is a fallback
	// for worktrees created while the watcher was down or via external tools.
	useEffect(() => {
		if (!isLifecycleOwner) return;

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
				.watchWorktreeDirectory(
					session.id,
					session.worktreeConfig!.basePath,
					getSshRemoteId(session)
				)
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
			try {
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
				const sshRemoteId = getSshRemoteId(parentSession);
				// Chokidar events are local; an old watcher cannot describe a new SSH target.
				if (sshRemoteId || !parentSession.worktreeConfig?.watchEnabled) return;
				const parentIdentity = {
					cwd: parentSession.cwd,
					basePath: parentSession.worktreeConfig.basePath,
					configuredSshEnabled: parentSession.sessionSshRemoteConfig?.enabled,
					configuredSshRemoteId: parentSession.sessionSshRemoteConfig?.remoteId,
				};

				const normalizedWorktreePath = normalizePath(worktree.path);
				const existingSession = latestSessions.find((s) => {
					if (s.parentSessionId !== sessionId) return false;
					if (typeof s.cwd !== 'string' || getSshRemoteId(s, true) !== sshRemoteId) return false;
					if (sessionMatchesWorktreeRoot(s, normalizedWorktreePath)) return true;
					if (unresolvedWorktreeSessionIdsRef.current.has(s.id)) return false;
					return s.worktreeBranch === worktree.branch;
				});
				if (existingSession) return;

				// Repo-identity check: chokidar fires for every new directory under the
				// watched basePath, including ones that turn out to be worktrees of a
				// *different* repo. Without this guard, those would be attached to the
				// wrong parent agent (matching the periodic-scan logic above).
				const [parentRepoRoot, discoveredInfo] = await Promise.all([
					resolveRepoRoot(parentSession.cwd, sshRemoteId),
					// Unexpected IPC errors here are reported to Sentry rather than
					// silently nulled out - otherwise a regressed worktreeInfo would
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

				let added = false;
				useSessionStore.getState().setSessions((prev) => {
					const currentParent = prev.find((s) => s.id === sessionId);
					if (
						!currentParent ||
						currentParent.cwd !== parentIdentity.cwd ||
						currentParent.worktreeConfig?.basePath !== parentIdentity.basePath ||
						!currentParent.worktreeConfig?.watchEnabled ||
						getSshRemoteId(currentParent) !== sshRemoteId ||
						currentParent.sessionSshRemoteConfig?.enabled !== parentIdentity.configuredSshEnabled ||
						currentParent.sessionSshRemoteConfig?.remoteId !== parentIdentity.configuredSshRemoteId
					)
						return prev;
					if (
						prev.some(
							(s) =>
								typeof s.cwd === 'string' &&
								s.parentSessionId === sessionId &&
								getSshRemoteId(s, true) === sshRemoteId &&
								sessionMatchesWorktreeRoot(s, normalizedWorktreePath)
						)
					)
						return prev;
					added = true;
					return [...prev, worktreeSession];
				});
				if (!added) return;

				useSessionStore.getState().updateSession(sessionId, { worktreesExpanded: true });

				notifyToast({
					type: 'success',
					title: 'New Worktree Discovered',
					message: worktree.branch || worktree.name,
				});
			} catch (err) {
				logger.error('[WorktreeWatcher] Failed to process discovered worktree:', undefined, err);
				captureException(err, {
					extra: { path: data.worktree?.path, source: 'onWorktreeDiscovered' },
				});
			}
		});

		// Listen for worktree removals (e.g., git worktree remove from CLI)
		const cleanupRemovalListener = window.maestro.git.onWorktreeRemoved((data) => {
			const { sessionId, worktreePath } = data;
			if (typeof worktreePath !== 'string') return;
			logger.warn(`[WT-DEBUG] onWorktreeRemoved fired:`, undefined, { sessionId, worktreePath });

			const normalizedRemovedPath = normalizePath(worktreePath);

			useSessionStore.getState().setSessions((prev) => {
				const parent = prev.find((s) => s.id === sessionId);
				if (!parent?.worktreeConfig?.watchEnabled || getSshRemoteId(parent)) return prev;
				const childToRemove = prev.find(
					(s) =>
						typeof s.cwd === 'string' &&
						s.parentSessionId === sessionId &&
						getSshRemoteId(s, true) === undefined &&
						normalizePath(s.cwd) === normalizedRemovedPath
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
	}, [isLifecycleOwner, worktreeConfigKey, defaultSaveToHistory, scanWorktreeConfigs]);

	// Effect 3: Legacy scanner for sessions using old worktreeParentPath
	// TODO: Remove after migration to new parent/child model (use worktreeConfig with file watchers instead)
	// PERFORMANCE: Only scan on app focus (visibility change) instead of continuous polling
	// This avoids blocking the main thread every 30 seconds during active use
	useEffect(() => {
		if (!isLifecycleOwner || !hasLegacyWorktreeSessions) return;

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
							try {
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
										typeof s.cwd === 'string' &&
										sessionMatchesWorktreeRoot(s, normalizedSubdirPath2)
								);
								if (existingSession) {
									continue;
								}

								// Skip if we're already adding this path in this scan batch
								if (pathsBeingAdded.has(subdir.path)) {
									continue;
								}

								// Found a new worktree - prepare session creation
								pathsBeingAdded.add(subdir.path);

								const sessionName = subdir.branch
									? `${subdir.name} (${subdir.branch})`
									: subdir.name;

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
							} catch (err) {
								logger.error(
									'[WorktreeScan] Failed to process worktree ' + subdir?.path + ':',
									undefined,
									err
								);
								captureException(err, {
									extra: { path: subdir?.path, source: 'worktreeDiscovery' },
								});
							}
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
						const currentPaths = new Set(
							prev.filter((s) => typeof s.cwd === 'string').map((s) => normalizePath(s.cwd))
						);
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
		// This is much more efficient - only scans when user returns to app
		const handleVisibilityChange = () => {
			if (!document.hidden) {
				scanWorktreeParents();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [isLifecycleOwner, hasLegacyWorktreeSessions, defaultSaveToHistory]);

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
		handlePRCreated,
		refreshWorktreeState: scanWorktreeConfigs,
	};
}
