/**
 * Remote Git Execution Utilities
 *
 * Provides functionality to execute git commands on remote hosts via SSH
 * when a session is configured for remote execution.
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
  /** Working directory on the remote host (optional - uses sshRemote.remoteWorkingDir if not provided) */
  remoteCwd?: string;
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

  // Determine the effective working directory on the remote
  const effectiveCwd = remoteCwd || sshRemote.remoteWorkingDir;

  if (!effectiveCwd) {
    logger.warn('No remote working directory specified for git command', LOG_CONTEXT);
  }

  // Build the remote command options
  const remoteOptions: RemoteCommandOptions = {
    command: 'git',
    args,
    cwd: effectiveCwd,
    // Pass any remote environment variables from the SSH config
    env: sshRemote.remoteEnv,
  };

  // Build the SSH command
  const sshCommand = buildSshCommand(sshRemote, remoteOptions);

  logger.debug(`Executing remote git command: ${args.join(' ')}`, LOG_CONTEXT, {
    host: sshRemote.host,
    cwd: effectiveCwd,
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
 * @param remoteCwd Optional remote working directory (overrides sshRemote.remoteWorkingDir)
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
