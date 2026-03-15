// src/main/process-manager/ProcessManager.ts

import { EventEmitter } from 'events';
import { execFile } from 'child_process';
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
import { isWindows } from '../../shared/platformDetection';
import type { SshRemoteConfig } from '../../shared/types';

/** Time (ms) to wait for a PTY process to exit after SIGTERM before sending SIGKILL. */
const PTY_KILL_ESCALATION_MS = 2000;

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
	 * Spawn a new process for a session.
	 *
	 * If a process already exists for the given sessionId, it is killed first
	 * to prevent orphaned PTY/child processes that are no longer tracked.
	 */
	spawn(config: ProcessConfig): SpawnResult {
		// Kill any existing process for this sessionId to prevent orphans.
		// This guards against double-spawn race conditions where a second spawn
		// overwrites the map entry and the first process becomes untracked.
		const existing = this.processes.get(config.sessionId);
		if (existing) {
			logger.warn('[ProcessManager] Killing existing process before re-spawn', 'ProcessManager', {
				sessionId: config.sessionId,
				existingPid: existing.pid,
			});
			this.kill(config.sessionId);
		}

		const usePty = this.shouldUsePty(config);

		if (usePty) {
			return this.ptySpawner.spawn(config);
		} else {
			return this.childProcessSpawner.spawn(config);
		}
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
				if (process.childProcess.stdin.writable) {
					process.childProcess.stdin.write(data);
					return true;
				}
				logger.warn('[ProcessManager] stdin not writable for session', 'ProcessManager', {
					sessionId,
				});
				return false;
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
	 * For child processes, escalates to kill() if the process doesn't exit
	 * within a short timeout (Claude Code may not immediately exit on SIGINT).
	 *
	 * On Windows, POSIX signals are not supported for shell-spawned processes,
	 * so we write Ctrl+C (\x03) to stdin instead. If that doesn't work, the
	 * escalation timer falls through to kill() which uses taskkill /t /f.
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

				if (isWindows()) {
					// On Windows, child.kill('SIGINT') is unreliable for shell-spawned
					// processes. Write Ctrl+C to stdin as a gentle interrupt instead.
					if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
						child.stdin.write('\x03');
						logger.debug(
							'[ProcessManager] Wrote Ctrl+C to stdin for Windows interrupt',
							'ProcessManager',
							{ sessionId }
						);
					} else {
						logger.warn(
							'[ProcessManager] stdin unavailable for Windows interrupt, will escalate to kill',
							'ProcessManager',
							{ sessionId }
						);
					}
				} else {
					child.kill('SIGINT');
				}

				// Escalate to forceful kill if the process doesn't exit promptly.
				// Some agents (e.g., Claude Code --print) may not exit on SIGINT alone.
				// On Windows, we don't call child.kill('SIGINT') because it's unreliable
				// for shell-spawned processes. The .killed flag remains false, which
				// correctly allows the escalation timer to fire.
				const escalationTimer = setTimeout(() => {
					const stillRunning = this.processes.get(sessionId);
					if (stillRunning?.childProcess && !stillRunning.childProcess.killed) {
						logger.warn(
							'[ProcessManager] Process did not exit after interrupt, escalating to kill',
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
	 * Kill a specific process.
	 *
	 * PTY processes receive SIGTERM first; if the process hasn't exited after
	 * PTY_KILL_ESCALATION_MS, it is sent SIGKILL. The process is removed from
	 * the tracking map immediately so that a replacement can be spawned, but the
	 * escalation timer keeps a reference to ensure the OS-level process dies.
	 */
	kill(sessionId: string): boolean {
		const proc = this.processes.get(sessionId);
		if (!proc) return false;

		try {
			if (proc.dataBufferTimeout) {
				clearTimeout(proc.dataBufferTimeout);
			}
			this.bufferManager.flushDataBuffer(sessionId);

			if (proc.isTerminal && proc.ptyProcess) {
				const ptyProc = proc.ptyProcess;
				const pid = proc.pid;

				// Use SIGTERM (not the default SIGHUP which shells may survive on macOS)
				try {
					ptyProc.kill('SIGTERM');
				} catch {
					// Process may already be dead
				}

				// Escalate to SIGKILL if the process doesn't exit promptly.
				// The ptyProcess reference is captured by the closure so the
				// process can be forcefully terminated even after map removal.
				const escalationTimer = setTimeout(() => {
					try {
						// node-pty's kill() is the only portable way to signal the PTY child.
						// If the process already exited, this is a harmless no-op.
						ptyProc.kill('SIGKILL');
						logger.warn(
							'[ProcessManager] PTY did not exit after SIGTERM, escalated to SIGKILL',
							'ProcessManager',
							{ sessionId, pid }
						);
					} catch {
						// Process already exited — expected after normal SIGTERM
					}
				}, PTY_KILL_ESCALATION_MS);

				// Cancel escalation if the PTY exits on its own
				ptyProc.onExit(() => {
					clearTimeout(escalationTimer);
				});
			} else if (proc.childProcess) {
				const pid = proc.childProcess.pid;
				if (isWindows() && pid) {
					this.killWindowsProcessTree(pid, sessionId);
				} else if (isWindows()) {
					logger.warn(
						'[ProcessManager] pid unavailable for Windows taskkill, falling back to SIGTERM',
						'ProcessManager',
						{ sessionId }
					);
					proc.childProcess.kill('SIGTERM');
				} else {
					proc.childProcess.kill('SIGTERM');
				}
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
	 * Kill a process and its entire child tree on Windows using taskkill.
	 * This is necessary because POSIX signals (SIGINT/SIGTERM) don't reliably
	 * terminate shell-spawned processes on Windows.
	 */
	private killWindowsProcessTree(pid: number, sessionId: string): void {
		logger.info(
			'[ProcessManager] Using taskkill to terminate process tree on Windows',
			'ProcessManager',
			{ sessionId, pid }
		);
		execFile('taskkill', ['/pid', String(pid), '/t', '/f'], (error) => {
			if (error) {
				// taskkill returns non-zero if the process is already dead, which is fine
				logger.debug(
					'[ProcessManager] taskkill exited with error (process may already be terminated)',
					'ProcessManager',
					{ sessionId, pid, error: String(error) }
				);
			}
		});
	}

	/**
	 * Kill all managed processes.
	 * Snapshots the session IDs first because kill() deletes from the map.
	 */
	killAll(): void {
		const sessionIds = [...this.processes.keys()];
		for (const sessionId of sessionIds) {
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
	 * Convenience wrapper for spawning a terminal tab PTY.
	 * Uses the terminal tab session ID format {sessionId}-terminal-{tabId},
	 * which causes PtySpawner to forward raw PTY data without filtering.
	 */
	spawnTerminalTab(config: {
		sessionId: string;
		cwd: string;
		shell?: string;
		shellArgs?: string;
		shellEnvVars?: Record<string, string>;
		cols?: number;
		rows?: number;
	}): SpawnResult {
		const shell = config.shell || (process.platform === 'win32' ? 'powershell.exe' : 'zsh');
		logger.info('[ProcessManager] Spawning terminal tab PTY', 'ProcessManager', {
			sessionId: config.sessionId,
			cwd: config.cwd,
			shell,
			cols: config.cols || 80,
			rows: config.rows || 24,
		});
		return this.spawn({
			sessionId: config.sessionId,
			toolType: 'terminal',
			cwd: config.cwd,
			command: shell,
			args: [],
			shell,
			shellArgs: config.shellArgs,
			shellEnvVars: config.shellEnvVars,
			cols: config.cols || 80,
			rows: config.rows || 24,
		});
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
