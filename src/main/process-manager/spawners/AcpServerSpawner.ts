import { EventEmitter } from 'events';
import { acpStdioStream } from './acp-stdio';
import * as acp from '@agentclientprotocol/sdk';
import type {
	ClientConnection,
	InitializeResponse,
	PromptResponse,
	SessionNotification,
} from '@agentclientprotocol/sdk';
import { logger } from '../../utils/logger';
import { createOutputParser } from '../../parsers';
import { captureException } from '../../utils/sentry';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { StderrHandler } from '../handlers/StderrHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { buildChildProcessEnv } from '../utils/envBuilder';
import { planSpawnShell } from '../utils/windowsSpawnShell';
import type { ToolType } from '../../../shared/types';
import { nextSpawnGeneration, isSupersededGeneration } from '../generation';
import {
	startTurn,
	type TurnExit,
	type TurnHandle,
} from '../../../shared/maestro-lib/run/start-turn';
import {
	stopProcess,
	INTERACTIVE_STOP_GRACE_MS,
} from '../../../shared/maestro-lib/control/termination';
import { AcpEventTranslator } from '../../../shared/maestro-lib/harness/acp/events';
import { AcpOutputParser } from '../../../shared/maestro-lib/harness/acp/output-parser';
import {
	acpPermissionOpenRequest,
	acpPermissionResponse,
} from '../../../shared/maestro-lib/harness/acp/interactions';
import { harnessInteractionBroker } from '../../harness-control/integration';
import type { HarnessControlCapabilities } from '../../../shared/harness-control/types';

const LOG_CONTEXT = 'AcpServer';

interface AcpTurnContext {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	stdoutHandler: StdoutHandler;
	stderrHandler: StderrHandler;
	exitHandler: ExitHandler;
	fallbackToCli: (config: ProcessConfig) => SpawnResult;
	clientVersion: string;
}

export class AcpServerSpawner {
	private readonly context: AcpTurnContext;

	constructor(
		processes: Map<string, ManagedProcess>,
		emitter: EventEmitter,
		bufferManager: DataBufferManager,
		private readonly fallbackToCli: (config: ProcessConfig) => SpawnResult,
		options: { clientVersion?: string } = {}
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
		if (!config.nativeAcpArgs) return this.fallbackToCli(config);
		try {
			return new AcpTurn(this.context, config).start();
		} catch (error) {
			if (config.permissionMode === 'standard') {
				return {
					pid: -1,
					success: false,
					error: `ACP Standard mode could not start: ${String(error)}`,
				};
			}
			void captureException(error);
			return this.fallbackToCli(config);
		}
	}
}

class AcpTurn {
	private readonly translator = new AcpEventTranslator();
	private readonly managedProcess: ManagedProcess;
	private turn!: TurnHandle;
	private connection?: ClientConnection;
	private providerSessionId?: string;
	private promptSent = false;
	private cancelled = false;
	private finished = false;
	private readonly closed = Promise.withResolvers<void>();
	private capabilities: HarnessControlCapabilities = {
		protocol: 'acp',
		protocolVersion: '1',
		steering: 'none',
		permissionRequests: true,
		questions: false,
		elicitations: false,
		modelSwitch: false,
		modeSwitch: false,
		imagePrompts: false,
		resume: false,
	};

	constructor(
		private readonly ctx: AcpTurnContext,
		private readonly config: ProcessConfig
	) {
		const { sessionId, toolType, cwd, command, args } = config;
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
			outputParser: new AcpOutputParser(
				toolType as ToolType,
				createOutputParser(toolType) || undefined
			),
			stderrBuffer: '',
			stdoutBuffer: '',
			contextWindow: config.contextWindow,
			command,
			args,
			querySource: config.querySource,
			tabId: config.tabId,
			projectPath: config.projectPath,
			agentSessionId: config.agentSessionId,
			sdkController: {
				interrupt: () => this.interrupt(),
				kill: (options) => this.kill(options),
			},
			harnessControl: {
				closed: this.closed.promise,
				getCapabilities: () => this.capabilities,
				steer: async ({ id }) => ({
					type: 'steering',
					id,
					verdict: 'refused',
					refusal: 'editor-unavailable',
					detail: 'ACP v1 does not define mid-turn steering.',
				}),
				interrupt: async () => this.interrupt(),
				close: async (options) => this.kill(options),
			},
		};
	}

	start(): SpawnResult {
		const { config } = this;
		const { sessionId, command } = config;
		const spawnPlan = planSpawnShell(command, config.nativeAcpArgs!, {
			runInShell: config.runInShell,
			shell: config.shell,
		});
		const env = buildChildProcessEnv(
			config.customEnvVars,
			!!config.agentSessionId,
			config.shellEnvVars,
			config.extraPathDirs,
			config.querySource
		);
		this.turn = startTurn(
			{
				command: spawnPlan.command,
				args: spawnPlan.args,
				cwd: config.cwd,
				env,
				shell: spawnPlan.shell,
			},
			{
				onStderr: (text) => this.ctx.stderrHandler.handleData(sessionId, text),
				onStdinError: (error) =>
					logger.debug('[AcpTurn] stdin error', LOG_CONTEXT, {
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
				label: 'acp',
			}
		);
		this.managedProcess.pid = this.turn.pid ?? -1;
		this.managedProcess.spawnGeneration = nextSpawnGeneration(sessionId);
		this.ctx.processes.set(sessionId, this.managedProcess);
		void this.turn.done.then((exit) => this.handleChildExit(exit));
		void this.run().catch((error) => this.handleRunError(error));
		return { pid: this.managedProcess.pid, success: true };
	}

	private async run(): Promise<void> {
		const { config } = this;
		const child = this.turn.child;
		if (!child.stdin || !child.stdout) throw new Error('ACP child requires stdin and stdout');
		const stream = acpStdioStream(child);
		const connectionStream = acp.ndJsonStream(stream.writable, stream.readable);
		const app = acp
			.client({ name: 'maestro' })
			.onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
				if (this.providerSessionId && params.sessionId !== this.providerSessionId) {
					return { outcome: { outcome: 'cancelled' as const } };
				}
				const opened = harnessInteractionBroker.open(
					acpPermissionOpenRequest(params, {
						sessionId: config.sessionId,
						tabId: config.tabId,
						spawnGeneration: this.managedProcess.spawnGeneration ?? 1,
						provider: config.toolType,
					})
				);
				return acpPermissionResponse(await opened.completion);
			})
			.onNotification(acp.methods.client.session.update, ({ params }) => {
				if (!this.promptSent) return;
				if (this.providerSessionId && params.sessionId !== this.providerSessionId) return;
				this.forwardUpdate(params);
			});
		this.connection = app.connect(connectionStream);
		const initialized = await this.connection.agent.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
			clientInfo: { name: 'maestro', version: this.ctx.clientVersion },
		});
		if (initialized.protocolVersion !== 1) {
			throw new Error(
				`ACP agent selected unsupported protocol version ${initialized.protocolVersion}`
			);
		}
		this.applyCapabilities(initialized);
		if ((config.sessionAdditionalDirectories?.length ?? 0) > 0) {
			throw new Error('ACP native mode cannot preserve per-directory read/write grants');
		}
		if (config.agentSessionId && initialized.agentCapabilities?.loadSession !== true) {
			throw new Error('ACP agent does not support resume; use the current transport');
		}
		const session = (
			config.agentSessionId && initialized.agentCapabilities?.loadSession === true
				? await this.connection.agent.request(acp.methods.agent.session.load, {
						sessionId: config.agentSessionId,
						cwd: config.cwd,
						mcpServers: [],
					})
				: await this.connection.agent.request(acp.methods.agent.session.new, {
						cwd: config.cwd,
						mcpServers: [],
					})
		) as {
			sessionId?: string;
		};
		this.providerSessionId = session?.sessionId ?? config.agentSessionId;
		if (!this.providerSessionId) throw new Error('ACP session did not return a session id');
		this.forwardLine(
			JSON.stringify({
				type: 'acp.init',
				sessionId: this.providerSessionId,
				agentInfo: initialized.agentInfo,
			})
		);
		this.promptSent = true;
		const result: PromptResponse = await this.connection.agent.request(
			acp.methods.agent.session.prompt,
			{
				sessionId: this.providerSessionId,
				prompt: this.promptContent(),
			}
		);
		this.forwardLine(
			JSON.stringify({
				type: 'acp.result',
				sessionId: this.providerSessionId,
				stopReason: result.stopReason,
				text: this.translator.finalText,
			})
		);
		this.finish(result.stopReason === 'end_turn' || result.stopReason === 'cancelled' ? 0 : 1);
		child.stdin.end();
	}

	private applyCapabilities(initialized: InitializeResponse): void {
		this.capabilities = {
			...this.capabilities,
			agentVersion: initialized.agentInfo?.version,
			resume: initialized.agentCapabilities?.loadSession === true,
			imagePrompts: initialized.agentCapabilities?.promptCapabilities?.image === true,
		};
	}

	private promptContent(): acp.ContentBlock[] {
		const content: acp.ContentBlock[] = [{ type: 'text', text: this.config.prompt ?? '' }];
		for (const image of this.config.images ?? []) {
			const match = /^data:([^;]+);base64,(.+)$/.exec(image);
			if (!match || !this.capabilities.imagePrompts) {
				throw new Error('ACP agent does not advertise image prompt support');
			}
			content.push({ type: 'image', data: match[2], mimeType: match[1] });
		}
		return content;
	}

	private forwardUpdate(notification: SessionNotification): void {
		for (const line of this.translator.handle(notification).lines) this.forwardLine(line);
	}

	private forwardLine(line: string): void {
		if (this.isSuperseded()) return;
		this.ctx.stdoutHandler.handleData(this.config.sessionId, line + '\n');
	}

	private async interrupt(): Promise<void> {
		this.cancelled = true;
		void this.cancelNative();
		stopProcess(
			{ child: this.turn.child },
			{
				from: 'interrupt',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				sessionId: this.config.sessionId,
				label: 'interrupt',
			}
		);
	}

	private async kill(options?: { sync?: boolean; shutdown?: boolean }): Promise<void> {
		this.cancelled = true;
		void this.cancelNative();
		stopProcess(
			{ child: this.turn.child },
			{
				from: 'terminate',
				upTo: options?.shutdown ? 'terminate' : 'kill',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				immediate: options?.shutdown,
				blocking: options?.sync,
				sessionId: this.config.sessionId,
				label: 'kill',
			}
		);
	}

	private async cancelNative(): Promise<void> {
		if (!this.connection || !this.providerSessionId) return;
		try {
			await this.connection.agent.notify(acp.methods.agent.session.cancel, {
				sessionId: this.providerSessionId,
			});
		} catch {
			// The process stop ladder remains authoritative after a transport failure.
		}
	}

	private handleRunError(error: unknown): void {
		if (this.finished || this.isSuperseded()) return;
		const canFallback = !this.promptSent;
		if (canFallback && this.config.permissionMode !== 'standard') {
			logger.warn('[AcpTurn] Native setup failed; using current transport', LOG_CONTEXT, {
				sessionId: this.config.sessionId,
				error: String(error),
			});
			stopProcess(
				{ child: this.turn.child },
				{
					from: 'terminate',
					graceMs: INTERACTIVE_STOP_GRACE_MS,
					sessionId: this.config.sessionId,
					label: 'fallback',
				}
			);
			this.finished = true;
			if (this.ctx.processes.get(this.config.sessionId) === this.managedProcess) {
				this.ctx.processes.delete(this.config.sessionId);
				this.ctx.fallbackToCli(this.config);
			}
			return;
		}
		stopProcess(
			{ child: this.turn.child },
			{
				from: 'terminate',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				sessionId: this.config.sessionId,
				label: 'error',
			}
		);
		void captureException(error);
		this.emitAgentError(error);
		this.finish(1);
	}

	private handleChildExit(exit: TurnExit): void {
		this.closed.resolve();
		this.connection?.close();
		if (this.finished || this.isSuperseded()) return;
		if (!this.promptSent) {
			this.handleRunError(
				exit.spawnError ?? new Error(`ACP child exited with code ${exit.exitCode}`)
			);
			return;
		}
		this.finish(this.cancelled ? 0 : (exit.exitCode ?? 1));
	}

	private emitAgentError(error: unknown): void {
		if (this.managedProcess.errorEmitted) return;
		this.managedProcess.errorEmitted = true;
		this.ctx.emitter.emit('agent-error', this.config.sessionId, {
			type: 'agent_crashed',
			message: `ACP transport error: ${error instanceof Error ? error.message : String(error)}`,
			recoverable: true,
			agentId: this.config.toolType,
			sessionId: this.config.sessionId,
			timestamp: Date.now(),
		});
	}

	private finish(code: number): void {
		if (this.finished) return;
		this.finished = true;
		void this.ctx.exitHandler
			.handleExit(this.config.sessionId, code, this.managedProcess)
			.catch((error) => {
				logger.error('[AcpTurn] handleExit failed', LOG_CONTEXT, {
					sessionId: this.config.sessionId,
					error: String(error),
				});
			});
	}

	private isSuperseded(): boolean {
		return isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration);
	}
}
