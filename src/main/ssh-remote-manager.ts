/**
 * SSH Remote Manager for Maestro.
 *
 * Manages SSH remote configurations and provides connection testing.
 * Used to execute AI agent commands on remote hosts via SSH.
 */

import { SshRemoteConfig, SshRemoteTestResult } from '../shared/types';
import { execFileNoThrow, ExecResult } from './utils/execFile';
import { expandTilde } from '../shared/pathUtils';
import { captureException } from './utils/sentry';
import { getPathAccessCache, defaultReadableProbe } from './utils/path-access-cache';
import { validateSshOption } from '../shared/sshOptions';
import {
	buildSshConnectionArgs,
	buildSshProbeCommand,
	describeSshConnectionError,
	readSshProbeOutput,
} from '../shared/sshConnection';

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
 * Default dependencies using real implementations. `checkFileAccess` is
 * wrapped behind {@link PathAccessCache} so rapid re-validation (e.g.
 * consecutive Test Connection clicks) skips the duplicate stat. Test
 * deps mock `checkFileAccess` directly and bypass the cache entirely.
 */
const defaultDeps: SshRemoteManagerDeps = {
	checkFileAccess: (filePath: string): boolean => {
		return getPathAccessCache().check(filePath, defaultReadableProbe);
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

		// Note: id is intentionally NOT validated here. It is a storage concern,
		// not a connection concern, and the save handler always assigns one
		// (crypto.randomUUID) before persisting. Requiring it here would break
		// "Test Connection" before saving a brand-new remote, which has no id yet.

		if (!config.name || config.name.trim() === '') {
			errors.push('Name is required');
		}

		if (!config.host || config.host.trim() === '') {
			errors.push('Host is required');
		}

		// Username and privateKeyPath are always optional - SSH will use:
		// 1. Values from ~/.ssh/config if the host matches a Host pattern
		// 2. ssh-agent for key authentication
		// 3. System defaults (current user, default keys)
		// The connection test will verify if the configuration actually works.

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

		// Extra `-o` options. A malformed keyword makes ssh exit before it dials,
		// so rejecting it here names the offending option instead of surfacing a
		// bare "command-line: line 0: Bad configuration option" at spawn time.
		for (const [key, value] of Object.entries(config.sshOptions ?? {})) {
			const invalid = validateSshOption(key, value);
			if (invalid) errors.push(invalid);
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

		sshArgs.push(buildSshProbeCommand(agentCommand));

		try {
			const result = await this.deps.execSsh('ssh', sshArgs);

			if (result.exitCode !== 0) {
				// Parse common SSH error patterns
				const errorMessage = this.parseSSHError(result.stderr) || 'Connection failed';
				return { success: false, error: errorMessage };
			}

			const reading = readSshProbeOutput(result.stdout, Boolean(agentCommand));
			if (!reading.ok) {
				return { success: false, error: 'Unexpected response from remote host' };
			}

			return {
				success: true,
				remoteInfo: {
					hostname: reading.hostname ?? 'unknown',
					agentVersion: reading.agentFound ? 'installed' : undefined,
				},
			};
		} catch (err) {
			void captureException(err);
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
		// Delegates so the connection this tests is byte-identical to the one an
		// agent spawn opens. See src/shared/sshConnection.ts.
		return buildSshConnectionArgs(config);
	}

	/**
	 * Parse SSH error messages to provide user-friendly descriptions.
	 *
	 * @param stderr The stderr output from SSH
	 * @returns Human-readable error message, or undefined if not recognized
	 */
	private parseSSHError(stderr: string): string | undefined {
		// Shared so the CLI's test verb names a failure exactly as the app does.
		return describeSshConnectionError(stderr);
	}
}

/**
 * Singleton instance of SshRemoteManager.
 * Use this for all SSH remote operations.
 */
export const sshRemoteManager = new SshRemoteManager();
