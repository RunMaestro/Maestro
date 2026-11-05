// src/main/process-manager/runners/LocalCommandRunner.ts

import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { logger } from '../../utils/logger';
import type { CommandResult } from '../types';
import { buildSpawnPath } from '../../utils/spawnPath';
import {
	resolveShellPath,
	buildInteractiveShellArgs,
	buildWrappedCommand,
} from '../utils/pathResolver';
import { isWindows } from '../../../shared/platformDetection';
import { killProcessTreeNow, sweepStragglers } from '../utils/commandKill';
import { captureException } from '../../utils/sentry';
import { stripControlSequences } from '../../utils/terminalFilter';
import { getDefaultShell } from '../../stores/defaults';
import { beginWorktreeActivity } from '../../git/worktreeActivity';
import { withWorktreeTurnActivity } from '../../git/worktreeTurnActivity';

/**
 * Exit code reported when a command had to be SIGKILLed and never told us how it
 * ended. 128+9, the shell convention for "killed by signal 9".
 */
const SIGKILL_EXIT_CODE = 137;

/**
 * Runs single commands locally and captures stdout/stderr cleanly.
 * On Unix, uses a transient PTY so interactive shell aliases behave correctly.
 */
export class LocalCommandRunner {
	/**
	 * In-flight commands keyed by the sessionId they were launched under, so a
	 * caller can terminate one that never exits on its own (an interactive
	 * program waiting on stdin, a `tail -f`, a runaway build). Entries are
	 * removed on exit.
	 */
	private running = new Map<string, () => void>();

	constructor(private emitter: EventEmitter) {}

	/**
	 * Terminate an in-flight command started by `run()`.
	 * Returns false when nothing is running under that sessionId.
	 */
	cancel(sessionId: string): boolean {
		return withWorktreeTurnActivity(() => {
			const kill = this.running.get(sessionId);
			if (!kill) return false;
			kill();
			return true;
		}, captureException);
	}

	private isRecoverablePtySpawnError(error: unknown): boolean {
		const errorCode =
			typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
		const message = error instanceof Error ? error.message : String(error);

		if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(errorCode)) {
			return true;
		}

		return /no such file|not found|not a directory|permission denied|cwd/i.test(message);
	}

	/**
	 * Run a single command and capture stdout/stderr cleanly
	 */
	async run(
		sessionId: string,
		command: string,
		cwd: string,
		shell?: string,
		shellEnvVars?: Record<string, string>
	): Promise<CommandResult> {
		// Commands and shell rc files may touch any repository or launch children
		// outside cwd. Register globally before yielding, without probing cwd.
		const admission = beginWorktreeActivity([]);
		let cancelled = false;
		const cancelPending = () => {
			cancelled = true;
		};
		this.running.set(sessionId, cancelPending);
		try {
			const release = await admission;
			if (cancelled) {
				try {
					this.emitter.emit('command-exit', sessionId, SIGKILL_EXIT_CODE);
					return { exitCode: SIGKILL_EXIT_CODE };
				} finally {
					release();
				}
			}
			return withWorktreeTurnActivity(
				(_start, observe) =>
					this.runAdmitted(sessionId, command, cwd, release, observe, shell, shellEnvVars),
				captureException
			);
		} finally {
			if (this.running.get(sessionId) === cancelPending) this.running.delete(sessionId);
		}
	}

	private runAdmitted(
		sessionId: string,
		command: string,
		cwd: string,
		release: () => void,
		observeCompletion: <T>(completion: Promise<T>) => Promise<T>,
		shell?: string,
		shellEnvVars?: Record<string, string>
	): Promise<CommandResult> {
		let spawned = false;
		let cancel: (() => void) | undefined;
		const result = new Promise<CommandResult>((resolve) => {
			const shellToUse = shell || getDefaultShell();

			logger.debug('[ProcessManager] runCommand()', 'ProcessManager', {
				sessionId,
				command,
				cwd,
				shell: shellToUse,
				hasEnvVars: !!shellEnvVars,
				isWindows: isWindows(),
			});

			// Build the command with shell config sourcing
			const shellName =
				shellToUse
					.split(/[/\\]/)
					.pop()
					?.replace(/\.exe$/i, '') || shellToUse;

			const shellPath = resolveShellPath(shellToUse);

			// Build environment for command execution
			let env: NodeJS.ProcessEnv;

			if (isWindows()) {
				// Windows: Inherit full parent environment
				env = {
					...process.env,
					TERM: 'xterm-256color',
				};
			} else {
				// Unix: Use an expanded PATH so commands can reach user install
				// locations (~/.local/bin, ~/.claude/local, ~/.opencode/bin, etc.)
				// even when the interactive shell doesn't source an rc file that
				// extends PATH. Matches buildPtyTerminalEnv()'s behavior for
				// consistency between PTY terminal tabs and single runCommand
				// invocations - a minimal-config zsh shouldn't see different
				// resolution between the two paths.
				env = {
					HOME: process.env.HOME,
					USER: process.env.USER,
					SHELL: process.env.SHELL,
					TERM: 'xterm-256color',
					LANG: process.env.LANG || 'en_US.UTF-8',
					PATH: buildSpawnPath(),
				};
			}

			// Apply custom shell environment variables from user configuration
			if (shellEnvVars && Object.keys(shellEnvVars).length > 0) {
				const homeDir = os.homedir();
				for (const [key, value] of Object.entries(shellEnvVars)) {
					env[key] = value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value;
				}
				logger.debug(
					'[ProcessManager] Applied custom shell env vars to runCommand',
					'ProcessManager',
					{
						keys: Object.keys(shellEnvVars),
					}
				);
			}

			if (!isWindows()) {
				const ptyArgs = buildInteractiveShellArgs(command, shellName);

				logger.debug('[ProcessManager] runCommand spawning PTY', 'ProcessManager', {
					shell: shellToUse,
					shellPath,
					ptyArgs,
					cwd,
					PATH: env.PATH?.substring(0, 100),
				});

				let ptyProcess: pty.IPty;
				try {
					ptyProcess = pty.spawn(shellPath, ptyArgs, {
						name: 'xterm-256color',
						cols: 120,
						rows: 40,
						cwd,
						env: env as Record<string, string>,
					});
					spawned = true;
				} catch (error) {
					if (!this.isRecoverablePtySpawnError(error)) {
						observeCompletion(
							Promise.resolve()
								.then(() =>
									captureException(error, {
										operation: 'process-runner:pty-spawn',
										sessionId,
										shell: shellToUse,
										shellPath,
										cwd,
									})
								)
								.catch(() => {})
						);
						throw error;
					}

					const message = error instanceof Error ? error.message : String(error);
					logger.error('[ProcessManager] runCommand PTY spawn error', 'ProcessManager', {
						sessionId,
						error: message,
						shell: shellToUse,
						shellPath,
					});
					this.emitter.emit('stderr', sessionId, `Error: ${message}`);
					this.emitter.emit('command-exit', sessionId, 1);
					resolve({ exitCode: 1 });
					return;
				}

				let settled = false;

				/**
				 * Report the run as finished exactly once, from whichever path gets
				 * there first: Stop, or the pty's own exit.
				 */
				const settle = (exitCode: number) => {
					if (settled) return;
					settled = true;
					if (this.running.get(sessionId) === cancel) this.running.delete(sessionId);
					try {
						this.emitter.emit('command-exit', sessionId, exitCode);
					} finally {
						resolve({ exitCode });
					}
				};

				// Stop settles the UI immediately; only an observed native exit releases
				// activity. Missing exit remains blocked. Detached descendants and the
				// background sweep are still unsupported cleanup coverage.
				ptyProcess.onExit((event) => {
					return withWorktreeTurnActivity(() => {
						const { exitCode } = event;
						try {
							logger.debug('[ProcessManager] runCommand PTY exit', 'ProcessManager', {
								sessionId,
								exitCode,
							});
							settle(exitCode);
						} finally {
							release();
						}
					}, captureException);
				});

				cancel = () => {
					// SIGKILL the whole tree, synchronously, right now. No SIGTERM grace
					// period and no Ctrl+C negotiation: Stop is a deliberate act on a
					// command the user has already decided against, and anything catchable
					// can be ignored by the very programs most likely to need stopping.
					killProcessTreeNow(ptyProcess.pid, { sessionId });

					// Tear down the pty itself so its master fd closes and the slave side
					// is released even if something in the tree outlived the signals.
					try {
						ptyProcess.kill('SIGKILL');
					} catch {
						// Already gone - expected, since we just killed it.
					}

					// Settle NOW rather than waiting for the pty's exit event. The tree
					// has been SIGKILLed, which cannot be caught or ignored, so there is
					// nothing left to wait for - and waiting is exactly what left the card
					// sitting on "Stopping..." with no way out.
					settle(SIGKILL_EXIT_CODE);

					// Fire-and-forget sweep for anything mid-fork during the kill. Never
					// awaited; the UI is already released.
					sweepStragglers(ptyProcess.pid);
				};
				this.running.set(sessionId, cancel);

				// Retained callbacks require fresh admission after native ownership ends.
				// Asynchronous EventEmitter consumers and descendants remain unproven.
				ptyProcess.onData((data) => {
					return withWorktreeTurnActivity(() => {
						const output = stripControlSequences(data, command, true);
						logger.debug('[ProcessManager] runCommand PTY stdout FILTERED', 'ProcessManager', {
							sessionId,
							filteredLength: output.length,
							filteredPreview: output.substring(0, 200),
							trimmedEmpty: !output.trim(),
						});

						if (output.trim()) {
							this.emitter.emit('data', sessionId, output);
						}
					}, captureException);
				});

				return;
			}

			const wrappedCommand = buildWrappedCommand(command, shellName);

			logger.debug('[ProcessManager] runCommand spawning', 'ProcessManager', {
				shell: shellToUse,
				shellPath,
				wrappedCommand,
				cwd,
				PATH: env.PATH?.substring(0, 100),
			});

			const childProcess = spawn(wrappedCommand, [], {
				cwd,
				env,
				shell: shellPath,
			});

			spawned = true;
			// exit/error/Stop can settle the UI before stdio closes. Never infer
			// child termination from .killed or release after an unobserved close.
			childProcess.once('close', () => withWorktreeTurnActivity(release, captureException));

			// Windows path. Same contract as the PTY branch above: kill the whole
			// tree at once (`taskkill /t /f`, since child.kill() takes only the
			// shell and orphans its children) and settle immediately rather than
			// waiting on an exit that may never arrive.
			let childSettled = false;
			const settleChild = (exitCode: number) => {
				if (childSettled) return;
				childSettled = true;
				if (this.running.get(sessionId) === cancel) this.running.delete(sessionId);
				try {
					this.emitter.emit('command-exit', sessionId, exitCode);
				} finally {
					resolve({ exitCode });
				}
			};

			cancel = () => {
				if (childProcess.pid) {
					killProcessTreeNow(childProcess.pid, { sessionId });
				}
				try {
					childProcess.kill('SIGKILL');
				} catch {
					// Already gone.
				}
				settleChild(SIGKILL_EXIT_CODE);
			};
			this.running.set(sessionId, cancel);

			// Handle stdout - emit data events for real-time streaming
			childProcess.stdout?.on('data', (data: Buffer) => {
				return withWorktreeTurnActivity(() => {
					let output = data.toString();
					logger.debug('[ProcessManager] runCommand stdout RAW', 'ProcessManager', {
						sessionId,
						rawLength: output.length,
						rawPreview: output.substring(0, 200),
					});

					// Filter out shell integration sequences
					output = output.replace(/\x1b?\]1337;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
					output = output.replace(/\x1b?\]133;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
					output = output.replace(/\x1b?\]7;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
					output = output.replace(/\x1b?\][0-9];[^\x07\x1b\n]*(\x07|\x1b\\)?/g, '');
					output = stripControlSequences(output, command, true);

					logger.debug('[ProcessManager] runCommand stdout FILTERED', 'ProcessManager', {
						sessionId,
						filteredLength: output.length,
						filteredPreview: output.substring(0, 200),
						trimmedEmpty: !output.trim(),
					});

					// Only emit if there's actual content after filtering
					if (output.trim()) {
						logger.debug('[ProcessManager] runCommand EMITTING data event', 'ProcessManager', {
							sessionId,
							outputLength: output.length,
						});
						this.emitter.emit('data', sessionId, output);
					} else {
						logger.debug(
							'[ProcessManager] runCommand SKIPPED emit (empty after trim)',
							'ProcessManager',
							{
								sessionId,
							}
						);
					}
				}, captureException);
			});

			// Handle stderr
			childProcess.stderr?.on('data', (data: Buffer) => {
				return withWorktreeTurnActivity(() => {
					const output = data.toString();
					this.emitter.emit('stderr', sessionId, output);
				}, captureException);
			});

			// Handle process exit
			childProcess.on('exit', (code) => {
				return withWorktreeTurnActivity(() => {
					logger.debug('[ProcessManager] runCommand exit', 'ProcessManager', {
						sessionId,
						exitCode: code,
					});
					settleChild(code || 0);
				}, captureException);
			});

			// Handle errors
			childProcess.on('error', (error) => {
				return withWorktreeTurnActivity(() => {
					logger.error('[ProcessManager] runCommand error', 'ProcessManager', {
						sessionId,
						error: error.message,
					});
					this.emitter.emit('stderr', sessionId, `Error: ${error.message}`);
					settleChild(1);
				}, captureException);
			});
		});
		return result.finally(() => {
			// Setup/spawn failure created no child. Once spawned, only its native
			// completion event may release, even if listener setup or reporting fails.
			if (!spawned) release();
		});
	}
}
