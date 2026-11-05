import { EventEmitter } from 'events';
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
import { AcpOutputParser } from '../../../shared/maestro-lib/harness/acp/output-parser';
import {
	NdJsonConnection,
	type NdJsonRecord,
	type NdJsonServerResponse,
} from '../../../shared/maestro-lib/harness/rpc/connection';
import { harnessInteractionBroker } from '../../harness-control/integration';
import type { HarnessControlCapabilities } from '../../../shared/harness-control/types';
import type { SteeringResultFrame } from '../../../shared/chatSteering';
import type { ToolType } from '../../../shared/types';
import { ANTIGRAVITY_SDK_SIDECAR } from './antigravitySdkSidecar';

const LOG_CONTEXT = 'AntigravitySdk';

interface AntigravityTurnContext {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	stdoutHandler: StdoutHandler;
	stderrHandler: StderrHandler;
	exitHandler: ExitHandler;
	fallbackToCli: (config: ProcessConfig) => SpawnResult;
}

export class AntigravitySdkSpawner {
	private readonly context: AntigravityTurnContext;

	constructor(
		processes: Map<string, ManagedProcess>,
		emitter: EventEmitter,
		bufferManager: DataBufferManager,
		private readonly fallbackToCli: (config: ProcessConfig) => SpawnResult
	) {
		this.context = {
			processes,
			emitter,
			stdoutHandler: new StdoutHandler({ processes, emitter, bufferManager }),
			stderrHandler: new StderrHandler({ processes, emitter }),
			exitHandler: new ExitHandler({ processes, emitter, bufferManager }),
			fallbackToCli,
		};
	}

	spawn(config: ProcessConfig): SpawnResult {
		if (config.toolType !== 'antigravity' || config.harnessControlMode !== 'native') {
			return this.fallbackToCli(config);
		}
		try {
			if ((config.images?.length ?? 0) > 0) {
				throw new Error('Antigravity SDK native mode does not support image prompts');
			}
			if (config.agentSessionId) {
				throw new Error('Antigravity SDK resume is not supported; use the current transport');
			}
			return new AntigravityTurn(this.context, config).start();
		} catch (error) {
			if (config.permissionMode === 'standard') {
				return {
					pid: -1,
					success: false,
					error: `Antigravity native mode could not start: ${String(error)}`,
				};
			}
			void captureException(error);
			return this.fallbackToCli(config);
		}
	}
}

class AntigravityTurn {
	private readonly managedProcess: ManagedProcess;
	private turn: TurnHandle;
	private connection?: NdJsonConnection;
	private cancelled = false;
	private finished = false;
	private readonly closed = Promise.withResolvers<void>();
	private readonly capabilities: HarnessControlCapabilities = {
		protocol: 'antigravity-sdk',
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
		private readonly ctx: AntigravityTurnContext,
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
			sdkController: {
				interrupt: () => this.interrupt(),
				kill: () => this.close(),
			},
			harnessControl: {
				getCapabilities: () => this.capabilities,
				closed: this.closed.promise,
				steer: (request) => this.steer(request),
				interrupt: async () => this.interrupt(),
				close: async () => this.close(),
			},
		};
		const python = config.customEnvVars?.ANTIGRAVITY_PYTHON || 'python';
		const sidecarArgs = ['-u', '-c', ANTIGRAVITY_SDK_SIDECAR];
		const spawnPlan = planSpawnShell(python, sidecarArgs, {
			runInShell: config.runInShell,
			shell: config.shell,
		});
		this.turn = startTurn(
			{
				command: spawnPlan.command,
				args: spawnPlan.args,
				cwd: config.cwd,
				env: buildChildProcessEnv(
					config.customEnvVars,
					false,
					config.shellEnvVars,
					config.extraPathDirs,
					config.querySource
				),
				shell: spawnPlan.shell,
			},
			{
				onStderr: (chunk) => this.ctx.stderrHandler.handleData(this.config.sessionId, chunk),
			},
			{
				stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
				keepStdinOpen: true,
				stdoutTailLimit: 0,
				stderrTailLimit: 0,
				sessionId: config.sessionId,
				label: 'antigravity-sdk',
			}
		);
		this.managedProcess.pid = this.turn.pid ?? -1;
		this.managedProcess.childProcess = this.turn.child;
		void this.turn.done.then((exit) => this.handleChildExit(exit));
	}

	start(): SpawnResult {
		const { sessionId } = this.config;
		this.managedProcess.spawnGeneration = nextSpawnGeneration(sessionId);
		this.ctx.processes.set(sessionId, this.managedProcess);
		void this.run().catch((error) => this.handleRunError(error));
		return { pid: this.managedProcess.pid, success: true };
	}

	private async run(): Promise<void> {
		this.connection = new NdJsonConnection(this.turn.child, {
			protocol: 'jsonrpc',
			onNotification: (record) => this.onNotification(record),
			onServerRequest: (record) => this.onServerRequest(record),
		});
		await this.connection.request('start', {
			cwd: this.config.cwd,
			prompt: this.config.prompt ?? '',
			model: this.config.modelId,
			permission_mode: this.config.permissionMode ?? 'standard',
		});
	}

	private onNotification(record: NdJsonRecord): void {
		if (this.isSuperseded()) return;
		const params = (record.params ?? {}) as Record<string, unknown>;
		switch (record.method) {
			case 'text':
				this.forwardLine(JSON.stringify({ type: 'acp.text', text: params.text ?? '' }));
				return;
			case 'complete':
				this.forwardLine(JSON.stringify({ type: 'acp.result', stopReason: 'end_turn' }));
				this.finish(typeof params.code === 'number' ? params.code : 0);
				this.turn.child.stdin?.end();
				return;
			case 'error':
				this.forwardLine(JSON.stringify({ type: 'acp.error', message: params.message }));
				return;
			default:
				this.forwardLine(JSON.stringify({ type: 'acp.system', update: record }));
		}
	}

	private async onServerRequest(record: NdJsonRecord): Promise<NdJsonServerResponse> {
		const params = (record.params ?? {}) as Record<string, unknown>;
		const opened = harnessInteractionBroker.open({
			sessionId: this.config.sessionId,
			tabId: this.config.tabId,
			spawnGeneration: this.managedProcess.spawnGeneration ?? 1,
			kind: 'permission',
			provider: 'antigravity',
			title: `Antigravity wants to use ${String(params.tool ?? 'a tool')}`,
			toolName: typeof params.tool === 'string' ? params.tool : undefined,
			input:
				params.input && typeof params.input === 'object'
					? (params.input as Record<string, unknown>)
					: undefined,
			options: [
				{ optionId: 'allow', label: 'Allow once', kind: 'allow-once' },
				{ optionId: 'deny', label: 'Deny', kind: 'reject-once' },
			],
		});
		const resolution = await opened.completion;
		return {
			kind: 'result',
			value: { allow: resolution.outcome === 'selected' && resolution.optionId === 'allow' },
		};
	}

	private steer(request: { id: string; text: string }): Promise<SteeringResultFrame> {
		return Promise.resolve({
			type: 'steering',
			id: request.id,
			verdict: 'refused',
			refusal: 'editor-unavailable',
			detail: 'Antigravity SDK does not expose mid-turn steering.',
		});
	}

	private forwardLine(line: string): void {
		if (!this.isSuperseded()) this.ctx.stdoutHandler.handleData(this.config.sessionId, line + '\n');
	}

	private async interrupt(): Promise<void> {
		this.cancelled = true;
		void this.connection?.request('interrupt').catch(() => undefined);
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

	private async close(): Promise<void> {
		this.cancelled = true;
		void this.connection?.request('close').catch(() => undefined);
		stopProcess(
			{ child: this.turn.child },
			{
				from: 'terminate',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				sessionId: this.config.sessionId,
				label: 'close',
			}
		);
	}

	private handleRunError(error: unknown): void {
		if (this.finished || this.isSuperseded()) return;
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
		this.finish(this.cancelled ? 0 : (exit.exitCode ?? 1));
	}

	private emitAgentError(error: unknown): void {
		if (this.managedProcess.errorEmitted) return;
		this.managedProcess.errorEmitted = true;
		this.ctx.emitter.emit('agent-error', this.config.sessionId, {
			type: 'agent_crashed',
			message: `Antigravity SDK transport error: ${error instanceof Error ? error.message : String(error)}`,
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
				logger.error('[AntigravityTurn] handleExit failed', LOG_CONTEXT, {
					sessionId: this.config.sessionId,
					error: String(error),
				});
			});
	}

	private isSuperseded(): boolean {
		return isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration);
	}
}
