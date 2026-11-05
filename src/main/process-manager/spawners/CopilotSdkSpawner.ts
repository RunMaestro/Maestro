import { EventEmitter } from 'events';
import {
	approveAll,
	type CopilotSession,
	type ElicitationContext,
	type PermissionRequest,
	type SessionEvent,
} from '@github/copilot-sdk';
import { logger } from '../../utils/logger';
import { withWorktreeTurnActivity } from '../../git/worktreeTurnActivity';
import { createOutputParser } from '../../parsers';
import { captureException } from '../../utils/sentry';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { StderrHandler } from '../handlers/StderrHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { nextSpawnGeneration, isSupersededGeneration } from '../generation';
import { harnessInteractionBroker } from '../../harness-control/integration';
import { CopilotConnectionManager, type CopilotConnectionLease } from './CopilotConnectionManager';
import { AcpOutputParser } from '../../../shared/maestro-lib/harness/acp/output-parser';
import type { HarnessControlCapabilities } from '../../../shared/harness-control/types';
import type { SteeringResultFrame } from '../../../shared/chatSteering';
import type { ToolType } from '../../../shared/types';
import {
	copilotElicitationQuestions,
	copilotElicitationResult,
} from '../../../shared/maestro-lib/harness/copilot/elicitation';

const LOG_CONTEXT = 'CopilotSdk';
interface CopilotUserInputRequest {
	question: string;
	choices?: string[];
	allowFreeform?: boolean;
}

interface CopilotTurnContext {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	stdoutHandler: StdoutHandler;
	stderrHandler: StderrHandler;
	exitHandler: ExitHandler;
	fallbackToCli: (config: ProcessConfig) => SpawnResult;
	connections: CopilotConnectionManager;
	leasesBySession: Map<string, CopilotConnectionLease>;
}

export class CopilotSdkSpawner {
	private readonly context: CopilotTurnContext;

	constructor(
		processes: Map<string, ManagedProcess>,
		emitter: EventEmitter,
		bufferManager: DataBufferManager,
		private readonly fallbackToCli: (config: ProcessConfig) => SpawnResult,
		connections = new CopilotConnectionManager()
	) {
		const leasesBySession = new Map<string, CopilotConnectionLease>();
		this.context = {
			processes,
			emitter,
			stdoutHandler: new StdoutHandler({ processes, emitter, bufferManager }),
			stderrHandler: new StderrHandler({ processes, emitter }),
			exitHandler: new ExitHandler({ processes, emitter, bufferManager }),
			fallbackToCli,
			connections,
			leasesBySession,
		};
	}

	async closeAll(): Promise<void> {
		return withWorktreeTurnActivity(
			(_start, observe) => {
				this.context.leasesBySession.clear();
				return observe(this.context.connections.closeAll());
			},
			(error) => captureException(error)
		);
	}

	closeAgent(agentId: string): void {
		withWorktreeTurnActivity(
			(_start, observe) => {
				for (const [sessionId, lease] of this.context.leasesBySession) {
					if (lease.agentId === agentId) this.context.leasesBySession.delete(sessionId);
				}
				observe(this.context.connections.closeAgent(agentId));
			},
			(error) => captureException(error)
		);
	}

	closeSession(sessionId: string): boolean {
		return withWorktreeTurnActivity(
			(_start, observe) => {
				const lease = this.context.leasesBySession.get(sessionId);
				if (!lease || lease.refs > 0 || lease.closed) return false;
				this.context.leasesBySession.delete(sessionId);
				observe(this.context.connections.close(lease));
				return true;
			},
			(error) => captureException(error)
		);
	}

	spawn(config: ProcessConfig): SpawnResult {
		try {
			return withWorktreeTurnActivity(
				(_start, observe) => this.spawnAdmitted(config, observe),
				(error) => captureException(error)
			);
		} catch (error) {
			return { pid: -1, success: false, error: String(error) };
		}
	}

	private spawnAdmitted(
		config: ProcessConfig,
		observe: <T>(completion: Promise<T>) => Promise<T>
	): SpawnResult {
		if (config.toolType !== 'copilot-cli' || config.harnessControlMode !== 'native') {
			return this.fallbackToCli(config);
		}
		try {
			return new CopilotTurn(this.context, config, observe).start();
		} catch (error) {
			if (config.permissionMode === 'standard') {
				return {
					pid: -1,
					success: false,
					error: `Copilot native mode could not start: ${String(error)}`,
				};
			}
			observe(
				Promise.resolve()
					.then(() => captureException(error))
					.catch(() => {})
			);
			return this.fallbackToCli(config);
		}
	}
}

class CopilotTurn {
	private readonly managedProcess: ManagedProcess;
	private lease?: CopilotConnectionLease;
	private session?: CopilotSession;
	private unsubscribe?: () => void;
	private promptSent = false;
	private cancelled = false;
	private finished = false;
	private finalizing = false;
	private readonly completion = Promise.withResolvers<void>();
	private sawMessageDelta = false;
	private readonly closed = Promise.withResolvers<void>();
	private readonly capabilities: HarnessControlCapabilities = {
		protocol: 'copilot-sdk',
		protocolVersion: 'jsonrpc',
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
		private readonly ctx: CopilotTurnContext,
		private readonly config: ProcessConfig,
		private readonly observe: <T>(completion: Promise<T>) => Promise<T>
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
			skipCopilotShutdownWait: true,
			sdkController: {
				interrupt: () => this.withActivity((observe) => this.interrupt(observe)).catch(() => {}),
				kill: () => this.withActivity((observe) => this.close(observe)).catch(() => {}),
			},
			harnessControl: {
				getCapabilities: () => this.capabilities,
				closed: this.closed.promise,
				steer: (request) => this.withActivity(() => this.steer(request)),
				interrupt: () => this.withActivity((observe) => this.interrupt(observe)),
				close: () => this.withActivity((observe) => this.close(observe)),
			},
		};
	}

	start(): SpawnResult {
		const { sessionId } = this.config;
		this.managedProcess.spawnGeneration = nextSpawnGeneration(sessionId);
		this.ctx.processes.set(sessionId, this.managedProcess);
		// send() acknowledgement does not end the event turn. Keep this promise
		// through idle/cancel/error reporting independently of manager ownership.
		this.observe(this.completion.promise);
		this.observe(this.run().catch((error) => this.handleRunError(error)));
		return { pid: -1, success: true };
	}

	private async run(): Promise<void> {
		const { config } = this;
		if ((config.images?.length ?? 0) > 0) {
			throw new Error('Copilot native mode does not support image prompts yet');
		}
		const lease = await this.ctx.connections.acquire(config, {
			onPermissionRequest: (request, invocation) =>
				this.withActivity(async () =>
					config.permissionMode === 'full'
						? approveAll(request, invocation)
						: config.permissionMode === 'readonly'
							? this.approveReadOnly(request)
							: this.approve(request)
				),
			onUserInputRequest: (request: CopilotUserInputRequest) =>
				this.withActivity(() => this.answerQuestion(request)),
			onElicitationRequest: (request: ElicitationContext) =>
				this.withActivity(() => this.answerElicitation(request)),
		});
		if (this.cancelled || this.finished || this.isSuperseded()) {
			await this.ctx.connections.close(lease);
			await this.finish(0);
			this.closed.resolve();
			return;
		}
		this.lease = lease;
		for (const [sessionId, current] of this.ctx.leasesBySession) {
			if (current === lease && sessionId !== config.sessionId) {
				this.ctx.leasesBySession.delete(sessionId);
			}
		}
		this.ctx.leasesBySession.set(config.sessionId, lease);
		this.session = lease.session;
		this.managedProcess.agentSessionId = this.session.sessionId;
		this.forwardLine(JSON.stringify({ type: 'acp.init', sessionId: this.session.sessionId }));
		this.unsubscribe = this.session.on((event) => {
			// The admitted boundary reports failures; refusal must stay side-effect free.
			void this.withActivity(async () => this.onEvent(event)).catch(() => {});
		});
		this.promptSent = true;
		await this.session.send({ prompt: config.prompt ?? '', mode: 'enqueue' });
	}

	private onEvent(event: SessionEvent): void {
		if (this.finished || this.isSuperseded()) return;
		switch (event.type) {
			case 'session.usage_info':
				this.forwardLine(
					JSON.stringify({
						type: 'acp.usage',
						usage: {
							contextUsed: event.data.currentTokens,
							contextWindow: event.data.tokenLimit,
						},
					})
				);
				return;
			case 'assistant.usage':
				this.forwardLine(
					JSON.stringify({
						type: 'acp.usage',
						usage: {
							inputTokens: event.data.inputTokens,
							outputTokens: event.data.outputTokens,
							cacheReadTokens: event.data.cacheReadTokens,
							cacheCreationTokens: event.data.cacheWriteTokens,
							reasoningTokens: event.data.reasoningTokens,
							contextWindow: event.data.maxPromptTokens,
							costUsd: event.data.cost,
						},
					})
				);
				return;
			case 'assistant.message_delta':
				this.sawMessageDelta = true;
				this.forwardLine(JSON.stringify({ type: 'acp.text', text: event.data.deltaContent }));
				return;
			case 'assistant.message':
				if (!this.sawMessageDelta && event.data.content) {
					this.forwardLine(JSON.stringify({ type: 'acp.text', text: event.data.content }));
				}
				return;
			case 'tool.execution_start':
				this.forwardLine(
					JSON.stringify({
						type: 'acp.tool',
						toolCallId: event.data.toolCallId,
						toolName: event.data.toolName,
						state: { status: 'running', input: event.data.arguments },
					})
				);
				return;
			case 'tool.execution_complete':
				this.forwardLine(
					JSON.stringify({
						type: 'acp.tool',
						toolCallId: event.data.toolCallId,
						state: {
							status: event.data.success ? 'completed' : 'failed',
							output: event.data.result?.content ?? event.data.error,
						},
					})
				);
				return;
			case 'session.error':
				this.forwardLine(JSON.stringify({ type: 'acp.error', message: event.data.message }));
				return;
			case 'session.idle':
				this.sawMessageDelta = false;
				void this.finish(this.cancelled ? 0 : 0);
				return;
			default:
				this.forwardLine(JSON.stringify({ type: 'acp.system', update: event }));
		}
	}

	private approveReadOnly(request: PermissionRequest) {
		return request.kind === 'read'
			? ({ kind: 'approve-once' } as const)
			: ({ kind: 'reject', feedback: 'Read-only mode denies this operation.' } as const);
	}

	private async approve(request: PermissionRequest) {
		const opened = harnessInteractionBroker.open({
			sessionId: this.config.sessionId,
			tabId: this.config.tabId,
			spawnGeneration: this.managedProcess.spawnGeneration ?? 1,
			kind: 'permission',
			provider: 'copilot-cli',
			title: `Copilot requests ${request.kind} permission`,
			detail:
				'fullCommandText' in request && typeof request.fullCommandText === 'string'
					? request.fullCommandText
					: undefined,
			toolName: request.kind,
			input: request as unknown as Record<string, unknown>,
			options: [
				{ optionId: 'allow', label: 'Allow once', kind: 'allow-once' },
				{ optionId: 'deny', label: 'Deny', kind: 'reject-once' },
			],
		});
		const resolution = await opened.completion;
		return resolution.outcome === 'selected' && resolution.optionId === 'allow'
			? ({ kind: 'approve-once' } as const)
			: ({ kind: 'reject', feedback: 'Denied by user.' } as const);
	}

	private async answerQuestion(request: CopilotUserInputRequest) {
		const opened = harnessInteractionBroker.open({
			sessionId: this.config.sessionId,
			tabId: this.config.tabId,
			spawnGeneration: this.managedProcess.spawnGeneration ?? 1,
			kind: 'question',
			provider: 'copilot-cli',
			title: request.question,
			options: [],
			questions: [
				{
					id: 'answer',
					question: request.question,
					allowCustom: request.allowFreeform !== false,
					options: (request.choices ?? []).map((choice, index) => ({
						optionId: `choice-${index}`,
						label: choice,
						kind: 'choice' as const,
					})),
				},
			],
		});
		const resolution = await opened.completion;
		const answer = resolution.outcome === 'answers' ? resolution.answers.answer : undefined;
		const text = Array.isArray(answer) ? answer.join(', ') : answer || '';
		return {
			answer: text,
			wasFreeform: !(request.choices ?? []).includes(text),
		};
	}

	private async answerElicitation(request: ElicitationContext) {
		const questions = copilotElicitationQuestions(request);
		const opened = harnessInteractionBroker.open({
			sessionId: this.config.sessionId,
			tabId: this.config.tabId,
			spawnGeneration: this.managedProcess.spawnGeneration ?? 1,
			kind: 'elicitation',
			provider: 'copilot-cli',
			title: request.message,
			options: [],
			questions,
		});
		const resolution = await opened.completion;
		return copilotElicitationResult(request, resolution);
	}

	private async steer(request: { id: string; text: string }): Promise<SteeringResultFrame> {
		if (!this.session || this.finished) {
			return {
				type: 'steering',
				id: request.id,
				verdict: 'refused',
				refusal: 'not-running',
				detail: 'That turn has already finished, so there is nothing to steer.',
			};
		}
		try {
			await this.session.send({ prompt: request.text, mode: 'immediate' });
			return { type: 'steering', id: request.id, verdict: 'delivered' };
		} catch (error) {
			return {
				type: 'steering',
				id: request.id,
				verdict: 'unknown',
				detail: String(error),
			};
		}
	}

	private forwardLine(line: string): void {
		if (this.isSuperseded()) return;
		this.ctx.stdoutHandler.handleData(this.config.sessionId, line + '\n');
	}

	private async interrupt(observe: typeof this.observe): Promise<void> {
		this.cancelled = true;
		if (this.session) observe(this.session.abort().catch(() => undefined));
	}

	private async close(observe: typeof this.observe): Promise<void> {
		this.cancelled = true;
		if (this.session) observe(this.session.abort().catch(() => undefined));
		if (this.lease) await this.ctx.connections.close(this.lease);
		this.ctx.leasesBySession.delete(this.config.sessionId);
		this.closed.resolve();
		await this.finish(0);
	}

	private handleRunError(error: unknown): void {
		if (this.finished || this.isSuperseded()) return;
		if (this.cancelled) {
			void this.finish(0);
			return;
		}
		if (!this.promptSent && this.config.permissionMode !== 'standard') {
			logger.warn('[CopilotTurn] Native setup failed; using current transport', LOG_CONTEXT, {
				sessionId: this.config.sessionId,
				error: String(error),
			});
			this.finished = true;
			if (this.lease) this.observe(this.ctx.connections.close(this.lease));
			this.ctx.leasesBySession.delete(this.config.sessionId);
			if (this.ctx.processes.get(this.config.sessionId) === this.managedProcess) {
				this.ctx.processes.delete(this.config.sessionId);
				this.ctx.fallbackToCli(this.config);
			}
			this.completion.resolve();
			return;
		}
		this.observe(
			Promise.resolve()
				.then(() => captureException(error))
				.catch(() => {})
		);
		this.emitAgentError(error);
		void this.finish(1);
	}

	private emitAgentError(error: unknown): void {
		if (this.managedProcess.errorEmitted) return;
		this.managedProcess.errorEmitted = true;
		this.ctx.emitter.emit('agent-error', this.config.sessionId, {
			type: 'agent_crashed',
			message: `Copilot native transport error: ${error instanceof Error ? error.message : String(error)}`,
			recoverable: true,
			agentId: this.config.toolType,
			sessionId: this.config.sessionId,
			timestamp: Date.now(),
		});
	}

	private finish(code: number): Promise<void> {
		if (this.finalizing) return this.completion.promise;
		this.finalizing = true;
		this.finished = true;
		return this.observe(
			(async () => {
				this.unsubscribe?.();
				this.unsubscribe = undefined;
				if (this.lease) this.ctx.connections.release(this.lease);
				await this.ctx.exitHandler.handleExit(this.config.sessionId, code, this.managedProcess);
			})().finally(() => this.completion.resolve())
		);
	}

	private async withActivity<T>(
		operation: (observe: typeof this.observe) => Promise<T>
	): Promise<T> {
		// SDK callbacks and retained controls can outlive the original turn hold.
		return withWorktreeTurnActivity(
			(_start, observe) => observe(operation(observe)),
			(error) => captureException(error)
		);
	}

	private isSuperseded(): boolean {
		return isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration);
	}
}
