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

import { SshRemoteConfig } from '../../shared/types';
import { execFileNoThrow, ExecResult } from './execFile';
import { shellEscape } from './shell-escape';
import { sshRemoteManager } from '../ssh-remote-manager';
import { logger } from './logger';

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
    return execFileNoThrow(command, args);
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

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const sshArgs = deps.buildSshArgs(config);
    sshArgs.push(remoteCommand);

    // Log SSH command for debugging connection issues
    if (attempt === 0) {
      logger.debug(`[remote-fs] SSH to ${config.host}: ssh ${sshArgs.slice(0, -1).join(' ')} "<command>"`);
    }

    const result = await deps.execSsh('ssh', sshArgs);
    lastResult = result;

    // Success - return immediately
    if (result.exitCode === 0) {
      return result;
    }

    // Check if this is a recoverable error
    const combinedOutput = `${result.stderr} ${result.stdout}`;
    if (isRecoverableSshError(combinedOutput) && attempt < maxRetries) {
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
  const escapedPath = shellEscape(dirPath);
  const remoteCommand = `ls -1AF --color=never ${escapedPath} 2>/dev/null || echo "__LS_ERROR__"`;

  const result = await execRemoteCommand(sshRemote, remoteCommand, deps);

  if (result.exitCode !== 0 && !result.stdout.includes('__LS_ERROR__')) {
    return {
      success: false,
      error: result.stderr || `ls failed with exit code ${result.exitCode}`,
    };
  }

  // Check for our error marker
  if (result.stdout.trim() === '__LS_ERROR__') {
    return {
      success: false,
      error: `Directory not found or not accessible: ${dirPath}`,
    };
  }

  const entries: RemoteDirEntry[] = [];
  const lines = result.stdout.trim().split('\n').filter(Boolean);

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
  const escapedPath = shellEscape(filePath);
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
  const escapedPath = shellEscape(filePath);
  // Use stat with format string:
  // %s = size in bytes
  // %F = file type (regular file, directory, symbolic link, etc.)
  // %Y = modification time as Unix timestamp (seconds)
  // Note: GNU stat vs BSD stat have different format specifiers
  // We try GNU format first (Linux), then BSD format (macOS)
  const remoteCommand = `stat --printf='%s\\n%F\\n%Y' ${escapedPath} 2>/dev/null || stat -f '%z\\n%HT\\n%m' ${escapedPath}`;

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
  const escapedPath = shellEscape(dirPath);
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
  content: string,
  sshRemote: SshRemoteConfig,
  deps: RemoteFsDeps = defaultDeps
): Promise<RemoteFsResult<void>> {
  const escapedPath = shellEscape(filePath);

  // Use base64 encoding to safely transfer the content
  // This avoids issues with special characters, quotes, and newlines
  const base64Content = Buffer.from(content, 'utf-8').toString('base64');

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
  const escapedPath = shellEscape(remotePath);
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
  const escapedPath = shellEscape(dirPath);
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
  const escapedOldPath = shellEscape(oldPath);
  const escapedNewPath = shellEscape(newPath);
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
  const escapedPath = shellEscape(targetPath);
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
  const escapedPath = shellEscape(dirPath);
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
