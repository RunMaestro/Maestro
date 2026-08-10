import { ipcMain } from 'electron';
import { execGit } from '../../../utils/remote-git';
import { getSshRemoteById } from '../../../stores';
import { withIpcErrorLogging, createIpcHandler } from '../../../utils/ipcHandler';
import { parseGitBranches, parseGitTags } from '../../../../shared/gitUtils';
import { resolveDefaultBranch } from '../../../utils/pr-creator';
import { handlerOpts } from './shared';

/**
 * Register branch/tag/repo-mutation Git IPC handlers: init, commitAll, branch,
 * branches, tags, switch, checkoutBranch, getDefaultBranch.
 */
export function registerBranchHandlers(): void {
	// Initialize a new git repository at the given directory.
	// Returns { success, error? }. Used by the agent-create UI to offer
	// `git init` when a chosen working directory isn't already a repo.
	ipcMain.handle(
		'git:init',
		withIpcErrorLogging(
			handlerOpts('init'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				// Fail fast if an SSH remote was requested but can't be resolved -
				// otherwise we'd silently `git init` the wrong (local) directory.
				if (sshRemoteId && !sshRemote) {
					return {
						success: false,
						error: `SSH remote not found: ${sshRemoteId}`,
					};
				}
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(['init'], cwd, sshRemote, effectiveRemoteCwd);
				if (result.exitCode !== 0) {
					return {
						success: false,
						error: result.stderr?.trim() || 'git init failed',
					};
				}
				return { success: true };
			}
		)
	);

	// Stage every change (new, modified, deleted) and commit it in one shot.
	// Used by Auto Run to checkpoint each iteration. Returns
	// { success, committed, commitHash?, error? }. A clean tree is NOT an error:
	// it resolves { success: true, committed: false } so callers can no-op
	// quietly. Commit failures (e.g. missing git identity, failing hooks) surface
	// as { success: false } so the caller can log without aborting its run.
	ipcMain.handle(
		'git:commitAll',
		withIpcErrorLogging(
			handlerOpts('commitAll'),
			async (cwd: string, message: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				// Fail fast if an SSH remote was requested but can't be resolved -
				// otherwise we'd silently commit in the wrong (local) directory.
				if (sshRemoteId && !sshRemote) {
					return {
						success: false,
						committed: false,
						error: `SSH remote not found: ${sshRemoteId}`,
					};
				}
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;

				// Stage everything first so the porcelain check below reflects the
				// full pending change set (including untracked files).
				const addResult = await execGit(['add', '-A'], cwd, sshRemote, effectiveRemoteCwd);
				if (addResult.exitCode !== 0) {
					return {
						success: false,
						committed: false,
						error: addResult.stderr?.trim() || 'git add failed',
					};
				}

				// Nothing staged → clean tree, nothing to commit. Report success.
				const statusResult = await execGit(
					['status', '--porcelain'],
					cwd,
					sshRemote,
					effectiveRemoteCwd
				);
				if (statusResult.exitCode === 0 && statusResult.stdout.trim() === '') {
					return { success: true, committed: false };
				}

				const commitResult = await execGit(
					['commit', '-m', message],
					cwd,
					sshRemote,
					effectiveRemoteCwd
				);
				if (commitResult.exitCode !== 0) {
					return {
						success: false,
						committed: false,
						error:
							commitResult.stderr?.trim() || commitResult.stdout?.trim() || 'git commit failed',
					};
				}

				// Best-effort short hash for feedback/logging; absence is non-fatal.
				const hashResult = await execGit(
					['rev-parse', '--short', 'HEAD'],
					cwd,
					sshRemote,
					effectiveRemoteCwd
				);
				const commitHash = hashResult.exitCode === 0 ? hashResult.stdout.trim() : undefined;
				return { success: true, committed: true, commitHash };
			}
		)
	);

	ipcMain.handle(
		'git:branch',
		withIpcErrorLogging(
			handlerOpts('branch'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(
					['rev-parse', '--abbrev-ref', 'HEAD'],
					cwd,
					sshRemote,
					effectiveRemoteCwd
				);
				return { stdout: result.stdout.trim(), stderr: result.stderr };
			}
		)
	);

	ipcMain.handle(
		'git:branches',
		withIpcErrorLogging(
			handlerOpts('branches'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(
					['branch', '-a', '--format=%(refname:short)'],
					cwd,
					sshRemote,
					effectiveRemoteCwd
				);
				if (result.exitCode !== 0) {
					return { branches: [], stderr: result.stderr };
				}
				// Use shared parsing function
				const branches = parseGitBranches(result.stdout);
				return { branches };
			}
		)
	);

	ipcMain.handle(
		'git:tags',
		withIpcErrorLogging(
			handlerOpts('tags'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(['tag', '--list'], cwd, sshRemote, effectiveRemoteCwd);
				if (result.exitCode !== 0) {
					return { tags: [], stderr: result.stderr };
				}
				// Use shared parsing function
				const tags = parseGitTags(result.stdout);
				return { tags };
			}
		)
	);

	// Switch to an existing branch in the current working tree.
	// Returns success=false with stderr text on failure (e.g., dirty working tree).
	ipcMain.handle(
		'git:switch',
		withIpcErrorLogging(
			handlerOpts('switch'),
			async (cwd: string, branchName: string, sshRemoteId?: string, remoteCwd?: string) => {
				// Reject flag-like names so a caller can't pass e.g. "-c new-branch" or "-C"
				// and have git interpret it as a switch flag. execFile blocks shell
				// injection but not flag injection.
				if (
					typeof branchName !== 'string' ||
					branchName.length === 0 ||
					branchName.startsWith('-')
				) {
					return {
						success: false,
						stdout: '',
						stderr: `Invalid branch name: ${branchName}`,
					};
				}
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const result = await execGit(['switch', branchName], cwd, sshRemote, effectiveRemoteCwd);
				return {
					success: result.exitCode === 0,
					stdout: result.stdout,
					stderr: result.stderr,
				};
			}
		)
	);

	// Switch the working tree to another branch. `createTracking` checks out a
	// remote-only branch (`git checkout -b <name> --track origin/<name>`), which
	// is what the branch switcher needs for branches that exist only on origin.
	ipcMain.handle(
		'git:checkoutBranch',
		withIpcErrorLogging(
			handlerOpts('checkoutBranch'),
			async (
				cwd: string,
				branch: string,
				createTracking?: boolean,
				sshRemoteId?: string,
				remoteCwd?: string
			) => {
				const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				// The user opted into SSH; silently checking out the local repo
				// instead would switch the wrong working tree.
				if (sshRemoteId && !sshRemote) {
					return { success: false, error: `SSH remote not found: ${sshRemoteId}` };
				}
				const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;
				const args = createTracking
					? ['checkout', '-b', branch, '--track', `origin/${branch}`]
					: ['checkout', branch];
				const result = await execGit(args, cwd, sshRemote, effectiveRemoteCwd);
				if (result.exitCode !== 0) {
					return {
						success: false,
						error: result.stderr?.trim() || result.stdout?.trim() || 'git checkout failed',
					};
				}
				// git checkout reports "Switched to branch 'x'" on stderr.
				return { success: true, output: (result.stderr || result.stdout).trim() };
			}
		)
	);

	// Get the default branch name (main or master)
	ipcMain.handle(
		'git:getDefaultBranch',
		createIpcHandler(handlerOpts('getDefaultBranch'), async (cwd: string) => {
			// Shared with pr-creator.ts, which needs the same resolution when a
			// caller opens a PR without an explicit base branch.
			const branch = await resolveDefaultBranch(cwd);
			if (!branch) {
				throw new Error('Could not determine default branch');
			}
			return { branch };
		})
	);
}
