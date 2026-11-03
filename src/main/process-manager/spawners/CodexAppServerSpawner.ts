// src/main/process-manager/spawners/CodexAppServerSpawner.ts

/**
 * Runs one Codex turn on `codex app-server` (JSON-RPC over stdio) instead of
 * `codex exec --json`, so the turn can be steered while it runs.
 *
 * Modelled on `OpencodeServerSpawner`: it registers a `ManagedProcess`,
 * translates the server's notifications back into the exec JSONL lines
 * (`CodexAppServerEventTranslator`), and feeds them through the SAME
 * `StdoutHandler` / `ExitHandler` the exec path uses, so the parser, usage,
 * tool cards, session id and renderer are reused unchanged. The one difference
 * from OpenCode is that this spawner owns a real OS child, one per turn, so
 * Stop still ends in the process-tree ladder (`stopProcess()`).
 *
 * The protocol mapping, the server-request policy and the lifecycle are
 * documented line by line in `docs/agent-guides/CODEX-APP-SERVER.md`.
 *
 * A turn this transport cannot carry (an image, a write grant, an arg it does
 * not know) runs on `codex exec` through `fallbackToCli`, and so does a turn
 * whose server will not start, whose handshake fails, whose thread does not
 * run under the sandbox it asked for, or whose `turn/start` the server answers
 * with a JSON-RPC ERROR (proof the prompt never started). Any other failure
 * after `turn/start` is sent (the child dying, a timeout) leaves it unknown
 * whether the prompt is running, so it is reported rather than retried:
 * sending the prompt twice is worse than an error.
 *
 * On an SSH remote the child is the local ssh client of the launch the spawn
 * handler built (`config.codexAppServerSsh`, see `ssh-launch.ts`). Its launch
 * script goes down stdin first and the JSON-RPC lines follow it. The script
 * records the remote pid, so every stop also signals the server on its host:
 * signals to the local client never reach it.
 */

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { createOutputParser } from '../../parsers';
import { captureException } from '../../utils/sentry';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { StderrHandler } from '../handlers/StderrHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { buildChildProcessEnv, collectMaestroEnvVars } from '../utils/envBuilder';
import { planSpawnShell } from '../utils/windowsSpawnShell';
import { argsResumeSession } from '../utils/resumeArgs';
import { nextSpawnGeneration, isSupersededGeneration } from '../generation';
import { DEFAULT_QUERY_SOURCE } from '../../../shared/querySource';
import { isWindows } from '../../../shared/platformDetection';
import {
	startTurn,
	type TurnExit,
	type TurnHandle,
} from '../../../shared/maestro-lib/run/start-turn';
import {
	stopProcess,
	INTERACTIVE_STOP_GRACE_MS,
} from '../../../shared/maestro-lib/control/termination';
import {
	newRemotePidFilePath,
	signalRemoteAgent,
	sshConnectionArgs,
	withRemotePidRecord,
	type RemoteSignalMode,
} from '../../../shared/maestro-lib/control/ssh-remote-signal';
import {
	CodexAppServerEventTranslator,
	type CodexExecLine,
} from '../../codex-app-server/event-translator';
import {
	isCodexNotification,
	isCodexResponse,
	isCodexServerRequest,
	type CodexAppServerMessage,
} from '../../codex-app-server/protocol';
import { CodexAppServerRpc, CodexRpcRequestError } from '../../codex-app-server/rpc-client';
import { answerCodexServerRequest } from '../../codex-app-server/server-requests';
import { steerCodexAppServerTurn } from '../../codex-app-server/steering';
import {
	codexServerInteraction,
	type CodexServerInteraction,
} from '../../codex-app-server/interaction-requests';
import { harnessInteractionBroker } from '../../harness-control/integration';
import type { CodexAppServerRequest } from '../../../shared/maestro-lib/codex/protocol';
import type { CodexServerRequestAnswer } from '../../../shared/maestro-lib/codex/server-requests';
import {
	codexThreadPolicyMismatch,
	parseCodexAppServerInvocation,
	type CodexAppServerInvocation,
} from '../../codex-app-server/invocation';

const LOG_CONTEXT = 'CodexAppServer';

/** How long a request the spawner sends may go unanswered before the turn gives up on it. */
export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long the child gets to leave on its own once the turn is over (stdin
 * closed) or once `turn/interrupt` was sent, before the stop ladder runs.
 */
export const CODEX_APP_SERVER_EXIT_GRACE_MS = INTERACTIVE_STOP_GRACE_MS;

/** Cap on the stderr held back during setup, reported if the turn falls back. */
const SETUP_STDERR_LIMIT = 16 * 1024;

export interface CodexAppServerSpawnerOptions {
	/** `clientInfo.version` on `initialize`; becomes the user-agent suffix. */
	clientVersion?: string;
}

/**
 * Where a turn is in its life. Setup failures fall back to exec. `starting`
 * means `turn/start` is sent and unanswered: an error RESPONSE still falls back
 * (the server refused the prompt), anything else is an error. Output stays held
 * through both, so a turn that falls back has shown nothing. The turn is
 * `committed` once the server accepts it (the response, or the turn's own
 * `turn/started`), and failures are errors from then on. `ended` means
 * `turn/completed` arrived or the child is gone.
 */
type TurnPhase = 'setup' | 'starting' | 'committed' | 'ended';

/**
 * Where the stop ladder starts for this child when the turn is ending anyway.
 * On Windows the `interrupt` stage writes Ctrl+C into the child's STDIN, which
 * here is the JSON-RPC channel: it would land inside (or between) protocol
 * lines and buys nothing, since `turn/interrupt` already is the protocol's
 * interrupt. POSIX's SIGINT travels out of band, so it keeps its stage.
 */
function softStopStage(): 'interrupt' | 'terminate' {
	return isWindows() ? 'terminate' : 'interrupt';
}

/** What every turn a spawner starts shares: the process map, the handlers, the fallback. */
interface TurnContext {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	stdoutHandler: StdoutHandler;
	stderrHandler: StderrHandler;
	exitHandler: ExitHandler;
	fallbackToCli: (config: ProcessConfig) => SpawnResult;
	clientVersion: string;
}

export class CodexAppServerSpawner {
	private readonly context: TurnContext;

	constructor(
		processes: Map<string, ManagedProcess>,
		emitter: EventEmitter,
		bufferManager: DataBufferManager,
		/** Runs the same config on `codex exec` (ProcessManager's ChildProcessSpawner.spawn). */
		private readonly fallbackToCli: (config: ProcessConfig) => SpawnResult,
		options: CodexAppServerSpawnerOptions = {}
	) {
		this.context = {
			processes,
			emitter,
			stdoutHandler: new StdoutHandler({ processes, emitter, bufferManager }),
			stderrHandler: new StderrHandler({ processes, emitter }),
			exitHandler: new ExitHandler({ processes, emitter, bufferManager }),
			fallbackToCli,
			clientVersion: options.clientVersion ?? '0.0.0',
		};
	}

	spawn(config: ProcessConfig): SpawnResult {
		const parsed = parseCodexAppServerInvocation(config);
		if (!parsed.ok) {
			logger.info(
				'[CodexAppServerSpawner] Turn not carried by app-server; using exec',
				LOG_CONTEXT,
				{
					sessionId: config.sessionId,
					reason: parsed.reason,
				}
			);
			if (config.permissionMode === 'standard') {
				return {
					pid: -1,
					success: false,
					error: `Codex Standard mode requires app-server: ${parsed.reason}`,
				};
			}
			return this.fallbackToCli(config);
		}
		try {
			return new CodexAppServerTurn(this.context, config, parsed.invocation).start();
		} catch (error) {
			// startTurn throws only on a bad spawn option; exec gets the turn.
			void captureException(error);
			logger.warn('[CodexAppServerSpawner] Could not start app-server; using exec', LOG_CONTEXT, {
				sessionId: config.sessionId,
				error: String(error),
			});
			if (config.permissionMode === 'standard') {
				return {
					pid: -1,
					success: false,
					error: 'Codex Standard mode could not start app-server.',
				};
			}
			return this.fallbackToCli(config);
		}
	}
}

/** One app-server child and the turn it runs. */
class CodexAppServerTurn {
	private readonly translator = new CodexAppServerEventTranslator();
	private readonly rpc: CodexAppServerRpc;
	private readonly managedProcess: ManagedProcess;
	private turn!: TurnHandle;
	private phase: TurnPhase = 'setup';
	/** Stop or kill was requested: never fall back, never report a crash. */
	private cancelled = false;
	private finished = false;
	/** Exec lines produced before the turn was committed; forwarded on commit. */
	private heldLines: CodexExecLine[] = [];
	/** Stderr produced before the turn was committed; forwarded on commit. */
	private heldStderr = '';
	private exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
	/** The turn is over (completed, failed, or the child is gone); steering listens. */
	private turnEnded = false;
	private readonly turnEndListeners = new Set<() => void>();

	constructor(
		private readonly ctx: TurnContext,
		private readonly config: ProcessConfig,
		private readonly invocation: CodexAppServerInvocation
	) {
		this.rpc = new CodexAppServerRpc((line) => this.writeLine(line));

		const { sessionId, toolType, cwd, command, args } = config;
		const translator = this.translator;
		const rpc = this.rpc;
		this.managedProcess = {
			sessionId,
			toolType,
			cwd,
			pid: -1,
			isTerminal: false,
			isBatchMode: true,
			isStreamJsonMode: true,
			jsonBuffer: '',
			startTime: Date.now(),
			outputParser: createOutputParser(toolType) || undefined,
			stderrBuffer: '',
			stdoutBuffer: '',
			contextWindow: config.contextWindow,
			command,
			args,
			querySource: config.querySource,
			tabId: config.tabId,
			projectPath: config.projectPath,
			agentSessionId: config.agentSessionId,
			// No `childProcess`: ProcessManager.write() would type into the
			// JSON-RPC stream. Lifecycle goes through the controller instead.
			sdkController: {
				interrupt: () => this.interrupt(),
				kill: (options) => this.kill(options),
			},
			codexAppServer: {
				get threadId() {
					return translator.threadId;
				},
				get activeTurnId() {
					return translator.activeTurnId;
				},
				sendRequest: <T = unknown>(
					method: string,
					params?: unknown,
					options?: { timeoutMs?: number }
				) => rpc.request<T>(method, params, options),
				onUserMessage: (listener) => translator.onUserMessage(listener),
				onTurnEnd: (listener) => this.onTurnEnd(listener),
			},
			harnessControl: {
				getCapabilities: () => ({
					protocol: 'codex-app-server',
					protocolVersion: 'experimental',
					steering: 'in-turn',
					permissionRequests: true,
					questions: true,
					elicitations: true,
					modelSwitch: false,
					modeSwitch: false,
					imagePrompts: false,
					resume: true,
				}),
				steer: ({ id, text }) =>
					steerCodexAppServerTurn(this.managedProcess.codexAppServer!, { id, text }, (verdict) =>
						this.ctx.emitter.emit('steering-verdict', sessionId, verdict)
					),
				interrupt: async () => this.interrupt(),
				close: async (options) => this.kill(options),
			},
		};
	}

	start(): SpawnResult {
		const { config, invocation, managedProcess } = this;
		const { sessionId, command, customEnvVars, shellEnvVars } = config;

		const isResuming = argsResumeSession(config.args);
		const env = buildChildProcessEnv(
			customEnvVars,
			isResuming,
			shellEnvVars,
			config.extraPathDirs,
			config.querySource
		);
		managedProcess.maestroEnvVars = collectMaestroEnvVars(
			shellEnvVars,
			customEnvVars,
			isResuming,
			config.querySource ?? DEFAULT_QUERY_SOURCE
		);

		// SSH: the local ssh client, never through a shell (its stdin carries the
		// launch script). Local: `codex app-server` with the turn's config args.
		const ssh = config.codexAppServerSsh;
		const spawnPlan = ssh
			? { command: ssh.command, args: ssh.args, shell: undefined }
			: planSpawnShell(command, ['app-server', ...invocation.configArgs], {
					runInShell: config.runInShell,
					shell: config.shell,
				});

		this.turn = startTurn(
			{
				command: spawnPlan.command,
				args: spawnPlan.args,
				cwd: config.cwd,
				env,
				shell: spawnPlan.shell,
			},
			{
				onLine: (line) => this.handleLine(line),
				onStderr: (text) => this.handleStderr(text),
				onStdinError: (error) =>
					logger.debug('[CodexAppServerSpawner] stdin error', LOG_CONTEXT, {
						sessionId,
						error: String(error),
					}),
			},
			{
				stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
				keepStdinOpen: true,
				stdoutTailLimit: 0,
				stderrTailLimit: 0,
				sessionId,
				label: 'codex-app-server',
			}
		);

		if (ssh) this.sendSshLaunchScript(ssh);

		managedProcess.pid = this.turn.pid ?? -1;
		managedProcess.spawnGeneration = nextSpawnGeneration(sessionId);
		this.ctx.processes.set(sessionId, managedProcess);

		void this.turn.done.then((exit) => this.handleChildExit(exit));
		void this.run().catch((error) => this.handleRunError(error));

		logger.info('[CodexAppServerSpawner] Started app-server turn', LOG_CONTEXT, {
			sessionId,
			pid: this.turn.pid,
			resume: !!invocation.resumeId,
			sandbox: invocation.sandbox ?? 'default',
			sshRemoteId: ssh ? config.sshRemoteId : undefined,
		});
		return { pid: managedProcess.pid, success: true };
	}

	/**
	 * Write the remote launch script ahead of any JSON-RPC line, prefixed with
	 * the pid record a remote stop signals. Remote bash reads it up to the line
	 * that `exec`s the server, which then reads the protocol from the same stdin.
	 */
	private sendSshLaunchScript(ssh: NonNullable<ProcessConfig['codexAppServerSsh']>): void {
		const pidFile = sshConnectionArgs(ssh.args) ? newRemotePidFilePath() : undefined;
		Object.assign(this.managedProcess, {
			command: ssh.command,
			args: ssh.args,
			sshRemoteId: this.config.sshRemoteId,
			sshRemoteHost: this.config.sshRemoteHost,
			sshRemoteCommand: ssh.remoteCommandLine,
			sshRemotePidFile: pidFile,
		});
		this.turn.child.stdin?.write(
			pidFile ? withRemotePidRecord(ssh.stdinScript, pidFile) : ssh.stdinScript
		);
	}

	/**
	 * Signal the server on its SSH host. A no-op for a local turn, or an SSH turn
	 * whose launch recorded no pid. Signals to the local ssh client never reach
	 * the remote server, which would otherwise run on with nothing reading it.
	 */
	private signalRemote(mode: RemoteSignalMode): void {
		const { sshRemotePidFile: pidFile, command, args } = this.managedProcess;
		if (!pidFile || !command || !args) return;
		signalRemoteAgent(
			{ sshCommand: command, sshArgs: args, pidFile, sessionId: this.config.sessionId },
			mode
		);
	}

	// ── Protocol ─────────────────────────────────────────────────────────

	private async run(): Promise<void> {
		const { invocation, config } = this;
		const request = <T>(method: string, params?: unknown) =>
			this.rpc.request<T>(method, params, { timeoutMs: CODEX_APP_SERVER_REQUEST_TIMEOUT_MS });

		// ── Setup: any failure here falls back to exec ─────────────────────
		try {
			await request('initialize', {
				clientInfo: { name: 'maestro', version: this.ctx.clientVersion },
				capabilities: { experimentalApi: true },
			});
			if (this.cancelled) return;
			this.rpc.notify('initialized');

			const threadParams = {
				cwd: invocation.cwd,
				approvalPolicy: config.permissionMode === 'standard' ? 'on-request' : 'never',
				...(invocation.sandbox ? { sandbox: invocation.sandbox } : {}),
				...(invocation.model ? { model: invocation.model } : {}),
			};
			const threadMethod = invocation.resumeId ? 'thread/resume' : 'thread/start';
			const threadResult = await request(
				threadMethod,
				invocation.resumeId
					? { ...threadParams, threadId: invocation.resumeId, excludeTurns: true }
					: threadParams
			);
			if (this.cancelled || this.phase !== 'setup') return;
			this.hold(this.translator.translateResponse(threadMethod, threadResult));
			if (!this.translator.threadId) {
				throw new Error(`${threadMethod} returned no thread id`);
			}
			// A resumed thread keeps its persisted settings unless the overrides
			// took; a read-only turn must not run under full access.
			const mismatch = codexThreadPolicyMismatch(invocation, threadResult);
			if (mismatch) throw new Error(`${threadMethod}: ${mismatch}`);
		} catch (error) {
			if (!this.cancelled) this.fallBack(error);
			return;
		}

		// ── Starting: the prompt is going out. Only a refusal falls back ──
		this.phase = 'starting';
		let turnResult: unknown;
		try {
			turnResult = await request('turn/start', {
				threadId: this.translator.threadId,
				input: [
					{ type: 'text', text: (config.codexAppServerSsh?.prompt ?? config.prompt) as string },
				],
				...(invocation.effort ? { effort: invocation.effort } : {}),
				...(invocation.summary ? { summary: invocation.summary } : {}),
			});
		} catch (error) {
			// An error RESPONSE proves the prompt did not start; a timeout or a
			// lost child does not, and goes to handleRunError.
			if (error instanceof CodexRpcRequestError && this.phase === 'starting' && !this.cancelled) {
				this.fallBack(error);
				return;
			}
			throw error;
		}
		if (this.phase === 'starting') this.commit();
		this.translator.translateResponse('turn/start', turnResult);
	}

	/** Route one framed stdout line from the server. */
	private handleLine(line: string): void {
		if (this.isSuperseded()) return;
		const trimmed = line.trim();
		if (!trimmed) return;

		let message: CodexAppServerMessage;
		try {
			message = JSON.parse(trimmed) as CodexAppServerMessage;
		} catch {
			logger.debug('[CodexAppServerSpawner] Ignoring non-JSON stdout line', LOG_CONTEXT, {
				sessionId: this.config.sessionId,
				preview: trimmed.slice(0, 200),
			});
			return;
		}
		if (!message || typeof message !== 'object') return;

		if (isCodexServerRequest(message)) {
			this.answerServerRequest(message);
			return;
		}
		if (isCodexResponse(message)) {
			this.rpc.handleResponse(message);
			return;
		}
		if (!isCodexNotification(message)) return;

		if (message.method === 'warning') {
			logger.debug('[CodexAppServerSpawner] Server warning', LOG_CONTEXT, {
				sessionId: this.config.sessionId,
				params: message.params,
			});
		}
		const lines = this.translator.translate(message);
		// The turn's own activity is proof the server accepted the prompt, even
		// ahead of the `turn/start` response.
		if (
			this.phase === 'starting' &&
			(this.translator.activeTurnId !== null || this.translator.outcome !== null)
		) {
			this.commit();
		}
		this.forward(lines);
		if (this.translator.outcome && this.phase !== 'ended') this.endTurn();
	}

	/**
	 * Answer a server request at once, by policy. An unanswered request stalls
	 * the turn forever, so even a method Maestro does not know gets an error.
	 */
	private answerServerRequest(request: CodexAppServerRequest): void {
		if (this.config.permissionMode === 'standard') {
			const interaction = codexServerInteraction(request, {
				sessionId: this.config.sessionId,
				tabId: this.config.tabId,
				spawnGeneration: this.managedProcess.spawnGeneration ?? 1,
			});
			if (interaction) {
				void this.answerInteractiveServerRequest(request, interaction).catch((error) => {
					logger.warn(
						'[CodexAppServerSpawner] Interactive request failed; declining',
						LOG_CONTEXT,
						{
							sessionId: this.config.sessionId,
							method: request.method,
							error: String(error),
						}
					);
					this.respondToServerRequest(
						request,
						answerCodexServerRequest(request, { grantApprovals: false })
					);
				});
				return;
			}
		}
		this.respondToServerRequest(
			request,
			answerCodexServerRequest(request, {
				grantApprovals: this.invocation.sandbox === 'danger-full-access',
			})
		);
	}

	private async answerInteractiveServerRequest(
		request: CodexAppServerRequest,
		interaction: CodexServerInteraction
	): Promise<void> {
		const opened = harnessInteractionBroker.open(interaction.request);
		const resolution = await opened.completion;
		this.respondToServerRequest(request, interaction.answer(resolution));
	}

	private respondToServerRequest(
		request: CodexAppServerRequest,
		answer: CodexServerRequestAnswer
	): void {
		logger.debug('[CodexAppServerSpawner] Answering server request', LOG_CONTEXT, {
			sessionId: this.config.sessionId,
			method: request.method,
			answered: 'error' in answer ? 'error' : 'result',
		});
		try {
			this.rpc.respond(request.id, answer);
		} catch (error) {
			logger.debug('[CodexAppServerSpawner] Could not answer server request', LOG_CONTEXT, {
				sessionId: this.config.sessionId,
				method: request.method,
				error: String(error),
			});
		}
	}

	private handleStderr(text: string): void {
		if (this.isSuperseded()) return;
		if (this.holding) {
			this.heldStderr = (this.heldStderr + text).slice(-SETUP_STDERR_LIMIT);
			return;
		}
		this.ctx.stderrHandler.handleData(this.config.sessionId, text);
	}

	// ── Output ───────────────────────────────────────────────────────────

	/** Output is held until the server accepts the turn, so a fallback has shown nothing. */
	private get holding(): boolean {
		return this.phase === 'setup' || this.phase === 'starting';
	}

	private hold(lines: CodexExecLine[]): void {
		this.heldLines.push(...lines);
	}

	/** Forward exec lines to the stdout pipeline, or hold them until the turn is committed. */
	private forward(lines: CodexExecLine[]): void {
		if (lines.length === 0) return;
		if (this.holding) {
			this.hold(lines);
			return;
		}
		if (this.finished) return;
		const { sessionId } = this.config;
		const chunk = lines.map((line) => JSON.stringify(line) + '\n').join('');
		// Same order as the exec path: raw stdout for live consumers, then the handler.
		try {
			this.ctx.emitter.emit('raw-stdout', sessionId, chunk);
		} catch (error) {
			void captureException(error);
		}
		this.ctx.stdoutHandler.handleData(sessionId, chunk);
	}

	private commit(): void {
		this.phase = 'committed';
		const lines = this.heldLines;
		const stderr = this.heldStderr;
		this.heldLines = [];
		this.heldStderr = '';
		if (stderr) this.ctx.stderrHandler.handleData(this.config.sessionId, stderr);
		this.forward(lines);
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	/**
	 * `turn/completed` arrived: report the exit now, then let the child go.
	 * Closing stdin ends the server; the ladder runs only if it lingers.
	 */
	private endTurn(): void {
		this.phase = 'ended';
		this.notifyTurnEnded();
		this.finish(this.translator.outcome === 'failed' ? 1 : 0);
		this.releaseChild();
	}

	private releaseChild(): void {
		try {
			this.turn.child.stdin?.end();
		} catch {
			/* already closed */
		}
		this.armExitGrace('terminate');
	}

	/**
	 * The prompt may be running and the turn is about to be reported: release
	 * what was held so the tab still learns the session id, the turn's output
	 * and its stderr.
	 */
	private flushIfStarting(): void {
		if (this.phase === 'starting') this.commit();
	}

	/** Run the stop ladder from `from` if the child is still here after the grace. */
	private armExitGrace(from: 'interrupt' | 'terminate'): void {
		if (this.exitGraceTimer) return;
		this.exitGraceTimer = setTimeout(() => {
			this.exitGraceTimer = undefined;
			if (!this.childRunning()) return;
			this.signalRemote('terminate');
			stopProcess(
				{ child: this.turn.child },
				{
					from,
					graceMs: INTERACTIVE_STOP_GRACE_MS,
					sessionId: this.config.sessionId,
					label: 'codex-app-server',
				}
			);
		}, CODEX_APP_SERVER_EXIT_GRACE_MS);
	}

	private childRunning(): boolean {
		const child = this.turn.child;
		return child.exitCode === null && (child.signalCode === null || child.signalCode === undefined);
	}

	/**
	 * Stop: ask the server to interrupt the turn, which then ends with
	 * `turn/completed` (`interrupted`) and the usage it spent. The stop ladder
	 * follows if the child has not left by the end of the grace, because a
	 * child that ignored the interrupt goes on running commands.
	 */
	private interrupt(): void {
		this.cancelled = true;
		const sent = this.sendTurnInterrupt();
		if (!sent && this.childRunning()) {
			// Nothing to interrupt yet (setup, or `turn/start` unanswered): stop the child now.
			this.signalRemote('terminate');
			stopProcess(
				{ child: this.turn.child },
				{
					from: softStopStage(),
					graceMs: INTERACTIVE_STOP_GRACE_MS,
					sessionId: this.config.sessionId,
					label: 'interrupt',
				}
			);
			return;
		}
		this.armExitGrace(softStopStage());
	}

	/** Hard stop: interrupt the turn as a courtesy, then run the ladder from SIGTERM. */
	private kill(options: { sync?: boolean; shutdown?: boolean } = {}): void {
		this.cancelled = true;
		this.sendTurnInterrupt();
		if (this.exitGraceTimer) {
			clearTimeout(this.exitGraceTimer);
			this.exitGraceTimer = undefined;
		}
		this.signalRemote('terminate');
		stopProcess(
			{ child: this.turn.child },
			{
				from: 'terminate',
				upTo: options.shutdown ? 'terminate' : 'kill',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				immediate: options.shutdown,
				blocking: options.sync,
				includeDescendants: !options.shutdown,
				sessionId: this.config.sessionId,
				label: 'kill',
			}
		);
	}

	/** Send `turn/interrupt` for the active turn. False when there is no turn to interrupt. */
	private sendTurnInterrupt(): boolean {
		const threadId = this.translator.threadId;
		const turnId = this.translator.activeTurnId;
		if (!threadId || !turnId || this.phase !== 'committed' || this.rpc.isClosed) return false;
		this.rpc
			.request(
				'turn/interrupt',
				{ threadId, turnId },
				{ timeoutMs: CODEX_APP_SERVER_EXIT_GRACE_MS }
			)
			.catch((error) => {
				logger.debug('[CodexAppServerSpawner] turn/interrupt failed', LOG_CONTEXT, {
					sessionId: this.config.sessionId,
					error: String(error),
				});
			});
		return true;
	}

	private handleChildExit(exit: TurnExit): void {
		if (this.exitGraceTimer) {
			clearTimeout(this.exitGraceTimer);
			this.exitGraceTimer = undefined;
		}
		this.notifyTurnEnded();
		this.rpc.close('app-server exited');
		if (this.isSuperseded() || this.finished) return;

		if (this.phase === 'setup' && !this.cancelled) {
			this.fallBack(exit.spawnError ?? new Error(`app-server exited (code ${exit.exitCode})`));
			return;
		}

		// Gone while `turn/start` was unanswered: the prompt may have run.
		this.flushIfStarting();
		this.phase = 'ended';
		if (exit.spawnError) {
			this.emitAgentError(exit.spawnError);
			this.finish(1);
			return;
		}
		// The child died before `turn/completed`. A stop the user asked for is a
		// clean end; anything else is a crash the exit code describes.
		this.finish(
			this.cancelled ? 0 : (exit.exitCode ?? 1),
			this.cancelled ? undefined : exit.signal
		);
	}

	/**
	 * The prompt never started (setup failed, or the server refused
	 * `turn/start`): run the same config on exec. Nothing held was shown, so
	 * exec's output is the only output the tab sees.
	 */
	private fallBack(error: unknown): void {
		// The child's exit and the request it orphaned both report the same
		// failure; only the first one falls back.
		if (!this.holding || this.finished) return;
		const { sessionId } = this.config;
		logger.warn(
			'[CodexAppServerSpawner] app-server setup failed; falling back to exec',
			LOG_CONTEXT,
			{
				sessionId,
				error: String(error),
				stderr: this.heldStderr.slice(-2000) || undefined,
			}
		);
		this.phase = 'ended';
		this.heldLines = [];
		this.heldStderr = '';
		if (this.childRunning()) {
			this.signalRemote('terminate');
			stopProcess(
				{ child: this.turn.child },
				{ from: 'terminate', graceMs: INTERACTIVE_STOP_GRACE_MS, sessionId, label: 'fallback' }
			);
		}
		// Reclaim the slot only if it is still ours: a respawn that already took
		// the session id must not be clobbered.
		if (this.ctx.processes.get(sessionId) !== this.managedProcess) {
			this.finished = true;
			return;
		}
		this.ctx.processes.delete(sessionId);
		if (this.config.permissionMode === 'standard') {
			this.emitAgentError(new Error(`Codex Standard mode requires app-server: ${String(error)}`));
			this.finish(1);
			return;
		}
		try {
			if (this.ctx.fallbackToCli(this.config).success) {
				// exec owns the turn now; this child's exit must report nothing.
				this.finished = true;
				return;
			}
		} catch (fallbackError) {
			void captureException(fallbackError);
		}
		this.emitAgentError(error);
		this.finish(1);
	}

	/** A failure in the committed path (a `turn/start` the server refused, a lost child). */
	private handleRunError(error: unknown): void {
		if (this.finished || this.cancelled || this.isSuperseded()) return;
		if (!(error instanceof Error && error.name.startsWith('CodexRpc')))
			void captureException(error);
		logger.warn('[CodexAppServerSpawner] app-server turn failed', LOG_CONTEXT, {
			sessionId: this.config.sessionId,
			error: String(error),
		});
		this.flushIfStarting();
		this.emitAgentError(error);
		this.phase = 'ended';
		this.notifyTurnEnded();
		this.finish(1);
		this.releaseChild();
	}

	/** See `CodexAppServerProcessHandle.onTurnEnd`. */
	private onTurnEnd(listener: () => void): () => void {
		if (this.turnEnded) {
			listener();
			return () => {};
		}
		this.turnEndListeners.add(listener);
		return () => {
			this.turnEndListeners.delete(listener);
		};
	}

	/**
	 * Tell steering the turn is over, once. Called BEFORE `finish()` so a
	 * `dropped` verdict reaches the renderer ahead of the exit, which would
	 * otherwise settle the held steer as unconfirmed.
	 */
	private notifyTurnEnded(): void {
		if (this.turnEnded) return;
		this.turnEnded = true;
		const listeners = [...this.turnEndListeners];
		this.turnEndListeners.clear();
		for (const listener of listeners) {
			try {
				listener();
			} catch (error) {
				void captureException(error);
			}
		}
	}

	/** Report the turn's exit through ExitHandler, exactly once. */
	private finish(code: number, signal?: NodeJS.Signals | null): void {
		if (this.finished) return;
		this.finished = true;
		void this.ctx.exitHandler
			.handleExit(this.config.sessionId, code, this.managedProcess, signal)
			.catch((error) => {
				logger.error('[CodexAppServerSpawner] handleExit threw', LOG_CONTEXT, {
					sessionId: this.config.sessionId,
					error: String(error),
				});
			});
	}

	private emitAgentError(error: unknown): void {
		if (this.managedProcess.errorEmitted) return;
		this.managedProcess.errorEmitted = true;
		this.ctx.emitter.emit('agent-error', this.config.sessionId, {
			type: 'agent_crashed',
			message: `Codex app-server error: ${error instanceof Error ? error.message : String(error)}`,
			recoverable: true,
			agentId: this.config.toolType,
			sessionId: this.config.sessionId,
			timestamp: Date.now(),
		});
	}

	private isSuperseded(): boolean {
		return isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration);
	}

	private writeLine(line: string): void {
		const stdin = this.turn?.child.stdin;
		if (!stdin || stdin.destroyed || stdin.writableEnded) {
			throw new Error('app-server stdin is closed');
		}
		stdin.write(line + '\n');
	}
}
