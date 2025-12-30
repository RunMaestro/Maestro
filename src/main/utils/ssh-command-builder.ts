/**
 * SSH Command Builder utilities for remote agent execution.
 *
 * Provides functions to construct SSH command invocations that wrap
 * agent commands for remote execution. These utilities work with
 * SshRemoteManager and ProcessManager to enable executing AI agents
 * on remote hosts via SSH.
 */

import { SshRemoteConfig } from '../../shared/types';
import { shellEscape, buildShellCommand } from './shell-escape';
import * as path from 'path';

/**
 * Result of building an SSH command.
 * Contains the command and arguments to pass to spawn().
 */
export interface SshCommandResult {
  /** The command to execute ('ssh') */
  command: string;
  /** Arguments for the SSH command */
  args: string[];
}

/**
 * Options for building the remote command.
 */
export interface RemoteCommandOptions {
  /** The command to execute on the remote host */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Working directory on the remote host (optional) */
  cwd?: string;
  /** Environment variables to set on the remote (optional) */
  env?: Record<string, string>;
}

/**
 * Default SSH options for all connections.
 * These options ensure non-interactive, key-based authentication.
 */
const DEFAULT_SSH_OPTIONS: Record<string, string> = {
  BatchMode: 'yes', // Disable password prompts (key-only)
  StrictHostKeyChecking: 'accept-new', // Auto-accept new host keys
  ConnectTimeout: '10', // Connection timeout in seconds
  ClearAllForwardings: 'yes', // Disable port forwarding from SSH config (avoids "Address already in use" errors)
  RequestTTY: 'no', // Don't request a TTY for command execution (avoids shell rc issues)
};

/**
 * Expand tilde (~) in paths to the user's home directory.
 *
 * @param filePath Path that may start with ~
 * @returns Expanded absolute path
 */
function expandPath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(homeDir, filePath.slice(1));
  }
  return filePath;
}

/**
 * Build the remote shell command string from command, args, cwd, and env.
 *
 * This function constructs a properly escaped shell command that:
 * 1. Changes to the specified working directory (if provided)
 * 2. Sets environment variables (if provided)
 * 3. Executes the command with its arguments
 *
 * The result is a single shell command string that can be passed to SSH.
 * All user-provided values are properly escaped to prevent shell injection.
 *
 * @param options Command options including command, args, cwd, and env
 * @returns Properly escaped shell command string for remote execution
 *
 * @example
 * buildRemoteCommand({
 *   command: 'claude',
 *   args: ['--print', '--verbose'],
 *   cwd: '/home/user/project',
 *   env: { ANTHROPIC_API_KEY: 'sk-...' }
 * })
 * // => "cd '/home/user/project' && ANTHROPIC_API_KEY='sk-...' 'claude' '--print' '--verbose'"
 */
export function buildRemoteCommand(options: RemoteCommandOptions): string {
  const { command, args, cwd, env } = options;

  const parts: string[] = [];

  // Add cd command if working directory is specified
  if (cwd) {
    parts.push(`cd ${shellEscape(cwd)}`);
  }

  // Build environment variable exports
  const envExports: string[] = [];
  if (env && Object.keys(env).length > 0) {
    for (const [key, value] of Object.entries(env)) {
      // Environment variable names are validated (alphanumeric + underscore)
      // but we still escape the value to be safe
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        envExports.push(`${key}=${shellEscape(value)}`);
      }
    }
  }

  // Build the command with arguments
  const commandWithArgs = buildShellCommand(command, args);

  // Combine env exports with command
  let fullCommand: string;
  if (envExports.length > 0) {
    // Prepend env vars inline: VAR1='val1' VAR2='val2' command args
    fullCommand = `${envExports.join(' ')} ${commandWithArgs}`;
  } else {
    fullCommand = commandWithArgs;
  }

  parts.push(fullCommand);

  // Join with && to ensure cd succeeds before running command
  return parts.join(' && ');
}

/**
 * Build SSH command and arguments for remote execution.
 *
 * This function constructs the complete SSH invocation to execute
 * a command on a remote host. It uses the SSH config for authentication
 * details and builds a properly escaped remote command string.
 *
 * When config.useSshConfig is true, the function relies on ~/.ssh/config
 * for connection settings (User, IdentityFile, Port, HostName) and only
 * passes the Host pattern to SSH. This allows leveraging existing SSH
 * configurations including ProxyJump for bastion hosts.
 *
 * @param config SSH remote configuration
 * @param remoteOptions Options for the remote command (command, args, cwd, env)
 * @returns Object with 'ssh' command and arguments array
 *
 * @example
 * // Direct connection (no SSH config)
 * buildSshCommand(
 *   { host: 'dev.example.com', port: 22, username: 'user', privateKeyPath: '~/.ssh/id_ed25519', ... },
 *   { command: 'claude', args: ['--print', 'hello'], cwd: '/home/user/project' }
 * )
 * // => {
 * //   command: 'ssh',
 * //   args: [
 * //     '-i', '/Users/me/.ssh/id_ed25519',
 * //     '-o', 'BatchMode=yes',
 * //     '-o', 'StrictHostKeyChecking=accept-new',
 * //     '-o', 'ConnectTimeout=10',
 * //     '-p', '22',
 * //     'user@dev.example.com',
 * //     "cd '/home/user/project' && 'claude' '--print' 'hello'"
 * //   ]
 * // }
 *
 * @example
 * // Using SSH config (useSshConfig: true)
 * buildSshCommand(
 *   { host: 'dev-server', useSshConfig: true, ... },
 *   { command: 'claude', args: ['--print', 'hello'] }
 * )
 * // => {
 * //   command: 'ssh',
 * //   args: [
 * //     '-o', 'BatchMode=yes',
 * //     '-o', 'StrictHostKeyChecking=accept-new',
 * //     '-o', 'ConnectTimeout=10',
 * //     'dev-server',  // SSH will look up settings from ~/.ssh/config
 * //     "'claude' '--print' 'hello'"
 * //   ]
 * // }
 */
export function buildSshCommand(
  config: SshRemoteConfig,
  remoteOptions: RemoteCommandOptions
): SshCommandResult {
  const args: string[] = [];

  // When using SSH config, we let SSH handle authentication settings
  // Only add explicit overrides if provided
  if (config.useSshConfig) {
    // Only specify identity file if explicitly provided (override SSH config)
    if (config.privateKeyPath && config.privateKeyPath.trim()) {
      args.push('-i', expandPath(config.privateKeyPath));
    }
  } else {
    // Direct connection: require private key
    args.push('-i', expandPath(config.privateKeyPath));
  }

  // Default SSH options for non-interactive operation
  // These are always needed to ensure BatchMode behavior
  for (const [key, value] of Object.entries(DEFAULT_SSH_OPTIONS)) {
    args.push('-o', `${key}=${value}`);
  }

  // Port specification - only add if not default and not using SSH config
  // (when using SSH config, let SSH config handle the port)
  if (!config.useSshConfig || config.port !== 22) {
    args.push('-p', config.port.toString());
  }

  // Build the destination (user@host or just host for SSH config)
  if (config.useSshConfig) {
    // When using SSH config, just pass the Host pattern
    // SSH will look up User, HostName, Port, IdentityFile from config
    // But if username is explicitly provided, use it as override
    if (config.username && config.username.trim()) {
      args.push(`${config.username}@${config.host}`);
    } else {
      args.push(config.host);
    }
  } else {
    // Direct connection: always include username
    args.push(`${config.username}@${config.host}`);
  }

  // Merge remote config's environment with the command-specific environment
  // Command-specific env takes precedence over remote config env
  const mergedEnv: Record<string, string> = {
    ...(config.remoteEnv || {}),
    ...(remoteOptions.env || {}),
  };

  // Determine the working directory:
  // 1. Use remoteOptions.cwd if provided (command-specific)
  // 2. Fall back to config.remoteWorkingDir if available
  // 3. No cd if neither is specified
  const effectiveCwd = remoteOptions.cwd || config.remoteWorkingDir;

  // Build the remote command string
  const remoteCommand = buildRemoteCommand({
    command: remoteOptions.command,
    args: remoteOptions.args,
    cwd: effectiveCwd,
    env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
  });

  args.push(remoteCommand);

  return {
    command: 'ssh',
    args,
  };
}
