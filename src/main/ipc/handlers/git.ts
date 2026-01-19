import { ipcMain, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { execFileNoThrow } from '../../utils/execFile';
import { execGit } from '../../utils/remote-git';
import { logger } from '../../utils/logger';
import {
	withIpcErrorLogging,
	createIpcHandler,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { resolveGhPath, getCachedGhStatus, setCachedGhStatus } from '../../utils/cliDetection';
import {
	parseGitBranches,
	parseGitTags,
	parseGitBehindAhead,
	countUncommittedChanges,
	isImageFile,
	getImageMimeType,
} from '../../../shared/gitUtils';
import { SshRemoteConfig } from '../../../shared/types';
import {
	worktreeInfoRemote,
	worktreeSetupRemote,
	worktreeCheckoutRemote,
	listWorktreesRemote,
	getRepoRootRemote,
} from '../../utils/remote-git';
import { readDirRemote } from '../../utils/remote-fs';

const LOG_CONTEXT = '[Git]';

/**
 * Dependencies for Git handlers
 */
export interface GitHandlerDependencies {
	/** Settings store for accessing SSH remote configurations */
	settingsStore: {
		get: (key: string, defaultValue?: unknown) => unknown;
	};
}

// Module-level reference to settings store (set during registration)
let gitSettingsStore: GitHandlerDependencies['settingsStore'] | null = null;

/**
 * Look up SSH remote configuration by ID.
 * Returns null if ID is not provided or config not found.
 */
function getSshRemoteById(sshRemoteId?: string): SshRemoteConfig | null {
	if (!sshRemoteId || !gitSettingsStore) return null;

	const sshRemotes = gitSettingsStore.get('sshRemotes', []) as SshRemoteConfig[];
	const config = sshRemotes.find((r) => r.id === sshRemoteId && r.enabled);

	if (!config) {
		logger.debug(`SSH remote not found or disabled: ${sshRemoteId}`, LOG_CONTEXT);
		return null;
	}

	return config;
}

// Worktree directory watchers keyed by session ID
const worktreeWatchers = new Map<string, FSWatcher>();
const worktreeWatchDebounceTimers = new Map<string, NodeJS.Timeout>();

/** Helper to create handler options with Git context */
const handlerOpts = (operation: string, logSuccess = false): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Register all Git-related IPC handlers.
 *
 * These handlers provide Git operations used across the application including:
 * - Basic operations: status, diff, branch, remote, tags
 * - Advanced queries: log, info, commitCount
 * - File operations: show, showFile
 * - Worktree management: worktreeInfo, worktreeSetup, worktreeCheckout (with SSH support)
 * - GitHub CLI integration: checkGhCli, createPR, getDefaultBranch
 *
 * @param deps Dependencies including settingsStore for SSH remote configuration lookup
 */
export function registerGitHandlers(deps: GitHandlerDependencies): void {
	// Store the settings reference for SSH remote lookups
	gitSettingsStore = deps.settingsStore;
	// Basic Git operations
	// All handlers accept optional sshRemoteId and remoteCwd for remote execution
	ipcMain.handle(
		'git:status',
		withIpcErrorLogging(
			handlerOpts('status'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = getSshRemoteById(sshRemoteId);
				const result = await execGit(['status', '--porcelain'], cwd, sshRemote, remoteCwd);
				return { stdout: result.stdout, stderr: result.stderr };
			}
		)
	);

	ipcMain.handle(
		'git:diff',
		withIpcErrorLogging(
			handlerOpts('diff'),
			async (cwd: string, file?: string, sshRemoteId?: string, remoteCwd?: string) => {
				const args = file ? ['diff', file] : ['diff'];
				const sshRemote = getSshRemoteById(sshRemoteId);
				const result = await execGit(args, cwd, sshRemote, remoteCwd);
				return { stdout: result.stdout, stderr: result.stderr };
			}
		)
	);

	ipcMain.handle(
		'git:isRepo',
		withIpcErrorLogging(
			handlerOpts('isRepo'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = getSshRemoteById(sshRemoteId);
				const result = await execGit(
					['rev-parse', '--is-inside-work-tree'],
					cwd,
					sshRemote,
					remoteCwd
				);
				return result.exitCode === 0;
			}
		)
	);

	ipcMain.handle(
		'git:numstat',
		withIpcErrorLogging(
			handlerOpts('numstat'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = getSshRemoteById(sshRemoteId);
				const result = await execGit(['diff', '--numstat'], cwd, sshRemote, remoteCwd);
				return { stdout: result.stdout, stderr: result.stderr };
			}
		)
	);

	ipcMain.handle(
		'git:branch',
		withIpcErrorLogging(
			handlerOpts('branch'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = getSshRemoteById(sshRemoteId);
				const result = await execGit(
					['rev-parse', '--abbrev-ref', 'HEAD'],
					cwd,
					sshRemote,
					remoteCwd
				);
				return { stdout: result.stdout.trim(), stderr: result.stderr };
			}
		)
	);

	ipcMain.handle(
		'git:remote',
		withIpcErrorLogging(
			handlerOpts('remote'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = getSshRemoteById(sshRemoteId);
				const result = await execGit(['remote', 'get-url', 'origin'], cwd, sshRemote, remoteCwd);
				return { stdout: result.stdout.trim(), stderr: result.stderr };
			}
		)
	);

	// Get all local and remote branches
	ipcMain.handle(
		'git:branches',
		withIpcErrorLogging(
			handlerOpts('branches'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				// Get all branches (local and remote) in a simple format
				// -a for all branches, --format to get clean names
				const sshRemote = getSshRemoteById(sshRemoteId);
				const result = await execGit(
					['branch', '-a', '--format=%(refname:short)'],
					cwd,
					sshRemote,
					remoteCwd
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

	// Get all tags
	ipcMain.handle(
		'git:tags',
		withIpcErrorLogging(
			handlerOpts('tags'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = getSshRemoteById(sshRemoteId);
				const result = await execGit(['tag', '--list'], cwd, sshRemote, remoteCwd);
				if (result.exitCode !== 0) {
					return { tags: [], stderr: result.stderr };
				}
				// Use shared parsing function
				const tags = parseGitTags(result.stdout);
				return { tags };
			}
		)
	);

	ipcMain.handle(
		'git:info',
		withIpcErrorLogging(
			handlerOpts('info'),
			async (cwd: string, sshRemoteId?: string, remoteCwd?: string) => {
				const sshRemote = getSshRemoteById(sshRemoteId);
				// Get comprehensive git info in a single call
				const [branchResult, remoteResult, statusResult, behindAheadResult] = await Promise.all([
					execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, sshRemote, remoteCwd),
					execGit(['remote', 'get-url', 'origin'], cwd, sshRemote, remoteCwd),
					execGit(['status', '--porcelain'], cwd, sshRemote, remoteCwd),
					execGit(
						['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
						cwd,
						sshRemote,
						remoteCwd
					),
				]);

				// Use shared parsing functions for behind/ahead and uncommitted changes
				const { behind, ahead } =
					behindAheadResult.exitCode === 0
						? parseGitBehindAhead(behindAheadResult.stdout)
						: { behind: 0, ahead: 0 };
				const uncommittedChanges = countUncommittedChanges(statusResult.stdout);

				return {
					branch: branchResult.stdout.trim(),
					remote: remoteResult.stdout.trim(),
					behind,
					ahead,
					uncommittedChanges,
				};
			}
		)
	);

	ipcMain.handle(
		'git:log',
		withIpcErrorLogging(
			handlerOpts('log'),
			async (cwd: string, options?: { limit?: number; search?: string }) => {
				// Get git log with formatted output for parsing
				// Format: hash|author|date|refs|subject followed by shortstat
				// Using a unique separator to split commits
				const limit = options?.limit || 100;
				const args = [
					'log',
					`--max-count=${limit}`,
					'--pretty=format:COMMIT_START%H|%an|%ad|%D|%s',
					'--date=iso-strict',
					'--shortstat',
				];

				// Add search filter if provided
				if (options?.search) {
					args.push('--all', `--grep=${options.search}`, '-i');
				}

				const result = await execFileNoThrow('git', args, cwd);

				if (result.exitCode !== 0) {
					return { entries: [], error: result.stderr };
				}

				// Split by COMMIT_START marker and parse each commit
				const commits = result.stdout.split('COMMIT_START').filter((c) => c.trim());
				const entries = commits.map((commitBlock) => {
					const lines = commitBlock.split('\n').filter((l) => l.trim());
					const mainLine = lines[0];
					const [hash, author, date, refs, ...subjectParts] = mainLine.split('|');

					// Parse shortstat line (e.g., " 3 files changed, 10 insertions(+), 5 deletions(-)")
					let additions = 0;
					let deletions = 0;
					const statLine = lines.find((l) => l.includes('changed'));
					if (statLine) {
						const addMatch = statLine.match(/(\d+) insertion/);
						const delMatch = statLine.match(/(\d+) deletion/);
						if (addMatch) additions = parseInt(addMatch[1], 10);
						if (delMatch) deletions = parseInt(delMatch[1], 10);
					}

					return {
						hash,
						shortHash: hash?.slice(0, 7),
						author,
						date,
						refs: refs ? refs.split(', ').filter((r) => r.trim()) : [],
						subject: subjectParts.join('|'), // In case subject contains |
						additions,
						deletions,
					};
				});

				return { entries, error: null };
			}
		)
	);

	ipcMain.handle(
		'git:commitCount',
		withIpcErrorLogging(handlerOpts('commitCount'), async (cwd: string) => {
			// Get total commit count using rev-list
			const result = await execFileNoThrow('git', ['rev-list', '--count', 'HEAD'], cwd);
			if (result.exitCode !== 0) {
				return { count: 0, error: result.stderr };
			}
			return { count: parseInt(result.stdout.trim(), 10) || 0, error: null };
		})
	);

	ipcMain.handle(
		'git:show',
		withIpcErrorLogging(handlerOpts('show'), async (cwd: string, hash: string) => {
			// Get the full diff for a specific commit
			const result = await execFileNoThrow('git', ['show', '--stat', '--patch', hash], cwd);
			return { stdout: result.stdout, stderr: result.stderr };
		})
	);

	// Read file content at a specific git ref (e.g., HEAD:path/to/file.png)
	// Returns base64 data URL for images, raw content for text files
	ipcMain.handle(
		'git:showFile',
		withIpcErrorLogging(
			handlerOpts('showFile'),
			async (cwd: string, ref: string, filePath: string) => {
				// Use git show to get file content at specific ref
				// We need to handle binary files differently
				const ext = filePath.split('.').pop()?.toLowerCase() || '';

				if (isImageFile(filePath)) {
					// For images, we need to get raw binary content
					// Use spawnSync to capture raw binary output
					const { spawnSync } = require('child_process');
					const result = spawnSync('git', ['show', `${ref}:${filePath}`], {
						cwd,
						encoding: 'buffer',
						maxBuffer: 50 * 1024 * 1024, // 50MB max
					});

					if (result.status !== 0) {
						return { error: result.stderr?.toString() || 'Failed to read file from git' };
					}

					const base64 = result.stdout.toString('base64');
					const mimeType = getImageMimeType(ext);
					return { content: `data:${mimeType};base64,${base64}` };
				} else {
					// For text files, use regular exec
					const result = await execFileNoThrow('git', ['show', `${ref}:${filePath}`], cwd);
					if (result.exitCode !== 0) {
						return { error: result.stderr || 'Failed to read file from git' };
					}
					return { content: result.stdout };
				}
			}
		)
	);

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
					const sshConfig = getSshRemoteById(sshRemoteId);
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

				// Get the git directory path
				const gitDirResult = await execFileNoThrow('git', ['rev-parse', '--git-dir'], worktreePath);
				if (gitDirResult.exitCode !== 0) {
					throw new Error('Failed to get git directory');
				}
				const gitDir = gitDirResult.stdout.trim();

				// A worktree's .git is a file pointing to the main repo, not a directory
				// Check if this is a worktree by looking for .git file (not directory) or checking git-common-dir
				const gitCommonDirResult = await execFileNoThrow(
					'git',
					['rev-parse', '--git-common-dir'],
					worktreePath
				);
				const gitCommonDir =
					gitCommonDirResult.exitCode === 0 ? gitCommonDirResult.stdout.trim() : gitDir;

				// If git-dir and git-common-dir are different, this is a worktree
				const isWorktree = gitDir !== gitCommonDir;

				// Get the current branch
				const branchResult = await execFileNoThrow(
					'git',
					['rev-parse', '--abbrev-ref', 'HEAD'],
					worktreePath
				);
				const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;

				// Get the repository root (of the main repository)
				const repoRootResult = await execFileNoThrow(
					'git',
					['rev-parse', '--show-toplevel'],
					worktreePath
				);
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

	// Get the root directory of the git repository
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'git:getRepoRoot',
		createIpcHandler(handlerOpts('getRepoRoot'), async (cwd: string, sshRemoteId?: string) => {
			// SSH remote: dispatch to remote git operations
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
				if (!sshConfig) {
					throw new Error(`SSH remote not found: ${sshRemoteId}`);
				}
				logger.debug(`${LOG_CONTEXT} getRepoRoot via SSH: ${cwd}`, LOG_CONTEXT);
				const result = await getRepoRootRemote(cwd, sshConfig);
				if (!result.success) {
					throw new Error(result.error || 'Not a git repository');
				}
				return { root: result.data };
			}

			// Local execution
			const result = await execFileNoThrow('git', ['rev-parse', '--show-toplevel'], cwd);
			if (result.exitCode !== 0) {
				throw new Error(result.stderr || 'Not a git repository');
			}
			return { root: result.stdout.trim() };
		})
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
				sshRemoteId?: string
			) => {
				// SSH remote: dispatch to remote git operations
				if (sshRemoteId) {
					const sshConfig = getSshRemoteById(sshRemoteId);
					if (!sshConfig) {
						throw new Error(`SSH remote not found: ${sshRemoteId}`);
					}
					logger.debug(
						`${LOG_CONTEXT} worktreeSetup via SSH: ${JSON.stringify({ mainRepoCwd, worktreePath, branchName })}`,
						LOG_CONTEXT
					);
					const result = await worktreeSetupRemote(
						mainRepoCwd,
						worktreePath,
						branchName,
						sshConfig
					);
					if (!result.success) {
						throw new Error(result.error || 'Remote worktreeSetup failed');
					}
					return result.data;
				}

				// Local execution (existing code)
				logger.debug(
					`worktreeSetup called with: ${JSON.stringify({ mainRepoCwd, worktreePath, branchName })}`,
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
					// Get the common dir to check if it's the same repo
					const gitCommonDirResult = await execFileNoThrow(
						'git',
						['rev-parse', '--git-common-dir'],
						worktreePath
					);
					const mainGitDirResult = await execFileNoThrow(
						'git',
						['rev-parse', '--git-dir'],
						mainRepoCwd
					);

					if (gitCommonDirResult.exitCode === 0 && mainGitDirResult.exitCode === 0) {
						const worktreeCommonDir = path.resolve(worktreePath, gitCommonDirResult.stdout.trim());
						const mainGitDir = path.resolve(mainRepoCwd, mainGitDirResult.stdout.trim());

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
					// Branch exists, just add worktree pointing to it
					createResult = await execFileNoThrow(
						'git',
						['worktree', 'add', worktreePath, branchName],
						mainRepoCwd
					);
				} else {
					// Branch doesn't exist, create it with -b flag
					createResult = await execFileNoThrow(
						'git',
						['worktree', 'add', '-b', branchName, worktreePath],
						mainRepoCwd
					);
				}

				if (createResult.exitCode !== 0) {
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
					const sshConfig = getSshRemoteById(sshRemoteId);
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

	// Create a PR from the worktree branch to a base branch
	// ghPath parameter allows specifying custom path to gh binary
	ipcMain.handle(
		'git:createPR',
		withIpcErrorLogging(
			handlerOpts('createPR'),
			async (
				worktreePath: string,
				baseBranch: string,
				title: string,
				body: string,
				ghPath?: string
			) => {
				// Resolve gh CLI path (uses cached detection or custom path)
				const ghCommand = await resolveGhPath(ghPath);
				logger.debug(`Using gh CLI at: ${ghCommand}`, LOG_CONTEXT);

				// First, push the current branch to origin
				const pushResult = await execFileNoThrow(
					'git',
					['push', '-u', 'origin', 'HEAD'],
					worktreePath
				);
				if (pushResult.exitCode !== 0) {
					return { success: false, error: `Failed to push branch: ${pushResult.stderr}` };
				}

				// Create the PR using gh CLI
				const prResult = await execFileNoThrow(
					ghCommand,
					['pr', 'create', '--base', baseBranch, '--title', title, '--body', body],
					worktreePath
				);

				if (prResult.exitCode !== 0) {
					// Check if gh CLI is not installed
					if (
						prResult.stderr.includes('command not found') ||
						prResult.stderr.includes('not recognized')
					) {
						return {
							success: false,
							error: 'GitHub CLI (gh) is not installed. Please install it to create PRs.',
						};
					}
					return { success: false, error: prResult.stderr || 'Failed to create PR' };
				}

				// The PR URL is typically in stdout
				const prUrl = prResult.stdout.trim();
				return { success: true, prUrl };
			}
		)
	);

	// Check if GitHub CLI (gh) is installed and authenticated
	// ghPath parameter allows specifying custom path to gh binary (e.g., /opt/homebrew/bin/gh)
	// Results are cached for 1 minute to avoid repeated subprocess calls
	ipcMain.handle(
		'git:checkGhCli',
		withIpcErrorLogging(handlerOpts('checkGhCli'), async (ghPath?: string) => {
			// Check cache first (skip if custom path provided)
			if (!ghPath) {
				const cached = getCachedGhStatus();
				if (cached !== null) {
					logger.debug(
						`Using cached gh CLI status: installed=${cached.installed}, authenticated=${cached.authenticated}`,
						LOG_CONTEXT
					);
					return cached;
				}
			}

			// Resolve gh CLI path (uses cached detection or custom path)
			const ghCommand = await resolveGhPath(ghPath);
			logger.debug(`Checking gh CLI at: ${ghCommand}`, LOG_CONTEXT);

			// Check if gh is installed by running gh --version
			const versionResult = await execFileNoThrow(ghCommand, ['--version']);
			if (versionResult.exitCode !== 0) {
				logger.warn(
					`gh CLI not found at ${ghCommand}: exit=${versionResult.exitCode}, stderr=${versionResult.stderr}`,
					LOG_CONTEXT
				);
				const result = { installed: false, authenticated: false };
				if (!ghPath) setCachedGhStatus(false, false);
				return result;
			}
			logger.debug(`gh CLI found: ${versionResult.stdout.trim().split('\n')[0]}`, LOG_CONTEXT);

			// Check if gh is authenticated by running gh auth status
			const authResult = await execFileNoThrow(ghCommand, ['auth', 'status']);
			const authenticated = authResult.exitCode === 0;
			logger.debug(
				`gh auth status: ${authenticated ? 'authenticated' : 'not authenticated'}`,
				LOG_CONTEXT
			);

			// Cache the result (only if not using custom path)
			if (!ghPath) {
				setCachedGhStatus(true, authenticated);
			}

			return { installed: true, authenticated };
		})
	);

	// Get the default branch name (main or master)
	ipcMain.handle(
		'git:getDefaultBranch',
		createIpcHandler(handlerOpts('getDefaultBranch'), async (cwd: string) => {
			// First try to get the default branch from remote
			const remoteResult = await execFileNoThrow('git', ['remote', 'show', 'origin'], cwd);
			if (remoteResult.exitCode === 0) {
				// Parse "HEAD branch: main" from the output
				const match = remoteResult.stdout.match(/HEAD branch:\s*(\S+)/);
				if (match) {
					return { branch: match[1] };
				}
			}

			// Fallback: check if main or master exists locally
			const mainResult = await execFileNoThrow('git', ['rev-parse', '--verify', 'main'], cwd);
			if (mainResult.exitCode === 0) {
				return { branch: 'main' };
			}

			const masterResult = await execFileNoThrow('git', ['rev-parse', '--verify', 'master'], cwd);
			if (masterResult.exitCode === 0) {
				return { branch: 'master' };
			}

			throw new Error('Could not determine default branch');
		})
	);

	// List all worktrees for a git repository
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'git:listWorktrees',
		createIpcHandler(handlerOpts('listWorktrees'), async (cwd: string, sshRemoteId?: string) => {
			// SSH remote: dispatch to remote git operations
			if (sshRemoteId) {
				const sshConfig = getSshRemoteById(sshRemoteId);
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

	// Scan a directory for subdirectories that are git repositories or worktrees
	// This is used for auto-discovering worktrees in a parent directory
	// PERFORMANCE: Parallelized git operations to avoid blocking UI (was sequential before)
	// Supports SSH remote execution via optional sshRemoteId parameter
	ipcMain.handle(
		'git:scanWorktreeDirectory',
		createIpcHandler(
			handlerOpts('scanWorktreeDirectory'),
			async (parentPath: string, sshRemoteId?: string) => {
				const sshRemote = getSshRemoteById(sshRemoteId);

				try {
					// Read directory contents (SSH-aware)
					let subdirs: Array<{ name: string; isDirectory: boolean }>;

					if (sshRemote) {
						// SSH remote: use readDirRemote
						const result = await readDirRemote(parentPath, sshRemote);
						if (!result.success || !result.data) {
							logger.error(
								`Failed to read remote directory ${parentPath}: ${result.error}`,
								LOG_CONTEXT
							);
							return { gitSubdirs: [] };
						}
						// Filter to only directories (excluding hidden directories)
						subdirs = result.data.filter((e) => e.isDirectory && !e.name.startsWith('.'));
					} else {
						// Local: use standard fs operations
						const entries = await fs.readdir(parentPath, { withFileTypes: true });
						// Filter to only directories (excluding hidden directories)
						subdirs = entries
							.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
							.map((e) => ({
								name: e.name,
								isDirectory: true,
							}));
					}

					// Process all subdirectories in parallel instead of sequentially
					// This dramatically reduces the time for directories with many worktrees
					const results = await Promise.all(
						subdirs.map(async (subdir) => {
							// Use POSIX path joining for remote paths
							const subdirPath = sshRemote
								? parentPath.endsWith('/')
									? `${parentPath}${subdir.name}`
									: `${parentPath}/${subdir.name}`
								: path.join(parentPath, subdir.name);

							// Check if it's inside a git work tree (SSH-aware via execGit)
							const isInsideWorkTree = await execGit(
								['rev-parse', '--is-inside-work-tree'],
								subdirPath,
								sshRemote
							);
							if (isInsideWorkTree.exitCode !== 0) {
								return null; // Not a git repo
							}

							// Run remaining git commands in parallel for each subdirectory (SSH-aware via execGit)
							const [gitDirResult, gitCommonDirResult, branchResult] = await Promise.all([
								execGit(['rev-parse', '--git-dir'], subdirPath, sshRemote),
								execGit(['rev-parse', '--git-common-dir'], subdirPath, sshRemote),
								execGit(['rev-parse', '--abbrev-ref', 'HEAD'], subdirPath, sshRemote),
							]);

							const gitDir = gitDirResult.exitCode === 0 ? gitDirResult.stdout.trim() : '';
							const gitCommonDir =
								gitCommonDirResult.exitCode === 0 ? gitCommonDirResult.stdout.trim() : gitDir;
							const isWorktree = gitDir !== gitCommonDir;
							const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;

							// Get repo root
							let repoRoot: string | null = null;
							if (isWorktree && gitCommonDir) {
								// For SSH, use POSIX path operations
								if (sshRemote) {
									const commonDirAbs = gitCommonDir.startsWith('/')
										? gitCommonDir
										: `${subdirPath}/${gitCommonDir}`.replace(/\/+/g, '/');
									// Get parent directory (remove last path component)
									repoRoot = commonDirAbs.split('/').slice(0, -1).join('/') || '/';
								} else {
									const commonDirAbs = path.isAbsolute(gitCommonDir)
										? gitCommonDir
										: path.resolve(subdirPath, gitCommonDir);
									repoRoot = path.dirname(commonDirAbs);
								}
							} else {
								const repoRootResult = await execGit(
									['rev-parse', '--show-toplevel'],
									subdirPath,
									sshRemote
								);
								if (repoRootResult.exitCode === 0) {
									repoRoot = repoRootResult.stdout.trim();
								}
							}

							return {
								path: subdirPath,
								name: subdir.name,
								isWorktree,
								branch,
								repoRoot,
							};
						})
					);

					// Filter out null results (non-git directories)
					const gitSubdirs = results.filter((r): r is NonNullable<typeof r> => r !== null);

					return { gitSubdirs };
				} catch (err) {
					logger.error(`Failed to scan directory ${parentPath}: ${err}`, LOG_CONTEXT);
					return { gitSubdirs: [] };
				}
			}
		)
	);

	// Watch a worktree directory for new worktrees
	// Note: File watching is not supported for SSH remote sessions.
	// Remote sessions will get success: true but isRemote: true flag indicating
	// watching is not active. The UI should periodically poll listWorktrees instead.
	ipcMain.handle(
		'git:watchWorktreeDirectory',
		createIpcHandler(
			handlerOpts('watchWorktreeDirectory'),
			async (sessionId: string, worktreePath: string, sshRemoteId?: string) => {
				// SSH remote: file watching is not supported
				// Return success with isRemote flag so UI knows to poll instead
				if (sshRemoteId) {
					logger.debug(
						`${LOG_CONTEXT} Worktree watching not supported for SSH remote sessions. Session ${sessionId} should poll instead.`,
						LOG_CONTEXT
					);
					return {
						success: true,
						isRemote: true,
						message: 'File watching not available for remote sessions. Use polling instead.',
					};
				}

				// Stop existing watcher if any
				const existingWatcher = worktreeWatchers.get(sessionId);
				if (existingWatcher) {
					await existingWatcher.close();
					worktreeWatchers.delete(sessionId);
				}

				// Clear any pending debounce timer
				const existingTimer = worktreeWatchDebounceTimers.get(sessionId);
				if (existingTimer) {
					clearTimeout(existingTimer);
					worktreeWatchDebounceTimers.delete(sessionId);
				}

				try {
					// Verify directory exists
					await fs.access(worktreePath);

					// Start watching the directory (only top level, not recursive)
					const watcher = chokidar.watch(worktreePath, {
						ignored: /(^|[/\\])\../, // Ignore dotfiles
						persistent: true,
						ignoreInitial: true,
						depth: 0, // Only watch top-level directory changes
					});

					// Handler for directory additions
					watcher.on('addDir', async (dirPath: string) => {
						// Skip the root directory itself
						if (dirPath === worktreePath) return;

						// Debounce to avoid flooding with events
						const existingTimer = worktreeWatchDebounceTimers.get(sessionId);
						if (existingTimer) {
							clearTimeout(existingTimer);
						}

						const timer = setTimeout(async () => {
							worktreeWatchDebounceTimers.delete(sessionId);

							// Check if this new directory is a git worktree
							const isInsideWorkTree = await execFileNoThrow(
								'git',
								['rev-parse', '--is-inside-work-tree'],
								dirPath
							);
							if (isInsideWorkTree.exitCode !== 0) {
								return; // Not a git repo
							}

							// Get branch name
							const branchResult = await execFileNoThrow(
								'git',
								['rev-parse', '--abbrev-ref', 'HEAD'],
								dirPath
							);
							const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;

							// Skip main/master/HEAD branches
							if (branch === 'main' || branch === 'master' || branch === 'HEAD') {
								return;
							}

							// Emit event to renderer
							const windows = BrowserWindow.getAllWindows();
							for (const win of windows) {
								win.webContents.send('worktree:discovered', {
									sessionId,
									worktree: {
										path: dirPath,
										name: path.basename(dirPath),
										branch,
									},
								});
							}

							logger.info(`${LOG_CONTEXT} New worktree discovered: ${dirPath} (branch: ${branch})`);
						}, 500); // 500ms debounce

						worktreeWatchDebounceTimers.set(sessionId, timer);
					});

					watcher.on('error', (error) => {
						logger.error(
							`${LOG_CONTEXT} Worktree watcher error for session ${sessionId}: ${error}`
						);
					});

					worktreeWatchers.set(sessionId, watcher);
					logger.info(
						`${LOG_CONTEXT} Started watching worktree directory: ${worktreePath} for session ${sessionId}`
					);

					return { success: true };
				} catch (err) {
					logger.error(`${LOG_CONTEXT} Failed to watch worktree directory ${worktreePath}: ${err}`);
					return { success: false, error: String(err) };
				}
			}
		)
	);

	// Stop watching a worktree directory
	ipcMain.handle(
		'git:unwatchWorktreeDirectory',
		createIpcHandler(handlerOpts('unwatchWorktreeDirectory'), async (sessionId: string) => {
			const watcher = worktreeWatchers.get(sessionId);
			if (watcher) {
				await watcher.close();
				worktreeWatchers.delete(sessionId);
				logger.info(`${LOG_CONTEXT} Stopped watching worktree directory for session ${sessionId}`);
			}

			// Clear any pending debounce timer
			const timer = worktreeWatchDebounceTimers.get(sessionId);
			if (timer) {
				clearTimeout(timer);
				worktreeWatchDebounceTimers.delete(sessionId);
			}

			return { success: true };
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
					return { success: true };
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					logger.error(`${LOG_CONTEXT} Failed to remove worktree ${worktreePath}: ${errorMessage}`);
					return { success: false, error: errorMessage };
				}
			}
		)
	);

	// Create a GitHub Gist from file content
	// Returns the gist URL on success
	ipcMain.handle(
		'git:createGist',
		withIpcErrorLogging(
			handlerOpts('createGist'),
			async (
				filename: string,
				content: string,
				description: string,
				isPublic: boolean,
				ghPath?: string
			) => {
				// Resolve gh CLI path (uses cached detection or custom path)
				const ghCommand = await resolveGhPath(ghPath);
				logger.debug(`Using gh CLI for gist creation at: ${ghCommand}`, LOG_CONTEXT);

				// Create gist using gh CLI with stdin for content
				// gh gist create --filename <name> --desc <desc> [--public] -
				const args = ['gist', 'create', '--filename', filename];
				if (description) {
					args.push('--desc', description);
				}
				if (isPublic) {
					args.push('--public');
				}
				args.push('-'); // Read from stdin

				const gistResult = await execFileNoThrow(ghCommand, args, undefined, { input: content });

				if (gistResult.exitCode !== 0) {
					// Check if gh CLI is not installed
					if (
						gistResult.stderr.includes('command not found') ||
						gistResult.stderr.includes('not recognized')
					) {
						return {
							success: false,
							error: 'GitHub CLI (gh) is not installed. Please install it to create gists.',
						};
					}
					// Check for authentication issues
					if (
						gistResult.stderr.includes('not logged') ||
						gistResult.stderr.includes('authentication')
					) {
						return {
							success: false,
							error: 'GitHub CLI is not authenticated. Please run "gh auth login" first.',
						};
					}
					return { success: false, error: gistResult.stderr || 'Failed to create gist' };
				}

				// The gist URL is typically in stdout
				const gistUrl = gistResult.stdout.trim();
				logger.info(`${LOG_CONTEXT} Created gist: ${gistUrl}`);
				return { success: true, gistUrl };
			}
		)
	);

	logger.debug(`${LOG_CONTEXT} Git IPC handlers registered`);
}
