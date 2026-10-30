// src/main/process-manager/ProcessManager.ts

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
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
import { OpencodeServerSpawner } from './spawners/OpencodeServerSpawner';
import { CodexAppServerSpawner } from './spawners/CodexAppServerSpawner';
import { AcpServerSpawner } from './spawners/AcpServerSpawner';
import { RpcServerSpawner } from './spawners/RpcServerSpawner';
import { HermesApiSpawner } from './spawners/HermesApiSpawner';
import { ClaudeSdkSpawner } from './spawners/ClaudeSdkSpawner';
import { CopilotSdkSpawner } from './spawners/CopilotSdkSpawner';
import { AntigravitySdkSpawner } from './spawners/AntigravitySdkSpawner';
import { codexAppServerConfigBlocker, wantsCodexAppServer } from '../codex-app-server/invocation';
import { DataBufferManager } from './handlers/DataBufferManager';
import { pushResolvedOmpContextWindow } from './handlers/StdoutHandler';
import { LocalCommandRunner } from './runners/LocalCommandRunner';
import { SshCommandRunner } from './runners/SshCommandRunner';
import { opencodeServerManager } from '../opencode-server/OpencodeServerManager';
import { logger } from '../utils/logger';
import { STEERING_TURN_FINISHED_DETAIL, type SteeringResultFrame } from '../../shared/chatSteering';
import { sendSteeringRequest } from './steering-client';
import { steerCodexAppServerTurn } from '../codex-app-server/steering';
import { isPidAlive } from './utils/childProcessInfo';
import { expandTilde } from '../../shared/pathUtils';
import { agentAlreadyRunningMessage } from '../../shared/processErrors';
import type { AgentError, SshRemoteConfig } from '../../shared/types';
import { unusableCwdReason } from './utils/spawnCwd';
import { getDefaultShell } from '../stores/defaults';
import { captureException } from '../utils/sentry';
import {
	COWORKING_SESSION_ID_ENV_VAR,
	COWORKING_SOCKET_OVERRIDE_ENV_VAR,
} from '../coworking/coworking-types';
import { resolveOwningMaestroSessionId } from '../coworking/coworking-session-id';
import { getBridgeSocketPath } from '../coworking/coworking-socket-path';
import {
	stopProcess,
	INTERACTIVE_STOP_GRACE_MS,
} from '../../shared/maestro-lib/control/termination';
import { signalRemoteAgent, type RemoteSignalMode } from '../utils/ssh-remote-signal';
import { HarnessControlRegistry } from '../harness-control/HarnessControlRegistry';
import type { HarnessControlCapabilities } from '../../shared/harness-control/types';

export interface ProcessManagerOptions {
	/** Maestro's version, reported to `codex app-server` as `clientInfo.version`. */
	appVersion?: string;
	/**
	 * Live read of the `encoreFeatures.coworking` gate. While it is off, no spawn
	 * carries the coworking session/socket env vars, so nothing in the agent can
	 * find the bridge. Main always passes it; omitted keeps the injection, which
	 * is what a bare `new ProcessManager()` in a test expects.
	 */
	isCoworkingEnabled?: () => boolean;
}

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
	private codexAppServerSpawner: CodexAppServerSpawner;
	private acpServerSpawner: AcpServerSpawner;
	private rpcServerSpawner: RpcServerSpawner;
	private hermesApiSpawner: HermesApiSpawner;
	private claudeSdkSpawner: ClaudeSdkSpawner;
	private copilotSdkSpawner: CopilotSdkSpawner;
	private antigravitySdkSpawner: AntigravitySdkSpawner;
	private localCommandRunner: LocalCommandRunner;
	private sshCommandRunner: SshCommandRunner;
	private readonly harnessControls = new HarnessControlRegistry();
	private readonly isCoworkingEnabled: () => boolean;

	constructor(
		/**
		 * Live read of the `encoreFeatures.opencodeServer` gate. Defaults to off so
		 * tests and any caller that builds ProcessManager without the wiring never
		 * route to the SDK-serve path. Read on every spawn so toggling the plugin
		 * takes effect without an app restart.
		 */
		private readonly isOpencodeServerEnabled: () => boolean = () => false,
		options: ProcessManagerOptions = {}
	) {
		super();
		this.on('exit', (sessionId: string) => this.harnessControls.forget(sessionId));
		this.isCoworkingEnabled = options.isCoworkingEnabled ?? (() => true);
		this.bufferManager = new DataBufferManager(this.processes, this);
		this.ptySpawner = new PtySpawner(this.processes, this, this.bufferManager);
		this.childProcessSpawner = new ChildProcessSpawner(this.processes, this, this.bufferManager);
		// The OpenCode SDK path falls back to the CLI spawner when the shared
		// server can't start, so local OpenCode never regresses to "broken".
		this.opencodeServerSpawner = new OpencodeServerSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.fallbackToCli(config)
		);
		// Same contract for Codex: a turn the app-server transport cannot carry,
		// or whose server will not start, runs on `codex exec` instead.
		this.codexAppServerSpawner = new CodexAppServerSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.fallbackToCli(config),
			{ clientVersion: options.appVersion }
		);
		this.acpServerSpawner = new AcpServerSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.fallbackToCli(config),
			{ clientVersion: options.appVersion }
		);
		this.rpcServerSpawner = new RpcServerSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.fallbackToCli(config)
		);
		this.hermesApiSpawner = new HermesApiSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.fallbackToCli(config)
		);
		this.claudeSdkSpawner = new ClaudeSdkSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.fallbackToCli(config)
		);
		this.copilotSdkSpawner = new CopilotSdkSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.fallbackToCli(config)
		);
		this.antigravitySdkSpawner = new AntigravitySdkSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.fallbackToCli(config)
		);
		this.localCommandRunner = new LocalCommandRunner(this);
		this.sshCommandRunner = new SshCommandRunner(this);
	}

	/**
	 * Spawn a new process for a session.
	 *
	 * Live AI processes own their sessionId until they exit. Canonical terminal-tab
	 * creation attaches to a live handle; generic terminal spawn can still replace it.
	 */
	spawn(config: ProcessConfig): SpawnResult {
		const existing = this.processes.get(config.sessionId);
		if (
			config.reuseTerminal &&
			config.toolType === 'terminal' &&
			existing?.isTerminal &&
			(existing.ptyProcess ||
				(existing.childProcess &&
					existing.childProcess.exitCode === null &&
					!existing.childProcess.signalCode))
		) {
			return { pid: existing.pid, success: true, attached: true };
		}
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

		// Refuse a working directory that is not there, rather than handing it to
		// the OS. node-pty's Windows path throws ERROR_DIRECTORY asynchronously
		// from a callback nothing can catch, which crashes the main process and
		// leaves the caller retrying - see utils/spawnCwd.ts for the full trace.
		//
		// Failing is the right answer rather than falling back to the home
		// directory: an agent silently pointed at the wrong tree would read and
		// edit files nobody asked it to.
		const cwdProblem = unusableCwdReason(config.cwd);
		if (cwdProblem) {
			logger.error(`[ProcessManager] Refusing to spawn: ${cwdProblem}`, 'ProcessManager', {
				sessionId: config.sessionId,
				toolType: config.toolType,
				cwd: config.cwd,
			});
			this.emit('agent-error', config.sessionId, {
				type: 'unknown',
				message: cwdProblem,
				recoverable: false,
				agentId: config.toolType,
				sessionId: config.sessionId,
				timestamp: Date.now(),
			} satisfies AgentError);
			return { pid: -1, success: false };
		}

		// Never replace an AI process while it still owns the session entry. Node's
		// `exit` event can set exitCode before `close` drains stdout, so exitCode is
		// not enough to prove that the final response has been reconciled. The exit
		// handler removes the entry before emitting `exit`, which lets replay flows
		// start the next process without racing the old process's trailing output.
		// Terminals intentionally keep their existing restart behavior.
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
				// An agent entry is only ever removed by the exit handler, so an entry
				// that is still here while its OS process is gone means `close` never
				// arrived and never will (reported after the machine idled for hours:
				// the child died without us seeing the event). Left alone, that entry
				// owns the session id forever and every later turn throws, with no way
				// back short of restarting the app. See issue #1339.
				//
				// The reconciliation is deliberately narrow so it cannot reopen the
				// lost-response race from #1249. There, node HAD seen the child exit
				// (`exitCode` is set) while `close` was still draining trailing stdout
				// microseconds later, so anything node knows has exited stays refused.
				// We only reclaim the opposite state: node still believes the child is
				// running, yet the OS says the PID is gone. The two are disjoint, so
				// the drain window keeps its protection.
				//
				// SDK-backed turns have no OS child of their own, so a liveness probe
				// would be meaningless (and could match an unrelated recycled PID);
				// they keep the strict refusal.
				const nodeObservedExit = existing.childProcess !== undefined && !childProcessRunning;
				const isStaleEntry =
					!nodeObservedExit && existing.sdkController === undefined && !isPidAlive(existing.pid);

				if (!isStaleEntry) {
					logger.warn(
						'[ProcessManager] Refusing to replace owned agent process',
						'ProcessManager',
						{
							sessionId: config.sessionId,
							existingPid: existing.pid,
							existingToolType: existing.toolType,
							requestedToolType: config.toolType,
						}
					);
					throw new Error(agentAlreadyRunningMessage(config.sessionId));
				}

				logger.warn(
					'[ProcessManager] Reclaiming stale agent process entry (PID no longer exists)',
					'ProcessManager',
					{
						sessionId: config.sessionId,
						stalePid: existing.pid,
						existingToolType: existing.toolType,
						requestedToolType: config.toolType,
					}
				);
				// Drop the dead entry and let the spawn below take the session id. No
				// kill() here: there is no process left to signal, and kill() would
				// emit a spurious exit for a turn that ended long ago.
				this.processes.delete(config.sessionId);
			} else if (existingProcessRunning) {
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
			const serveResult = this.opencodeServerSpawner.spawn(config);
			// The same `spawn` seam the CLI path emits below. This transport
			// reports `exit` through the shared handlers, so a listener that pairs
			// the two would otherwise see every turn here end without a start.
			if (serveResult.success) {
				this.registerHarnessControl(config);
				this.emitSpawn(config);
			}
			return serveResult;
		}

		// Inject the *owning Maestro session id* into the agent CLI's env so the
		// coworking MCP subprocess (spawned by the agent's MCP client, inheriting
		// parent env) can announce the correct caller key to the bridge. We must
		// strip the `-ai-{tabId}[-fp-{ts}]` composite suffix that ProcessManager
		// uses for AI-tab spawns, because the registry pushes terminal records
		// keyed by the bare Session.id from the renderer. Without this, the
		// bridge handshake binds to a session id that never has records in the
		// registry → `list_terminals` returns [] for the caller's own session.
		// Terminals don't run MCP clients, so we skip them, and nothing is
		// injected while the coworking Encore flag is off. Spawn-callers can
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
			config.toolType === 'terminal' || !this.isCoworkingEnabled()
				? config
				: {
						...config,
						customEnvVars: {
							[COWORKING_SESSION_ID_ENV_VAR]: resolveOwningMaestroSessionId(config.sessionId),
							[COWORKING_SOCKET_OVERRIDE_ENV_VAR]: getBridgeSocketPath(),
							...(config.customEnvVars ?? {}),
						},
					};

		// The Codex app-server child is spawned per turn (no shared server to
		// fingerprint, unlike OpenCode serve), so it takes the coworking env like
		// any CLI spawn and is routed after the injection.
		let result: SpawnResult;
		if (configWithCoworkingSession.harnessControlMode === 'native') {
			if (configWithCoworkingSession.toolType === 'hermes') {
				result = this.hermesApiSpawner.spawn(configWithCoworkingSession);
			} else if (configWithCoworkingSession.toolType === 'claude-code') {
				result = this.claudeSdkSpawner.spawn(configWithCoworkingSession);
			} else if (configWithCoworkingSession.toolType === 'copilot-cli') {
				result = this.copilotSdkSpawner.spawn(configWithCoworkingSession);
			} else if (configWithCoworkingSession.toolType === 'antigravity') {
				result = this.antigravitySdkSpawner.spawn(configWithCoworkingSession);
			} else if (configWithCoworkingSession.nativeAcpArgs) {
				result = this.acpServerSpawner.spawn(configWithCoworkingSession);
			} else if (configWithCoworkingSession.nativeRpcProtocol) {
				result = this.rpcServerSpawner.spawn(configWithCoworkingSession);
			} else {
				result = this.childProcessSpawner.spawn(configWithCoworkingSession);
			}
		} else if (this.shouldUseCodexAppServer(configWithCoworkingSession)) {
			result = this.codexAppServerSpawner.spawn(configWithCoworkingSession);
		} else if (this.shouldUsePty(configWithCoworkingSession)) {
			result = this.ptySpawner.spawn(configWithCoworkingSession);
		} else {
			result = this.childProcessSpawner.spawn(configWithCoworkingSession);
		}

		if (result.success) {
			this.registerHarnessControl(config);
			this.emitSpawn(config);
		}

		return result;
	}

	/**
	 * Emit a spawn event AFTER the spawner returns so the agent-run capture
	 * service only records a running run for a process that actually started
	 * (symmetric with the 'exit' seam; no orphan on spawn failure). Guarded: a
	 * capture listener throwing must never break spawning.
	 */
	private emitSpawn(config: ProcessConfig): void {
		try {
			this.emit('spawn', config);
		} catch {
			// Capture is best-effort; never let it break process spawning.
		}
	}

	/** Negotiated control features for an explicitly selected native transport. */
	getHarnessControlCapabilities(sessionId: string): HarnessControlCapabilities | null {
		return this.harnessControls.getCapabilities(sessionId);
	}

	private fallbackToCli(config: ProcessConfig): SpawnResult {
		this.harnessControls.forget(config.sessionId);
		return this.childProcessSpawner.spawn(config);
	}

	private registerHarnessControl(config: ProcessConfig): void {
		const managed = this.processes.get(config.sessionId);
		if (managed?.harnessControl && managed.spawnGeneration) {
			this.harnessControls.register(
				config.sessionId,
				managed.spawnGeneration,
				managed.harnessControl
			);
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
	 * Route a Codex turn through `codex app-server` (steerable mid-turn) instead
	 * of `codex exec --json`. Opt-in per agent (`codexTransport`), and only for an
	 * INTERACTIVE turn (`wantsCodexAppServer`, which the SSH spawn handler also
	 * reads before it builds an app-server launch).
	 *
	 * The config-level exclusions (no prompt, images, an SSH turn with no
	 * app-server launch, a prompt already in the args) are the spawner's own
	 * `codexAppServerConfigBlocker`, so routing and the spawner cannot disagree
	 * about which turns app-server can carry. The spawner still re-checks the
	 * args and falls back to exec for anything it does not recognize.
	 */
	private shouldUseCodexAppServer(config: ProcessConfig): boolean {
		return wantsCodexAppServer(config) && codexAppServerConfigBlocker(config) === null;
	}

	/**
	 * Ask a running turn to take `text` into the turn in flight (chat steering):
	 * a Claude turn on maestro-p, or a Codex turn on the app-server transport.
	 * Resolves with a verdict for the UI; never rejects. The later verdict for a
	 * delivered steer is emitted as `steering-verdict` with the same id: for
	 * maestro-p it arrives on stdout (StdoutHandler), for Codex it comes from
	 * `steerCodexAppServerTurn`.
	 *
	 * Requires the process to still be REGISTERED, checked here rather than left to
	 * the socket, because a finished turn and an un-steerable one need different
	 * words: "the turn has already finished" is actionable (send it normally) where
	 * "not steerable" invites the user to go looking for a setting.
	 *
	 * Everything else is deliberately NOT decided here. Whether the turn is on
	 * maestro-p at all is answered by whether a channel exists (the spawn opens one
	 * only for a local interactive turn), and whether the TUI can accept keystroke
	 * right now is answered by maestro-p, which is the only party holding the
	 * screen. Re-deriving either would mean two places believing different things
	 * about the same turn. A Codex process carries its own channel
	 * (`codexAppServer`, present only on the app-server path), so an exec turn has
	 * none and is refused by the socket client exactly like an unsteerable Claude
	 * turn.
	 */
	async steer(sessionId: string, text: string): Promise<SteeringResultFrame> {
		const id = randomUUID();
		const process = this.processes.get(sessionId);
		if (!process) {
			return {
				type: 'steering',
				id,
				verdict: 'refused',
				refusal: 'not-running',
				detail: STEERING_TURN_FINISHED_DETAIL,
			};
		}
		if (this.harnessControls.has(sessionId)) {
			return this.harnessControls.steer(sessionId, text);
		}
		if (process.codexAppServer) {
			return steerCodexAppServerTurn(process.codexAppServer, { id, text }, (verdict) =>
				this.emit('steering-verdict', sessionId, verdict)
			);
		}
		return sendSteeringRequest({ processKey: sessionId, text, id });
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
	 * Interrupt a process, the way the Stop button does.
	 *
	 * A pipe-backed agent goes through the shared stop ladder: SIGINT (Ctrl+C on
	 * stdin on Windows, where a signal does not reach a shell-spawned process),
	 * then SIGTERM or `taskkill /t /f` if it is still running after the grace
	 * period, then SIGKILL for its tree. Whatever the agent started is stopped
	 * with it.
	 *
	 * A PTY gets Ctrl+C and nothing more. A PTY process that survives Ctrl+C is
	 * the normal case, not a stuck one: a shell that cancelled a command, or a
	 * TUI that cancelled its turn and is waiting for the next prompt.
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
			if (this.harnessControls.has(sessionId)) {
				void this.harnessControls.interrupt(sessionId);
				return true;
			}
			if (process.sdkController) {
				// Server-backed process (OpenCode SDK, Codex app-server): interrupt the
				// in-flight turn over its protocol; the controller escalates if needed.
				process.sdkController.interrupt();
				return true;
			} else if (process.isTerminal && process.ptyProcess) {
				process.ptyProcess.write('\x03');
				return true;
			} else if (process.childProcess) {
				stopProcess(
					{ child: process.childProcess },
					{
						from: 'interrupt',
						graceMs: INTERACTIVE_STOP_GRACE_MS,
						sessionId,
						label: 'interrupt',
					}
				);
				// The local child of an SSH spawn is only the ssh client; the agent on
				// the remote host never sees its signals. Ask the host to deliver them:
				// SIGINT now, SIGTERM if the turn is still running after the grace.
				this.signalRemote(sessionId, process, 'interrupt');
				this.scheduleRemoteTerminate(sessionId, process, process.childProcess);
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
	 * Kill a specific process, through the shared stop ladder.
	 *
	 * The ladder starts at SIGTERM and, if the process has not exited after the
	 * grace period, kills it with SIGKILL. On Windows the whole tree goes through
	 * `taskkill /t /f`, because node-pty and `child.kill()` end only the direct
	 * child. The process is removed from the tracking map immediately so that a
	 * replacement can be spawned; the ladder keeps its own reference to make sure
	 * the OS-level process dies.
	 *
	 * An agent's descendants are stopped with it. A terminal tab's are not: a
	 * job the user left running in their shell is theirs to keep, so only the
	 * shell is signalled, as before.
	 *
	 * `sync: true` blocks on `taskkill`, so the tree is gone before the app
	 * exits.
	 *
	 * `shutdown: true` is the app quitting. It sends exactly what quitting has
	 * always sent, at once, with no timer and no exit listener, and leaves the
	 * process's descendants alone:
	 * - a PTY gets SIGKILL directly. This collapses the window in which
	 *   node-pty's worker thread is still posting via napi_threadsafe_function
	 *   while Electron begins tearing down the Node environment - that race
	 *   aborts inside `ThreadSafeFunction::~ThreadSafeFunction → uv_mutex_lock`
	 *   on macOS (Sentry MAESTRO-3B).
	 * - a pipe-backed agent gets SIGTERM and nothing after it, so it can finish
	 *   writing its state (a transcript, a session file) before it exits. No
	 *   SIGKILL follows: there is no event loop left to wait out a grace period,
	 *   and one sent right behind the SIGTERM would take that chance away.
	 * - on Windows both go through a blocking `taskkill /t /f`.
	 */
	kill(
		sessionId: string,
		{ sync = false, shutdown = false }: { sync?: boolean; shutdown?: boolean } = {}
	): boolean {
		const proc = this.processes.get(sessionId);
		if (!proc) return this.copilotSdkSpawner.closeSession(sessionId);

		// A kill is a stop Maestro asked for (a closed tab, the Process Monitor, a
		// watchdog), so the exit it causes is not a crash. The resolver reads any
		// signal it is not told about as an outside kill, which it is not here.
		proc.interrupted = true;

		try {
			if (proc.dataBufferTimeout) {
				clearTimeout(proc.dataBufferTimeout);
			}
			this.bufferManager.flushDataBuffer(sessionId);

			if (this.harnessControls.has(sessionId)) {
				void this.harnessControls.close(sessionId, { sync, shutdown });
			} else if (proc.sdkController) {
				// Server-backed process (OpenCode SDK, Codex app-server): the stop
				// starts with a protocol call. The controller tears its transport down
				// (and runs the stop ladder on any child it owns); the exit event
				// follows from there. Fall through to the map deletion below.
				proc.sdkController.kill({ sync, shutdown });
			} else if (proc.isTerminal && proc.ptyProcess) {
				stopProcess(
					{ pty: proc.ptyProcess, pid: proc.pid },
					{
						from: shutdown ? 'kill' : 'terminate',
						graceMs: INTERACTIVE_STOP_GRACE_MS,
						immediate: shutdown,
						blocking: sync,
						includeDescendants: !shutdown && proc.toolType !== 'terminal',
						sessionId,
						label: 'kill',
					}
				);
			} else if (proc.childProcess) {
				this.signalRemote(sessionId, proc, 'terminate');
				stopProcess(
					{ child: proc.childProcess },
					{
						from: 'terminate',
						upTo: shutdown ? 'terminate' : 'kill',
						graceMs: INTERACTIVE_STOP_GRACE_MS,
						immediate: shutdown,
						blocking: sync,
						includeDescendants: !shutdown,
						sessionId,
						label: 'kill',
					}
				);
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
	 * Deliver a signal to an SSH-hosted agent on its remote host. A no-op for
	 * local processes and for SSH spawns that recorded no remote pid.
	 */
	private signalRemote(sessionId: string, proc: ManagedProcess, mode: RemoteSignalMode): void {
		if (!proc.sshRemotePidFile || !proc.command || !proc.args) return;
		signalRemoteAgent(
			{
				sshCommand: proc.command,
				sshArgs: proc.args,
				pidFile: proc.sshRemotePidFile,
				sessionId,
			},
			mode
		);
	}

	/**
	 * The stop ladder escalates only the local ssh client. When an interrupted
	 * SSH agent has not exited after the grace period, ask its host for SIGTERM
	 * too. Test for an observed exit, never `.killed`, which is set as soon as a
	 * signal is delivered.
	 */
	private scheduleRemoteTerminate(
		sessionId: string,
		proc: ManagedProcess,
		child: NonNullable<ManagedProcess['childProcess']>
	): void {
		if (!proc.sshRemotePidFile) return;
		const timer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				this.signalRemote(sessionId, proc, 'terminate');
			}
		}, INTERACTIVE_STOP_GRACE_MS);
		child.once('exit', () => clearTimeout(timer));
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
		void this.copilotSdkSpawner.closeAll().catch((error) => {
			captureException(error instanceof Error ? error : new Error(String(error)), {
				context: 'Copilot native connection shutdown',
			});
		});
	}
	/** Stop every active turn for an agent and dispose retained native runtimes. */
	closeAgent(agentId: string): void {
		for (const proc of [...this.processes.values()]) {
			if (proc.sessionId.replace(/-ai(?:-.+)?$/, '') === agentId) this.kill(proc.sessionId);
		}
		this.copilotSdkSpawner.closeAgent(agentId);
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
	 * Re-emit a corrected `usage` event for a local omp process whose model
	 * context window could not be resolved when its first usage arrived, because
	 * the catalog prime was still running. Called by the spawn handler when a
	 * prime that exceeded the spawn cap finally lands.
	 *
	 * @returns true when a corrected event was emitted.
	 */
	pushResolvedOmpContextWindow(sessionId: string, catalogKey: string): boolean {
		return pushResolvedOmpContextWindow(this.processes, this, sessionId, catalogKey);
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
	 * Ensure a terminal tab PTY exists, attaching to its live host handle if present.
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
			reuseTerminal: true,
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

	/**
	 * Terminate an in-flight `runCommand()` for a sessionId (local or SSH).
	 * Returns false when nothing is running under that id.
	 */
	cancelCommand(sessionId: string): boolean {
		return this.localCommandRunner.cancel(sessionId) || this.sshCommandRunner.cancel(sessionId);
	}
}
