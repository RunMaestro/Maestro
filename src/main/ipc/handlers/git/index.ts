import { logger } from '../../../utils/logger';
import { registerReadHandlers } from './read';
import { registerBranchHandlers } from './branch';
import { registerStreamingHandlers } from './streaming';
import { registerWorktreeHandlers } from './worktree';
import { registerCheckpointHandlers } from './checkpoint';
import { registerWorktreeWatchHandlers } from './worktreeWatch';
import { registerGithubHandlers } from './github';
import { LOG_CONTEXT, GitHandlerDependencies } from './shared';

export type { GitHandlerDependencies } from './shared';

/**
 * Register all Git-related IPC handlers.
 *
 * These handlers provide Git operations used across the application, split by
 * domain across this directory:
 * - read.ts: status, diff, log, graph, show, showFile, commitCount, getRepoRoot, etc.
 * - branch.ts: branch/tag listing, switch, checkout, init, commitAll, getDefaultBranch
 * - streaming.ts: runCommand/cancelCommand (push/pull/fetch with live progress)
 * - worktree.ts: worktree create/checkout/list/remove
 * - checkpoint.ts: worktree checkpoint create/list/restore/delete
 * - worktreeWatch.ts: worktree directory filesystem watching
 * - github.ts: gh CLI integration (createPR, checkGhCli, createGist)
 *
 * @param deps Dependencies including settingsStore for SSH remote configuration lookup
 */
export function registerGitHandlers(deps: GitHandlerDependencies): void {
	registerReadHandlers();
	registerBranchHandlers();
	registerStreamingHandlers();
	registerWorktreeHandlers();
	registerCheckpointHandlers();
	registerWorktreeWatchHandlers(deps);
	registerGithubHandlers();

	logger.debug(`${LOG_CONTEXT} Git IPC handlers registered`);
}
