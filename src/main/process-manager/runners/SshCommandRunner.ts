// src/main/process-manager/runners/SshCommandRunner.ts

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { matchSshErrorPattern } from '../../parsers/error-patterns';
import { shellEscapeForDoubleQuotes } from '../../utils/shell-escape';
import { getExpandedEnv, resolveSshPath } from '../../utils/cliDetection';
import { expandTilde } from '../../../shared/pathUtils';
import type { CommandResult } from '../types';
import type { SshRemoteConfig } from '../../../shared/types';

/**
 * Runs terminal commands on remote hosts via SSH.
 */
export class SshCommandRunner {
	constructor(private emitter: EventEmitter) {}

	/**
	 * Run a terminal command on a remote host via SSH
	 */
	async run(
		sessionId: string,
		command: string,
		cwd: string,
		sshConfig: SshRemoteConfig,
		shellEnvVars?: Record<string, string>
	): Promise<CommandResult> {
		// Build SSH arguments
		const sshArgs: string[] = [];

		// Force disable TTY allocation
		sshArgs.push('-T');

		// Add identity file
		if (sshConfig.useSshConfig) {
			// Only specify identity file if explicitly provided (override SSH config)
			if (sshConfig.privateKeyPath && sshConfig.privateKeyPath.trim()) {
				sshArgs.push('-i', expandTilde(sshConfig.privateKeyPath));
			}
		} else {
			// Direct connection: require private key
			sshArgs.push('-i', expandTilde(sshConfig.privateKeyPath));
		}

		// Default SSH options for non-interactive operation
		const sshOptions: Record<string, string> = {
			BatchMode: 'yes',
			StrictHostKeyChecking: 'accept-new',
			ConnectTimeout: '10',
			ClearAllForwardings: 'yes',
			RequestTTY: 'no',
		};
		for (const [key, value] of Object.entries(sshOptions)) {
			sshArgs.push('-o', `${key}=${value}`);
		}

		// Port specification
		if (!sshConfig.useSshConfig || sshConfig.port !== 22) {
			sshArgs.push('-p', sshConfig.port.toString());
		}

		// Build destination (user@host or just host for SSH config)
		if (sshConfig.useSshConfig) {
			if (sshConfig.username && sshConfig.username.trim()) {
				sshArgs.push(`${sshConfig.username}@${sshConfig.host}`);
			} else {
				sshArgs.push(sshConfig.host);
			}
		} else {
			sshArgs.push(`${sshConfig.username}@${sshConfig.host}`);
		}

		// Determine the working directory on the remote
		const remoteCwd = cwd || '~';

		// Merge environment variables: SSH config's remoteEnv + shell env vars
		const mergedEnv: Record<string, string> = {
			...(sshConfig.remoteEnv || {}),
			...(shellEnvVars || {}),
		};

		// Build the remote command with cd and env vars
		const envExports = Object.entries(mergedEnv)
			.filter(([key]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
			.map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'`)
			.join(' ');

		// Escape the user's command for the remote shell
		const escapedCommand = shellEscapeForDoubleQuotes(command);
		let remoteCommand: string;
		if (envExports) {
			remoteCommand = `cd '${remoteCwd.replace(/'/g, "'\\''")}' && ${envExports} $SHELL -lc "${escapedCommand}"`;
		} else {
			remoteCommand = `cd '${remoteCwd.replace(/'/g, "'\\''")}' && $SHELL -lc "${escapedCommand}"`;
		}

		// Wrap the entire thing for SSH
		const wrappedForSsh = `$SHELL -c "${shellEscapeForDoubleQuotes(remoteCommand)}"`;
		sshArgs.push(wrappedForSsh);

		logger.info('[ProcessManager] runCommandViaSsh spawning', 'ProcessManager', {
			sessionId,
			sshHost: sshConfig.host,
			remoteCwd,
			command,
			fullSshCommand: `ssh ${sshArgs.join(' ')}`,
		});

		// Resolve SSH path before entering the Promise
		const sshPath = await resolveSshPath();
		const expandedEnv = getExpandedEnv();

		return new Promise((resolve) => {
			const childProcess = spawn(sshPath, sshArgs, {
				env: {
					...expandedEnv,
					HOME: process.env.HOME,
					SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
				},
			});

			// Handle stdout
			childProcess.stdout?.on('data', (data: Buffer) => {
				const output = data.toString();
				if (output.trim()) {
					logger.debug('[ProcessManager] runCommandViaSsh stdout', 'ProcessManager', {
						sessionId,
						length: output.length,
					});
					this.emitter.emit('data', sessionId, output);
				}
			});

			// Handle stderr
			childProcess.stderr?.on('data', (data: Buffer) => {
				const output = data.toString();
				logger.debug('[ProcessManager] runCommandViaSsh stderr', 'ProcessManager', {
					sessionId,
					output: output.substring(0, 200),
				});

				// Check for SSH-specific errors
				const sshError = matchSshErrorPattern(output);
				if (sshError) {
					logger.warn('[ProcessManager] SSH error detected in terminal command', 'ProcessManager', {
						sessionId,
						errorType: sshError.type,
						message: sshError.message,
					});
				}

				this.emitter.emit('stderr', sessionId, output);
			});

			// Handle process exit
			childProcess.on('exit', (code) => {
				logger.debug('[ProcessManager] runCommandViaSsh exit', 'ProcessManager', {
					sessionId,
					exitCode: code,
				});
				this.emitter.emit('command-exit', sessionId, code || 0);
				resolve({ exitCode: code || 0 });
			});

			// Handle errors
			childProcess.on('error', (error) => {
				logger.error('[ProcessManager] runCommandViaSsh error', 'ProcessManager', {
					sessionId,
					error: error.message,
				});
				this.emitter.emit('stderr', sessionId, `SSH Error: ${error.message}`);
				this.emitter.emit('command-exit', sessionId, 1);
				resolve({ exitCode: 1 });
			});
		});
	}
}
