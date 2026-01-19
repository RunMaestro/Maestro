/**
 * Remote Git Execution Utilities
 *
 * Provides functionality to execute git commands on remote hosts via SSH
 * when a session is configured for remote execution.
 *
 * These utilities enable worktree management and other git operations
 * when a session is running on a remote host.
 */

import { SshRemoteConfig } from '../../shared/types';
import { execFileNoThrow, ExecResult } from './execFile';
import { buildSshCommand, RemoteCommandOptions } from './ssh-command-builder';
import { logger } from './logger';

const LOG_CONTEXT = '[RemoteGit]';

/**
 * Options for remote git execution
 */
export interface RemoteGitOptions {
	/** SSH remote configuration */
	sshRemote: SshRemoteConfig;
	/** Working directory on the remote host */
	remoteCwd?: string;
}

/**
 * Result wrapper for remote git operations.
 * Includes success/failure status and optional error message.
 */
export interface RemoteGitResult<T> {
	/** Whether the operation succeeded */
	success: boolean;
	/** The result data (if success is true) */
	data?: T;
	/** Error message (if success is false) */
	error?: string;
}

/**
 * Execute a git command on a remote host via SSH.
 *
 * @param args Git command arguments (e.g., ['status', '--porcelain'])
 * @param options SSH remote configuration and optional remote working directory
 * @returns Execution result with stdout, stderr, and exit code
 */
export async function execGitRemote(
	args: string[],
	options: RemoteGitOptions
): Promise<ExecResult> {
	const { sshRemote, remoteCwd } = options;

	if (!remoteCwd) {
		logger.warn('No remote working directory specified for git command', LOG_CONTEXT);
	}

	// Build the remote command options
	const remoteOptions: RemoteCommandOptions = {
		command: 'git',
		args,
		cwd: remoteCwd,
		// Pass any remote environment variables from the SSH config
		env: sshRemote.remoteEnv,
	};

	// Build the SSH command
	const sshCommand = await buildSshCommand(sshRemote, remoteOptions);

	logger.debug(`Executing remote git command: ${args.join(' ')}`, LOG_CONTEXT, {
		host: sshRemote.host,
		cwd: remoteCwd,
	});

	// Execute the SSH command
	const result = await execFileNoThrow(sshCommand.command, sshCommand.args);

	if (result.exitCode !== 0) {
		logger.debug(`Remote git command failed: ${result.stderr}`, LOG_CONTEXT, {
			exitCode: result.exitCode,
			args,
		});
	}

	return result;
}

/**
 * Execute a git command either locally or remotely based on the SSH configuration.
 *
 * This is a convenience function that dispatches to either local or remote execution.
 *
 * @param args Git command arguments
 * @param localCwd Local working directory (used for local execution)
 * @param sshRemote Optional SSH remote configuration (triggers remote execution if provided)
 * @param remoteCwd Remote working directory (required for remote execution)
 * @returns Execution result
 */
export async function execGit(
	args: string[],
	localCwd: string,
	sshRemote?: SshRemoteConfig | null,
	remoteCwd?: string
): Promise<ExecResult> {
	if (sshRemote) {
		return execGitRemote(args, {
			sshRemote,
			remoteCwd,
		});
	}

	// Local execution
	return execFileNoThrow('git', args, localCwd);
}

/**
 * Execute a shell command on a remote host via SSH.
 *
 * @param shellCommand The shell command to execute on the remote
 * @param sshRemote SSH remote configuration
 * @returns Execution result
 */
async function execRemoteShellCommand(
	shellCommand: string,
	sshRemote: SshRemoteConfig
): Promise<ExecResult> {
	const remoteOptions: RemoteCommandOptions = {
		command: 'sh',
		args: ['-c', shellCommand],
		env: sshRemote.remoteEnv,
	};

	const sshCommand = await buildSshCommand(sshRemote, remoteOptions);
	return execFileNoThrow(sshCommand.command, sshCommand.args);
}

/**
 * Worktree info result from remote host.
 */
export interface RemoteWorktreeInfo extends Record<string, unknown> {
	exists: boolean;
	isWorktree: boolean;
	currentBranch?: string;
	repoRoot?: string;
}

/**
 * Get information about a worktree at a given path on a remote host.
 *
 * @param worktreePath Path to the worktree on the remote host
 * @param sshRemote SSH remote configuration
 * @returns Worktree information
 */
export async function worktreeInfoRemote(
	worktreePath: string,
	sshRemote: SshRemoteConfig
): Promise<RemoteGitResult<RemoteWorktreeInfo>> {
	// Check if path exists
	const existsResult = await execRemoteShellCommand(
		`test -d '${worktreePath}' && echo "EXISTS" || echo "NOT_EXISTS"`,
		sshRemote
	);

	if (existsResult.exitCode !== 0) {
		return {
			success: false,
			error: existsResult.stderr || 'Failed to check path existence',
		};
	}

	if (existsResult.stdout.trim() === 'NOT_EXISTS') {
		return {
			success: true,
			data: { exists: false, isWorktree: false },
		};
	}

	// Check if it's a git directory
	const isInsideWorkTree = await execGitRemote(['rev-parse', '--is-inside-work-tree'], {
		sshRemote,
		remoteCwd: worktreePath,
	});

	if (isInsideWorkTree.exitCode !== 0) {
		return {
			success: true,
			data: { exists: true, isWorktree: false },
		};
	}

	// Get git-dir and git-common-dir to determine if it's a worktree
	const gitDirResult = await execGitRemote(['rev-parse', '--git-dir'], {
		sshRemote,
		remoteCwd: worktreePath,
	});

	if (gitDirResult.exitCode !== 0) {
		return {
			success: false,
			error: 'Failed to get git directory',
		};
	}

	const gitDir = gitDirResult.stdout.trim();

	const gitCommonDirResult = await execGitRemote(['rev-parse', '--git-common-dir'], {
		sshRemote,
		remoteCwd: worktreePath,
	});

	const gitCommonDir =
		gitCommonDirResult.exitCode === 0 ? gitCommonDirResult.stdout.trim() : gitDir;

	// If git-dir and git-common-dir are different, this is a worktree
	const isWorktree = gitDir !== gitCommonDir;

	// Get current branch
	const branchResult = await execGitRemote(['rev-parse', '--abbrev-ref', 'HEAD'], {
		sshRemote,
		remoteCwd: worktreePath,
	});

	const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;

	// Get repository root
	let repoRoot: string | undefined;

	if (isWorktree && gitCommonDir) {
		// For worktrees, find main repo root from common dir
		// Use dirname on the remote to get parent of .git folder
		const repoRootResult = await execRemoteShellCommand(
			`cd '${worktreePath}' && dirname $(cd '${gitCommonDir}' && pwd)`,
			sshRemote
		);

		if (repoRootResult.exitCode === 0) {
			repoRoot = repoRootResult.stdout.trim();
		}
	} else {
		const repoRootResult = await execGitRemote(['rev-parse', '--show-toplevel'], {
			sshRemote,
			remoteCwd: worktreePath,
		});

		if (repoRootResult.exitCode === 0) {
			repoRoot = repoRootResult.stdout.trim();
		}
	}

	return {
		success: true,
		data: {
			exists: true,
			isWorktree,
			currentBranch,
			repoRoot,
		},
	};
}

/**
 * Worktree setup result.
 */
export interface RemoteWorktreeSetupResult extends Record<string, unknown> {
	success: boolean;
	error?: string;
	created?: boolean;
	currentBranch?: string;
	requestedBranch?: string;
	branchMismatch?: boolean;
}

/**
 * Create or reuse a worktree on a remote host.
 *
 * @param mainRepoCwd Path to the main repository on the remote
 * @param worktreePath Path where the worktree should be created
 * @param branchName Branch name for the worktree
 * @param sshRemote SSH remote configuration
 * @returns Setup result with success/failure and branch info
 */
export async function worktreeSetupRemote(
	mainRepoCwd: string,
	worktreePath: string,
	branchName: string,
	sshRemote: SshRemoteConfig
): Promise<RemoteGitResult<RemoteWorktreeSetupResult>> {
	// Check if worktree path is inside the main repo (nested worktree)
	const checkNestedResult = await execRemoteShellCommand(
		`realpath '${mainRepoCwd}' && realpath --canonicalize-missing '${worktreePath}'`,
		sshRemote
	);

	if (checkNestedResult.exitCode === 0) {
		const lines = checkNestedResult.stdout.trim().split('\n');
		if (lines.length >= 2) {
			const resolvedMainRepo = lines[0];
			const resolvedWorktree = lines[1];
			if (resolvedWorktree.startsWith(resolvedMainRepo + '/')) {
				return {
					success: true,
					data: {
						success: false,
						error:
							'Worktree path cannot be inside the main repository. Please use a sibling directory.',
					},
				};
			}
		}
	}

	// Check if worktree path already exists
	const existsResult = await execRemoteShellCommand(
		`test -d '${worktreePath}' && echo "EXISTS" || echo "NOT_EXISTS"`,
		sshRemote
	);

	if (existsResult.exitCode !== 0) {
		return {
			success: false,
			error: existsResult.stderr || 'Failed to check path existence',
		};
	}

	let pathExists = existsResult.stdout.trim() === 'EXISTS';

	if (pathExists) {
		// Check if it's already a worktree of this repo
		const worktreeInfo = await execGitRemote(['rev-parse', '--is-inside-work-tree'], {
			sshRemote,
			remoteCwd: worktreePath,
		});

		if (worktreeInfo.exitCode !== 0) {
			// Path exists but isn't a git repo - check if empty
			const lsResult = await execRemoteShellCommand(
				`ls -A '${worktreePath}' 2>/dev/null | head -1`,
				sshRemote
			);

			if (lsResult.exitCode === 0 && lsResult.stdout.trim() === '') {
				// Empty directory - remove it
				await execRemoteShellCommand(`rmdir '${worktreePath}'`, sshRemote);
				pathExists = false;
			} else {
				return {
					success: true,
					data: {
						success: false,
						error: 'Path exists but is not a git worktree or repository (and is not empty)',
					},
				};
			}
		}
	}

	if (pathExists) {
		// Verify it belongs to the same repo
		const gitCommonDirResult = await execGitRemote(['rev-parse', '--git-common-dir'], {
			sshRemote,
			remoteCwd: worktreePath,
		});

		const mainGitDirResult = await execGitRemote(['rev-parse', '--git-dir'], {
			sshRemote,
			remoteCwd: mainRepoCwd,
		});

		if (gitCommonDirResult.exitCode === 0 && mainGitDirResult.exitCode === 0) {
			// Compare normalized paths on remote
			const compareResult = await execRemoteShellCommand(
				`test "$(cd '${worktreePath}' && cd '${gitCommonDirResult.stdout.trim()}' && pwd)" = "$(cd '${mainRepoCwd}' && cd '${mainGitDirResult.stdout.trim()}' && pwd)" && echo "SAME" || echo "DIFFERENT"`,
				sshRemote
			);

			if (compareResult.stdout.trim() === 'DIFFERENT') {
				return {
					success: true,
					data: {
						success: false,
						error: 'Worktree path belongs to a different repository',
					},
				};
			}
		}

		// Get current branch in existing worktree
		const currentBranchResult = await execGitRemote(['rev-parse', '--abbrev-ref', 'HEAD'], {
			sshRemote,
			remoteCwd: worktreePath,
		});

		const currentBranch =
			currentBranchResult.exitCode === 0 ? currentBranchResult.stdout.trim() : '';

		return {
			success: true,
			data: {
				success: true,
				created: false,
				currentBranch,
				requestedBranch: branchName,
				branchMismatch: currentBranch !== branchName && branchName !== '',
			},
		};
	}

	// Worktree doesn't exist, create it
	// First check if branch exists
	const branchExistsResult = await execGitRemote(['rev-parse', '--verify', branchName], {
		sshRemote,
		remoteCwd: mainRepoCwd,
	});

	const branchExists = branchExistsResult.exitCode === 0;

	let createResult: ExecResult;
	if (branchExists) {
		createResult = await execGitRemote(['worktree', 'add', worktreePath, branchName], {
			sshRemote,
			remoteCwd: mainRepoCwd,
		});
	} else {
		createResult = await execGitRemote(['worktree', 'add', '-b', branchName, worktreePath], {
			sshRemote,
			remoteCwd: mainRepoCwd,
		});
	}

	if (createResult.exitCode !== 0) {
		return {
			success: true,
			data: {
				success: false,
				error: createResult.stderr || 'Failed to create worktree',
			},
		};
	}

	return {
		success: true,
		data: {
			success: true,
			created: true,
			currentBranch: branchName,
			requestedBranch: branchName,
			branchMismatch: false,
		},
	};
}

/**
 * Worktree checkout result.
 */
export interface RemoteWorktreeCheckoutResult extends Record<string, unknown> {
	success: boolean;
	hasUncommittedChanges: boolean;
	error?: string;
}

/**
 * Checkout a branch in a worktree on a remote host.
 *
 * @param worktreePath Path to the worktree on the remote
 * @param branchName Branch to checkout
 * @param createIfMissing Whether to create the branch if it doesn't exist
 * @param sshRemote SSH remote configuration
 * @returns Checkout result
 */
export async function worktreeCheckoutRemote(
	worktreePath: string,
	branchName: string,
	createIfMissing: boolean,
	sshRemote: SshRemoteConfig
): Promise<RemoteGitResult<RemoteWorktreeCheckoutResult>> {
	// Check for uncommitted changes
	const statusResult = await execGitRemote(['status', '--porcelain'], {
		sshRemote,
		remoteCwd: worktreePath,
	});

	if (statusResult.exitCode !== 0) {
		return {
			success: true,
			data: {
				success: false,
				hasUncommittedChanges: false,
				error: 'Failed to check git status',
			},
		};
	}

	if (statusResult.stdout.trim().length > 0) {
		return {
			success: true,
			data: {
				success: false,
				hasUncommittedChanges: true,
				error: 'Worktree has uncommitted changes. Please commit or stash them first.',
			},
		};
	}

	// Check if branch exists
	const branchExistsResult = await execGitRemote(['rev-parse', '--verify', branchName], {
		sshRemote,
		remoteCwd: worktreePath,
	});

	const branchExists = branchExistsResult.exitCode === 0;

	let checkoutResult: ExecResult;
	if (branchExists) {
		checkoutResult = await execGitRemote(['checkout', branchName], {
			sshRemote,
			remoteCwd: worktreePath,
		});
	} else if (createIfMissing) {
		checkoutResult = await execGitRemote(['checkout', '-b', branchName], {
			sshRemote,
			remoteCwd: worktreePath,
		});
	} else {
		return {
			success: true,
			data: {
				success: false,
				hasUncommittedChanges: false,
				error: `Branch '${branchName}' does not exist`,
			},
		};
	}

	if (checkoutResult.exitCode !== 0) {
		return {
			success: true,
			data: {
				success: false,
				hasUncommittedChanges: false,
				error: checkoutResult.stderr || 'Checkout failed',
			},
		};
	}

	return {
		success: true,
		data: {
			success: true,
			hasUncommittedChanges: false,
		},
	};
}

/**
 * Worktree entry from list.
 */
export interface RemoteWorktreeEntry extends Record<string, unknown> {
	path: string;
	head: string;
	branch: string | null;
	isBare: boolean;
}

/**
 * List all worktrees for a git repository on a remote host.
 *
 * @param cwd Path to the repository on the remote
 * @param sshRemote SSH remote configuration
 * @returns Array of worktree entries
 */
export async function listWorktreesRemote(
	cwd: string,
	sshRemote: SshRemoteConfig
): Promise<RemoteGitResult<RemoteWorktreeEntry[]>> {
	const result = await execGitRemote(['worktree', 'list', '--porcelain'], {
		sshRemote,
		remoteCwd: cwd,
	});

	if (result.exitCode !== 0) {
		// Not a git repo or no worktree support
		return {
			success: true,
			data: [],
		};
	}

	// Parse porcelain output
	const worktrees: RemoteWorktreeEntry[] = [];
	const lines = result.stdout.split('\n');
	let current: { path?: string; head?: string; branch?: string | null; isBare?: boolean } = {};

	for (const line of lines) {
		if (line.startsWith('worktree ')) {
			current.path = line.substring(9);
		} else if (line.startsWith('HEAD ')) {
			current.head = line.substring(5);
		} else if (line.startsWith('branch ')) {
			const branchRef = line.substring(7);
			current.branch = branchRef.replace('refs/heads/', '');
		} else if (line === 'bare') {
			current.isBare = true;
		} else if (line === 'detached') {
			current.branch = null;
		} else if (line === '' && current.path) {
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

	return {
		success: true,
		data: worktrees,
	};
}

/**
 * Get the repository root on a remote host.
 *
 * @param cwd Path to check on the remote
 * @param sshRemote SSH remote configuration
 * @returns Repository root path
 */
export async function getRepoRootRemote(
	cwd: string,
	sshRemote: SshRemoteConfig
): Promise<RemoteGitResult<string>> {
	const result = await execGitRemote(['rev-parse', '--show-toplevel'], {
		sshRemote,
		remoteCwd: cwd,
	});

	if (result.exitCode !== 0) {
		return {
			success: false,
			error: result.stderr || 'Not a git repository',
		};
	}

	return {
		success: true,
		data: result.stdout.trim(),
	};
}
