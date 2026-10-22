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
import { isWorktreeAlreadyUsedError, parseWorktreePathForBranch } from '../../shared/gitUtils';
import { shellEscapeRemotePath } from './shell-escape';

const LOG_CONTEXT = '[RemoteGit]';

/**
 * Options for remote git execution
 */
export interface RemoteGitOptions {
	/** SSH remote configuration */
	sshRemote: SshRemoteConfig;
	/** Working directory on the remote host */
	remoteCwd?: string;
	/** Kill the SSH invocation after this many milliseconds */
	timeout?: number;
	/** Extra environment for the remote git, merged over the remote's `remoteEnv` */
	env?: Record<string, string>;
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
	const { sshRemote, remoteCwd, timeout, env } = options;

	if (!remoteCwd) {
		logger.warn('No remote working directory specified for git command', LOG_CONTEXT);
	}

	// Build the remote command options
	const remoteOptions: RemoteCommandOptions = {
		command: 'git',
		args,
		cwd: remoteCwd,
		// Pass any remote environment variables from the SSH config
		env: env ? { ...(sshRemote.remoteEnv ?? {}), ...env } : sshRemote.remoteEnv,
	};

	// Build the SSH command
	const sshCommand = await buildSshCommand(sshRemote, remoteOptions);

	logger.debug(`Executing remote git command: ${args.join(' ')}`, LOG_CONTEXT, {
		host: sshRemote.host,
		cwd: remoteCwd,
	});

	// Execute the SSH command
	const result = timeout
		? await execFileNoThrow(sshCommand.command, sshCommand.args, undefined, { timeout })
		: await execFileNoThrow(sshCommand.command, sshCommand.args);

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
	remoteCwd?: string,
	options: { timeout?: number; env?: Record<string, string> } = {}
): Promise<ExecResult> {
	const { timeout, env } = options;
	if (sshRemote) {
		return execGitRemote(args, {
			sshRemote,
			remoteCwd,
			...(timeout ? { timeout } : {}),
			...(env ? { env } : {}),
		});
	}

	// Local execution. `env` replaces the child's environment wholesale, so
	// extra variables are layered over this process's own.
	if (!timeout && !env) return execFileNoThrow('git', args, localCwd);
	return execFileNoThrow('git', args, localCwd, {
		...(timeout ? { timeout } : {}),
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
}

/**
 * How long a background read-only git query (the git indicator's status,
 * branch and numstat polls) may run before the caller gets a timeout instead
 * of an answer. A repo in an iCloud Drive / file-provider folder blocks every
 * `git status` on the OS downloading offloaded files, which can take minutes.
 */
export const READ_ONLY_GIT_TIMEOUT_MS = 20_000;

/** Same text `execFileNoThrow` appends to stderr when it kills a timed-out child. */
const timeoutResult = (timeoutMs: number): ExecResult => ({
	stdout: '',
	stderr: `ETIMEDOUT: process timed out after ${timeoutMs}ms`,
	exitCode: 'ETIMEDOUT',
});

/** True when a git result is a timeout rather than an answer from git. */
export function isGitTimeout(result: ExecResult): boolean {
	return result.exitCode === 'ETIMEDOUT';
}

// One live process per (host, folder, command). Entries are removed when the
// git process actually exits, not when a caller gives up on it, so a process
// that ignores its kill signal still blocks new spawns for that folder.
const readOnlyGitInFlight = new Map<string, Promise<ExecResult>>();

/**
 * Disables git's optional locks (the index refresh `git status` writes back).
 * Equivalent to `git --no-optional-locks`, but set through the environment
 * because the flag is a hard "unknown option" error before git 2.15, which an
 * older SSH host would turn into an empty status (a false "clean"), while the
 * variable is simply ignored there.
 */
const NO_OPTIONAL_LOCKS_ENV = { GIT_OPTIONAL_LOCKS: '0' } as const;

/**
 * Run a read-only git query that the UI polls in the background.
 *
 * Three things `execGit` does not do, each of which a slow folder needs:
 * - No optional locks (`GIT_OPTIONAL_LOCKS=0`), so the query never takes
 *   `.git/index.lock` and cannot fight the agent's own git commands for it.
 * - A timeout: the child is killed and the caller gets an `ETIMEDOUT` result.
 * - Single-flight per folder: a caller that arrives while the same query is
 *   still running joins it instead of spawning another. Without this, every
 *   poll tick on a folder where git hangs adds one more stuck process.
 *
 * Callers always settle within `timeoutMs`, even if the child has not exited
 * yet; later callers keep joining that child until it does.
 */
export async function execGitReadOnly(
	args: string[],
	localCwd: string,
	sshRemote?: SshRemoteConfig | null,
	remoteCwd?: string,
	timeoutMs: number = READ_ONLY_GIT_TIMEOUT_MS
): Promise<ExecResult> {
	const key = [sshRemote?.id ?? '', sshRemote ? (remoteCwd ?? '') : localCwd, ...args].join('\0');
	let run = readOnlyGitInFlight.get(key);
	if (!run) {
		run = execGit(args, localCwd, sshRemote, remoteCwd, {
			timeout: timeoutMs,
			env: NO_OPTIONAL_LOCKS_ENV,
		}).finally(() => {
			readOnlyGitInFlight.delete(key);
		});
		readOnlyGitInFlight.set(key, run);
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<ExecResult>((resolve) => {
		timer = setTimeout(() => resolve(timeoutResult(timeoutMs)), timeoutMs);
	});
	try {
		return await Promise.race([run, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Options for `execShellRemote`.
 */
export interface RemoteShellOptions {
	/** Working directory on the remote host */
	cwd?: string;
	/** Extra environment variables, merged over the SSH config's `remoteEnv` */
	env?: Record<string, string>;
	/** Timeout in milliseconds for the whole SSH invocation */
	timeoutMs?: number;
}

/**
 * Execute a shell command on a remote host via SSH.
 *
 * @param shellCommand The shell command to execute on the remote
 * @param sshRemote SSH remote configuration
 * @param options Optional remote cwd, extra env, and timeout
 * @returns Execution result
 */
export async function execShellRemote(
	shellCommand: string,
	sshRemote: SshRemoteConfig,
	options?: RemoteShellOptions
): Promise<ExecResult> {
	// Keep `env` undefined when there's nothing to set so the SSH command builder
	// doesn't prepend an empty `env` prefix to the remote command.
	const mergedEnv = options?.env
		? { ...(sshRemote.remoteEnv ?? {}), ...options.env }
		: sshRemote.remoteEnv;

	const remoteOptions: RemoteCommandOptions = {
		command: 'sh',
		args: ['-c', shellCommand],
		cwd: options?.cwd,
		env: mergedEnv,
	};

	const sshCommand = await buildSshCommand(sshRemote, remoteOptions);
	return execFileNoThrow(
		sshCommand.command,
		sshCommand.args,
		undefined,
		options?.timeoutMs ? { timeout: options.timeoutMs } : undefined
	);
}

/**
 * Backwards-compatible wrapper for the many callers below that only need a
 * bare remote shell command with no cwd, env, or timeout.
 */
async function execRemoteShellCommand(
	shellCommand: string,
	sshRemote: SshRemoteConfig
): Promise<ExecResult> {
	return execShellRemote(shellCommand, sshRemote);
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
	/** True when the branch was already attached to a worktree on disk. */
	alreadyExisted?: boolean;
	/** Path of the existing worktree when alreadyExisted is true. */
	existingPath?: string;
}

/**
 * Look up the worktree path currently checked out on the given branch by
 * running `git worktree list --porcelain` against the remote main repo.
 *
 * Stale registrations (where the directory was removed manually without
 * `git worktree prune`) are filtered out by a `test -d` check on the remote
 * so callers never get a path that points at nothing.
 *
 * @returns Absolute worktree path on the remote, or null if not found / stale
 */
async function findRemoteWorktreeForBranch(
	mainRepoCwd: string,
	branchName: string,
	sshRemote: SshRemoteConfig
): Promise<string | null> {
	const result = await execGitRemote(['worktree', 'list', '--porcelain'], {
		sshRemote,
		remoteCwd: mainRepoCwd,
	});
	if (result.exitCode !== 0) return null;
	const existingPath = parseWorktreePathForBranch(result.stdout, branchName);
	if (!existingPath) return null;
	const existsResult = await execRemoteShellCommand(
		`test -d '${existingPath}' && echo EXISTS || echo MISSING`,
		sshRemote
	);
	if (existsResult.exitCode !== 0 || !existsResult.stdout.includes('EXISTS')) {
		return null;
	}
	return existingPath;
}

/**
 * Create or reuse a worktree on a remote host.
 *
 * @param mainRepoCwd Path to the main repository on the remote
 * @param worktreePath Path where the worktree should be created
 * @param branchName Branch name for the worktree
 * @param sshRemote SSH remote configuration
 * @param baseBranch When the branch does not exist, the ref to branch from
 *                   (passed to `git worktree add -b <new> <path> <base>`).
 *                   Defaults to the remote main repo's HEAD when omitted.
 * @returns Setup result with success/failure and branch info
 */
export async function worktreeSetupRemote(
	mainRepoCwd: string,
	worktreePath: string,
	branchName: string,
	sshRemote: SshRemoteConfig,
	baseBranch?: string
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
		// baseBranch is irrelevant when the branch already exists.
		createResult = await execGitRemote(['worktree', 'add', worktreePath, branchName], {
			sshRemote,
			remoteCwd: mainRepoCwd,
		});
	} else if (baseBranch) {
		createResult = await execGitRemote(
			['worktree', 'add', '-b', branchName, worktreePath, baseBranch],
			{
				sshRemote,
				remoteCwd: mainRepoCwd,
			}
		);
	} else {
		createResult = await execGitRemote(['worktree', 'add', '-b', branchName, worktreePath], {
			sshRemote,
			remoteCwd: mainRepoCwd,
		});
	}

	if (createResult.exitCode !== 0) {
		// Recover from "already used / already checked out" - the branch is
		// attached to another worktree on the remote. Resolve that path so
		// callers can open it instead of surfacing an opaque error.
		const errMsg = createResult.stderr || '';
		if (isWorktreeAlreadyUsedError(errMsg)) {
			const existingPath = await findRemoteWorktreeForBranch(mainRepoCwd, branchName, sshRemote);
			logger.debug(
				`Worktree-already-used recovery: branch=${branchName} host=${sshRemote.host} existingPath=${existingPath ?? '<none>'}`,
				LOG_CONTEXT
			);
			if (existingPath) {
				return {
					success: true,
					data: {
						success: true,
						created: false,
						alreadyExisted: true,
						existingPath,
						currentBranch: branchName,
						requestedBranch: branchName,
						branchMismatch: false,
					},
				};
			}
		}
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
	/** Retained registry entries whose worktree directory is no longer reachable. */
	isPrunable?: boolean;
}

/** Resolve configured worktree directories on the remote host before comparing Git paths. */
export async function resolveWorktreePathsRemote(
	cwd: string,
	basePath: string,
	sshRemote: SshRemoteConfig,
	sessionPaths: string[] = []
): Promise<
	RemoteGitResult<{
		resolvedCwd: string;
		resolvedBasePath: string;
		resolvedSessionPaths?: Record<string, string>;
		missingSessionPaths?: string[];
		unresolvedSessionPaths?: string[];
	}>
> {
	if (!cwd || !basePath) {
		return { success: false, error: 'Missing remote worktree directory' };
	}
	// The line-based protocol cannot preserve these characters. Command
	// substitution also strips trailing line feeds from physical path output.
	if ([cwd, basePath].some((p) => /[\r\n\0]/.test(p))) {
		return { success: false, error: 'Invalid remote worktree path characters' };
	}
	// Subshells keep relative paths relative to the same SSH login directory.
	// pwd -P follows symlinks without depending on GNU realpath flags.
	const result = await execShellRemote(
		`(cd -P -- ${shellEscapeRemotePath(cwd)} && pwd -P) && (cd -P -- ${shellEscapeRemotePath(basePath)} && pwd -P)`,
		sshRemote
	);
	if (result.exitCode !== 0) {
		return {
			success: false,
			error: result.stderr?.trim() || 'Could not resolve remote worktree paths',
		};
	}
	const paths = result.stdout.replace(/\n$/, '').split('\n');
	if (paths.length !== 2 || paths.some((p) => !p.startsWith('/') || /[\r\0]/.test(p))) {
		return { success: false, error: 'Invalid resolved remote worktree paths' };
	}
	const aliases = await resolveWorktreeAliasesRemote(sessionPaths, sshRemote);
	if (!aliases.success || !aliases.data) {
		return { success: false, error: aliases.error || 'Could not resolve remote worktree aliases' };
	}
	return {
		success: true,
		data: { resolvedCwd: paths[0], resolvedBasePath: paths[1], ...aliases.data },
	};
}

/** Resolve saved or registered worktree aliases independently, preserving individual probe failures. */
export async function resolveWorktreeAliasesRemote(
	sessionPaths: string[],
	sshRemote: SshRemoteConfig
): Promise<
	RemoteGitResult<{
		resolvedSessionPaths?: Record<string, string>;
		missingSessionPaths?: string[];
		unresolvedSessionPaths?: string[];
	}>
> {
	// A matching lexical base prefix does not establish physical identity:
	// leaf or group symlinks can point elsewhere, including registry paths.
	const uniqueSessionPaths = [...new Set(sessionPaths)];
	const unresolvedSessionPaths = new Set(
		uniqueSessionPaths.filter((p) => !p || /[\r\n\0]/.test(p))
	);
	const aliases = uniqueSessionPaths.filter((candidate) => !unresolvedSessionPaths.has(candidate));
	let resolvedSessionPaths: Record<string, string> | undefined;
	const missingSessionPaths: string[] = [];
	if (aliases.length > 0) {
		// A failed cd alone does not prove deletion: it may be a permission
		// failure, an inaccessible alias ancestor, or a dangling symlink. Only
		// derive a missing leaf's physical candidate from a reachable parent.
		// Each path produces its own status, including unresolved errors. NUL
		// framing keeps an invalid physical filename from corrupting sibling
		// records. The marker retains filename-final line feeds across shell
		// command substitution; those paths are preserved as unresolved below.
		const probe = `for p in ${aliases.map(shellEscapeRemotePath).join(' ')}; do
if physical=$(cd -P -- "$p" >/dev/null 2>&1 && pwd -P && printf '.'); then
	physical=\${physical%.}; physical=\${physical%?}
	printf 'resolved\\000%s\\000' "$physical"
else
	trimmed=$p
	while [ "\${trimmed%/}" != "$trimmed" ]; do trimmed=\${trimmed%/}; done
	leaf=\${trimmed##*/}
	case "$leaf" in ''|.|..) printf 'unresolved\\000-\\000'; continue ;; esac
	parent=\${trimmed%/*}
	if [ "$parent" = "$trimmed" ]; then parent=.; fi
	if [ -z "$parent" ]; then parent=/; fi
	if physical=$(cd -P -- "$parent" >/dev/null 2>&1 || exit 1
		if [ -e "./$leaf" ] || [ -L "./$leaf" ]; then exit 1; fi
		pwd -P && printf '.'); then
		physical=\${physical%.}; physical=\${physical%?}
		printf 'missing\\000%s/%s\\000' "\${physical%/}" "$leaf"
	else
		printf 'unresolved\\000-\\000'
	fi
fi
done`;
		const resolved = await execShellRemote(probe, sshRemote);
		const resolvedAliases = resolved.stdout.split('\0').slice(0, -1);
		if (
			resolved.exitCode !== 0 ||
			!resolved.stdout.endsWith('\0') ||
			resolvedAliases.length !== aliases.length * 2
		) {
			return {
				success: false,
				error: resolved.stderr?.trim() || 'Could not resolve existing remote worktree paths',
			};
		}
		const resolvedEntries: [string, string][] = [];
		aliases.forEach((alias, index) => {
			const status = resolvedAliases[index * 2];
			const path = resolvedAliases[index * 2 + 1];
			if (!['resolved', 'missing'].includes(status) || !/^\/[^\r\n\0]*$/.test(path)) {
				unresolvedSessionPaths.add(alias);
				return;
			}
			if (status === 'missing') missingSessionPaths.push(alias);
			resolvedEntries.push([alias, path]);
		});
		if (resolvedEntries.length > 0) resolvedSessionPaths = Object.fromEntries(resolvedEntries);
	}
	return {
		success: true,
		data: {
			...(resolvedSessionPaths ? { resolvedSessionPaths } : {}),
			...(missingSessionPaths.length > 0 ? { missingSessionPaths } : {}),
			...(unresolvedSessionPaths.size > 0
				? { unresolvedSessionPaths: [...unresolvedSessionPaths] }
				: {}),
		},
	};
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
		return {
			success: false,
			error: result.stderr?.trim() || `git worktree list failed: ${result.exitCode}`,
		};
	}
	if (!result.stdout.trim()) {
		return { success: false, error: 'git worktree list returned no worktrees' };
	}

	// Parse porcelain output
	const worktrees: RemoteWorktreeEntry[] = [];
	const lines = result.stdout.split('\n');
	let current: {
		path?: string;
		head?: string;
		branch?: string | null;
		isBare?: boolean;
		isPrunable?: boolean;
	} = {};

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
		} else if (line === 'prunable' || line.startsWith('prunable ')) {
			current.isPrunable = true;
		} else if (line === '' && current.path) {
			worktrees.push({
				path: current.path,
				head: current.head || '',
				branch: current.branch ?? null,
				isBare: current.isBare || false,
				...(current.isPrunable ? { isPrunable: true } : {}),
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
			...(current.isPrunable ? { isPrunable: true } : {}),
		});
	}
	if (worktrees.length === 0) {
		return { success: false, error: 'git worktree list returned no valid worktrees' };
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
