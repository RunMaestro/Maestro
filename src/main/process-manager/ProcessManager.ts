// src/main/process-manager/ProcessManager.ts

import { EventEmitter } from 'events';
import type {
	ProcessConfig,
	ManagedProcess,
	SpawnResult,
	CommandResult,
	ParsedEvent,
	AgentOutputParser,
} from './types';
import { PtySpawner } from './spawners/PtySpawner';
import { ChildProcessSpawner } from './spawners/ChildProcessSpawner';
import { DataBufferManager } from './handlers/DataBufferManager';
import { LocalCommandRunner } from './runners/LocalCommandRunner';
import { SshCommandRunner } from './runners/SshCommandRunner';
import { logger } from '../utils/logger';
import type { SshRemoteConfig } from '../../shared/types';

/**
 * ProcessManager orchestrates spawning and managing processes for sessions.
 *
 * Responsibilities:
 * - Spawn PTY and child processes
 * - Route data events from processes
 * - Provide process lifecycle management (write, resize, interrupt, kill)
 * - Execute commands (local and SSH remote)
 */
export class ProcessManager extends EventEmitter {
	private processes: Map<string, ManagedProcess> = new Map();
	private bufferManager: DataBufferManager;
	private ptySpawner: PtySpawner;
	private childProcessSpawner: ChildProcessSpawner;
	private localCommandRunner: LocalCommandRunner;
	private sshCommandRunner: SshCommandRunner;

	constructor() {
		super();
		this.bufferManager = new DataBufferManager(this.processes, this);
		this.ptySpawner = new PtySpawner(this.processes, this, this.bufferManager);
		this.childProcessSpawner = new ChildProcessSpawner(this.processes, this, this.bufferManager);
		this.localCommandRunner = new LocalCommandRunner(this);
		this.sshCommandRunner = new SshCommandRunner(this);
	}

	/**
	 * Spawn a new process for a session
	 */
	spawn(config: ProcessConfig): SpawnResult {
		const usePty = this.shouldUsePty(config);

		const result = usePty
			? this.ptySpawner.spawn(config)
			: this.childProcessSpawner.spawn(config);

		if (result.success) {
			this.emit('spawn', config.sessionId);
		}

		return result;
	}

	private shouldUsePty(config: ProcessConfig): boolean {
		const { toolType, requiresPty, prompt } = config;
		return (toolType === 'terminal' || requiresPty === true) && !prompt;
	}

	/**
	 * Write data to a process's stdin
	 */
	write(sessionId: string, data: string): boolean {
		const process = this.processes.get(sessionId);
		if (!process) {
			logger.error('[ProcessManager] write() - No process found for session', 'ProcessManager', {
				sessionId,
			});
			return false;
		}

		try {
			if (process.isTerminal && process.ptyProcess) {
				const command = data.replace(/\r?\n$/, '');
				if (command.trim()) {
					process.lastCommand = command.trim();
				}
				process.ptyProcess.write(data);
				return true;
			} else if (process.childProcess?.stdin) {
				process.childProcess.stdin.write(data);
				return true;
			}
			return false;
		} catch (error) {
			logger.error('[ProcessManager] Failed to write to process', 'ProcessManager', {
				sessionId,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Resize terminal (for pty processes)
	 */
	resize(sessionId: string, cols: number, rows: number): boolean {
		const process = this.processes.get(sessionId);
		if (!process || !process.isTerminal || !process.ptyProcess) return false;

		try {
			process.ptyProcess.resize(cols, rows);
			return true;
		} catch (error) {
			logger.error('[ProcessManager] Failed to resize terminal', 'ProcessManager', {
				sessionId,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Send interrupt signal (SIGINT/Ctrl+C) to a process.
	 * For child processes, escalates to SIGTERM if the process doesn't exit
	 * within a short timeout (Claude Code may not immediately exit on SIGINT).
	 */
	interrupt(sessionId: string): boolean {
		const process = this.processes.get(sessionId);
		if (!process) return false;

		try {
			if (process.isTerminal && process.ptyProcess) {
				process.ptyProcess.write('\x03');
				return true;
			} else if (process.childProcess) {
				const child = process.childProcess;
				child.kill('SIGINT');

				// Escalate to SIGTERM if the process doesn't exit promptly.
				// Some agents (e.g., Claude Code --print) may not exit on SIGINT alone.
				const escalationTimer = setTimeout(() => {
					const stillRunning = this.processes.get(sessionId);
					if (stillRunning?.childProcess && !stillRunning.childProcess.killed) {
						logger.warn(
							'[ProcessManager] Process did not exit after SIGINT, escalating to SIGTERM',
							'ProcessManager',
							{ sessionId, pid: stillRunning.pid }
						);
						this.kill(sessionId);
					}
				}, 2000);

				// Clear the timer if the process exits on its own
				child.once('exit', () => {
					clearTimeout(escalationTimer);
				});

				return true;
			}
			return false;
		} catch (error) {
			logger.error('[ProcessManager] Failed to interrupt process', 'ProcessManager', {
				sessionId,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Kill a specific process
	 */
	kill(sessionId: string): boolean {
		const process = this.processes.get(sessionId);
		if (!process) return false;

		try {
			if (process.dataBufferTimeout) {
				clearTimeout(process.dataBufferTimeout);
			}
			this.bufferManager.flushDataBuffer(sessionId);

			if (process.isTerminal && process.ptyProcess) {
				process.ptyProcess.kill();
			} else if (process.childProcess) {
				process.childProcess.kill('SIGTERM');
			}
			this.processes.delete(sessionId);
			return true;
		} catch (error) {
			logger.error('[ProcessManager] Failed to kill process', 'ProcessManager', {
				sessionId,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Kill all managed processes
	 */
	killAll(): void {
		for (const [sessionId] of this.processes) {
			this.kill(sessionId);
		}
	}

	/**
	 * Get all active processes
	 */
	getAll(): ManagedProcess[] {
		return Array.from(this.processes.values());
	}

	/**
	 * Get a specific process
	 */
	get(sessionId: string): ManagedProcess | undefined {
		return this.processes.get(sessionId);
	}

	/**
	 * Get the output parser for a session's agent type
	 */
	getParser(sessionId: string): AgentOutputParser | null {
		const process = this.processes.get(sessionId);
		return process?.outputParser || null;
	}

	/**
	 * Parse a JSON line using the appropriate parser for the session
	 */
	parseLine(sessionId: string, line: string): ParsedEvent | null {
		const parser = this.getParser(sessionId);
		if (!parser) return null;
		return parser.parseJsonLine(line);
	}

	/**
	 * Run a single command and capture stdout/stderr cleanly
	 */
	runCommand(
		sessionId: string,
		command: string,
		cwd: string,
		shell?: string,
		shellEnvVars?: Record<string, string>,
		sshRemoteConfig?: SshRemoteConfig | null
	): Promise<CommandResult> {
		if (sshRemoteConfig) {
			return this.sshCommandRunner.run(sessionId, command, cwd, sshRemoteConfig, shellEnvVars);
		}
		return this.localCommandRunner.run(sessionId, command, cwd, shell, shellEnvVars);
	}
}
