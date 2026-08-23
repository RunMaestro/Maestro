/**
 * useGitAgentActions - the git actions available for a single agent.
 *
 * Two surfaces offer the same set: the header branch pill dropdown
 * (`GitPillMenu`) and the Left Bar right-click menu (`SessionContextMenu`).
 * Both call this hook rather than re-deriving the repo path, the SSH remote,
 * and the modal-opening calls, so the two menus can't drift apart.
 *
 * Every action opens a modal through the modal store directly, which keeps the
 * callers free of prop drilling and lets the Left Bar act on an agent that
 * isn't the active one.
 */

import { useCallback, useMemo } from 'react';
import { useModalStore } from '../../stores/modalStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useGitBranch, useGitDetail, useGitFileStatus } from '../../contexts/GitStatusContext';
import { gitService } from '../../services/git';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { useGitRunActive } from '../../stores/gitCommandRunStore';
import type { GitChangeTotals, GitStreamingOperation } from '../../../shared/gitUtils';
import type { Session } from '../../types';

export interface GitAgentActions {
	/** False for non-git agents - callers should render nothing. */
	isGitRepo: boolean;
	/** Current branch, when git status polling has seen this agent. */
	branch: string | undefined;
	/** Commits ahead of upstream (0 when unknown). */
	ahead: number;
	/** Commits behind upstream (0 when unknown). */
	behind: number;
	/**
	 * Uncommitted-change totals for this agent's tree, so every git surface can
	 * badge "there is a diff here" instead of offering a diff that may be empty.
	 * Line counts are zero for non-active agents - see `GitChangeTotals`.
	 */
	changes: GitChangeTotals;
	/** Whether opening a PR makes sense for this agent (needs a branch). */
	canCreatePR: boolean;
	viewLog: () => void;
	/**
	 * Fetch the working-tree diff and open the viewer. Async because the diff has
	 * to be read before there's anything to show; resolves once the modal is open
	 * (or once the "nothing to diff" flash has fired).
	 */
	viewDiff: () => Promise<void>;
	pull: () => void;
	push: () => void;
	/**
	 * True while a `git pull` / `git push` started from this agent's repo is
	 * still running, including after its console was dismissed with Run in
	 * Background. Menus badge the row with it; clicking the row re-opens the
	 * console attached to that same run.
	 */
	pullRunning: boolean;
	pushRunning: boolean;
	switchBranch: () => void;
	createPR: () => void;
	/**
	 * Open the worktree configuration modal for this agent. Activates the agent
	 * first, because the modal reads the active session.
	 */
	configureWorktrees: () => void;
	/**
	 * Whether worktree config applies. False for worktree children, which can't
	 * own a config of their own.
	 */
	canConfigureWorktrees: boolean;
}

/**
 * Resolve the directory git commands should run in. Terminal-mode agents can
 * have cd'd elsewhere, so their live shell cwd wins over the configured one.
 */
export function resolveGitCwd(session: Session): string {
	return session.inputMode === 'terminal' ? session.shellCwd || session.cwd : session.cwd;
}

/**
 * Resolve the SSH remote id for an agent, covering both the legacy top-level
 * field and the per-session config.
 */
export function resolveGitSshRemoteId(session: Session): string | undefined {
	return (
		session.sshRemoteId ||
		(session.sessionSshRemoteConfig?.enabled
			? session.sessionSshRemoteConfig.remoteId
			: undefined) ||
		undefined
	);
}

export function useGitAgentActions(session: Session | null | undefined): GitAgentActions {
	const { getBranchInfo } = useGitBranch();
	const { getFileDetails, refreshGitStatus } = useGitDetail();
	const { getFileCount } = useGitFileStatus();
	const branchInfo = session ? getBranchInfo(session.id) : undefined;
	const fileDetails = session ? getFileDetails(session.id) : undefined;
	const fileCount = session ? getFileCount(session.id) : 0;

	const changes = useMemo<GitChangeTotals>(
		() => ({
			fileCount,
			additions: fileDetails?.totalAdditions ?? 0,
			deletions: fileDetails?.totalDeletions ?? 0,
			modified: fileDetails?.modifiedCount ?? 0,
		}),
		[
			fileCount,
			fileDetails?.totalAdditions,
			fileDetails?.totalDeletions,
			fileDetails?.modifiedCount,
		]
	);

	const target = useMemo(() => {
		if (!session) return null;
		return {
			sessionId: session.id,
			cwd: resolveGitCwd(session),
			sshRemoteId: resolveGitSshRemoteId(session),
		};
	}, [
		session?.id,
		session?.inputMode,
		session?.shellCwd,
		session?.cwd,
		session?.sshRemoteId,
		session?.sessionSshRemoteConfig?.enabled,
		session?.sessionSshRemoteConfig?.remoteId,
	]);

	const branch = branchInfo?.branch || session?.worktreeBranch || undefined;

	const viewLog = useCallback(() => {
		if (!target) return;
		// The viewer defaults to the active agent's repo; passing the path
		// explicitly is what lets the Left Bar open the log for another agent.
		useModalStore.getState().openModal('gitLog', {
			cwd: target.cwd,
			sshRemoteId: target.sshRemoteId,
		});
	}, [target]);

	const viewDiff = useCallback(async () => {
		if (!target) return;
		const { diff } = await gitService.getDiff(target.cwd, undefined, target.sshRemoteId);
		if (diff) {
			// Pass the repo path so the viewer opens clicked files against THIS
			// agent's tree, not whichever agent happens to be active.
			useModalStore.getState().openModal('gitDiff', { diff, cwd: target.cwd });
			return;
		}
		// Same wording as the Cmd+Shift+D path and the command palette.
		notifyCenterFlash({ message: 'No diff to examine', color: 'theme' });
		// Polling said there were changes but `git diff` came back empty, so the
		// cached stats are stale - re-sync rather than leave the widget lying.
		void refreshGitStatus();
	}, [target, refreshGitStatus]);

	const runCommand = useCallback(
		(operation: GitStreamingOperation) => {
			if (!target) return;
			useModalStore.getState().openModal('gitCommandRunner', {
				sessionId: target.sessionId,
				operation,
				cwd: target.cwd,
				sshRemoteId: target.sshRemoteId,
				branch,
			});
		},
		[target, branch]
	);

	const pull = useCallback(() => runCommand('pull'), [runCommand]);
	const push = useCallback(() => runCommand('push'), [runCommand]);

	// Keyed on the same repo + operation the run store uses, so a run started
	// from any surface (or from a different agent on the same worktree) shows up
	// here too.
	const pullRunning = useGitRunActive(target ? { ...target, operation: 'pull' } : null);
	const pushRunning = useGitRunActive(target ? { ...target, operation: 'push' } : null);

	const switchBranch = useCallback(() => {
		if (!target) return;
		useModalStore.getState().openModal('branchSwitcher', {
			sessionId: target.sessionId,
			cwd: target.cwd,
			sshRemoteId: target.sshRemoteId,
			currentBranch: branch,
		});
	}, [target, branch]);

	const createPR = useCallback(() => {
		if (!session) return;
		// Pass the live branch: a plain git agent has no `worktreeBranch` for the
		// PR modal to fall back on.
		useModalStore.getState().openModal('createPR', { session, sourceBranch: branch });
	}, [session, branch]);

	const configureWorktrees = useCallback(() => {
		if (!session) return;
		// The config modal renders against the active session, so activating is
		// part of targeting it - same order handleOpenWorktreeConfigSession uses.
		useSessionStore.getState().setActiveSessionId(session.id);
		useModalStore.getState().openModal('worktreeConfig');
	}, [session]);

	return {
		isGitRepo: Boolean(session?.isGitRepo),
		branch,
		ahead: branchInfo?.ahead ?? 0,
		behind: branchInfo?.behind ?? 0,
		changes,
		// A PR needs a source branch to push. Worktree children always have one;
		// plain git agents get theirs from status polling.
		canCreatePR: Boolean(session?.isGitRepo && branch),
		viewLog,
		viewDiff,
		pull,
		push,
		pullRunning,
		pushRunning,
		switchBranch,
		createPR,
		configureWorktrees,
		// Worktree children can't own a worktree config of their own.
		canConfigureWorktrees: Boolean(session?.isGitRepo && !session.parentSessionId),
	};
}
