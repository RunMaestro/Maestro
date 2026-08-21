import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { execFileNoThrow } from '../../../utils/execFile';
import { logger } from '../../../utils/logger';
import { getSshRemoteById } from '../../../stores';
import { withIpcErrorLogging, createIpcHandler } from '../../../utils/ipcHandler';
import {
	isWorktreeAlreadyUsedError,
	parseWorktreePathForBranch,
} from '../../../../shared/gitUtils';
import {
	worktreeInfoRemote,
	worktreeSetupRemote,
	worktreeCheckoutRemote,
	listWorktreesRemote,
} from '../../../utils/remote-git';
import { markStaleForDeletedWorktreeUsingStore } from '../../../agent-run/worktree-stale';
import { runWorktreeSetupScript } from '../../../utils/worktree-setup-script';
import type { SshRemoteConfig } from '../../../../shared/types';
import { LOG_CONTEXT, handlerOpts } from './shared';

/**
 * Look up the worktree path currently checked out on the given branch
 * by running `git worktree list --porcelain` against the local repo.
 *
 * Used to recover from `git worktree add` failures with the "already used /
 * already checked out" error: instead of bubbling up an opaque error, we
 * return the existing worktree path so callers can open it as a session.
 *
 * Stale registrations (where the directory was deleted manually without
 * `git worktree prune`) are filtered out by an `fs.access` check so callers
 * never get a path that points at nothing.
 *
 * @returns Absolute worktree path, or null if not found / stale
 */
async function findLocalWorktreeForBranch(
	mainRepoCwd: string,
	branchName: string
): Promise<string | null> {
	const result = await execFileNoThrow('git', ['worktree', 'list', '--porcelain'], mainRepoCwd);
	if (result.exitCode !== 0) return null;
	const existingPath = parseWorktreePathForBranch(result.stdout, branchName);
	if (!existingPath) return null;
	try {
		await fs.access(existingPath);
		return existingPath;
	} catch {
		return null;
	}
}

/**
 * Register worktree lifecycle Git IPC handlers: worktreeInfo, worktreeSetup,
 * worktreeCheckout, listWorktrees, removeWorktree.
 *
 * Filesystem watching (scanWorktreeDirectory, watchWorktreeDirectory,
 * unwatchWorktreeDirectory) lives in ./worktreeWatch.ts instead - it carries
 * its own module-level watcher state and is a distinct concern from
 * create/checkout/list/remove.
 */
export function registerWorktreeHandlers(): void {
	// Git worktree operations for Auto Run parallelization

	// Get information about a worktree at a given path
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'git:worktreeInfo',
		createIpcHandler(
			handlerOpts('worktreeInfo'),
			async (worktreePath: string, sshRemoteId?: string) => {
				// SSH remote: dispatch to remote git operations
				if (sshRemoteId) {
					const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
					logger.debug(`${LOG_CONTEXT} worktreeInfo via SSH: ${worktreePath}`, LOG_CONTEXT);
					const result = await worktreeInfoRemote(worktreePath, sshConfig);
					if (!result.success || !result.data) {
						throw new Error(result.error || 'Remote worktreeInfo failed');
					}
					return result.data;
				}

				// Local execution (existing code)
				// Check if the path exists
				try {
					await fs.access(worktreePath);
				} catch {
					return { exists: false, isWorktree: false };
				}

				// Check if it's a git directory (could be main repo or worktree)
				const isInsideWorkTree = await execFileNoThrow(
					'git',
					['rev-parse', '--is-inside-work-tree'],
					worktreePath
				);
				if (isInsideWorkTree.exitCode !== 0) {
					return { exists: true, isWorktree: false };
				}

				// Run git queries in parallel to reduce latency
				const [gitDirResult, gitCommonDirResult, branchResult, repoRootResult] = await Promise.all([
					execFileNoThrow('git', ['rev-parse', '--git-dir'], worktreePath),
					execFileNoThrow('git', ['rev-parse', '--git-common-dir'], worktreePath),
					execFileNoThrow('git', ['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath),
					execFileNoThrow('git', ['rev-parse', '--show-toplevel'], worktreePath),
				]);
				if (gitDirResult.exitCode !== 0) {
					throw new Error('Failed to get git directory');
				}
				const gitDir = gitDirResult.stdout.trim();

				const gitCommonDir =
					gitCommonDirResult.exitCode === 0 ? gitCommonDirResult.stdout.trim() : gitDir;

				// If git-dir and git-common-dir are different, this is a worktree
				const isWorktree = gitDir !== gitCommonDir;

				const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;

				let repoRoot: string | undefined;

				if (isWorktree && gitCommonDir) {
					// For worktrees, we need to find the main repo root from the common dir
					// The common dir points to the .git folder of the main repo
					// The main repo root is the parent of the .git folder
					const commonDirAbs = path.isAbsolute(gitCommonDir)
						? gitCommonDir
						: path.resolve(worktreePath, gitCommonDir);
					repoRoot = path.dirname(commonDirAbs);
				} else if (repoRootResult.exitCode === 0) {
					repoRoot = repoRootResult.stdout.trim();
				}

				return {
					exists: true,
					isWorktree,
					currentBranch,
					repoRoot,
				};
			}
		)
	);

	// Create or reuse a worktree
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'git:worktreeSetup',
		withIpcErrorLogging(
			handlerOpts('worktreeSetup'),
			async (
				mainRepoCwd: string,
				worktreePath: string,
				branchName: string,
				sshRemoteId?: string,
				baseBranch?: string
			) => {
				// SSH remote: dispatch to remote git operations
				if (sshRemoteId) {
					const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
					logger.debug(
						`${LOG_CONTEXT} worktreeSetup via SSH: ${JSON.stringify({ mainRepoCwd, worktreePath, branchName, baseBranch })}`,
						LOG_CONTEXT
					);
					const result = await worktreeSetupRemote(
						mainRepoCwd,
						worktreePath,
						branchName,
						sshConfig,
						baseBranch
					);
					if (!result.success) {
						throw new Error(result.error || 'Remote worktreeSetup failed');
					}
					return result.data;
				}

				// Local execution (existing code)
				logger.debug(
					`worktreeSetup called with: ${JSON.stringify({ mainRepoCwd, worktreePath, branchName, baseBranch })}`,
					LOG_CONTEXT
				);

				// Resolve paths to absolute for proper comparison
				const resolvedMainRepo = path.resolve(mainRepoCwd);
				const resolvedWorktree = path.resolve(worktreePath);
				logger.debug(
					`Resolved paths: ${JSON.stringify({ resolvedMainRepo, resolvedWorktree })}`,
					LOG_CONTEXT
				);

				// Check if worktree path is inside the main repo (nested worktree)
				// This can cause issues because git and Claude Code search upward for .git
				// and may resolve to the parent repo instead of the worktree
				if (resolvedWorktree.startsWith(resolvedMainRepo + path.sep)) {
					return {
						success: false,
						error:
							'Worktree path cannot be inside the main repository. Please use a sibling directory (e.g., ../my-worktree) instead.',
					};
				}

				// First check if the worktree path already exists
				let pathExists = true;
				try {
					await fs.access(resolvedWorktree);
					logger.debug(`Path exists: ${resolvedWorktree}`, LOG_CONTEXT);
				} catch {
					pathExists = false;
					logger.debug(`Path does not exist: ${resolvedWorktree}`, LOG_CONTEXT);
				}

				if (pathExists) {
					// Check if it's already a worktree of this repo
					const worktreeInfoResult = await execFileNoThrow(
						'git',
						['rev-parse', '--is-inside-work-tree'],
						resolvedWorktree
					);
					logger.debug(
						`is-inside-work-tree result: ${JSON.stringify(worktreeInfoResult)}`,
						LOG_CONTEXT
					);
					if (worktreeInfoResult.exitCode !== 0) {
						// Path exists but isn't a git repo - check if it's empty and can be removed
						const dirContents = await fs.readdir(resolvedWorktree);
						logger.debug(`Directory contents: ${JSON.stringify(dirContents)}`, LOG_CONTEXT);
						if (dirContents.length === 0) {
							// Empty directory - remove it so we can create the worktree
							logger.debug(`Removing empty directory`, LOG_CONTEXT);
							await fs.rmdir(resolvedWorktree);
							pathExists = false;
						} else {
							logger.debug(`Directory not empty, returning error`, LOG_CONTEXT);
							return {
								success: false,
								error: 'Path exists but is not a git worktree or repository (and is not empty)',
							};
						}
					}
				}

				if (pathExists) {
					// Get the common dir to check if it's the same repo (parallel)
					const [gitCommonDirResult, mainGitDirResult] = await Promise.all([
						execFileNoThrow('git', ['rev-parse', '--git-common-dir'], resolvedWorktree),
						execFileNoThrow('git', ['rev-parse', '--git-dir'], resolvedMainRepo),
					]);

					if (gitCommonDirResult.exitCode === 0 && mainGitDirResult.exitCode === 0) {
						const worktreeCommonDir = path.resolve(
							resolvedWorktree,
							gitCommonDirResult.stdout.trim()
						);
						const mainGitDir = path.resolve(resolvedMainRepo, mainGitDirResult.stdout.trim());

						// Normalize paths for comparison
						const normalizedWorktreeCommon = path.normalize(worktreeCommonDir);
						const normalizedMainGit = path.normalize(mainGitDir);

						if (normalizedWorktreeCommon !== normalizedMainGit) {
							return { success: false, error: 'Worktree path belongs to a different repository' };
						}
					}

					// Get current branch in the existing worktree
					const currentBranchResult = await execFileNoThrow(
						'git',
						['rev-parse', '--abbrev-ref', 'HEAD'],
						worktreePath
					);
					const currentBranch =
						currentBranchResult.exitCode === 0 ? currentBranchResult.stdout.trim() : '';

					return {
						success: true,
						created: false,
						currentBranch,
						requestedBranch: branchName,
						branchMismatch: currentBranch !== branchName && branchName !== '',
					};
				}

				// Worktree doesn't exist, create it
				// First check if the branch exists
				const branchExistsResult = await execFileNoThrow(
					'git',
					['rev-parse', '--verify', branchName],
					mainRepoCwd
				);
				const branchExists = branchExistsResult.exitCode === 0;

				let createResult;
				if (branchExists) {
					// Branch exists, just add worktree pointing to it. baseBranch is
					// ignored here because the existing branch already has its own commit.
					createResult = await execFileNoThrow(
						'git',
						['worktree', 'add', worktreePath, branchName],
						mainRepoCwd
					);
				} else if (baseBranch) {
					// Branch doesn't exist; create it from the requested base branch.
					// `git worktree add -b <new> <path> <base>` is the explicit form.
					createResult = await execFileNoThrow(
						'git',
						['worktree', 'add', '-b', branchName, worktreePath, baseBranch],
						mainRepoCwd
					);
				} else {
					// Branch doesn't exist and no base specified; defaults to current HEAD
					// of the main repo (preserves pre-baseBranch behavior).
					createResult = await execFileNoThrow(
						'git',
						['worktree', 'add', '-b', branchName, worktreePath],
						mainRepoCwd
					);
				}

				if (createResult.exitCode !== 0) {
					// Recover from "already used / already checked out" - the branch is
					// already registered with another worktree on disk. Resolve that path
					// from `git worktree list --porcelain` so the caller can open it.
					const errMsg = createResult.stderr || '';
					if (isWorktreeAlreadyUsedError(errMsg)) {
						const existingPath = await findLocalWorktreeForBranch(mainRepoCwd, branchName);
						if (existingPath) {
							return {
								success: true,
								created: false,
								alreadyExisted: true,
								existingPath,
								currentBranch: branchName,
								requestedBranch: branchName,
								branchMismatch: false,
							};
						}
					}
					return { success: false, error: createResult.stderr || 'Failed to create worktree' };
				}

				return {
					success: true,
					created: true,
					currentBranch: branchName,
					requestedBranch: branchName,
					branchMismatch: false,
				};
			}
		)
	);

	// Run the agent's configured post-create setup script inside a new worktree.
	// Callers invoke this right after `worktreeSetup` reports a freshly created
	// worktree; a blank script is a no-op (ran: false).
	// Supports SSH remote execution via optional sshRemoteId parameter.
	ipcMain.handle(
		'git:worktreeRunSetup',
		withIpcErrorLogging(
			handlerOpts('worktreeRunSetup'),
			async (
				script: string,
				context: {
					worktreePath: string;
					branchName: string;
					mainRepoPath: string;
					baseBranch?: string;
				},
				sshRemoteId?: string
			) => {
				let sshConfig: SshRemoteConfig | undefined;
				if (sshRemoteId) {
					sshConfig = getSshRemoteById(sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
				}
				return runWorktreeSetupScript(script, context, sshConfig);
			}
		)
	);

	// Checkout a branch in a worktree (with uncommitted changes check)
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'git:worktreeCheckout',
		withIpcErrorLogging(
			handlerOpts('worktreeCheckout'),
			async (
				worktreePath: string,
				branchName: string,
				createIfMissing: boolean,
				sshRemoteId?: string
			) => {
				// SSH remote: dispatch to remote git operations
				if (sshRemoteId) {
					const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
					logger.debug(
						`${LOG_CONTEXT} worktreeCheckout via SSH: ${JSON.stringify({ worktreePath, branchName, createIfMissing })}`,
						LOG_CONTEXT
					);
					const result = await worktreeCheckoutRemote(
						worktreePath,
						branchName,
						createIfMissing,
						sshConfig
					);
					if (!result.success) {
						throw new Error(result.error || 'Remote worktreeCheckout failed');
					}
					return result.data;
				}

				// Local execution (existing code)
				// Check for uncommitted changes
				const statusResult = await execFileNoThrow('git', ['status', '--porcelain'], worktreePath);
				if (statusResult.exitCode !== 0) {
					return {
						success: false,
						hasUncommittedChanges: false,
						error: 'Failed to check git status',
					};
				}

				const uncommittedChanges = statusResult.stdout.trim().length > 0;
				if (uncommittedChanges) {
					return {
						success: false,
						hasUncommittedChanges: true,
						error: 'Worktree has uncommitted changes. Please commit or stash them first.',
					};
				}

				// Check if branch exists
				const branchExistsResult = await execFileNoThrow(
					'git',
					['rev-parse', '--verify', branchName],
					worktreePath
				);
				const branchExists = branchExistsResult.exitCode === 0;

				let checkoutResult;
				if (branchExists) {
					checkoutResult = await execFileNoThrow('git', ['checkout', branchName], worktreePath);
				} else if (createIfMissing) {
					checkoutResult = await execFileNoThrow(
						'git',
						['checkout', '-b', branchName],
						worktreePath
					);
				} else {
					return {
						success: false,
						hasUncommittedChanges: false,
						error: `Branch '${branchName}' does not exist`,
					};
				}

				if (checkoutResult.exitCode !== 0) {
					return {
						success: false,
						hasUncommittedChanges: false,
						error: checkoutResult.stderr || 'Checkout failed',
					};
				}

				return { success: true, hasUncommittedChanges: false };
			}
		)
	);

	// List all worktrees for a git repository
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'git:listWorktrees',
		createIpcHandler(handlerOpts('listWorktrees'), async (cwd: string, sshRemoteId?: string) => {
			// SSH remote: dispatch to remote git operations
			if (sshRemoteId) {
				const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				logger.debug(`${LOG_CONTEXT} listWorktrees via SSH: ${cwd}`, LOG_CONTEXT);
				const result = await listWorktreesRemote(cwd, sshConfig);
				if (!result.success) {
					throw new Error(result.error || 'Remote listWorktrees failed');
				}
				return { worktrees: result.data };
			}

			// Local execution (existing code)
			// Run git worktree list --porcelain for machine-readable output
			const result = await execFileNoThrow('git', ['worktree', 'list', '--porcelain'], cwd);
			if (result.exitCode !== 0) {
				// Not a git repo or no worktree support
				return { worktrees: [] };
			}

			// Parse porcelain output:
			// worktree /path/to/worktree
			// HEAD abc123
			// branch refs/heads/branch-name
			// (blank line separates entries)
			const worktrees: Array<{
				path: string;
				head: string;
				branch: string | null;
				isBare: boolean;
			}> = [];

			const lines = result.stdout.split('\n');
			let current: { path?: string; head?: string; branch?: string | null; isBare?: boolean } = {};

			for (const line of lines) {
				if (line.startsWith('worktree ')) {
					current.path = line.substring(9);
				} else if (line.startsWith('HEAD ')) {
					current.head = line.substring(5);
				} else if (line.startsWith('branch ')) {
					// Extract branch name from refs/heads/branch-name
					const branchRef = line.substring(7);
					current.branch = branchRef.replace('refs/heads/', '');
				} else if (line === 'bare') {
					current.isBare = true;
				} else if (line === 'detached') {
					current.branch = null; // Detached HEAD
				} else if (line === '' && current.path) {
					// End of entry
					worktrees.push({
						path: current.path,
						head: current.head || '',
						branch: current.branch ?? null,
						isBare: current.isBare || false,
					});
					current = {};
				}
			}

			// Handle last entry if no trailing newline
			if (current.path) {
				worktrees.push({
					path: current.path,
					head: current.head || '',
					branch: current.branch ?? null,
					isBare: current.isBare || false,
				});
			}

			return { worktrees };
		})
	);

	// Remove a worktree directory from disk
	// Uses `git worktree remove` if it's a git worktree, or falls back to recursive delete
	ipcMain.handle(
		'git:removeWorktree',
		withIpcErrorLogging(
			handlerOpts('removeWorktree'),
			async (worktreePath: string, force: boolean = false) => {
				try {
					// First check if the directory exists
					await fs.access(worktreePath);

					// Try to use git worktree remove first (cleanest approach)
					const args = force
						? ['worktree', 'remove', '--force', worktreePath]
						: ['worktree', 'remove', worktreePath];
					const gitResult = await execFileNoThrow('git', args, worktreePath);

					if (gitResult.exitCode === 0) {
						logger.info(`${LOG_CONTEXT} Removed worktree via git: ${worktreePath}`);
						markStaleForDeletedWorktreeUsingStore(worktreePath);
						return { success: true };
					}

					// If git worktree remove failed (maybe not a worktree or has changes), try force removal
					if (!force) {
						// Check if there are uncommitted changes
						const statusResult = await execFileNoThrow(
							'git',
							['status', '--porcelain'],
							worktreePath
						);
						if (statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0) {
							return {
								success: false,
								error: 'Worktree has uncommitted changes. Use force option to delete anyway.',
								hasUncommittedChanges: true,
							};
						}
					}

					// Fall back to recursive directory removal
					await fs.rm(worktreePath, { recursive: true, force: true });
					logger.info(`${LOG_CONTEXT} Removed worktree directory: ${worktreePath}`);
					markStaleForDeletedWorktreeUsingStore(worktreePath);
					return { success: true };
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					logger.error(`${LOG_CONTEXT} Failed to remove worktree ${worktreePath}: ${errorMessage}`);
					return { success: false, error: errorMessage };
				}
			}
		)
	);
}
