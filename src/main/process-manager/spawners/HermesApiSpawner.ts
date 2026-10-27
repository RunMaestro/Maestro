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
import type {
	HarnessControlCapabilities,
	HarnessInteractionOption,
} from '../../../shared/harness-control/types';
import type { SteeringResultFrame } from '../../../shared/chatSteering';
import type { ToolType } from '../../../shared/types';
import { resolveHermesGatewayLaunch } from '../../../shared/maestro-lib/providers/hermes-launch';

const LOG_CONTEXT = 'HermesGateway';

interface HermesTurnContext {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	stdoutHandler: StdoutHandler;
	stderrHandler: StderrHandler;
	exitHandler: ExitHandler;
	fallbackToCli: (config: ProcessConfig) => SpawnResult;
}

export class HermesApiSpawner {
	private readonly context: HermesTurnContext;

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
		if (config.toolType !== 'hermes' || config.harnessControlMode !== 'native') {
			return this.fallbackToCli(config);
		}
		if (config.permissionMode === 'readonly') {
			// The gateway has no enforceable read-only tool contract. Use the
			// existing transport before any native prompt is attempted.
			return this.fallbackToCli(config);
		}
		try {
			return new HermesTurn(this.context, resolveHermesGatewayLaunch(config)).start();
		} catch (error) {
			if (config.permissionMode === 'standard') {
				return {
					pid: -1,
					success: false,
					error: `Hermes native mode could not start: ${String(error)}`,
				};
			}
			void captureException(error);
			return this.fallbackToCli(config);
		}
	}
}

class HermesTurn {
	private readonly managedProcess: ManagedProcess;
	private turn!: TurnHandle;
	private connection?: NdJsonConnection;
	private providerSessionId?: string;
	private acpSessionId?: string;
	private promptSent = false;
	private cancelled = false;
	private finished = false;
	private readonly closed = Promise.withResolvers<void>();
	private readonly pendingRequests = new Map<string, string>();
	private lastUsage = { input: 0, output: 0 };
	private readonly completedText: string[] = [];
	private readonly capabilities: HarnessControlCapabilities = {
		protocol: 'hermes-gateway',
		protocolVersion: 'stdio-jsonrpc',
		steering: 'in-turn',
		permissionRequests: true,
		questions: true,
		elicitations: true,
		modelSwitch: true,
		modeSwitch: false,
		imagePrompts: false,
		resume: true,
	};

	constructor(
		private readonly ctx: HermesTurnContext,
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
				getCapabilities: () => this.capabilities,
				closed: this.closed.promise,
				steer: (request) => this.steer(request),
				interrupt: async () => this.interrupt(),
				close: async (options) => this.kill(options),
			},
		};
	}

	start(): SpawnResult {
		const { config } = this;
		const { sessionId, command } = config;
		const spawnPlan = planSpawnShell(command, ['-m', 'tui_gateway.entry'], {
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
					logger.debug('[HermesTurn] stdin error', LOG_CONTEXT, {
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
				label: 'hermes-gateway',
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
		if ((config.images?.length ?? 0) > 0) {
			throw new Error('Hermes native mode does not support image prompts');
		}
		this.connection = new NdJsonConnection(this.turn.child, {
			protocol: 'jsonrpc',
			onNotification: (record) => this.onNotification(record),
			onServerRequest: (record) => this.onServerRequest(record),
		});
		if (config.agentSessionId) {
			const resumed = await this.connection.request('session.resume', {
				session_id: config.agentSessionId,
			});
			this.acpSessionId = config.agentSessionId;
			this.providerSessionId =
				resumed && typeof resumed === 'object' && 'session_id' in resumed
					? (resumed.session_id as string)
					: config.agentSessionId;
			if (resumed && typeof resumed === 'object') {
				const pending = resumed as {
					pending_approval?: unknown;
					pending_clarify?: unknown;
				};
				if (pending.pending_approval && typeof pending.pending_approval === 'object') {
					void this.onGatewayInteraction(
						'approval.request',
						pending.pending_approval as Record<string, unknown>
					);
				}
				if (pending.pending_clarify && typeof pending.pending_clarify === 'object') {
					void this.onGatewayInteraction(
						'clarify.request',
						pending.pending_clarify as Record<string, unknown>
					);
				}
			}
		} else {
			const created = await this.connection.request('session.create', {
				cwd: config.cwd,
				...(config.modelId ? { model: config.modelId } : {}),
				...(config.effort ? { reasoning_effort: config.effort } : {}),
			});
			const sessionId =
				created && typeof created === 'object' && 'session_id' in created
					? created.session_id
					: undefined;
			if (typeof sessionId !== 'string') {
				throw new Error(`Hermes did not create a session: ${JSON.stringify(created)}`);
			}
			this.providerSessionId = sessionId;
			this.acpSessionId =
				created && typeof created === 'object' && 'stored_session_id' in created
					? (created.stored_session_id as string)
					: sessionId;
		}
		this.forwardLine(JSON.stringify({ type: 'acp.init', sessionId: this.acpSessionId }));
		this.promptSent = true;
		await this.connection.request('prompt.submit', {
			session_id: this.providerSessionId,
			text: config.prompt ?? '',
			queued: false,
		});
	}

	private onNotification(record: NdJsonRecord): void {
		if (this.isSuperseded()) return;
		let method = record.method;
		let params = (record.params ?? {}) as Record<string, unknown>;
		if (method === 'event') {
			method = typeof params.type === 'string' ? params.type : '';
			params = (
				params.payload && typeof params.payload === 'object' ? params.payload : {}
			) as Record<string, unknown>;
		}
		if (method === 'request.cancel') {
			const nativeId = typeof params.id === 'string' ? params.id : undefined;
			const brokerId = nativeId ? this.pendingRequests.get(nativeId) : undefined;
			if (nativeId && brokerId) {
				this.pendingRequests.delete(nativeId);
				harnessInteractionBroker.withdraw(brokerId);
			}
			return;
		}
		switch (method) {
			case 'tool.start':
				this.forwardLine(
					JSON.stringify({
						type: 'acp.tool',
						toolCallId: params.tool_call_id ?? params.tool_id ?? params.id,
						toolName: params.tool ?? params.name,
						state: { status: 'running', input: params.preview ?? params.input ?? params.args },
					})
				);
				return;
			case 'tool.complete':
				this.forwardLine(
					JSON.stringify({
						type: 'acp.tool',
						toolCallId: params.tool_call_id ?? params.tool_id ?? params.id,
						toolName: params.tool ?? params.name,
						state: {
							status: params.error ? 'failed' : 'completed',
							output: params.preview ?? params.output ?? params.result,
						},
					})
				);
				return;
			case 'approval.request':
			case 'clarify.request':
			case 'secret.request':
			case 'sudo.request':
				void this.onGatewayInteraction(method, params);
				return;
			case 'approval.expire':
			case 'clarify.expire':
			case 'secret.expire':
			case 'sudo.expire': {
				const nativeId = typeof params.request_id === 'string' ? params.request_id : '';
				const brokerId = nativeId ? this.pendingRequests.get(nativeId) : undefined;
				if (nativeId && brokerId) {
					this.pendingRequests.delete(nativeId);
					harnessInteractionBroker.withdraw(brokerId);
				}
				return;
			}
			case 'message.delta':
				this.forwardLine(
					JSON.stringify({ type: 'acp.text', text: params.text ?? params.delta ?? '' })
				);
				return;
			case 'message.interim':
				if (params.already_streamed !== true) {
					this.forwardLine(JSON.stringify({ type: 'acp.text', text: params.text ?? '' }));
				}
				return;
			case 'session.usage':
				this.forwardUsage(params.usage);
				return;
			case 'message.complete':
				void this.onComplete(params);
				return;
			case 'message.error':
			case 'run.failed':
			case 'run.cancelled':
			case 'run.interrupted':
				this.forwardLine(JSON.stringify({ type: 'acp.error', message: params.error ?? method }));
				this.finish(1);
				this.turn.child.stdin?.end();
				return;
			default:
				this.forwardLine(JSON.stringify({ type: 'acp.system', update: record }));
		}
	}

	private async onComplete(params: Record<string, unknown>): Promise<void> {
		if (this.finished || this.isSuperseded()) return;
		const failed = params.status === 'error';
		this.forwardUsage(params.usage);
		this.completedText.push(String(params.output ?? params.final_response ?? params.text ?? ''));
		if (failed) {
			this.forwardLine(
				JSON.stringify({
					type: 'acp.result',
					sessionId: params.effective_session_id ?? this.acpSessionId,
					stopReason: 'error',
					text: this.completedText.join('\n\n'),
					usage: params.usage,
				})
			);
			this.forwardLine(
				JSON.stringify({
					type: 'acp.error',
					message: params.error ?? params.text ?? 'Hermes turn failed',
				})
			);
			this.finish(1);
			this.turn.child.stdin!.end();
			return;
		}
		try {
			const state = (await this.connection!.request('session.resume', {
				session_id: this.providerSessionId,
			})) as { running?: boolean; queued?: unknown };
			if (state.running || state.queued || params.pending_steer) {
				return;
			}
			this.forwardLine(
				JSON.stringify({
					type: 'acp.result',
					sessionId: params.effective_session_id ?? this.acpSessionId,
					stopReason: 'end_turn',
					text: this.completedText.join('\n\n'),
					usage: params.usage,
				})
			);
			this.finish(0);
			this.turn.child.stdin!.end();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (detail.includes('4007')) {
				this.forwardLine(
					JSON.stringify({
						type: 'acp.result',
						sessionId: params.effective_session_id ?? this.acpSessionId,
						stopReason: 'end_turn',
						text: this.completedText.join('\n\n'),
						usage: params.usage,
					})
				);
				this.finish(0);
				this.turn.child.stdin!.end();
				return;
			}
			if (detail.includes('4009') || detail.includes('session busy')) return;
			this.emitAgentError(error);
			this.finish(1);
			this.turn.child.stdin!.end();
		}
	}

	private async steer(request: { id: string; text: string }): Promise<SteeringResultFrame> {
		if (!this.connection || !this.providerSessionId || this.finished) {
			return {
				type: 'steering',
				id: request.id,
				verdict: 'refused',
				refusal: 'not-running',
				detail: 'That turn has already finished, so there is nothing to steer.',
			};
		}
		try {
			const result = await this.connection.request('session.steer', {
				session_id: this.providerSessionId,
				text: request.text,
			});
			if (
				!result ||
				typeof result !== 'object' ||
				!('status' in result) ||
				result.status !== 'queued'
			) {
				return {
					type: 'steering',
					id: request.id,
					verdict: 'refused',
					refusal: 'editor-unavailable',
					detail: `Hermes did not accept the steer: ${JSON.stringify(result)}`,
				};
			}
			return { type: 'steering', id: request.id, verdict: 'queued' };
		} catch (error) {
			return {
				type: 'steering',
				id: request.id,
				verdict: 'unknown',
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async onGatewayInteraction(
		method: string,
		params: Record<string, unknown>
	): Promise<void> {
		const nativeId = typeof params.request_id === 'string' ? params.request_id : '';
		if (!nativeId || !this.connection) return;
		const base = method.slice(0, -'.request'.length);
		if (base === 'approval') {
			void this.connection
				.request('approval.received', {
					session_id: this.providerSessionId,
					request_id: nativeId,
				})
				.catch(() => undefined);
		}
		try {
			const response = await this.onServerRequest({
				jsonrpc: '2.0',
				id: nativeId,
				method: base,
				params,
			});
			let value: Record<string, unknown>;
			if (response.kind === 'result' && response.value && typeof response.value === 'object') {
				value = response.value as Record<string, unknown>;
			} else if (base === 'approval') {
				value = { choice: 'deny' };
			} else if (base === 'clarify') {
				value = { answers: {} };
			} else {
				value = { value: '' };
			}
			if (base === 'sudo' && 'value' in value) {
				value = { password: value.value };
			}
			await this.connection.request(`${base}.respond`, {
				session_id: this.providerSessionId,
				request_id: nativeId,
				...value,
			});
		} catch (error) {
			logger.warn('[HermesTurn] Interaction response failed', LOG_CONTEXT, {
				sessionId: this.config.sessionId,
				method,
				error: String(error),
			});
		}
	}

	private async onServerRequest(record: NdJsonRecord): Promise<NdJsonServerResponse> {
		const method = typeof record.method === 'string' ? record.method : '';
		const params = (record.params ?? {}) as Record<string, unknown>;
		const nativeId =
			typeof record.id === 'string' || typeof record.id === 'number' ? String(record.id) : '';
		const options: HarnessInteractionOption[] = [];
		if (method === 'approval') {
			const choices = Array.isArray(params.choices) ? params.choices : ['once', 'deny'];
			for (const choice of choices) {
				if (choice === 'once')
					options.push({ optionId: 'once', label: 'Allow once', kind: 'allow-once' });
				else if (choice === 'session')
					options.push({
						optionId: 'session',
						label: 'Allow for this session',
						kind: 'allow-always',
					});
				else if (choice === 'always')
					options.push({ optionId: 'always', label: 'Always allow', kind: 'allow-always' });
				else if (choice === 'deny')
					options.push({ optionId: 'deny', label: 'Deny', kind: 'reject-once' });
			}
		} else if (method === 'clarify') {
			const questions = Array.isArray(params.questions) ? params.questions : [];
			for (const question of questions) {
				if (!question || typeof question !== 'object') continue;
				const q = question as Record<string, unknown>;
				const questionOptions = Array.isArray(q.options) ? q.options : [];
				for (const [index, option] of questionOptions.entries()) {
					if (typeof option === 'string') {
						options.push({
							optionId: `${String(q.id)}:option-${index}`,
							label: option,
							kind: 'choice',
						});
					}
				}
			}
			if (options.length === 0)
				options.push({ optionId: 'cancel', label: 'Cancel', kind: 'reject-once' });
		}
		if (method === 'approval' && this.config.permissionMode === 'full') {
			return { kind: 'result', value: { choice: 'once' } };
		}
		const opened = harnessInteractionBroker.open({
			sessionId: this.config.sessionId,
			tabId: this.config.tabId,
			spawnGeneration: this.managedProcess.spawnGeneration ?? 1,
			kind:
				method === 'approval' ? 'permission' : method === 'clarify' ? 'question' : 'elicitation',
			provider: 'hermes',
			title:
				typeof params.description === 'string' ? params.description : `Hermes ${method} request`,
			detail: typeof params.command === 'string' ? params.command : undefined,
			toolName: method,
			input: params,
			options,
			secret: method === 'secret' || method === 'sudo' || String(method).startsWith('vault'),
		});
		if (nativeId) this.pendingRequests.set(nativeId, opened.request.requestId);
		try {
			const resolution = await opened.completion;
			if (method === 'approval') {
				const choice = resolution.outcome === 'selected' ? resolution.optionId : 'deny';
				return { kind: 'result', value: { choice } };
			}
			if (method === 'clarify') {
				const answers: Record<string, string | string[]> = {};
				if (resolution.outcome === 'selected') {
					const optionId = resolution.optionId;
					for (const question of Array.isArray(params.questions) ? params.questions : []) {
						if (!question || typeof question !== 'object') continue;
						const q = question as Record<string, unknown>;
						if (typeof q.id !== 'string' || !optionId.startsWith(`${q.id}:option-`)) continue;
						const index = Number(optionId.slice(`${q.id}:option-`.length));
						const questionOptions = Array.isArray(q.options) ? q.options : [];
						if (typeof questionOptions[index] === 'string') answers[q.id] = questionOptions[index];
					}
				} else if (resolution.outcome === 'answers') {
					for (const question of Array.isArray(params.questions) ? params.questions : []) {
						if (!question || typeof question !== 'object') continue;
						const id = (question as Record<string, unknown>).id;
						if (typeof id !== 'string') continue;
						const selected = resolution.answers[id] ?? resolution.answers.answer;
						if (selected !== undefined) answers[id] = selected;
					}
				}
				return { kind: 'result', value: { answers } };
			}
			if (resolution.outcome === 'answers') {
				const value = resolution.answers.answer ?? Object.values(resolution.answers)[0] ?? '';
				return { kind: 'result', value: { value } };
			}
			return { kind: 'error', code: -32601, message: `${method} was cancelled by the user` };
		} finally {
			if (nativeId) this.pendingRequests.delete(nativeId);
		}
	}

	private forwardLine(line: string): void {
		if (this.isSuperseded()) return;
		this.ctx.stdoutHandler.handleData(this.config.sessionId, line + '\n');
	}

	private async interrupt(): Promise<void> {
		this.cancelled = true;
		if (this.connection && this.providerSessionId) {
			void this.connection
				.request('session.interrupt', { session_id: this.providerSessionId })
				.catch(() => undefined);
		}
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
		if (this.connection && this.providerSessionId) {
			void this.connection
				.request('session.interrupt', { session_id: this.providerSessionId })
				.catch(() => undefined);
		}
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

	private forwardUsage(raw: unknown): void {
		if (!raw || typeof raw !== 'object') return;
		const usage = raw as Record<string, unknown>;
		const input = typeof usage.input === 'number' ? usage.input : 0;
		const output = typeof usage.output === 'number' ? usage.output : 0;
		const inputDelta = Math.max(0, input - this.lastUsage.input);
		const outputDelta = Math.max(0, output - this.lastUsage.output);
		this.lastUsage = { input, output };
		this.forwardLine(
			JSON.stringify({
				type: 'acp.usage',
				usage: {
					inputTokens: inputDelta,
					outputTokens: outputDelta,
					contextUsed: usage.context_used,
					contextWindow: usage.context_max,
					costUsd: usage.cost,
				},
			})
		);
	}

	private handleRunError(error: unknown): void {
		if (this.finished || this.isSuperseded()) return;
		const canFallback = !this.promptSent;
		if (canFallback && this.config.permissionMode !== 'standard') {
			logger.warn('[HermesTurn] Native setup failed; using current transport', LOG_CONTEXT, {
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
				exit.spawnError ?? new Error(`Hermes backend exited with code ${exit.exitCode}`)
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
			message: `Hermes native transport error: ${error instanceof Error ? error.message : String(error)}`,
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
				logger.error('[HermesTurn] handleExit failed', LOG_CONTEXT, {
					sessionId: this.config.sessionId,
					error: String(error),
				});
			});
	}

	private isSuperseded(): boolean {
		return isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration);
	}
}
