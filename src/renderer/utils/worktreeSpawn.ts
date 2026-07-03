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
	sessionOwnedByParent,
} from './worktreeDedup';
import { sanitizeGitBranchName } from '../../shared/gitUtils';

/**
 * TTL for the pre-`git worktree add` dedup mark. Sized to comfortably outlast a
 * slow worktree creation (large repo, cold disk, SSH remote) so the mark can't
 * expire mid-setup and let a watcher adopt the worktree under the wrong parent.
 * The success path re-marks with the default (short) TTL once setup completes,
 * and the error/already-existed branches clear the path, so this window never
 * outlives the operation it guards.
 */
const WORKTREE_SETUP_MARK_TTL_MS = 60000;

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
		// skips this path and doesn't create a duplicate session. Use a generous TTL:
		// `git worktree add` below can outrun the default 10s window on a large repo,
		// cold disk, or SSH remote, and if this mark expired mid-`await` the
		// main-process chokidar debounce could emit `worktree:discovered` before the
		// re-mark on the resolved path runs - letting a sibling watcher adopt the
		// worktree under the wrong parent. The error and already-existed branches
		// clear this path explicitly, and the success path re-marks with the default
		// TTL, so the long window never outlives the setup it guards.
		markWorktreePathAsRecentlyCreated(worktreePath, WORKTREE_SETUP_MARK_TTL_MS);

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

		// Refresh the dedup mark on the RESOLVED path. Two reasons this is not
		// redundant with the mark above:
		//   1. The original 10s TTL started BEFORE `git worktree add`, which can be
		//      slow (large repo, cold disk, SSH remote). The chokidar discovery then
		//      fires during the `getBranches`/`buildWorktreeSession` window below,
		//      AFTER the mark has aged out, letting a sibling agent watching the
		//      same basePath adopt this worktree under the wrong parent (PR #946).
		//   2. When the branch was already attached elsewhere, `worktreePath` was
		//      reassigned to `result.existingPath`, which the original mark (and the
		//      clear just above) never covered.
		// Re-marking restarts the TTL from after the slow disk operation, so the
		// mark stays live until the owning session is committed to the store below.
		// Only for create-new: existing-closed worktrees are already on disk and
		// fire no addDir event, so there is nothing to race with.
		markWorktreePathAsRecentlyCreated(worktreePath);
	} else {
		// existing-closed: worktree already on disk
		worktreePath = target.worktreePath!;
		// Split on either separator so Windows paths (e.g. `C:\repo\worktrees\foo`)
		// don't collapse into a single segment.
		branchName = worktreePath.split(/[\\/]/).pop() || 'worktree';
	}

	// If a session OWNED BY THIS PARENT already exists for this worktree path
	// (e.g., a prior Auto Run against the same existing worktree), reuse it
	// instead of building a duplicate. The match is scoped to the launching
	// parent on purpose: a same-repo sibling agent may own its own child at this
	// cwd, and dispatching this parent's Auto Run onto the sibling's child would
	// reproduce the wrong-parent attribution this flow exists to prevent. When no
	// owned session matches we fall through and build a fresh child for the
	// launching parent below. Either way we still populate config.worktree so PR
	// creation continues to work.
	const normalizedWorktreePath = normalizePath(worktreePath);
	const existingSession = useSessionStore
		.getState()
		.sessions.find(
			(s) =>
				sessionOwnedByParent(s, parentSession) &&
				sessionMatchesWorktreeRoot(s, normalizedWorktreePath)
		);

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
