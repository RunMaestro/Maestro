import type { BrowserWindow } from 'electron';
import { CreateHandlerOptions } from '../../../utils/ipcHandler';
import type { BranchSwitchGuardDeps } from '../../../utils/branch-switch-guard';
import type { ExecResult } from '../../../utils/execFile';
import { isGitTimeout } from '../../../utils/remote-git';

export const LOG_CONTEXT = '[Git]';

/**
 * Dependencies for Git handlers
 */
export interface GitHandlerDependencies {
	/** Settings store for accessing SSH remote configurations */
	settingsStore: {
		get: (key: string, defaultValue?: unknown) => unknown;
	};
	/**
	 * Returns the current main window (or null). Used to route worktree
	 * watcher events through safeSend so web-desktop bridge clients receive
	 * them alongside the desktop renderer.
	 */
	getMainWindow: () => BrowserWindow | null;
	/** Live processes, so a branch switch can refuse while an agent works in the tree. */
	getProcessManager?: BranchSwitchGuardDeps['getProcessManager'];
	/** Agent name for an agent id, for the refusal message. */
	getAgentName?: BranchSwitchGuardDeps['getAgentName'];
}

/** Helper to create handler options with Git context */
export const handlerOpts = (operation: string, logSuccess = false): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Reply shape for the polled read-only channels (status, numstat, branch).
 * `timedOut` is present only when git did not answer, so the renderer can keep
 * its last good value instead of reading the empty stdout as "no changes" or
 * "no branch".
 */
export function readOnlyGitReply(
	result: ExecResult,
	options: { trim?: boolean } = {}
): { stdout: string; stderr: string; timedOut?: boolean } {
	const reply = {
		stdout: options.trim ? result.stdout.trim() : result.stdout,
		stderr: result.stderr,
	};
	return isGitTimeout(result) ? { ...reply, timedOut: true } : reply;
}
