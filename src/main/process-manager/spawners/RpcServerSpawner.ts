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
import {
	NdJsonConnection,
	type NdJsonRecord,
} from '../../../shared/maestro-lib/harness/rpc/connection';
import { answerRpcExtensionRequest } from '../../harness-control/rpc-interactions';
import { steeringTextMatches, type SteeringResultFrame } from '../../../shared/chatSteering';
import type { HarnessControlCapabilities } from '../../../shared/harness-control/types';
import type { NativeRpcProtocol } from '../../../shared/maestro-lib/providers/native-control';

const LOG_CONTEXT = 'NativeRpc';

interface RpcTurnContext {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	stdoutHandler: StdoutHandler;
	stderrHandler: StderrHandler;
	exitHandler: ExitHandler;
	fallbackToCli: (config: ProcessConfig) => SpawnResult;
}

export class RpcServerSpawner {
	private readonly context: RpcTurnContext;

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
		if (!config.nativeRpcArgs || !config.nativeRpcProtocol) return this.fallbackToCli(config);
		try {
			return new RpcTurn(this.context, config).start();
		} catch (error) {
			if (config.permissionMode === 'standard') {
				return {
					pid: -1,
					success: false,
					error: `Native RPC Standard mode could not start: ${String(error)}`,
				};
			}
			void captureException(error);
			return this.fallbackToCli(config);
		}
	}
}

class RpcTurn {
	private readonly managedProcess: ManagedProcess;
	private readonly protocol: NativeRpcProtocol;
	private turn!: TurnHandle;
	private connection?: NdJsonConnection;
	private providerSessionId?: string;
	private promptSent = false;
	private cancelled = false;
	private finished = false;
	private readonly pendingSteers = new Map<string, string>();
	private readonly closed = Promise.withResolvers<void>();
	private capabilities: HarnessControlCapabilities;

	constructor(
		private readonly ctx: RpcTurnContext,
		private readonly config: ProcessConfig
	) {
		this.protocol = config.nativeRpcProtocol ?? 'pi-rpc';
		const { sessionId, toolType, cwd, command, args } = config;
		this.capabilities = {
			protocol: this.protocol,
			protocolVersion: config.nativeRpcProtocol === 'omp-rpc' ? '2' : '1',
			steering: 'in-turn',
			permissionRequests: true,
			questions: true,
			elicitations: false,
			modelSwitch: true,
			modeSwitch: false,
			imagePrompts: true,
			resume: true,
		};
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
			sdkController: {
				interrupt: () => this.interrupt(),
				kill: (options) => this.kill(options),
			},
			harnessControl: {
				getCapabilities: () => this.capabilities,
				steer: (request) => this.steer(request),
				interrupt: async () => this.interrupt(),
				closed: this.closed.promise,
				close: async (options) => this.kill(options),
			},
		};
	}

	start(): SpawnResult {
		const { config } = this;
		const { sessionId, command } = config;
		const spawnPlan = planSpawnShell(command, config.nativeRpcArgs!, {
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
					logger.debug('[RpcTurn] stdin error', LOG_CONTEXT, {
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
				label: 'native-rpc',
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
		const connection = new NdJsonConnection(this.turn.child, {
			protocol: 'pi',
			negotiateV2: config.nativeRpcProtocol === 'omp-rpc',
			onNotification: (record) => this.onNotification(record),
			onServerRequest: (record) =>
				answerRpcExtensionRequest(record, {
					sessionId: config.sessionId,
					tabId: config.tabId,
					spawnGeneration: this.managedProcess.spawnGeneration ?? 1,
					provider: config.toolType,
				}),
		});
		this.connection = connection;
		if (config.agentSessionId) {
			const switched = (await connection.request('switch_session', {
				sessionPath: config.agentSessionId,
			})) as { cancelled?: boolean };
			if (switched.cancelled === true) throw new Error('Pi cancelled the session switch');
		}
		if (config.modelId) {
			const separator = config.modelId.indexOf('/');
			if (separator > 0) {
				await connection.request('set_model', {
					provider: config.modelId.slice(0, separator),
					modelId: config.modelId.slice(separator + 1),
				});
			}
		}
		if (config.effort) {
			await connection.request('set_thinking_level', { level: config.effort });
		}
		const state = (await connection.request('get_state')) as {
			sessionId?: string;
			sessionFile?: string;
		};
		this.providerSessionId = state.sessionFile ?? config.agentSessionId ?? state.sessionId;
		if (this.providerSessionId) {
			this.forwardLine(JSON.stringify({ type: 'session', id: this.providerSessionId }));
		}
		this.promptSent = true;
		const submission = (await connection.request('prompt', {
			message: config.prompt ?? '',
			...(this.promptImages().length > 0 ? { images: this.promptImages() } : {}),
		})) as { disposition?: string } | undefined;
		if (submission?.disposition === 'handled') {
			const state = (await connection.request('get_state')) as {
				isStreaming?: boolean;
				pendingMessageCount?: number;
			};
			if (!state.isStreaming && (state.pendingMessageCount ?? 0) === 0) {
				this.finish(0);
				this.turn.child.stdin!.end();
			}
		}
	}

	private promptImages(): Array<{ type: 'image'; data: string; mimeType: string }> {
		return (this.config.images ?? []).flatMap((image) => {
			const match = /^data:([^;]+);base64,(.+)$/.exec(image);
			return match ? [{ type: 'image' as const, data: match[2], mimeType: match[1] }] : [];
		});
	}

	private async steer(request: { id: string; text: string }): Promise<SteeringResultFrame> {
		if (!this.connection || !this.promptSent || this.finished) {
			return {
				type: 'steering',
				id: request.id,
				verdict: 'refused',
				refusal: 'not-running',
				detail: 'That turn has already finished, so there is nothing to steer.',
			};
		}
		try {
			this.pendingSteers.set(request.id, request.text);
			await this.connection.request('steer', {
				message: request.text,
				...(this.promptImages().length > 0 ? { images: this.promptImages() } : {}),
			});
			return { type: 'steering', id: request.id, verdict: 'delivered' };
		} catch (error) {
			this.pendingSteers.delete(request.id);
			return {
				type: 'steering',
				id: request.id,
				verdict: 'unknown',
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private onNotification(record: NdJsonRecord): void {
		if (this.isSuperseded()) return;
		if (record.type === 'message_start') {
			const message = record.message as { role?: string; content?: unknown } | undefined;
			if (message?.role === 'user') {
				const text = this.messageText(message.content);
				for (const [id, steeredText] of this.pendingSteers) {
					if (steeringTextMatches(text, steeredText)) {
						this.pendingSteers.delete(id);
						this.ctx.emitter.emit('steering-verdict', this.config.sessionId, {
							type: 'steering',
							id,
							verdict: 'absorbed',
						} satisfies SteeringResultFrame);
					}
				}
			}
		}
		if (record.type === 'agent_settled' || record.type === 'session_settled') {
			for (const id of this.pendingSteers.keys()) {
				this.ctx.emitter.emit('steering-verdict', this.config.sessionId, {
					type: 'steering',
					id,
					verdict: 'dropped',
				} satisfies SteeringResultFrame);
			}
			this.pendingSteers.clear();
			this.forwardLine(JSON.stringify(record));
			this.finish(record.aborted === true && !this.cancelled ? 1 : 0);
			this.turn.child.stdin!.end();
			return;
		}
		if (record.type === 'prompt_result' && record.status && record.status !== 'completed') {
			this.emitAgentError(
				new Error(`Native prompt failed: ${String(record.error ?? record.status)}`)
			);
			this.finish(1);
			this.turn.child.stdin?.end();
			return;
		}
		this.forwardLine(JSON.stringify(record));
	}

	private messageText(content: unknown): string {
		if (typeof content === 'string') return content;
		if (!Array.isArray(content)) return '';
		return content
			.map((block) => {
				if (!block || typeof block !== 'object') return '';
				const value = block as { type?: unknown; text?: unknown };
				return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
			})
			.join('');
	}

	private forwardLine(line: string): void {
		if (this.isSuperseded()) return;
		this.ctx.stdoutHandler.handleData(this.config.sessionId, line + '\n');
	}

	private async interrupt(): Promise<void> {
		this.cancelled = true;
		void this.connection?.request('abort').catch(() => undefined);
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
		void this.connection?.request('abort').catch(() => undefined);
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

	private handleRunError(error: unknown): void {
		if (this.finished || this.isSuperseded()) return;
		const canFallback = !this.promptSent;
		if (canFallback && this.config.permissionMode !== 'standard') {
			logger.warn('[RpcTurn] Native setup failed; using current transport', LOG_CONTEXT, {
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
				exit.spawnError ?? new Error(`Native RPC child exited with code ${exit.exitCode}`)
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
			message: `Native RPC transport error: ${error instanceof Error ? error.message : String(error)}`,
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
				logger.error('[RpcTurn] handleExit failed', LOG_CONTEXT, {
					sessionId: this.config.sessionId,
					error: String(error),
				});
			});
	}

	private isSuperseded(): boolean {
		return isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration);
	}
}
