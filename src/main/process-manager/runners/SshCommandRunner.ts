// src/main/process-manager/runners/SshCommandRunner.ts

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { matchSshErrorPattern } from '../../parsers/error-patterns';
import { shellEscapeForDoubleQuotes } from '../../utils/shell-escape';
import { getExpandedEnv, resolveSshPath } from '../../utils/cliDetection';
import { expandTilde } from '../../../shared/pathUtils';
import { killProcessTreeNow } from '../utils/commandKill';
import type { CommandResult } from '../types';
import type { SshRemoteConfig } from '../../../shared/types';

/** Exit code for a command we SIGKILLed. 128+9, the shell convention. */
const SIGKILL_EXIT_CODE = 137;

/**
 * Runs terminal commands on remote hosts via SSH.
 */
export class SshCommandRunner {
	/**
	 * In-flight SSH commands keyed by sessionId. Killing the local `ssh` client
	 * drops the channel, which terminates the remote command. Entries are
	 * removed on exit. Mirrors LocalCommandRunner's registry.
	 */
	private running = new Map<string, () => void>();

	constructor(private emitter: EventEmitter) {}

	/**
	 * Terminate an in-flight command started by `run()`.
	 * Returns false when nothing is running under that sessionId.
	 */
	cancel(sessionId: string): boolean {
		const kill = this.running.get(sessionId);
		if (!kill) return false;
		kill();
		return true;
	}

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

		// Private key - only add if explicitly provided
		// SSH will use ~/.ssh/config or ssh-agent if no key is specified
		if (sshConfig.privateKeyPath && sshConfig.privateKeyPath.trim()) {
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

		// Build destination - use user@host if username provided, otherwise just host
		// SSH will use current user or ~/.ssh/config User directive if no username specified
		if (sshConfig.username && sshConfig.username.trim()) {
			sshArgs.push(`${sshConfig.username}@${sshConfig.host}`);
		} else {
			sshArgs.push(sshConfig.host);
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

			let settled = false;

			/** Report the run as finished exactly once. */
			const settle = (exitCode: number) => {
				if (settled) return;
				settled = true;
				this.running.delete(sessionId);
				this.emitter.emit('command-exit', sessionId, exitCode);
				resolve({ exitCode });
			};

			// Killing the local ssh client drops the channel, which is what ends the
			// remote command - we have no other handle on it. SIGKILL immediately,
			// same contract as the local runner: Stop means stopped, now.
			this.running.set(sessionId, () => {
				if (childProcess.pid) {
					killProcessTreeNow(childProcess.pid, { sessionId });
				}
				try {
					childProcess.kill('SIGKILL');
				} catch {
					// Already gone.
				}
				settle(SIGKILL_EXIT_CODE);
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
				settle(code || 0);
			});

			// Handle errors
			childProcess.on('error', (error) => {
				logger.error('[ProcessManager] runCommandViaSsh error', 'ProcessManager', {
					sessionId,
					error: error.message,
				});
				this.emitter.emit('stderr', sessionId, `SSH Error: ${error.message}`);
				settle(1);
			});
		});
	}
}
