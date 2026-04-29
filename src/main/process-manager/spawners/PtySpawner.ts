import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { stripControlSequences } from '../../utils/terminalFilter';
import { logger } from '../../utils/logger';
import type { ProcessConfig, ManagedProcess, SpawnResult, TerminalCommandState } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { buildPtyTerminalEnv, buildChildProcessEnv } from '../utils/envBuilder';
import { isWindows } from '../../../shared/platformDetection';
import { getShellIntegrationArgs, getShellIntegrationEnv } from '../../shell-integration';
import { OscStreamParser, type OscEvent } from '../../shell-integration/oscParser';
import { getSettingsStore } from '../../stores/getters';

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
		const {
			sessionId,
			toolType,
			cwd,
			command,
			args,
			shell,
			shellArgs,
			shellEnvVars,
			customEnvVars,
		} = config;

		const isTerminal = toolType === 'terminal';

		try {
			let ptyCommand: string;
			let ptyArgs: string[];

			if (isTerminal) {
				// Full shell emulation for terminal mode
				if (shell) {
					ptyCommand = shell;
				} else {
					ptyCommand = isWindows() ? 'powershell.exe' : 'bash';
				}

				// Use -l (login) AND -i (interactive) flags for fully configured shell
				ptyArgs = isWindows() ? [] : ['-l', '-i'];

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

				// Log environment variable application for terminal sessions
				if (shellEnvVars && Object.keys(shellEnvVars).length > 0) {
					const globalVarKeys = Object.keys(shellEnvVars);
					logger.debug(
						'[ProcessManager] Applying global environment variables to terminal session',
						'ProcessManager',
						{
							sessionId,
							globalVarCount: globalVarKeys.length,
							globalVarKeys: globalVarKeys.slice(0, 10), // First 10 keys for visibility
						}
					);
				}

				// Inject shell integration (zsh/bash only; helpers return empty for
				// other shells so the merge/prepend is a safe no-op there). Setting
				// defaults to true; explicit `false` disables for the whole tab.
				if (getSettingsStore().get('terminalShellIntegration', true)) {
					const integrationArgs = getShellIntegrationArgs(ptyCommand);
					const integrationEnv = getShellIntegrationEnv(ptyCommand);
					if (Object.keys(integrationEnv).length > 0) {
						Object.assign(ptyEnv, integrationEnv);
					}
					if (integrationArgs.length > 0) {
						// Prepend so the user's `shellArgs` overrides ours if they
						// happen to set the same flag (e.g. a custom `--rcfile`).
						ptyArgs = [...integrationArgs, ...ptyArgs];
					}
				}
			} else {
				// For AI agents in PTY mode: use same env building logic as child processes
				// This ensures tilde expansion (~/ paths), Electron var stripping, and consistent
				// global shell environment variable handling across all spawner types
				ptyEnv = buildChildProcessEnv(customEnvVars, false, shellEnvVars);
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

			// Terminal tabs get an OSC stream parser + initial shell-integration
			// state so command/cwd tracking works even before the first prompt
			// fires (UI can read `commandRunning: false` immediately). AI-agent
			// PTYs skip this — their output isn't a shell prompt and would never
			// emit our OSC sequences anyway.
			if (isTerminal) {
				managedProcess.oscParser = new OscStreamParser();
				managedProcess.shellIntegration = { commandRunning: false };
			}

			this.processes.set(sessionId, managedProcess);

			// Handle output
			ptyProcess.onData((data) => {
				const managedProc = this.processes.get(sessionId);

				// OSC parsing runs on the raw chunk (before stripControlSequences),
				// so partial sequences split across chunks are correctly stitched
				// by the parser's residual buffer. The original `data` is still
				// what we forward to xterm.js — the parser is read-only.
				if (isTerminal && managedProc?.oscParser) {
					const { events } = managedProc.oscParser.parse(data);
					for (const event of events) {
						this.handleOscEvent(sessionId, managedProc, event);
					}
				}

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

	/**
	 * Apply an OSC event to a managed process's shell-integration state and
	 * emit the corresponding renderer-facing event.
	 *
	 * `command-start` and `command-finished` both emit `terminal-command-state`
	 * with the current snapshot — the renderer treats `commandRunning` as the
	 * authoritative live/idle bit. We deliberately do NOT clear `currentCommand`
	 * on `command-finished`: it sticks around so the persistence layer can
	 * snapshot the last-run command for restart re-execution.
	 *
	 * `prompt-start` (133;A) and `command-output` (133;C) carry no state we
	 * forward today — they're parsed for boundary correctness but emit nothing.
	 */
	private handleOscEvent(sessionId: string, proc: ManagedProcess, event: OscEvent): void {
		if (!proc.shellIntegration) {
			// Defensive: only initialized for terminal tabs. If we somehow get
			// here for a non-terminal proc, silently drop the event rather than
			// constructing state for a session that has no UI tab to receive it.
			return;
		}

		switch (event.type) {
			case 'command-start': {
				proc.shellIntegration.currentCommand = event.command;
				proc.shellIntegration.commandRunning = true;
				this.emitTerminalCommandState(sessionId, proc.shellIntegration);
				return;
			}
			case 'command-finished': {
				proc.shellIntegration.commandRunning = false;
				if (event.exitCode !== undefined) {
					proc.shellIntegration.lastExitCode = event.exitCode;
				}
				this.emitTerminalCommandState(sessionId, proc.shellIntegration);
				return;
			}
			case 'cwd-change': {
				if (event.cwd === undefined) return;
				proc.shellIntegration.currentCwd = event.cwd;
				// Mirror onto the canonical `cwd` field too — downstream consumers
				// (process info queries, UI tooltips) read `proc.cwd` directly and
				// shouldn't need to know about shell-integration state.
				proc.cwd = event.cwd;
				this.emitter.emit('terminal-cwd', sessionId, event.cwd);
				return;
			}
			case 'prompt-start':
			case 'command-output':
				return;
		}
	}

	private emitTerminalCommandState(
		sessionId: string,
		state: NonNullable<ManagedProcess['shellIntegration']>
	): void {
		const snapshot: TerminalCommandState = {
			currentCommand: state.currentCommand,
			commandRunning: state.commandRunning,
			lastExitCode: state.lastExitCode,
		};
		this.emitter.emit('terminal-command-state', sessionId, snapshot);
	}
}
