import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { stripControlSequences } from '../../utils/terminalFilter';
import { logger } from '../../utils/logger';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { buildPtyTerminalEnv } from '../utils/envBuilder';

/**
 * Handles spawning of PTY (pseudo-terminal) processes.
 * Used for terminal mode and AI agents that require TTY support.
 */
export class PtySpawner {
	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter,
		private bufferManager: DataBufferManager
	) {}

	/**
	 * Spawn a PTY process for a session
	 */
	spawn(config: ProcessConfig): SpawnResult {
		const { sessionId, toolType, cwd, command, args, shell, shellArgs, shellEnvVars } = config;

		const isTerminal = toolType === 'terminal';
		const isWindows = process.platform === 'win32';

		try {
			let ptyCommand: string;
			let ptyArgs: string[];

			if (isTerminal) {
				// Full shell emulation for terminal mode
				if (shell) {
					ptyCommand = shell;
				} else {
					ptyCommand = isWindows ? 'powershell.exe' : 'bash';
				}

				// Use -l (login) AND -i (interactive) flags for fully configured shell
				ptyArgs = isWindows ? [] : ['-l', '-i'];

				// Append custom shell arguments from user configuration
				if (shellArgs && shellArgs.trim()) {
					const customShellArgsArray = shellArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
					const cleanedArgs = customShellArgsArray.map((arg) => {
						if (
							(arg.startsWith('"') && arg.endsWith('"')) ||
							(arg.startsWith("'") && arg.endsWith("'"))
						) {
							return arg.slice(1, -1);
						}
						return arg;
					});
					if (cleanedArgs.length > 0) {
						logger.debug('Appending custom shell args', 'ProcessManager', {
							shellArgs: cleanedArgs,
						});
						ptyArgs = [...ptyArgs, ...cleanedArgs];
					}
				}
			} else {
				// Spawn the AI agent directly with PTY support
				ptyCommand = command;
				ptyArgs = args;
			}

			// Build environment for PTY process
			let ptyEnv: NodeJS.ProcessEnv;
			if (isTerminal) {
				ptyEnv = buildPtyTerminalEnv(shellEnvVars);
			} else {
				// For AI agents in PTY mode: pass full env (they need NODE_PATH, etc.)
				ptyEnv = process.env;
			}

			const ptyProcess = pty.spawn(ptyCommand, ptyArgs, {
				name: 'xterm-256color',
				cols: 100,
				rows: 30,
				cwd: cwd,
				env: ptyEnv as Record<string, string>,
			});

			const managedProcess: ManagedProcess = {
				sessionId,
				toolType,
				ptyProcess,
				cwd,
				pid: ptyProcess.pid,
				isTerminal: true,
				startTime: Date.now(),
				command: ptyCommand,
				args: ptyArgs,
			};

			this.processes.set(sessionId, managedProcess);

			// Handle output
			ptyProcess.onData((data) => {
				const managedProc = this.processes.get(sessionId);
				const cleanedData = stripControlSequences(data, managedProc?.lastCommand, isTerminal);
				logger.debug('[ProcessManager] PTY onData', 'ProcessManager', {
					sessionId,
					pid: ptyProcess.pid,
					dataPreview: cleanedData.substring(0, 100),
				});
				// Only emit if there's actual content after filtering
				if (cleanedData.trim()) {
					this.bufferManager.emitDataBuffered(sessionId, cleanedData);
				}
			});

			ptyProcess.onExit(({ exitCode }) => {
				// Flush any remaining buffered data before exit
				this.bufferManager.flushDataBuffer(sessionId);

				logger.debug('[ProcessManager] PTY onExit', 'ProcessManager', {
					sessionId,
					exitCode,
				});
				this.emitter.emit('exit', sessionId, exitCode);
				this.processes.delete(sessionId);
			});

			logger.debug('[ProcessManager] PTY process created', 'ProcessManager', {
				sessionId,
				toolType,
				isTerminal,
				requiresPty: config.requiresPty || false,
				pid: ptyProcess.pid,
				command: ptyCommand,
				args: ptyArgs,
				cwd,
			});

			return { pid: ptyProcess.pid, success: true };
		} catch (error) {
			logger.error('[ProcessManager] Failed to spawn PTY process', 'ProcessManager', {
				error: String(error),
			});
			return { pid: -1, success: false };
		}
	}
}
