/**
 * Per-card git worktree provisioning (Board Phase 4).
 *
 * A card that carries a {@link WorktreeRef} runs in its own checkout instead of
 * the shared project root, so two cards dispatched in the same tick cannot step
 * on each other's edits or git state.
 *
 * Lifecycle (the rule both the desktop and CLI dispatch paths follow):
 *   - **created lazily**, on the first claim that actually spawns the card;
 *   - **reused** by every later attempt (retries land in the same branch, so a
 *     retry continues the work instead of starting from a clean tree);
 *   - **never auto-deleted and never auto-merged** - a finished branch is left
 *     on disk for the user to review, merge, and remove.
 *
 * Provisioning delegates to `setupWorktreeLocal` (`src/main/utils/git-worktree`),
 * the SAME implementation the `git:worktreeSetup` IPC handler uses for Auto Run.
 * No `git worktree` shell calls are hand-rolled here.
 *
 * Electron-free on purpose: `board tick` in the CLI imports this module directly.
 */

import type { WorktreeRef } from '../../shared/board/types';
import { boardWorktreePath } from '../../shared/board/worktree';
import { setupWorktreeLocal } from '../utils/git-worktree';

/** Outcome of {@link ensureCardWorktree}. */
export type EnsureWorktreeResult =
	| { ok: true; path: string; branch: string }
	| { ok: false; reason: string };

/** Reason text used when a card asks for isolation on an SSH-remote agent. */
export const WORKTREE_SSH_UNSUPPORTED =
	'worktree isolation is not supported on SSH remotes yet - clear the card worktree or move it to a local agent';

/**
 * Create (or reuse) the worktree a card should run in, returning the resolved
 * checkout path and branch.
 *
 * `ref.branch` is optional on a hand-written card; when it is missing the
 * worktree is created detached from the ref path alone, which git cannot do -
 * so a missing branch is a hard failure with a readable reason rather than a
 * silent fallback to the project root.
 */
export async function ensureCardWorktree(
	projectRoot: string,
	ref: WorktreeRef
): Promise<EnsureWorktreeResult> {
	const branch = ref.branch?.trim();
	if (!branch) {
		return {
			ok: false,
			reason: 'card worktree is missing a branch name (set one on the card or re-enable isolation)',
		};
	}
	// A card may carry only a branch (or a path that predates the sibling-layout
	// convention); derive the conventional path so provisioning still works.
	const requestedPath = ref.path?.trim() || boardWorktreePath(projectRoot, branch);

	const result = await setupWorktreeLocal(projectRoot, requestedPath, branch);
	if (!result.success) {
		return { ok: false, reason: result.error || 'failed to create worktree' };
	}
	// The branch was already attached to another checkout: reuse that one rather
	// than failing, exactly as the Auto Run path does.
	const resolvedPath =
		result.alreadyExisted && result.existingPath ? result.existingPath : requestedPath;
	if (result.branchMismatch) {
		return {
			ok: false,
			reason: `worktree at ${resolvedPath} is on branch "${result.currentBranch}", not "${branch}"`,
		};
	}
	return { ok: true, path: resolvedPath, branch };
}
