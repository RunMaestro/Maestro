/**
 * SSH Remote Manager for Maestro.
 *
 * Manages SSH remote configurations and provides connection testing.
 * Used to execute AI agent commands on remote hosts via SSH.
 */

import * as fs from 'fs';
import { SshRemoteConfig, SshRemoteTestResult } from '../shared/types';
import { execFileNoThrow, ExecResult } from './utils/execFile';
import { expandTilde } from '../shared/pathUtils';

/**
 * Validation result for SSH remote configuration.
 */
export interface SshRemoteValidation {
  /** Whether the configuration is valid */
  valid: boolean;
  /** List of validation error messages */
  errors: string[];
}

/**
 * Dependencies that can be injected for testing.
 */
export interface SshRemoteManagerDeps {
  /** Function to check file accessibility */
  checkFileAccess: (filePath: string) => boolean;
  /** Function to execute SSH commands */
  execSsh: (command: string, args: string[]) => Promise<ExecResult>;
}

/**
 * Default dependencies using real implementations.
 */
const defaultDeps: SshRemoteManagerDeps = {
  checkFileAccess: (filePath: string): boolean => {
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  execSsh: (command: string, args: string[]): Promise<ExecResult> => {
    return execFileNoThrow(command, args);
  },
};

/**
 * Manager for SSH remote configurations and connections.
 *
 * Provides:
 * - Configuration validation
 * - Connection testing
 * - SSH argument building
 */
export class SshRemoteManager {
  private readonly deps: SshRemoteManagerDeps;

  /**
   * Default SSH options used for all connections.
   * These options ensure non-interactive key-based authentication.
   */
  private readonly defaultSshOptions: Record<string, string> = {
    BatchMode: 'yes', // Disable password prompts (key-only)
    StrictHostKeyChecking: 'accept-new', // Auto-accept new host keys
    ConnectTimeout: '10', // Connection timeout in seconds
    ClearAllForwardings: 'yes', // Disable port forwarding from SSH config (avoids "Address already in use" errors)
    RequestTTY: 'no', // Don't request a TTY for command execution (avoids shell rc issues)
    ControlMaster: 'no', // Disable connection multiplexing to prevent "UNKNOWN port -1" errors when multiple agents connect to same server
    ControlPath: 'none', // Ensure no ControlPath is used from ~/.ssh/config
  };

  /**
   * Create a new SshRemoteManager.
   *
   * @param deps Optional dependencies for testing. Uses real implementations if not provided.
   */
  constructor(deps?: Partial<SshRemoteManagerDeps>) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /**
   * Validate an SSH remote configuration.
   *
   * Checks:
   * - Required fields are present
   * - Port is in valid range (1-65535)
   * - Private key file exists and is readable (unless using SSH config)
   *
   * When useSshConfig is true, username and privateKeyPath are optional
   * as they can be inherited from ~/.ssh/config.
   *
   * @param config The SSH remote configuration to validate
   * @returns Validation result with any error messages
   */
  validateConfig(config: SshRemoteConfig): SshRemoteValidation {
    const errors: string[] = [];

    // Required field checks (always required)
    if (!config.id || config.id.trim() === '') {
      errors.push('Configuration ID is required');
    }

    if (!config.name || config.name.trim() === '') {
      errors.push('Name is required');
    }

    if (!config.host || config.host.trim() === '') {
      errors.push('Host is required');
    }

    // Username and privateKeyPath are optional when using SSH config
    if (!config.useSshConfig) {
      if (!config.username || config.username.trim() === '') {
        errors.push('Username is required');
      }

      if (!config.privateKeyPath || config.privateKeyPath.trim() === '') {
        errors.push('Private key path is required');
      }
    }

    // Port validation
    if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535) {
      errors.push('Port must be between 1 and 65535');
    }

    // Private key file existence check (only if path is provided)
    if (config.privateKeyPath && config.privateKeyPath.trim() !== '') {
      const keyPath = expandTilde(config.privateKeyPath);
      if (!this.deps.checkFileAccess(keyPath)) {
        errors.push(`Private key not readable: ${config.privateKeyPath}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Test SSH connection to a remote host.
   *
   * Executes a simple command on the remote to verify:
   * - SSH connection can be established
   * - Authentication succeeds
   * - Remote shell is accessible
   *
   * Optionally checks if the specified agent command is available.
   *
   * @param config The SSH remote configuration to test
   * @param agentCommand Optional agent command to check availability (e.g., 'claude')
   * @returns Test result with success status and remote info
   */
  async testConnection(
    config: SshRemoteConfig,
    agentCommand?: string
  ): Promise<SshRemoteTestResult> {
    // First validate the config
    const validation = this.validateConfig(config);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.errors.join('; '),
      };
    }

    // Build SSH command for connection test
    const sshArgs = this.buildSshArgs(config);

    // Test command: echo marker, get hostname, optionally check agent
    let testCommand = 'echo "SSH_OK" && hostname';
    if (agentCommand) {
      testCommand += ` && which ${agentCommand} 2>/dev/null || echo "AGENT_NOT_FOUND"`;
    }
    sshArgs.push(testCommand);

    try {
      const result = await this.deps.execSsh('ssh', sshArgs);

      if (result.exitCode !== 0) {
        // Parse common SSH error patterns
        const errorMessage = this.parseSSHError(result.stderr) || 'Connection failed';
        return { success: false, error: errorMessage };
      }

      const lines = result.stdout.trim().split('\n');

      // Verify we got our marker
      if (lines[0] !== 'SSH_OK') {
        return { success: false, error: 'Unexpected response from remote host' };
      }

      // Extract hostname and agent info
      const hostname = lines[1] || 'unknown';
      let agentVersion: string | undefined;

      if (agentCommand && lines[2]) {
        if (lines[2] !== 'AGENT_NOT_FOUND') {
          agentVersion = 'installed'; // Path found = agent installed
        }
      }

      return {
        success: true,
        remoteInfo: {
          hostname,
          agentVersion,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Connection test failed: ${String(err)}`,
      };
    }
  }

  /**
   * Build SSH command-line arguments for a remote connection.
   *
   * Constructs the argument array needed for spawning SSH with
   * proper authentication and connection options.
   *
   * When config.useSshConfig is true, the arguments are minimal,
   * allowing SSH to use settings from ~/.ssh/config.
   *
   * @param config The SSH remote configuration
   * @returns Array of SSH command-line arguments
   */
  buildSshArgs(config: SshRemoteConfig): string[] {
    const args: string[] = [];

    // Force disable TTY allocation - this helps prevent shell rc files from being sourced
    args.push('-T');

    // Private key (only if provided, or required for non-SSH config mode)
    if (config.useSshConfig) {
      // Only add key if explicitly provided (as override)
      if (config.privateKeyPath && config.privateKeyPath.trim()) {
        args.push('-i', expandTilde(config.privateKeyPath));
      }
    } else {
      // Direct connection: require private key
      args.push('-i', expandTilde(config.privateKeyPath));
    }

    // Default SSH options
    for (const [key, value] of Object.entries(this.defaultSshOptions)) {
      args.push('-o', `${key}=${value}`);
    }

    // Port (only add if not using SSH config, or if non-default)
    if (!config.useSshConfig || config.port !== 22) {
      args.push('-p', config.port.toString());
    }

    // Build destination
    if (config.useSshConfig) {
      // When using SSH config, just the Host pattern (or user@host if overriding)
      if (config.username && config.username.trim()) {
        args.push(`${config.username}@${config.host}`);
      } else {
        args.push(config.host);
      }
    } else {
      // Direct connection: user@host
      args.push(`${config.username}@${config.host}`);
    }

    return args;
  }

  /**
   * Parse SSH error messages to provide user-friendly descriptions.
   *
   * @param stderr The stderr output from SSH
   * @returns Human-readable error message, or undefined if not recognized
   */
  private parseSSHError(stderr: string): string | undefined {
    const lowerStderr = stderr.toLowerCase();

    if (lowerStderr.includes('permission denied')) {
      return 'Authentication failed. Check username and private key.';
    }

    if (lowerStderr.includes('connection refused')) {
      return 'Connection refused. Check host and port.';
    }

    if (lowerStderr.includes('connection timed out') || lowerStderr.includes('timed out')) {
      return 'Connection timed out. Check host and network.';
    }

    if (lowerStderr.includes('no route to host')) {
      return 'No route to host. Check host address and network.';
    }

    if (
      lowerStderr.includes('could not resolve hostname') ||
      lowerStderr.includes('name or service not known')
    ) {
      return 'Could not resolve hostname. Check the host address.';
    }

    if (lowerStderr.includes('remote host identification has changed')) {
      return 'SSH host key changed. Verify server identity and update known_hosts.';
    }

    if (lowerStderr.includes('passphrase')) {
      return 'Private key has a passphrase. Key-based auth requires passphrase-less keys.';
    }

    if (lowerStderr.includes('no such file')) {
      return 'Private key file not found.';
    }

    // Return the raw stderr if we don't recognize the pattern
    if (stderr.trim()) {
      return stderr.trim();
    }

    return undefined;
  }
}

/**
 * Singleton instance of SshRemoteManager.
 * Use this for all SSH remote operations.
 */
export const sshRemoteManager = new SshRemoteManager();
