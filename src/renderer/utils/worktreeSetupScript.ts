/**
 * Post-create worktree setup script.
 *
 * Every path that creates a worktree on disk (config modal, create-worktree
 * modal, Auto Run spawn, batch runner) funnels through here afterwards so a
 * single user-configured command - copy `.env.local` in, run `setup.sh`,
 * install dependencies - runs consistently in the new worktree.
 *
 * The script lives on the parent agent's `worktreeConfig`; a blank one is a
 * no-op, which is the common case.
 */

import type { Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { normalizePath } from './worktreeDedup';

interface RunWorktreeSetupScriptArgs {
	/** Parent agent that owns the worktree config. Falls back to a lookup by `mainRepoPath`. */
	parentSession?: Session | null;
	/** Absolute path of the main repository the worktree was created from */
	mainRepoPath: string;
	/** Absolute path of the freshly created worktree */
	worktreePath: string;
	/** Branch checked out in the new worktree */
	branchName: string;
	/** Base branch the new branch was rooted at, when one was specified */
	baseBranch?: string;
	/** SSH remote to run the script on, for remote worktrees */
	sshRemoteId?: string;
}

/**
 * Find the agent whose worktree config should drive setup for a given main repo.
 *
 * The batch runner only knows the repo cwd, so this resolves the owning parent
 * agent from the store instead of threading the session through every layer.
 */
function findParentSessionByRepoPath(mainRepoPath: string): Session | undefined {
	const normalized = normalizePath(mainRepoPath);
	return useSessionStore
		.getState()
		.sessions.find(
			(s) => !s.parentSessionId && s.worktreeConfig && normalizePath(s.cwd) === normalized
		);
}

/**
 * Run the parent agent's configured setup script inside a newly created worktree.
 *
 * Failures are surfaced as a toast and swallowed: the worktree and its agent are
 * already usable, and a broken setup script shouldn't abort the spawn flow.
 *
 * @returns true when a script ran and succeeded, false otherwise
 */
export async function runWorktreeSetupScript({
	parentSession,
	mainRepoPath,
	worktreePath,
	branchName,
	baseBranch,
	sshRemoteId,
}: RunWorktreeSetupScriptArgs): Promise<boolean> {
	const owner = parentSession ?? findParentSessionByRepoPath(mainRepoPath);
	const script = owner?.worktreeConfig?.setupScript?.trim();
	if (!script) return false;

	try {
		const result = await window.maestro.git.worktreeRunSetup(
			script,
			{ worktreePath, branchName, mainRepoPath, baseBranch },
			sshRemoteId
		);

		if (!result.ran) return false;

		if (!result.success) {
			notifyToast({
				type: 'error',
				title: 'Worktree Setup Script Failed',
				message: result.error || 'Setup script exited with an error',
			});
			return false;
		}

		notifyToast({
			type: 'success',
			title: 'Worktree Setup Complete',
			message: `Setup script finished for ${branchName}`,
		});
		return true;
	} catch (err) {
		notifyToast({
			type: 'error',
			title: 'Worktree Setup Script Failed',
			message: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}
