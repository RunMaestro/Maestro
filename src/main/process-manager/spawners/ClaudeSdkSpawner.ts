import { EventEmitter } from 'events';
import {
	query,
	type CanUseTool,
	type Query,
	type SDKUserMessage,
	type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../utils/logger';
import { createOutputParser } from '../../parsers';
import { captureException } from '../../utils/sentry';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { StderrHandler } from '../handlers/StderrHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { buildChildProcessEnv } from '../utils/envBuilder';
import { nextSpawnGeneration, isSupersededGeneration } from '../generation';
import { harnessInteractionBroker } from '../../harness-control/integration';
import type { HarnessControlCapabilities } from '../../../shared/harness-control/types';
import type { SteeringResultFrame } from '../../../shared/chatSteering';
import { parseQuestionRequest } from '../../permission-relay/question-request';
import { encodeQuestionAnswer } from '../../../renderer/components/PermissionPrompt/questionAnswer';
import { isClaudeReadOnlyTool } from '../../../shared/maestro-lib/providers/claude-permissions';

const LOG_CONTEXT = 'ClaudeSdk';

interface ClaudeTurnContext {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	stdoutHandler: StdoutHandler;
	stderrHandler: StderrHandler;
	exitHandler: ExitHandler;
	fallbackToCli: (config: ProcessConfig) => SpawnResult;
}

export class ClaudeSdkSpawner {
	private readonly context: ClaudeTurnContext;

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
		if (config.toolType !== 'claude-code' || config.harnessControlMode !== 'native') {
			return this.fallbackToCli(config);
		}
		try {
			return new ClaudeTurn(this.context, config).start();
		} catch (error) {
			if (config.permissionMode === 'standard') {
				return {
					pid: -1,
					success: false,
					error: `Claude native mode could not start: ${String(error)}`,
				};
			}
			void captureException(error);
			return this.fallbackToCli(config);
		}
	}
}

class ClaudeTurn {
	private readonly managedProcess: ManagedProcess;
	private query?: Query;
	private promptSent = false;
	private cancelled = false;
	private finished = false;
	private resultCode = 0;
	private readonly closed = Promise.withResolvers<void>();
	private readonly messageQueue: SDKUserMessage[] = [];
	private queueClosed = false;
	private queueWaiter?: () => void;
	private followUpInFlight = false;
	private lastResult?: SDKResultMessage;
	private readonly completedResults: SDKResultMessage[] = [];
	private readonly capabilities: HarnessControlCapabilities = {
		protocol: 'claude-sdk',
		protocolVersion: 'streaming-input',
		steering: 'follow-up',
		permissionRequests: true,
		questions: true,
		elicitations: false,
		modelSwitch: true,
		modeSwitch: true,
		imagePrompts: true,
		resume: true,
	};

	constructor(
		private readonly ctx: ClaudeTurnContext,
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
	}

	start(): SpawnResult {
		const { sessionId } = this.config;
		this.managedProcess.spawnGeneration = nextSpawnGeneration(sessionId);
		this.ctx.processes.set(sessionId, this.managedProcess);
		void this.run().catch((error) => this.handleRunError(error));
		return { pid: -1, success: true };
	}

	private async run(): Promise<void> {
		const { config } = this;
		this.promptSent = true;
		const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
			if (config.permissionMode === 'readonly') {
				return isClaudeReadOnlyTool(toolName)
					? { behavior: 'allow', updatedInput: input }
					: { behavior: 'deny', message: 'Read-only mode denies this operation.' };
			}
			if (config.permissionMode !== 'standard') return { behavior: 'allow', updatedInput: input };
			if (signal.aborted)
				return { behavior: 'deny', message: 'Permission request was interrupted.' };
			const question = parseQuestionRequest(toolName, input);
			const opened = harnessInteractionBroker.open({
				sessionId: config.sessionId,
				tabId: config.tabId,
				spawnGeneration: this.managedProcess.spawnGeneration ?? 1,
				kind: question ? 'question' : 'permission',
				provider: 'claude-code',
				title: question ? 'Claude Code has a question' : `Claude Code wants to use ${toolName}`,
				toolName,
				input,
				options: question
					? []
					: [
							{ optionId: 'allow', label: 'Allow once', kind: 'allow-once' },
							{ optionId: 'deny', label: 'Deny', kind: 'reject-once' },
						],
				questions: question?.questions.map((item, index) => ({
					id: `question-${index}`,
					question: item.question,
					header: item.header,
					options: item.options.map((option, optionIndex) => ({
						optionId: `option-${optionIndex}`,
						label: option.label,
						kind: 'choice' as const,
						description: option.description,
					})),
					multiSelect: item.multiSelect,
					allowCustom: true,
				})),
			});
			const resolution = await opened.completion;
			if (question) {
				const selections = question.questions.map((_item, index) => {
					const answer =
						resolution.outcome === 'answers' ? resolution.answers[`question-${index}`] : undefined;
					return {
						selectedLabels: answer ? (Array.isArray(answer) ? answer : [answer]) : [],
						otherText:
							resolution.outcome === 'answers' && typeof resolution.answers.other === 'string'
								? resolution.answers.other
								: undefined,
					};
				});
				return { behavior: 'deny', message: encodeQuestionAnswer(question.questions, selections) };
			}
			if (resolution.outcome === 'selected' && resolution.optionId === 'allow') {
				return { behavior: 'allow', updatedInput: input };
			}
			return { behavior: 'deny', message: 'Denied by user.' };
		};
		this.query = query({
			prompt: this.inputMessages(),
			options: {
				cwd: config.cwd,
				resume: config.agentSessionId,
				model: config.modelId,
				effort: config.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
				permissionMode:
					config.permissionMode === 'full'
						? 'bypassPermissions'
						: config.permissionMode === 'readonly'
							? 'plan'
							: 'default',
				canUseTool,
				additionalDirectories: config.sessionAdditionalDirectories?.map((item) => item.path),
				pathToClaudeCodeExecutable: config.command,
				allowDangerouslySkipPermissions: config.permissionMode === 'full',
				systemPrompt: config.appendSystemPrompt
					? { type: 'preset', preset: 'claude_code', append: config.appendSystemPrompt }
					: undefined,
				env: buildChildProcessEnv(
					config.customEnvVars,
					!!config.agentSessionId,
					config.shellEnvVars,
					config.extraPathDirs,
					config.querySource
				),
			},
		});
		for await (const message of this.query) {
			if (this.isSuperseded()) break;
			if (message.type === 'result') {
				this.completedResults.push(message);
				this.lastResult = message;
				this.followUpInFlight = false;
				if (message.subtype !== 'success') this.resultCode = 1;
				if (
					this.messageQueue.length === 0 &&
					!this.followUpInFlight &&
					(message.queued_turn_count ?? 0) === 0
				) {
					this.queueClosed = true;
					this.queueWaiter?.();
					this.queueWaiter = undefined;
				}
				continue;
			}
			this.forwardLine(JSON.stringify(message));
		}
		if (this.lastResult) {
			const text = this.completedResults
				.map((result) => ('result' in result ? result.result : result.errors.join('\n')))
				.filter(Boolean)
				.join('\n\n');
			this.forwardLine(
				JSON.stringify(
					this.lastResult.subtype === 'success'
						? { ...this.lastResult, result: text }
						: this.lastResult
				)
			);
		}
		this.finish(this.cancelled ? 0 : this.resultCode);
	}

	private async *inputMessages(): AsyncGenerator<SDKUserMessage> {
		const initial: SDKUserMessage = {
			type: 'user',
			message: {
				role: 'user',
				content: this.config.prompt ?? '',
			},
			parent_tool_use_id: null,
		};
		if (this.config.images && this.config.images.length > 0) {
			initial.message.content = [
				{ type: 'text', text: this.config.prompt ?? '' },
				...this.config.images.map((image) => {
					const match = /^data:([^;]+);base64,(.+)$/.exec(image);
					if (!match) throw new Error('Invalid image payload');
					return {
						type: 'image' as const,
						source: {
							type: 'base64' as const,
							media_type: match[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
							data: match[2],
						},
					};
				}),
			];
		}
		yield initial;
		while (!this.queueClosed) {
			const next = this.messageQueue.shift();
			if (next) {
				this.followUpInFlight = true;
				yield next;
			} else {
				await new Promise<void>((resolve) => {
					this.queueWaiter = resolve;
				});
			}
		}
	}

	private async steer(request: { id: string; text: string }): Promise<SteeringResultFrame> {
		if (this.finished || this.queueClosed) {
			return {
				type: 'steering',
				id: request.id,
				verdict: 'refused',
				refusal: 'not-running',
				detail: 'That turn has already finished, so there is nothing to queue.',
			};
		}
		this.messageQueue.push({
			type: 'user',
			message: { role: 'user', content: request.text },
			parent_tool_use_id: null,
		});
		this.queueWaiter?.();
		this.queueWaiter = undefined;
		return { type: 'steering', id: request.id, verdict: 'queued' };
	}

	private forwardLine(line: string): void {
		if (this.isSuperseded()) return;
		this.ctx.stdoutHandler.handleData(this.config.sessionId, line + '\n');
	}

	private async interrupt(): Promise<void> {
		this.cancelled = true;
		try {
			await this.query?.interrupt();
		} catch {
			// close() below is still required.
		}
		this.query?.close();
	}

	private async close(): Promise<void> {
		this.cancelled = true;
		this.query?.close();
	}

	private handleRunError(error: unknown): void {
		if (this.finished || this.isSuperseded()) return;
		if (!this.promptSent) {
			logger.warn('[ClaudeTurn] Native setup failed; using current transport', LOG_CONTEXT, {
				sessionId: this.config.sessionId,
				error: String(error),
			});
			this.finished = true;
			if (this.ctx.processes.get(this.config.sessionId) === this.managedProcess) {
				this.ctx.processes.delete(this.config.sessionId);
				this.ctx.fallbackToCli(this.config);
			}
			return;
		}
		void captureException(error);
		this.emitAgentError(error);
		this.finish(1);
	}

	private emitAgentError(error: unknown): void {
		if (this.managedProcess.errorEmitted) return;
		this.managedProcess.errorEmitted = true;
		this.ctx.emitter.emit('agent-error', this.config.sessionId, {
			type: 'agent_crashed',
			message: `Claude native transport error: ${error instanceof Error ? error.message : String(error)}`,
			recoverable: true,
			agentId: this.config.toolType,
			sessionId: this.config.sessionId,
			timestamp: Date.now(),
		});
	}

	private finish(code: number): void {
		if (this.finished) return;
		this.finished = true;
		this.queueClosed = true;
		this.queueWaiter?.();
		this.queueWaiter = undefined;
		this.query?.close();
		this.closed.resolve();
		void this.ctx.exitHandler
			.handleExit(this.config.sessionId, code, this.managedProcess)
			.catch((error) => {
				logger.error('[ClaudeTurn] handleExit failed', LOG_CONTEXT, {
					sessionId: this.config.sessionId,
					error: String(error),
				});
			});
	}

	private isSuperseded(): boolean {
		return isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration);
	}
}
