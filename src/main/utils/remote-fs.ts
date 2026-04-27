/**
 * Remote File System utilities for SSH remote execution.
 *
 * Provides functions to perform file system operations on remote hosts via SSH.
 * These utilities enable File Explorer, Auto Run, and other features to work
 * when a session is running on a remote host.
 *
 * All functions accept a SshRemoteConfig and execute the corresponding
 * Unix commands (ls, cat, stat, du) via SSH, parsing their output.
 */

import { spawn } from 'child_process';
import { SshRemoteConfig } from '../../shared/types';
import { execFileNoThrow, ExecResult } from './execFile';
import { shellEscape, shellEscapeForDoubleQuotes } from './shell-escape';
import { sshRemoteManager } from '../ssh-remote-manager';
import { logger } from './logger';
import { resolveSshPath } from './cliDetection';

/**
 * File or directory entry returned from readDir operations.
 */
export interface RemoteDirEntry {
	/** File or directory name */
	name: string;
	/** Whether this entry is a directory */
	isDirectory: boolean;
	/** Whether this entry is a symbolic link */
	isSymlink: boolean;
}

/**
 * File stat information returned from stat operations.
 */
export interface RemoteStatResult {
	/** File size in bytes */
	size: number;
	/** Whether this is a directory */
	isDirectory: boolean;
	/** Modification time as Unix timestamp (milliseconds) */
	mtime: number;
}

/**
 * Result wrapper for remote fs operations.
 * Includes success/failure status and optional error message.
 */
export interface RemoteFsResult<T> {
	/** Whether the operation succeeded */
	success: boolean;
	/** The result data (if success is true) */
	data?: T;
	/** Error message (if success is false) */
	error?: string;
}

/**
 * Dependencies that can be injected for testing.
 */
export interface RemoteFsDeps {
	/** Function to execute SSH commands */
	execSsh: (command: string, args: string[]) => Promise<ExecResult>;
	/** Function to build SSH args from config */
	buildSshArgs: (config: SshRemoteConfig) => string[];
}

/**
 * Default dependencies using real implementations.
 */
const defaultDeps: RemoteFsDeps = {
	execSsh: (command: string, args: string[]): Promise<ExecResult> => {
		return execFileNoThrow(command, args, undefined, { timeout: SSH_COMMAND_TIMEOUT_MS });
	},
	buildSshArgs: (config: SshRemoteConfig): string[] => {
		return sshRemoteManager.buildSshArgs(config);
	},
};

/**
 * Patterns indicating transient SSH errors that should be retried.
 * These are network/connection issues that may resolve on retry.
 */
const RECOVERABLE_SSH_ERRORS = [
	/connection closed/i,
	/connection reset/i,
	/broken pipe/i,
	/network is unreachable/i,
	/connection timed out/i,
	/client_loop:\s*send disconnect/i,
	/packet corrupt/i,
	/protocol error/i,
	/ssh_exchange_identification/i,
	/connection unexpectedly closed/i,
	/kex_exchange_identification/i,
	/read: Connection reset by peer/i,
	/banner exchange/i, // SSH handshake failed - often due to stale ControlMaster sockets
	/socket is not connected/i, // Connection dropped before handshake
	/ETIMEDOUT/i, // Command timed out - SSH connection may be stale
];

/**
 * Check if an SSH error is recoverable (transient network issue).
 */
function isRecoverableSshError(stderr: string): boolean {
	return RECOVERABLE_SSH_ERRORS.some((pattern) => pattern.test(stderr));
}

/**
 * Default retry configuration for SSH operations.
 */
const DEFAULT_RETRY_CONFIG = {
	maxRetries: 3,
	baseDelayMs: 500,
	maxDelayMs: 5000,
};

/**
 * Timeout for individual SSH commands in milliseconds.
 * Prevents hung SSH connections (e.g., stale ControlMaster sockets)
 * from blocking the file tree load indefinitely.
 */
const SSH_COMMAND_TIMEOUT_MS = 30000;

/**
 * Maximum concurrent SSH commands per remote host.
 *
 * SSH-via-cloudflared (and similar tunneled transports) rate-limit aggressive
 * connection bursts. A naive recursive file walk over a large tree can spawn
 * hundreds of fresh SSH connections in seconds, saturating the tunnel and
 * starving unrelated SSH traffic — agent spawn, terminal start, git ops.
 *
 * 4 in-flight per host steady-state is well below cloudflared's burst threshold
 * while still keeping a multi-thousand-directory walk progressing acceptably
 * (each ls call is short). Excess calls queue rather than spawn new processes.
 */
const MAX_CONCURRENT_SSH_PER_HOST = 4;

/**
 * Per-host async semaphore. Caps in-flight SSH commands so a runaway scan on
 * one host can't exhaust the SSH transport for unrelated callers (agents,
 * terminals, git).
 */
class HostLimiter {
	private inFlight = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly max: number) {}

	async acquire(): Promise<void> {
		if (this.inFlight < this.max) {
			this.inFlight++;
			return;
		}
		await new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
		this.inFlight++;
	}

	release(): void {
		this.inFlight--;
		const next = this.waiters.shift();
		if (next) next();
	}
}

/** Limiters keyed by stable host identifier — see {@link sshHostKey}. */
const hostLimiters = new Map<string, HostLimiter>();

/** Stable key for per-host limiting. Different users/ports on the same host get separate limiters. */
function sshHostKey(config: SshRemoteConfig): string {
	const user = config.username?.trim() || '';
	return `${user}@${config.host}:${config.port}`;
}

function getHostLimiter(config: SshRemoteConfig): HostLimiter {
	const key = sshHostKey(config);
	let limiter = hostLimiters.get(key);
	if (!limiter) {
		limiter = new HostLimiter(MAX_CONCURRENT_SSH_PER_HOST);
		hostLimiters.set(key, limiter);
	}
	return limiter;
}

/**
 * Test-only: reset the per-host limiter map. Avoids cross-test state leakage
 * when tests exercise the limiter behavior with custom hosts.
 */
export function __resetHostLimitersForTest(): void {
	hostLimiters.clear();
}

/**
 * Sleep for a specified duration with jitter.
 */
function sleep(ms: number): Promise<void> {
	// Add 0-20% jitter to prevent thundering herd
	const jitter = ms * (Math.random() * 0.2);
	return new Promise((resolve) => setTimeout(resolve, ms + jitter));
}

/**
 * Calculate exponential backoff delay.
 */
function getBackoffDelay(attempt: number, baseDelay: number, maxDelay: number): number {
	const delay = baseDelay * Math.pow(2, attempt);
	return Math.min(delay, maxDelay);
}

/**
 * Execute a command on a remote host via SSH with automatic retry for transient errors.
 *
 * Implements exponential backoff with jitter for recoverable SSH errors like
 * connection closed, connection reset, broken pipe, etc.
 *
 * @param config SSH remote configuration
 * @param remoteCommand The shell command to execute on the remote
 * @param deps Optional dependencies for testing
 * @returns ExecResult with stdout, stderr, and exitCode
 */
async function execRemoteCommand(
	config: SshRemoteConfig,
	remoteCommand: string,
	deps: RemoteFsDeps = defaultDeps
): Promise<ExecResult> {
	const { maxRetries, baseDelayMs, maxDelayMs } = DEFAULT_RETRY_CONFIG;
	let lastResult: ExecResult | null = null;

	// Resolve SSH binary path (critical for Windows where spawn() doesn't search PATH)
	const sshPath = await resolveSshPath();

	// Cap concurrent SSH commands per host. Tunneled transports (e.g.,
	// cloudflared) drop connections under burst load; throttling here prevents
	// a recursive file scan from starving unrelated SSH consumers (agent spawn,
	// terminal, git). Acquired once for the whole retry loop so retries don't
	// double-count against the cap.
	const limiter = getHostLimiter(config);
	await limiter.acquire();

	try {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const sshArgs = deps.buildSshArgs(config);
			sshArgs.push(remoteCommand);

			const result = await deps.execSsh(sshPath, sshArgs);
			lastResult = result;

			// Success - return immediately
			if (result.exitCode === 0) {
				return result;
			}

			// Check if this is a recoverable error
			const combinedOutput = `${result.stderr} ${result.stdout}`;
			const isNodeTimeout = result.exitCode === 'ETIMEDOUT';
			if ((isRecoverableSshError(combinedOutput) || isNodeTimeout) && attempt < maxRetries) {
				const delay = getBackoffDelay(attempt, baseDelayMs, maxDelayMs);
				logger.debug(
					`[remote-fs] SSH transient error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${result.stderr.slice(0, 100)}`
				);
				await sleep(delay);
				continue;
			}

			// Non-recoverable error or max retries reached - return the result
			return result;
		}

		// Should never reach here, but return last result as fallback
		return lastResult!;
	} finally {
		limiter.release();
	}
}

function shellEscapeRemotePath(filePath: string): string {
	if (filePath === '~') {
		return '"$HOME"';
	}

	if (filePath.startsWith('~/')) {
		return `"$HOME/${shellEscapeForDoubleQuotes(filePath.slice(2))}"`;
	}

	if (filePath === '$HOME') {
		return '"$HOME"';
	}

	if (filePath.startsWith('$HOME/')) {
		return `"$HOME/${shellEscapeForDoubleQuotes(filePath.slice('$HOME/'.length))}"`;
	}

	return shellEscape(filePath);
}

/**
 * Read directory contents from a remote host via SSH.
 *
 * Executes `ls -la` on the remote and parses the output to extract
 * file names, types (directory, file, symlink), and other metadata.
 *
 * @param dirPath Path to the directory on the remote host
 * @param sshRemote SSH remote configuration
 * @param deps Optional dependencies for testing
 * @returns Array of directory entries
 *
 * @example
 * const entries = await readDirRemote('/home/user/project', sshConfig);
 * // => [{ name: 'src', isDirectory: true, isSymlink: false }, ...]
 */
export async function readDirRemote(
	dirPath: string,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<RemoteDirEntry[]>> {
	// Use ls with specific options:
	// -1: One entry per line
	// -A: Show hidden files except . and ..
	// -F: Append indicator (/ for dirs, @ for symlinks, * for executables)
	// --color=never: Disable color codes in output
	// We avoid -l because parsing long format is complex and locale-dependent
	//
	// A second command identifies symlinks whose targets are directories so
	// that consumers can recurse into them.  The marker line __SYMDIR__
	// separates the two outputs.
	//
	// Implementation choices (both matter — each guards against a real failure
	// we hit in production):
	//
	// 1. `find -mindepth 1 -maxdepth 1 -type l` rather than shell globs,
	//    because zsh (default shell on modern macOS) errors on unmatched
	//    globs (NOMATCH), which would fail the whole SSH command for any
	//    directory missing dotfiles. `find` has no such failure mode.
	//
	// 2. `-exec test -d {} \; -exec basename {} \;` rather than a
	//    `| while read` pipeline, because the while loop's exit status is
	//    the exit status of its last body command. If `find` returns any
	//    symlink whose target is NOT a directory (e.g. a symlink to a file),
	//    `test -d` fails for that iteration and the pipeline leaks exit 1,
	//    which `readDirRemote`'s caller would then report as a failure even
	//    though `ls` succeeded. `find -exec` always reports success when
	//    find itself completed, regardless of -exec outcomes.
	//
	// Both `-mindepth`/`-maxdepth` and the POSIX `-exec … {} \;` form are
	// supported by GNU and BSD (macOS) find.
	const escapedPath = shellEscapeRemotePath(dirPath);
	const symlinkScan =
		`find ${escapedPath} -mindepth 1 -maxdepth 1 -type l ` +
		`-exec test -d {} \\; -exec basename {} \\; 2>/dev/null`;
	const remoteCommand =
		`ls -1AF --color=never ${escapedPath} 2>/dev/null || echo "__LS_ERROR__"; ` +
		`echo "__SYMDIR__"; ` +
		symlinkScan;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0 && !result.stdout.includes('__LS_ERROR__')) {
		return {
			success: false,
			error: result.stderr || `ls failed with exit code ${result.exitCode}`,
		};
	}

	// Split output at the marker to separate ls output from symlink-dir list
	const parts = result.stdout.split('__SYMDIR__');
	const lsOutput = parts[0].trim();
	const symlinkDirNames = new Set((parts[1] || '').trim().split('\n').filter(Boolean));

	// Check for our error marker
	if (lsOutput === '__LS_ERROR__') {
		return {
			success: false,
			error: `Directory not found or not accessible: ${dirPath}`,
		};
	}

	const entries: RemoteDirEntry[] = [];
	const lines = lsOutput.split('\n').filter(Boolean);

	for (const line of lines) {
		if (!line || line === '__LS_ERROR__') continue;

		let name = line;
		let isDirectory = false;
		let isSymlink = false;

		// Parse the indicator suffix from -F flag
		if (name.endsWith('/')) {
			name = name.slice(0, -1);
			isDirectory = true;
		} else if (name.endsWith('@')) {
			name = name.slice(0, -1);
			isSymlink = true;
			// Resolve symlink: if the target is a directory, mark it as such
			if (symlinkDirNames.has(name)) {
				isDirectory = true;
			}
		} else if (name.endsWith('*')) {
			// Executable file - remove the indicator
			name = name.slice(0, -1);
		} else if (name.endsWith('|')) {
			// Named pipe - remove the indicator
			name = name.slice(0, -1);
		} else if (name.endsWith('=')) {
			// Socket - remove the indicator
			name = name.slice(0, -1);
		}

		// Skip empty names (shouldn't happen, but be safe)
		if (!name) continue;

		entries.push({ name, isDirectory, isSymlink });
	}

	return {
		success: true,
		data: entries,
	};
}

/**
 * Directory entry with stat metadata. Returned by {@link listDirWithStatsRemote}.
 */
export interface RemoteDirEntryWithStats {
	/** File name (basename, no leading directory) */
	name: string;
	/** File size in bytes */
	size: number;
	/** Modification time as Unix timestamp (milliseconds) */
	mtime: number;
}

/**
 * List files in a remote directory along with their size and mtime in a **single**
 * SSH call.
 *
 * Why this exists: firing `statRemote` per file via `Promise.all` opens one SSH
 * connection per file, which is rejected by sshd's `MaxStartups` limit (default
 * 10:30:100) once you go past ~30 concurrent files. This utility runs `stat` on
 * all files in the directory in one round-trip so large session directories
 * (hundreds of entries) list reliably.
 *
 * Only regular files are returned (directories and symlinks are skipped). The
 * optional `nameSuffix` filters by extension (e.g. `.jsonl`).
 */
export async function listDirWithStatsRemote(
	dirPath: string,
	sshRemote: SshRemoteConfig,
	options?: { nameSuffix?: string },
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<RemoteDirEntryWithStats[]>> {
	const escapedPath = shellEscape(dirPath);
	// Build a glob pattern passed to the remote shell. If no suffix is given,
	// match every non-hidden file in the directory.
	const glob = options?.nameSuffix ? `*${options.nameSuffix}` : '*';

	// Portable bulk stat: GNU (`stat --printf`) falls back to BSD (`stat -f`).
	// Output format: <size>|<mtime-seconds>|<name>\n
	// Using `|` as a separator — both UUID-style session names and common
	// filenames never contain it, and neither does whitespace in tab form.
	// The leading `cd` scopes `*.jsonl` expansion to the target dir so file
	// names come back as basenames rather than full paths.
	const remoteCommand =
		`cd ${escapedPath} 2>/dev/null || exit 0; ` +
		`if stat --version >/dev/null 2>&1; then ` +
		`stat --printf='%s|%Y|%n\\n' ${glob} 2>/dev/null || true; ` +
		`else ` +
		`stat -f '%z|%m|%N' ${glob} 2>/dev/null || true; ` +
		`fi`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		return {
			success: false,
			error: result.stderr || `Failed to list directory with stats: ${dirPath}`,
		};
	}

	const entries: RemoteDirEntryWithStats[] = [];
	const lines = result.stdout.split('\n');
	for (const line of lines) {
		if (!line) continue;
		// Name may contain `|` in pathological cases; split on first two pipes only.
		const firstPipe = line.indexOf('|');
		const secondPipe = firstPipe >= 0 ? line.indexOf('|', firstPipe + 1) : -1;
		if (firstPipe < 0 || secondPipe < 0) continue;
		const size = parseInt(line.slice(0, firstPipe), 10);
		const mtimeSeconds = parseInt(line.slice(firstPipe + 1, secondPipe), 10);
		const name = line.slice(secondPipe + 1);
		if (!name || isNaN(size) || isNaN(mtimeSeconds)) continue;
		entries.push({ name, size, mtime: mtimeSeconds * 1000 });
	}

	return { success: true, data: entries };
}

/**
 * Bulk-stat a fixed file name within every immediate subdirectory of
 * `parentDir`, in a single SSH round-trip.
 *
 * Why this exists: agents like Copilot store sessions as
 * `parentDir/<sessionId>/events.jsonl`. Listing N sessions naively means
 * one stat (or `du`) call per session, which fans out past sshd's
 * `MaxStartups` once N grows. This collapses the fan-out to one
 * shell-glob `stat` invocation.
 *
 * Returned entries use the parent subdirectory name (the session id, in
 * Copilot's case) as `name`. Subdirectories that lack the file are silently
 * omitted — the caller decides how to treat them.
 */
export async function bulkStatFileInSubdirsRemote(
	parentDir: string,
	fileName: string,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<RemoteDirEntryWithStats[]>> {
	// `fileName` is interpolated raw into a shell glob; reject any
	// metacharacters so a malicious caller can't inject extra commands.
	if (/[^\w.-]/.test(fileName)) {
		return { success: false, error: `Refusing unsafe fileName: ${fileName}` };
	}
	const escapedParent = shellEscape(parentDir);
	// Output one line per matching file: `<size>|<mtime-seconds>|<subdir>/<fileName>`.
	// Same GNU-then-BSD probe used by `listDirWithStatsRemote`. The leading
	// `cd` scopes the glob so file names come back as relative paths.
	const remoteCommand =
		`cd ${escapedParent} 2>/dev/null || exit 0; ` +
		`if stat --version >/dev/null 2>&1; then ` +
		`stat --printf='%s|%Y|%n\\n' */${fileName} 2>/dev/null || true; ` +
		`else ` +
		`stat -f '%z|%m|%N' */${fileName} 2>/dev/null || true; ` +
		`fi`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		return {
			success: false,
			error: result.stderr || `Failed to bulk-stat ${fileName} under: ${parentDir}`,
		};
	}

	const entries: RemoteDirEntryWithStats[] = [];
	const lines = result.stdout.split('\n');
	const suffix = `/${fileName}`;
	for (const line of lines) {
		if (!line) continue;
		const firstPipe = line.indexOf('|');
		const secondPipe = firstPipe >= 0 ? line.indexOf('|', firstPipe + 1) : -1;
		if (firstPipe < 0 || secondPipe < 0) continue;
		const size = parseInt(line.slice(0, firstPipe), 10);
		const mtimeSeconds = parseInt(line.slice(firstPipe + 1, secondPipe), 10);
		const fullName = line.slice(secondPipe + 1);
		if (!fullName || isNaN(size) || isNaN(mtimeSeconds)) continue;
		// Strip the trailing `/<fileName>` to recover the subdirectory name.
		if (!fullName.endsWith(suffix)) continue;
		const name = fullName.slice(0, -suffix.length);
		if (!name) continue;
		entries.push({ name, size, mtime: mtimeSeconds * 1000 });
	}

	return { success: true, data: entries };
}

/**
 * Read file contents from a remote host via SSH.
 *
 * Executes `cat` on the remote to read the file contents.
 * For binary files or very large files, consider using different approaches.
 *
 * @param filePath Path to the file on the remote host
 * @param sshRemote SSH remote configuration
 * @param deps Optional dependencies for testing
 * @returns File contents as a string
 *
 * @example
 * const content = await readFileRemote('/home/user/project/README.md', sshConfig);
 * // => '# My Project\n...'
 */
export async function readFileRemote(
	filePath: string,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<string>> {
	const escapedPath = shellEscapeRemotePath(filePath);
	// Use cat with explicit error handling
	const remoteCommand = `cat ${escapedPath}`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		const error = result.stderr || `Failed to read file: ${filePath}`;
		return {
			success: false,
			error: error.includes('No such file')
				? `File not found: ${filePath}`
				: error.includes('Is a directory')
					? `Path is a directory: ${filePath}`
					: error.includes('Permission denied')
						? `Permission denied: ${filePath}`
						: error,
		};
	}

	return {
		success: true,
		data: result.stdout,
	};
}

/**
 * Read a remote file with abort support — used for user-initiated file previews
 * where the user may close the tab mid-load to cancel the SSH read.
 *
 * Unlike readFileRemote (which buffers via execFile), this spawns ssh+cat
 * directly so we can SIGTERM the child process when the AbortSignal fires.
 * No retries: a user-driven open that fails should surface the error, not
 * silently retry while the user waits.
 */
export async function readFileRemoteAbortable(
	filePath: string,
	sshRemote: SshRemoteConfig,
	signal: AbortSignal
): Promise<RemoteFsResult<string>> {
	if (signal.aborted) {
		return { success: false, error: 'Aborted' };
	}

	const escapedPath = shellEscapeRemotePath(filePath);
	const remoteCommand = `cat ${escapedPath}`;

	const sshPath = await resolveSshPath();
	const sshArgs = sshRemoteManager.buildSshArgs(sshRemote);
	sshArgs.push(remoteCommand);

	const limiter = getHostLimiter(sshRemote);
	await limiter.acquire();

	try {
		return await new Promise<RemoteFsResult<string>>((resolve) => {
			const child = spawn(sshPath, sshArgs, {
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			let stdout = '';
			let stderr = '';
			let aborted = false;

			const onAbort = () => {
				aborted = true;
				// SIGTERM lets ssh tear down its connection cleanly; if the child
				// hasn't exited within a grace period, escalate to SIGKILL.
				child.kill('SIGTERM');
				setTimeout(() => {
					if (!child.killed) child.kill('SIGKILL');
				}, 1000).unref();
			};

			signal.addEventListener('abort', onAbort, { once: true });

			child.stdout?.setEncoding('utf-8');
			child.stdout?.on('data', (chunk: string) => {
				stdout += chunk;
			});

			child.stderr?.setEncoding('utf-8');
			child.stderr?.on('data', (chunk: string) => {
				stderr += chunk;
			});

			child.on('error', (err) => {
				signal.removeEventListener('abort', onAbort);
				resolve({ success: false, error: err.message });
			});

			child.on('close', (code) => {
				signal.removeEventListener('abort', onAbort);
				if (aborted) {
					resolve({ success: false, error: 'Aborted' });
					return;
				}
				if (code !== 0) {
					const err = stderr || `Failed to read file: ${filePath}`;
					resolve({
						success: false,
						error: err.includes('No such file')
							? `File not found: ${filePath}`
							: err.includes('Is a directory')
								? `Path is a directory: ${filePath}`
								: err.includes('Permission denied')
									? `Permission denied: ${filePath}`
									: err,
					});
					return;
				}
				resolve({ success: true, data: stdout });
			});
		});
	} finally {
		limiter.release();
	}
}

/**
 * Get file/directory stat information from a remote host via SSH.
 *
 * Executes `stat` on the remote with a specific format string to get
 * size, type, and modification time.
 *
 * @param filePath Path to the file or directory on the remote host
 * @param sshRemote SSH remote configuration
 * @param deps Optional dependencies for testing
 * @returns Stat information (size, isDirectory, mtime)
 *
 * @example
 * const stats = await statRemote('/home/user/project/package.json', sshConfig);
 * // => { size: 1234, isDirectory: false, mtime: 1703836800000 }
 */
export async function statRemote(
	filePath: string,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<RemoteStatResult>> {
	const escapedPath = shellEscapeRemotePath(filePath);
	// Use stat with format string:
	// %s = size in bytes
	// %F = file type (regular file, directory, symbolic link, etc.)
	// %Y = modification time as Unix timestamp (seconds)
	// Note: GNU stat vs BSD stat have different format specifiers
	// We try GNU format first (Linux), then BSD format (macOS)
	// BSD stat requires $'...' ANSI-C quoting to interpret \n as newlines
	const remoteCommand = `stat --printf='%s\\n%F\\n%Y' ${escapedPath} 2>/dev/null || stat -f $'%z\\n%HT\\n%m' ${escapedPath}`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		const error = result.stderr || `Failed to stat: ${filePath}`;
		return {
			success: false,
			error: error.includes('No such file')
				? `Path not found: ${filePath}`
				: error.includes('Permission denied')
					? `Permission denied: ${filePath}`
					: error,
		};
	}

	const lines = result.stdout.trim().split('\n');
	if (lines.length < 3) {
		return {
			success: false,
			error: `Invalid stat output for: ${filePath}`,
		};
	}

	const size = parseInt(lines[0], 10);
	const fileType = lines[1].toLowerCase();
	const mtimeSeconds = parseInt(lines[2], 10);

	if (isNaN(size) || isNaN(mtimeSeconds)) {
		return {
			success: false,
			error: `Failed to parse stat output for: ${filePath}`,
		};
	}

	// Determine if it's a directory from the file type string
	// GNU stat returns: "regular file", "directory", "symbolic link"
	// BSD stat returns: "Regular File", "Directory", "Symbolic Link"
	const isDirectory = fileType.includes('directory');

	return {
		success: true,
		data: {
			size,
			isDirectory,
			mtime: mtimeSeconds * 1000, // Convert to milliseconds
		},
	};
}

/**
 * Get total size of a directory from a remote host via SSH.
 *
 * Executes `du -sb` on the remote to calculate the total size
 * of all files in the directory.
 *
 * @param dirPath Path to the directory on the remote host
 * @param sshRemote SSH remote configuration
 * @param deps Optional dependencies for testing
 * @returns Total size in bytes
 *
 * @example
 * const size = await directorySizeRemote('/home/user/project', sshConfig);
 * // => 1234567890
 */
export async function directorySizeRemote(
	dirPath: string,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<number>> {
	const escapedPath = shellEscapeRemotePath(dirPath);
	// Use du with:
	// -s: summarize (total only)
	// -b: apparent size in bytes (GNU)
	// If -b not available (BSD), use -k and multiply by 1024
	const remoteCommand = `du -sb ${escapedPath} 2>/dev/null || du -sk ${escapedPath} 2>/dev/null | awk '{print $1 * 1024}'`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		const error = result.stderr || `Failed to get directory size: ${dirPath}`;
		return {
			success: false,
			error: error.includes('No such file')
				? `Directory not found: ${dirPath}`
				: error.includes('Permission denied')
					? `Permission denied: ${dirPath}`
					: error,
		};
	}

	// Parse the size from the output (first field)
	const output = result.stdout.trim();
	const match = output.match(/^(\d+)/);

	if (!match) {
		return {
			success: false,
			error: `Failed to parse du output for: ${dirPath}`,
		};
	}

	const size = parseInt(match[1], 10);

	if (isNaN(size)) {
		return {
			success: false,
			error: `Invalid size value for: ${dirPath}`,
		};
	}

	return {
		success: true,
		data: size,
	};
}

/**
 * Write file contents to a remote host via SSH.
 *
 * Uses cat with a heredoc to safely write content to a file on the remote.
 * This is safe for text content but not recommended for binary files.
 *
 * @param filePath Path to the file on the remote host
 * @param content Content to write
 * @param sshRemote SSH remote configuration
 * @param deps Optional dependencies for testing
 * @returns Success/failure result
 *
 * @example
 * const result = await writeFileRemote('/home/user/project/output.txt', 'Hello!', sshConfig);
 * // => { success: true }
 */
export async function writeFileRemote(
	filePath: string,
	content: string | Buffer,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<void>> {
	const escapedPath = shellEscapeRemotePath(filePath);

	// Use base64 encoding to safely transfer the content
	// This avoids issues with special characters, quotes, and newlines
	// Accept both string and Buffer for binary file support
	const base64Content = Buffer.isBuffer(content)
		? content.toString('base64')
		: Buffer.from(content, 'utf-8').toString('base64');

	// Decode base64 on remote and write to file
	const remoteCommand = `echo '${base64Content}' | base64 -d > ${escapedPath}`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		const error = result.stderr || `Failed to write file: ${filePath}`;
		return {
			success: false,
			error: error.includes('Permission denied')
				? `Permission denied: ${filePath}`
				: error.includes('No such file')
					? `Parent directory not found: ${filePath}`
					: error,
		};
	}

	return { success: true };
}

/**
 * Check if a path exists on a remote host via SSH.
 *
 * @param remotePath Path to check
 * @param sshRemote SSH remote configuration
 * @param deps Optional dependencies for testing
 * @returns Whether the path exists
 */
export async function existsRemote(
	remotePath: string,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<boolean>> {
	const escapedPath = shellEscapeRemotePath(remotePath);
	const remoteCommand = `test -e ${escapedPath} && echo "EXISTS" || echo "NOT_EXISTS"`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		return {
			success: false,
			error: result.stderr || 'Failed to check path existence',
		};
	}

	return {
		success: true,
		data: result.stdout.trim() === 'EXISTS',
	};
}

/**
 * Create a directory on a remote host via SSH.
 *
 * @param dirPath Directory path to create
 * @param sshRemote SSH remote configuration
 * @param recursive Whether to create parent directories (mkdir -p)
 * @param deps Optional dependencies for testing
 * @returns Success/failure result
 */
export async function mkdirRemote(
	dirPath: string,
	sshRemote: SshRemoteConfig,
	recursive: boolean = true,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<void>> {
	const escapedPath = shellEscapeRemotePath(dirPath);
	const mkdirFlag = recursive ? '-p' : '';
	const remoteCommand = `mkdir ${mkdirFlag} ${escapedPath}`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		const error = result.stderr || `Failed to create directory: ${dirPath}`;
		return {
			success: false,
			error: error.includes('Permission denied')
				? `Permission denied: ${dirPath}`
				: error.includes('File exists')
					? `Directory already exists: ${dirPath}`
					: error,
		};
	}

	return { success: true };
}

/**
 * Rename a file or directory on a remote host via SSH.
 *
 * @param oldPath Current path of the file/directory
 * @param newPath New path for the file/directory
 * @param sshRemote SSH remote configuration
 * @param deps Optional dependencies for testing
 * @returns Success/failure result
 */
export async function renameRemote(
	oldPath: string,
	newPath: string,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<void>> {
	const escapedOldPath = shellEscapeRemotePath(oldPath);
	const escapedNewPath = shellEscapeRemotePath(newPath);
	const remoteCommand = `mv ${escapedOldPath} ${escapedNewPath}`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		const error = result.stderr || `Failed to rename: ${oldPath}`;
		return {
			success: false,
			error: error.includes('Permission denied')
				? `Permission denied: ${oldPath}`
				: error.includes('No such file')
					? `Path not found: ${oldPath}`
					: error,
		};
	}

	return { success: true };
}

/**
 * Delete a file or directory on a remote host via SSH.
 *
 * @param targetPath Path to delete
 * @param sshRemote SSH remote configuration
 * @param recursive Whether to recursively delete directories (default: true)
 * @param deps Optional dependencies for testing
 * @returns Success/failure result
 */
export async function deleteRemote(
	targetPath: string,
	sshRemote: SshRemoteConfig,
	recursive: boolean = true,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<void>> {
	const escapedPath = shellEscapeRemotePath(targetPath);
	// Use rm -rf for recursive delete (directories), rm -f for files
	// The -f flag prevents errors if file doesn't exist
	const rmFlags = recursive ? '-rf' : '-f';
	const remoteCommand = `rm ${rmFlags} ${escapedPath}`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		const error = result.stderr || `Failed to delete: ${targetPath}`;
		return {
			success: false,
			error: error.includes('Permission denied')
				? `Permission denied: ${targetPath}`
				: error.includes('No such file')
					? `Path not found: ${targetPath}`
					: error,
		};
	}

	return { success: true };
}

/**
 * Count files and folders in a directory on a remote host via SSH.
 *
 * @param dirPath Directory path to count items in
 * @param sshRemote SSH remote configuration
 * @param deps Optional dependencies for testing
 * @returns File and folder counts
 */
export async function countItemsRemote(
	dirPath: string,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<{ fileCount: number; folderCount: number }>> {
	const escapedPath = shellEscapeRemotePath(dirPath);
	// Use find to count files and directories separately
	// -type f for files, -type d for directories (excluding the root dir itself)
	const remoteCommand = `echo "FILES:$(find ${escapedPath} -type f 2>/dev/null | wc -l)" && echo "DIRS:$(find ${escapedPath} -mindepth 1 -type d 2>/dev/null | wc -l)"`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0) {
		const error = result.stderr || `Failed to count items: ${dirPath}`;
		return {
			success: false,
			error: error.includes('Permission denied')
				? `Permission denied: ${dirPath}`
				: error.includes('No such file')
					? `Directory not found: ${dirPath}`
					: error,
		};
	}

	// Parse output like:
	// FILES:123
	// DIRS:45
	const output = result.stdout.trim();
	const filesMatch = output.match(/FILES:\s*(\d+)/);
	const dirsMatch = output.match(/DIRS:\s*(\d+)/);

	const fileCount = filesMatch ? parseInt(filesMatch[1], 10) : 0;
	const folderCount = dirsMatch ? parseInt(dirsMatch[1], 10) : 0;

	return {
		success: true,
		data: { fileCount, folderCount },
	};
}

/**
 * Options for {@link listTreeRemote}.
 */
export interface ListTreeOptions {
	/** Maximum depth to recurse into (find -maxdepth). Default 5. */
	maxDepth?: number;
	/**
	 * Glob patterns whose names should be pruned (no recursion). Patterns containing
	 * a `/` are skipped (find -name matches base names only). Patterns are passed
	 * verbatim to `find -name`, which interprets `*`, `?`, and `[…]` as globs.
	 */
	ignorePatterns?: string[];
	/**
	 * Relative paths (from `rootPath`) to exclude entirely via `find -path`. Used by
	 * the renderer to skip `.maestro` in the "rest of tree" phase since `.maestro`
	 * is enumerated in its own phase with no entry cap.
	 */
	excludePaths?: string[];
	/**
	 * Soft cap on file entries. Files beyond the cap are dropped server-side via
	 * `head -n`. Directories are never capped — the structure is always complete
	 * to `maxDepth`. Omit for unlimited.
	 */
	maxFiles?: number;
}

/**
 * Result of {@link listTreeRemote}. Paths are relative to the root passed to
 * the function, with no leading `./` or `/`.
 */
export interface ListTreeResult {
	/** Relative directory paths (e.g. `src`, `src/components`). */
	directories: string[];
	/** Relative file paths (e.g. `package.json`, `src/index.ts`). */
	files: string[];
	/** True iff the file list was truncated by the `maxFiles` cap. */
	truncated: boolean;
}

/**
 * Enumerate a remote directory tree in a single SSH round-trip.
 *
 * Replaces N per-directory `ls` calls with two `find` invocations bundled into
 * one SSH command (one for directories, one for files). Used by the file
 * explorer to load remote trees in 1–2 round-trips total instead of one per
 * directory.
 *
 * Implementation notes:
 * - `find -L` follows symlinks, so symlinks-to-directories appear as their
 *   target directories (matching the prior `readDir + per-symlink test -d`
 *   resolution behavior). Loop detection in find prevents infinite recursion.
 * - `find . -mindepth 1 …` is run with `cd` into the root so output paths come
 *   back relative (`./foo/bar`), avoiding ambiguity when `rootPath` contains
 *   spaces or `~`.
 * - Two find calls (rather than one with `-printf '%y\t%p\n'`) keeps us
 *   portable: `-printf` is GNU-only.
 * - The file list is piped through `head -n maxFiles+1` server-side so we
 *   never transfer more than the cap allows. The `+1` lets us detect overflow.
 */
export async function listTreeRemote(
	rootPath: string,
	options: ListTreeOptions,
	sshRemote: SshRemoteConfig,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<ListTreeResult>> {
	const maxDepth = options.maxDepth ?? 5;
	const rawIgnore = options.ignorePatterns ?? [];
	const rawExclude = options.excludePaths ?? [];
	const maxFiles = options.maxFiles;

	const escapedRoot = shellEscapeRemotePath(rootPath);

	// Single-quote each pattern for safe interpolation into the find command.
	// Inside single quotes, the shell does not expand anything; embedded quotes
	// are escaped with the standard '"'"' idiom.
	const sqQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

	const pruneTerms: string[] = [];
	for (const pattern of rawIgnore) {
		// `find -name` matches base names only; skip path-bearing patterns.
		if (!pattern || pattern.includes('/')) continue;
		pruneTerms.push(`-name ${sqQuote(pattern)}`);
	}
	for (const excludePath of rawExclude) {
		// Normalize to a leading `./` so it matches the relative paths produced
		// by `find . -mindepth 1`.
		const cleaned = excludePath.replace(/^\.?\/+/, '');
		if (!cleaned) continue;
		pruneTerms.push(`-path ${sqQuote(`./${cleaned}`)}`);
	}

	const pruneClause = pruneTerms.length > 0 ? `\\( ${pruneTerms.join(' -o ')} \\) -prune -o` : '';

	const dirFind = `find -L . -mindepth 1 -maxdepth ${maxDepth} ${pruneClause} -type d -print 2>/dev/null`;

	const headTail = maxFiles !== undefined ? ` | head -n ${maxFiles + 1}` : '';
	const fileFind = `find -L . -mindepth 1 -maxdepth ${maxDepth} ${pruneClause} -type f -print 2>/dev/null${headTail}`;

	const SEP = '__MAESTRO_FIND_SEP__';
	const remoteCommand =
		`cd ${escapedRoot} 2>/dev/null || { echo "__CD_ERROR__"; exit 0; }; ` +
		`${dirFind}; ` +
		`echo "${SEP}"; ` +
		`${fileFind}`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0 && !result.stdout.includes('__CD_ERROR__')) {
		return {
			success: false,
			error: result.stderr || `find failed with exit code ${result.exitCode}`,
		};
	}

	if (result.stdout.startsWith('__CD_ERROR__')) {
		return { success: false, error: `Directory not found or not accessible: ${rootPath}` };
	}

	const sepLine = `\n${SEP}\n`;
	const sepIdx = result.stdout.indexOf(sepLine);
	const dirSection = sepIdx >= 0 ? result.stdout.slice(0, sepIdx) : result.stdout;
	const fileSection = sepIdx >= 0 ? result.stdout.slice(sepIdx + sepLine.length) : '';

	const stripPrefix = (line: string): string => (line.startsWith('./') ? line.slice(2) : line);

	const directories = dirSection.split('\n').filter(Boolean).map(stripPrefix).filter(Boolean);

	const fileLinesRaw = fileSection.split('\n').filter(Boolean);
	let truncated = false;
	let fileLines = fileLinesRaw;
	if (maxFiles !== undefined && fileLinesRaw.length > maxFiles) {
		truncated = true;
		fileLines = fileLinesRaw.slice(0, maxFiles);
	}
	const files = fileLines.map(stripPrefix).filter(Boolean);

	return { success: true, data: { directories, files, truncated } };
}

/**
 * Result of an incremental file scan showing changes since last check.
 */
export interface IncrementalScanResult {
	/** Files added or modified since the reference time */
	added: string[];
	/** Files deleted since the reference time (requires full paths from previous scan) */
	deleted: string[];
	/** Whether any changes were detected */
	hasChanges: boolean;
	/** Timestamp of this scan (use for next incremental scan) */
	scanTime: number;
}

/**
 * Perform an incremental scan to find files changed since a reference time.
 * Uses `find -newer` with a temporary marker file for efficient delta detection.
 *
 * This is much faster than a full directory walk for large remote filesystems,
 * especially over slow SSH connections. On subsequent refreshes, only files
 * modified since the last scan are returned.
 *
 * Note: This cannot detect deletions directly. For deletion detection, the caller
 * should compare the returned paths against the previous file list.
 *
 * @param dirPath Directory to scan
 * @param sshRemote SSH remote configuration
 * @param sinceTimestamp Unix timestamp (seconds) to find changes after
 * @param deps Optional dependencies for testing
 * @returns List of changed file paths (relative to dirPath)
 */
export async function incrementalScanRemote(
	dirPath: string,
	sshRemote: SshRemoteConfig,
	sinceTimestamp: number,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<IncrementalScanResult>> {
	const escapedPath = shellEscapeRemotePath(dirPath);
	const scanTime = Math.floor(Date.now() / 1000);

	// Use find with -newermt to find files modified after the given timestamp
	// -newermt accepts a date string in ISO format
	// We exclude common patterns like node_modules and __pycache__
	const isoDate = new Date(sinceTimestamp * 1000).toISOString();
	const remoteCommand = `find ${escapedPath} -newermt "${isoDate}" -type f \\( ! -path "*/node_modules/*" ! -path "*/__pycache__/*" \\) 2>/dev/null || true`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	// find returns exit code 0 even with no matches, errors go to stderr
	if (result.exitCode !== 0 && result.stderr) {
		return {
			success: false,
			error: result.stderr,
		};
	}

	// Parse the output - each line is a full path
	const lines = result.stdout.trim().split('\n').filter(Boolean);

	// Convert to paths relative to dirPath
	const added = lines
		.map((line) => {
			// Remove the dirPath prefix to get relative path
			if (line.startsWith(dirPath)) {
				return line.substring(dirPath.length).replace(/^\//, '');
			}
			return line;
		})
		.filter(Boolean);

	return {
		success: true,
		data: {
			added,
			deleted: [], // Caller must detect deletions by comparing with previous state
			hasChanges: added.length > 0,
			scanTime,
		},
	};
}

/**
 * Get all file paths in a directory (for establishing baseline for incremental scans).
 * Uses find to list all files, which is faster than recursive readDir for large trees.
 *
 * @param dirPath Directory to scan
 * @param sshRemote SSH remote configuration
 * @param maxDepth Maximum depth to scan (default: 10)
 * @param deps Optional dependencies for testing
 * @returns List of all file paths (relative to dirPath)
 */
export async function listAllFilesRemote(
	dirPath: string,
	sshRemote: SshRemoteConfig,
	maxDepth: number = 10,
	deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<string[]>> {
	const escapedPath = shellEscapeRemotePath(dirPath);

	// Use find with -maxdepth to list all files
	// Exclude node_modules and __pycache__
	const remoteCommand = `find ${escapedPath} -maxdepth ${maxDepth} -type f \\( ! -path "*/node_modules/*" ! -path "*/__pycache__/*" \\) 2>/dev/null || true`;

	const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

	if (result.exitCode !== 0 && result.stderr) {
		return {
			success: false,
			error: result.stderr,
		};
	}

	const lines = result.stdout.trim().split('\n').filter(Boolean);

	// Convert to paths relative to dirPath
	const files = lines
		.map((line) => {
			if (line.startsWith(dirPath)) {
				return line.substring(dirPath.length).replace(/^\//, '');
			}
			return line;
		})
		.filter(Boolean);

	return {
		success: true,
		data: files,
	};
}
