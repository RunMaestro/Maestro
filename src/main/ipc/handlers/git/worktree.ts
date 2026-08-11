import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { execFileNoThrow } from '../../../utils/execFile';
import { logger } from '../../../utils/logger';
import { getSshRemoteById } from '../../../stores';
import { withIpcErrorLogging, createIpcHandler } from '../../../utils/ipcHandler';
import {
	worktreeInfoRemote,
	worktreeSetupRemote,
	worktreeCheckoutRemote,
	listWorktreesRemote,
} from '../../../utils/remote-git';
import { markStaleForDeletedWorktreeUsingStore } from '../../../agent-run/worktree-stale';
import { setupWorktreeLocal } from '../../../utils/git-worktree';
import { LOG_CONTEXT, handlerOpts } from './shared';

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

				// Local execution: delegated to the single shared implementation in
				// `utils/git-worktree` so the Board's per-card provisioning and this
				// handler cannot drift apart.
				logger.debug(
					`worktreeSetup called with: ${JSON.stringify({ mainRepoCwd, worktreePath, branchName, baseBranch })}`,
					LOG_CONTEXT
				);
				return setupWorktreeLocal(mainRepoCwd, worktreePath, branchName, baseBranch, (msg) =>
					logger.debug(msg, LOG_CONTEXT)
				);
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
