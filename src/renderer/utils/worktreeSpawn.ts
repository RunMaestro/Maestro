/**
 * Shared worktree-spawn helper.
 *
 * Originally lived as a private helper in useAutoRunHandlers; extracted here so
 * the remote (mobile/web) AutoRun launch path in useAppRemoteEventListeners can
 * spawn a child session against the launching parent — instead of relying on
 * the chokidar watcher in useWorktreeHandlers, which attaches to whichever
 * sibling agent's basePath matches first and produces wrong-parent children.
 */

import type { Session, BatchRunConfig } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { gitService } from '../services/git';
import { notifyToast } from '../stores/notificationStore';
import { buildWorktreeSession } from './worktreeSession';
import {
	markWorktreePathAsRecentlyCreated,
	clearRecentlyCreatedWorktreePath,
	normalizePath,
	sessionMatchesWorktreeRoot,
} from './worktreeDedup';
import { sanitizeGitBranchName } from '../../shared/gitUtils';

/**
 * Get the SSH remote ID for a session, checking both runtime and config values.
 *
 * Note: sshRemoteId is only set after AI agent spawns. For terminal-only SSH
 * sessions, fall back to sessionSshRemoteConfig.remoteId. See CLAUDE.md "SSH
 * Remote Sessions".
 */
function getSshRemoteId(session: Session): string | undefined {
	return session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
}

/**
 * Spawn a worktree agent session and prepare config for dispatch.
 * Handles both 'create-new' (creates worktree on disk first) and
 * 'existing-closed' (worktree already on disk, just needs a session).
 *
 * Returns the new session ID, or null if an error occurred (toast shown).
 */
export async function spawnWorktreeAgentAndDispatch(
	parentSession: Session,
	config: BatchRunConfig
): Promise<string | null> {
	const sshRemoteId = getSshRemoteId(parentSession);
	const target = config.worktreeTarget!;
	let worktreePath: string;
	let branchName: string;

	if (target.mode === 'create-new') {
		// Step 1: Resolve worktree path. Sanitize the branch so user input like
		// "Cue Dashboard" doesn't blow up `git worktree add` with "not a valid branch name".
		branchName = sanitizeGitBranchName(target.newBranchName ?? '');
		if (!branchName) {
			notifyToast({
				type: 'error',
				title: 'Invalid Branch Name',
				message: `"${target.newBranchName ?? ''}" cannot be used as a git branch name. Try letters, numbers, hyphens, or slashes.`,
			});
			return null;
		}
		// Strip the last path segment using a separator-agnostic regex so the
		// fallback works for both POSIX (`/`) and Windows (`\`) paths.
		const basePath =
			parentSession.worktreeConfig?.basePath ||
			parentSession.cwd.replace(/[\\/][^\\/]+$/, '') + '/worktrees';
		worktreePath = basePath + '/' + branchName;

		// Mark path BEFORE creating on disk so the file watcher in useWorktreeHandlers
		// skips this path and doesn't create a duplicate session.
		markWorktreePathAsRecentlyCreated(worktreePath);

		// Step 2: Create worktree on disk. Pass baseBranch so the new branch is
		// rooted at the user-selected base (e.g. "rc") instead of the main repo's
		// current HEAD — historically this was dropped and the UI's "Base Branch"
		// dropdown only affected PR target.
		let result;
		try {
			result = await window.maestro.git.worktreeSetup(
				parentSession.cwd,
				worktreePath,
				branchName,
				sshRemoteId,
				target.baseBranch || undefined
			);
		} catch (error) {
			clearRecentlyCreatedWorktreePath(worktreePath);
			throw error;
		}
		if (!result.success) {
			clearRecentlyCreatedWorktreePath(worktreePath);
			notifyToast({
				type: 'error',
				title: 'Failed to Create Worktree',
				message: result.error || 'Unknown error',
			});
			return null;
		}
		// If the branch was already attached to another worktree on disk, the main
		// process resolved its path and returned it. Open that worktree instead of
		// the requested path so the user isn't blocked by a stale registration.
		if (result.alreadyExisted && result.existingPath) {
			clearRecentlyCreatedWorktreePath(worktreePath);
			worktreePath = result.existingPath;
			notifyToast({
				type: 'info',
				title: 'Worktree Already Existed',
				message: `Opened existing worktree at ${worktreePath}`,
			});
		}
	} else {
		// existing-closed: worktree already on disk
		worktreePath = target.worktreePath!;
		// Split on either separator so Windows paths (e.g. `C:\repo\worktrees\foo`)
		// don't collapse into a single segment.
		branchName = worktreePath.split(/[\\/]/).pop() || 'worktree';
	}

	// If a session for this worktree path already exists (e.g., the resolved
	// existing worktree is already open in Maestro), reuse it instead of
	// building a duplicate. We still fall through to populate config.worktree
	// below so PR creation continues to work.
	const normalizedWorktreePath = normalizePath(worktreePath);
	const existingSession = useSessionStore
		.getState()
		.sessions.find((s) => sessionMatchesWorktreeRoot(s, normalizedWorktreePath));

	// Step 3: Fetch git info for the worktree.
	// gitService.getBranches uses createIpcMethod with defaultValue: [] and no
	// rethrow, so the IPC wrapper already logs and reports failures to Sentry.
	// We swallow any leftover rejection here without a second captureException
	// (would be a duplicate report) — git info is nice-to-have and a failure
	// must not abort the spawn flow.
	let gitBranches: string[] | undefined;
	try {
		gitBranches = await gitService.getBranches(worktreePath, sshRemoteId);
	} catch {
		gitBranches = undefined;
	}

	let dispatchSessionId: string;
	if (existingSession) {
		// Mirror the existing-open guard (handleStartBatchRun line ~392): refuse
		// to dispatch onto an in-flight agent. Without this, a recovery into a
		// busy worktree session silently queues the batch on top of an active
		// run.
		if (existingSession.state === 'busy' || existingSession.state === 'connecting') {
			notifyToast({
				type: 'warning',
				title: 'Target Agent Busy',
				message: 'Existing worktree agent is busy. Please try again.',
			});
			return null;
		}
		dispatchSessionId = existingSession.id;
	} else {
		// Step 4: Build the session
		const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
		const newSession = buildWorktreeSession({
			parentSession,
			path: worktreePath,
			branch: branchName,
			name: branchName,
			gitBranches,
			defaultSaveToHistory,
			defaultShowThinking,
		});

		// Step 5: Add session to store and expand parent's worktrees
		useSessionStore
			.getState()
			.setSessions((prev) => [
				...prev.map((s) => (s.id === parentSession.id ? { ...s, worktreesExpanded: true } : s)),
				newSession,
			]);
		dispatchSessionId = newSession.id;
	}

	// Step 6: Populate config.worktree for PR creation if requested
	if (target.createPROnCompletion) {
		config.worktree = {
			enabled: true,
			path: worktreePath,
			branchName,
			createPROnCompletion: true,
			prTargetBranch: target.baseBranch || 'main',
		};
	}

	return dispatchSessionId;
}
