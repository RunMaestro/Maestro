// src/main/process-manager/ProcessManager.ts

import { EventEmitter } from 'events';
import { execFile, execFileSync } from 'child_process';
import type {
	ProcessConfig,
	ManagedProcess,
	SpawnResult,
	CommandResult,
	ParsedEvent,
	ParsedEventObserver,
	AgentOutputParser,
} from './types';
import { PtySpawner } from './spawners/PtySpawner';
import { ChildProcessSpawner } from './spawners/ChildProcessSpawner';
import { OpencodeServerSpawner } from './spawners/OpencodeServerSpawner';
import { DataBufferManager } from './handlers/DataBufferManager';
import { LocalCommandRunner } from './runners/LocalCommandRunner';
import { SshCommandRunner } from './runners/SshCommandRunner';
import { opencodeServerManager } from '../opencode-server/OpencodeServerManager';
import { logger } from '../utils/logger';
import { isWindows } from '../../shared/platformDetection';
import { expandTilde } from '../../shared/pathUtils';
import type { SshRemoteConfig } from '../../shared/types';
import { getDefaultShell } from '../stores/defaults';
import { captureException } from '../utils/sentry';
import {
	COWORKING_SESSION_ID_ENV_VAR,
	COWORKING_SOCKET_OVERRIDE_ENV_VAR,
} from '../coworking/coworking-types';
import { resolveOwningMaestroSessionId } from '../coworking/coworking-session-id';
import { getBridgeSocketPath } from '../coworking/coworking-socket-path';

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
	private opencodeServerSpawner: OpencodeServerSpawner;
	private localCommandRunner: LocalCommandRunner;
	private sshCommandRunner: SshCommandRunner;

	constructor(
		/**
		 * Live read of the `encoreFeatures.opencodeServer` gate. Defaults to off so
		 * tests and any caller that builds ProcessManager without the wiring never
		 * route to the SDK-serve path. Read on every spawn so toggling the plugin
		 * takes effect without an app restart.
		 */
		private readonly isOpencodeServerEnabled: () => boolean = () => false
	) {
		super();
		this.bufferManager = new DataBufferManager(this.processes, this);
		this.ptySpawner = new PtySpawner(this.processes, this, this.bufferManager);
		this.childProcessSpawner = new ChildProcessSpawner(this.processes, this, this.bufferManager);
		// The OpenCode SDK path falls back to the CLI spawner when the shared
		// server can't start, so local OpenCode never regresses to "broken".
		this.opencodeServerSpawner = new OpencodeServerSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.childProcessSpawner.spawn(config)
		);
		this.localCommandRunner = new LocalCommandRunner(this);
		this.sshCommandRunner = new SshCommandRunner(this);
	}

	/**
	 * Install (or clear, with `null`) an observer for every normalized agent
	 * event, before routing/coalescing. Used by Time-Traveling Stream Rules to
	 * watch the live stream without the process manager knowing that subsystem
	 * exists. Late-bound because the observer is built after this manager.
	 *
	 * Only the structured-output spawners carry a stdout parser; PTY/terminal
	 * output has no parsed events (Gate A tier C: out of scope).
	 */
	setParsedEventObserver(observer: ParsedEventObserver | null): void {
		this.childProcessSpawner.setParsedEventObserver(observer);
		this.opencodeServerSpawner.setParsedEventObserver(observer);
	}

	/**
	 * Spawn a new process for a session.
	 *
	 * Live AI processes own their sessionId until they exit. Terminal processes
	 * retain replacement semantics so shell restarts continue to work.
	 */
	spawn(config: ProcessConfig): SpawnResult {
		// Expand a leading `~` in the working directory before spawning. node-pty
		// and child_process hand `cwd` straight to the OS, which - unlike a shell -
		// does not expand `~`. A session whose cwd is persisted as `~/project` (or
		// bare `~`) would otherwise make the child's chdir() fail, leaving the shell
		// in an invalid/unreadable directory. On macOS that surfaces on every shell
		// startup as `Error: The current working directory must be readable to
		// <user> to run brew`. The spawned process is always local (even the SSH
		// client runs locally, with the remote `cd` injected into its args), so a
		// literal `~` cwd is never intentional here. See issue #1173.
		if (config.cwd) {
			const expandedCwd = expandTilde(config.cwd);
			if (expandedCwd !== config.cwd) {
				config = { ...config, cwd: expandedCwd };
			}
		}

		// Never replace an AI process while it still owns the session entry. Node's
		// `exit` event can set exitCode before `close` drains stdout, so exitCode is
		// not enough to prove that the final response has been reconciled. The exit
		// handler removes the entry before emitting `exit`, which lets replay flows
		// start the next process without racing the old process's trailing output.
		// Terminals intentionally keep their existing restart behavior.
		const existing = this.processes.get(config.sessionId);
		if (existing) {
			const childProcessRunning =
				existing.childProcess !== undefined &&
				existing.childProcess.exitCode === null &&
				(existing.childProcess.signalCode === null ||
					existing.childProcess.signalCode === undefined);
			const existingProcessRunning =
				childProcessRunning ||
				existing.ptyProcess !== undefined ||
				existing.sdkController !== undefined;

			if (!existing.isTerminal) {
				logger.warn('[ProcessManager] Refusing to replace owned agent process', 'ProcessManager', {
					sessionId: config.sessionId,
					existingPid: existing.pid,
					existingToolType: existing.toolType,
					requestedToolType: config.toolType,
				});
				throw new Error(`Agent process already running for session ${config.sessionId}`);
			}

			if (existingProcessRunning) {
				logger.warn('[ProcessManager] Restarting existing terminal process', 'ProcessManager', {
					sessionId: config.sessionId,
					existingPid: existing.pid,
				});
				this.kill(config.sessionId);
			} else {
				this.processes.delete(config.sessionId);
			}
		}

		// Decide the OpenCode SDK-serve path on the RAW config, before any coworking
		// env injection. The serve transport uses a single, process-wide `opencode
		// serve` keyed by an env fingerprint (OpencodeServerManager.buildServerKey);
		// injecting the per-session MAESTRO_COWORKING_SESSION_ID here would fingerprint
		// into a distinct server per session, fragmenting the shared server. Coworking
		// over the serve transport needs a per-request mechanism (tracked follow-up),
		// so we skip injection on this path. The coworking bridge fails closed for the
		// resulting env-less MCP subprocess (its parent is the shared serve PID, not a
		// tracked agent CLI), so the tools are cleanly unavailable, never mis-scoped.
		if (this.shouldUseOpencodeServer(config)) {
			const sdkResult = this.opencodeServerSpawner.spawn(config);
			// Same seam as the CLI path below: this spawner also registers its
			// managed process synchronously, so listeners (agent-run capture,
			// TTSR) must see the turn start here too.
			this.emitSpawn(config);
			return sdkResult;
		}

		// Inject the *owning Maestro session id* into the agent CLI's env so the
		// coworking MCP subprocess (spawned by the agent's MCP client, inheriting
		// parent env) can announce the correct caller key to the bridge. We must
		// strip the `-ai-{tabId}[-fp-{ts}]` composite suffix that ProcessManager
		// uses for AI-tab spawns, because the registry pushes terminal records
		// keyed by the bare Session.id from the renderer. Without this, the
		// bridge handshake binds to a session id that never has records in the
		// registry → `list_terminals` returns [] for the caller's own session.
		// Terminals don't run MCP clients, so we skip them. Spawn-callers can
		// override by passing the var explicitly in customEnvVars.
		//
		// We ALSO inject the owning window's bridge socket path
		// (MAESTRO_COWORKING_SOCKET_OVERRIDE). The socket baked into the shared
		// user-level MCP config is a single global value (last install wins), so
		// with multiple windows open an agent could dial the wrong window's bridge.
		// This override is recomputed per spawn from THIS window's userData and the
		// MCP server script prefers it, so env-propagating CLIs (Claude Code,
		// OpenCode) bind to the window that spawned them and self-heal when the
		// config socket is stale. Codex does not propagate env and falls back to the
		// config socket (single-window).
		const configWithCoworkingSession =
			config.toolType === 'terminal'
				? config
				: {
						...config,
						customEnvVars: {
							[COWORKING_SESSION_ID_ENV_VAR]: resolveOwningMaestroSessionId(config.sessionId),
							[COWORKING_SOCKET_OVERRIDE_ENV_VAR]: getBridgeSocketPath(),
							...(config.customEnvVars ?? {}),
						},
					};

		const usePty = this.shouldUsePty(configWithCoworkingSession);
		const result = usePty
			? this.ptySpawner.spawn(configWithCoworkingSession)
			: this.childProcessSpawner.spawn(configWithCoworkingSession);

		this.emitSpawn(config);

		return result;
	}

	/**
	 * Emit the spawn event AFTER the spawner returns so listeners only see a
	 * turn that actually started (symmetric with the 'exit' seam; no orphan on
	 * spawn failure). Guarded: a listener throwing must never break spawning.
	 */
	private emitSpawn(config: ProcessConfig): void {
		try {
			this.emit('spawn', config);
		} catch {
			// Listeners (agent-run capture, TTSR) are best-effort.
		}
	}

	private shouldUsePty(config: ProcessConfig): boolean {
		const { toolType, requiresPty, prompt } = config;
		return (toolType === 'terminal' || requiresPty === true) && !prompt;
	}

	/**
	 * Route local, interactive OpenCode prompt turns through the SDK server path,
	 * gated behind the default-off `encoreFeatures.opencodeServer` plugin.
	 *
	 * Excluded (stay on the CLI path):
	 * - SSH-remote sessions (the SDK server spawn is local-only; deferred).
	 * - Image prompts (handled by the CLI's file-based `-f` args; the SDK path is
	 *   text-only for now and falls back anyway).
	 * - Non-prompt spawns (the SDK path is prompt-driven).
	 */
	private shouldUseOpencodeServer(config: ProcessConfig): boolean {
		return (
			// Default-off plugin gate (encoreFeatures.opencodeServer). While it is
			// off, OpenCode stays on the CLI path - which keeps the Coworking MCP
			// working, since the serve transport can't inject per-session env.
			this.isOpencodeServerEnabled() &&
			config.toolType === 'opencode' &&
			!!config.prompt &&
			!config.sshRemoteId &&
			!(config.images && config.images.length > 0)
		);
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
			void captureException(error);
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
			void captureException(error);
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

		// Mark the turn as user-interrupted BEFORE signalling. `interrupt()` (unlike
		// `kill()`) leaves the process in the map, so its `close` still reaches
		// ExitHandler - which coerces the null signal code to 0. Without this flag,
		// an instant stop (no output yet) would look identical to a clean silent
		// crash and trip the "exited without producing a response" guard.
		process.interrupted = true;

		try {
			if (process.sdkController) {
				// Server-backed (OpenCode SDK) process: abort the in-flight turn.
				process.sdkController.interrupt();
				return true;
			} else if (process.isTerminal && process.ptyProcess) {
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
			void captureException(error);
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
	 *
	 * `shutdown: true` switches PTYs to SIGKILL with no escalation timer or
	 * onExit listener. This collapses the window in which node-pty's worker
	 * thread is still posting via napi_threadsafe_function while Electron
	 * begins tearing down the Node environment - that race aborts inside
	 * `ThreadSafeFunction::~ThreadSafeFunction → uv_mutex_lock` on macOS
	 * (Sentry MAESTRO-3B). A SIGTERM grace period serves no purpose during
	 * shutdown anyway since the user has already confirmed quit.
	 */
	kill(
		sessionId: string,
		{ sync = false, shutdown = false }: { sync?: boolean; shutdown?: boolean } = {}
	): boolean {
		const proc = this.processes.get(sessionId);
		if (!proc) return false;

		try {
			if (proc.dataBufferTimeout) {
				clearTimeout(proc.dataBufferTimeout);
			}
			this.bufferManager.flushDataBuffer(sessionId);

			if (proc.sdkController) {
				// Server-backed (OpenCode SDK) process: no OS child to signal. Abort
				// the turn and tear down the SSE subscription; the stream ending emits
				// the exit event. Fall through to the map deletion below.
				proc.sdkController.kill();
			} else if (proc.isTerminal && proc.ptyProcess) {
				if (isWindows() && proc.pid) {
					// On Windows, node-pty's kill() only terminates the direct ConPTY
					// child (the shell), not grandchild processes it spawned (e.g., dev
					// servers, watchers). Use taskkill /t /f to kill the entire tree.
					this.killWindowsProcessTree(proc.pid, sessionId, sync);
				} else if (shutdown) {
					// Shutdown path: SIGKILL the pty child immediately so the master fd
					// reaches EOF, node-pty's worker thread exits, and its TSFN releases
					// before Electron's environment teardown runs CleanupHandles.
					try {
						proc.ptyProcess.kill('SIGKILL');
					} catch {
						// Process may already be dead
					}
				} else {
					const ptyProc = proc.ptyProcess;
					const pid = proc.pid;

					// Use SIGTERM (not the default SIGHUP which shells may survive on macOS)
					try {
						ptyProc.kill('SIGTERM');
					} catch {
						// Process may already be dead
					}

					// Escalate to SIGKILL if the process doesn't exit promptly.
					const escalationTimer = setTimeout(() => {
						try {
							ptyProc.kill('SIGKILL');
							logger.warn(
								'[ProcessManager] PTY did not exit after SIGTERM, escalated to SIGKILL',
								'ProcessManager',
								{ sessionId, pid }
							);
						} catch {
							// Process already exited - expected after normal SIGTERM
						}
					}, PTY_KILL_ESCALATION_MS);

					// Cancel escalation if the PTY exits on its own
					ptyProc.onExit(() => {
						clearTimeout(escalationTimer);
					});
				}
			} else if (proc.childProcess) {
				const pid = proc.childProcess.pid;
				if (isWindows() && pid) {
					this.killWindowsProcessTree(pid, sessionId, sync);
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
			void captureException(error);
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
	private killWindowsProcessTree(pid: number, sessionId: string, sync = false): void {
		logger.info(
			'[ProcessManager] Using taskkill to terminate process tree on Windows',
			'ProcessManager',
			{ sessionId, pid, sync }
		);
		if (sync) {
			// During shutdown, block until taskkill completes so the process tree
			// is actually dead before Electron exits.
			try {
				execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
					timeout: 5000,
				});
			} catch {
				// taskkill returns non-zero if the process is already dead, which is fine
			}
		} else {
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
	}

	/**
	 * Kill all managed processes.
	 * Snapshots the session IDs first because kill() deletes from the map.
	 *
	 * `shutdown: true` enables SIGKILL-immediate semantics for PTYs to avoid
	 * the libuv/N-API teardown race that aborts the main process during
	 * Electron environment cleanup (see kill() docs).
	 */
	killAll({ shutdown = false }: { shutdown?: boolean } = {}): void {
		const sessionIds = [...this.processes.keys()];
		for (const sessionId of sessionIds) {
			// Use sync kills so process trees are dead before the app exits.
			// On Windows this blocks briefly per process (taskkill is fast),
			// on POSIX this has no effect (SIGTERM is already non-blocking).
			this.kill(sessionId, { sync: true, shutdown });
		}
		// Tear down the shared OpenCode server(s) that back the SDK path.
		opencodeServerManager.shutdown();
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
	 * Look up the *owning Maestro session id* for a given OS PID, or null if
	 * the PID does not match any tracked agent-CLI process. Used by the
	 * coworking bridge to bind a connection when an agent CLI (e.g. Codex)
	 * does not propagate `MAESTRO_COWORKING_SESSION_ID` into the MCP
	 * subprocess it spawned - the subprocess instead sends `process.ppid`
	 * during handshake and we walk the parent chain to find the owning agent.
	 *
	 * Terminals are excluded: they don't spawn MCP clients, and skipping them
	 * preserves the property that only AI-tab processes can ever satisfy a
	 * coworking handshake.
	 */
	getSessionIdByPid(pid: number): string | null {
		if (!Number.isInteger(pid) || pid <= 0) return null;
		for (const proc of this.processes.values()) {
			if (proc.pid === pid && proc.toolType !== 'terminal') {
				return resolveOwningMaestroSessionId(proc.sessionId);
			}
		}
		return null;
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
		const shell = config.shell || getDefaultShell();
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
