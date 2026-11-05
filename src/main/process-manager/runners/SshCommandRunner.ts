// src/main/process-manager/runners/SshCommandRunner.ts

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { matchSshErrorPattern } from '../../parsers/error-patterns';
import { shellEscapeForDoubleQuotes, shellEscapeRemotePath } from '../../utils/shell-escape';
import { getExpandedEnv, resolveSshPath } from '../../utils/cliDetection';
import { expandTilde } from '../../../shared/pathUtils';
import { killProcessTreeNow } from '../utils/commandKill';
import type { CommandResult } from '../types';
import type { SshRemoteConfig } from '../../../shared/types';
import { buildSshOptionArgs } from '../../../shared/sshOptions';
import { beginGlobalWorktreeActivity } from '../../git/worktreeActivity';
import { withWorktreeTurnActivity } from '../../git/worktreeTurnActivity';
import { captureException } from '../../utils/sentry';

/** Exit code for a command we SIGKILLed. 128+9, the shell convention. */
const SIGKILL_EXIT_CODE = 137;

/**
 * Runs terminal commands on remote hosts via SSH.
 */
export class SshCommandRunner {
	/**
	 * In-flight SSH commands keyed by sessionId. Killing the local `ssh` client
	 * drops the channel, but does not prove remote termination. Entries are
	 * removed when the command result settles, independently of native close.
	 */
	private running = new Map<string, () => void>();

	constructor(private emitter: EventEmitter) {}

	/**
	 * Terminate an in-flight command started by `run()`.
	 * Returns false when nothing is running under that sessionId.
	 */
	cancel(sessionId: string): boolean {
		return withWorktreeTurnActivity(
			() => {
				const kill = this.running.get(sessionId);
				if (!kill) return false;
				kill();
				return true;
			},
			(error) => captureException(error)
		);
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
		// SSH options/proxies and setup can touch arbitrary local paths. Never
		// canonicalize the remote cwd or treat it as the local activity domain.
		const release = beginGlobalWorktreeActivity();
		let settled = false;
		const forget = (): void => {
			if (this.running.get(sessionId) === cancel) this.running.delete(sessionId);
		};
		const activity = {
			cancelled: false,
			nativeAttempted: false,
			nativeClosed: false,
			kill: undefined as (() => void) | undefined,
			onResult: forget,
			onClose: () => {
				if (settled) release();
			},
		};
		const cancel = () => {
			activity.cancelled = true;
			activity.kill?.();
		};
		this.running.set(sessionId, cancel);
		try {
			return await this.runAdmitted(sessionId, command, cwd, sshConfig, activity, shellEnvVars);
		} finally {
			settled = true;
			if (!activity.nativeAttempted || activity.nativeClosed) release();
			forget();
		}
	}

	private async runAdmitted(
		sessionId: string,
		command: string,
		cwd: string,
		sshConfig: SshRemoteConfig,
		activity: {
			cancelled: boolean;
			nativeAttempted: boolean;
			nativeClosed: boolean;
			kill?: () => void;
			onResult: () => void;
			onClose: () => void;
		},
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

		// Default SSH options for non-interactive operation, plus this remote's
		// overrides (ProxyCommand, a longer ConnectTimeout for a tunnelled host).
		sshArgs.push(...buildSshOptionArgs(sshConfig.sshOptions));

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

		// Determine the working directory on the remote. Rendered through the
		// tilde-aware escaper below: the old single-quoted `'~'` default could
		// never expand, so a command with no cwd failed on `cd` before it ran.
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
		const escapedCwd = shellEscapeRemotePath(remoteCwd);
		let remoteCommand: string;
		if (envExports) {
			remoteCommand = `cd ${escapedCwd} && ${envExports} $SHELL -lc "${escapedCommand}"`;
		} else {
			remoteCommand = `cd ${escapedCwd} && $SHELL -lc "${escapedCommand}"`;
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
		if (activity.cancelled) {
			activity.onResult();
			this.emitter.emit('command-exit', sessionId, SIGKILL_EXIT_CODE);
			return { exitCode: SIGKILL_EXIT_CODE };
		}
		const expandedEnv = getExpandedEnv();

		return new Promise((resolve) => {
			// Without a returned handle/observer, a failed native attempt is unknown.
			activity.nativeAttempted = true;
			const childProcess = spawn(sshPath, sshArgs, {
				env: {
					...expandedEnv,
					HOME: process.env.HOME,
					SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
				},
			});
			// Install before fallible stream/reporting setup. UI completion, error,
			// exit or kill requests cannot release an unobserved local child.
			childProcess.on('close', () =>
				withWorktreeTurnActivity(
					() => {
						activity.nativeClosed = true;
						activity.onClose();
					},
					(error) => captureException(error)
				)
			);

			let settled = false;

			/** Report the run as finished exactly once. */
			const settle = (exitCode: number) => {
				if (settled) return;
				settled = true;
				activity.onResult();
				try {
					this.emitter.emit('command-exit', sessionId, exitCode);
				} finally {
					resolve({ exitCode });
				}
			};

			// Killing the local client is best effort for the remote command; neither
			// a signal nor local close proves remote termination. SIGKILL immediately,
			// same contract as the local runner: Stop means stopped, now.
			activity.kill = () => {
				if (childProcess.pid) {
					killProcessTreeNow(childProcess.pid, { sessionId });
				}
				try {
					childProcess.kill('SIGKILL');
				} catch {
					// Already gone.
				}
				settle(SIGKILL_EXIT_CODE);
			};

			// Retained callbacks can run after request/native ownership ends. Admit
			// each invocation before decoding, reporting or notifying consumers.
			// Remote termination and asynchronous event listeners remain unproven.
			// Handle stdout
			childProcess.stdout?.on('data', (data: Buffer) =>
				withWorktreeTurnActivity(
					() => {
						const output = data.toString();
						if (output.trim()) {
							logger.debug('[ProcessManager] runCommandViaSsh stdout', 'ProcessManager', {
								sessionId,
								length: output.length,
							});
							this.emitter.emit('data', sessionId, output);
						}
					},
					(error) => captureException(error)
				)
			);

			// Handle stderr
			childProcess.stderr?.on('data', (data: Buffer) =>
				withWorktreeTurnActivity(
					() => {
						const output = data.toString();
						logger.debug('[ProcessManager] runCommandViaSsh stderr', 'ProcessManager', {
							sessionId,
							output: output.substring(0, 200),
						});

						// Check for SSH-specific errors
						const sshError = matchSshErrorPattern(output);
						if (sshError) {
							logger.warn(
								'[ProcessManager] SSH error detected in terminal command',
								'ProcessManager',
								{
									sessionId,
									errorType: sshError.type,
									message: sshError.message,
								}
							);
						}

						this.emitter.emit('stderr', sessionId, output);
					},
					(error) => captureException(error)
				)
			);

			// Handle process exit
			childProcess.on('exit', (code) =>
				withWorktreeTurnActivity(
					() => {
						try {
							logger.debug('[ProcessManager] runCommandViaSsh exit', 'ProcessManager', {
								sessionId,
								exitCode: code,
							});
						} finally {
							settle(code || 0);
						}
					},
					(error) => captureException(error)
				)
			);

			// Handle errors
			childProcess.on('error', (error) =>
				withWorktreeTurnActivity(
					() => {
						try {
							logger.error('[ProcessManager] runCommandViaSsh error', 'ProcessManager', {
								sessionId,
								error: error.message,
							});
							this.emitter.emit('stderr', sessionId, `SSH Error: ${error.message}`);
						} finally {
							settle(1);
						}
					},
					(error) => captureException(error)
				)
			);
			if (activity.cancelled) activity.kill();
		});
	}
}
