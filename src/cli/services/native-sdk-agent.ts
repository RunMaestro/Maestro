import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import {
	CopilotClient,
	RuntimeConnection,
	approveAll,
	type CopilotSession,
	type ElicitationContext,
	type PermissionRequest,
	type SessionEvent,
} from '@github/copilot-sdk';
import { InteractionBroker } from '../../main/harness-control/InteractionBroker';
import { TurnCapture } from '../../shared/maestro-lib/run/turn-capture';
import { createOutputParser } from '../../shared/maestro-lib/parsers/parser-factory';
import { AcpOutputParser } from '../../shared/maestro-lib/harness/acp/output-parser';
import { parseQuestionRequest } from '../../main/permission-relay/question-request';
import { buildChildProcessEnv } from '../../shared/maestro-lib/launch/env';
import { encodeQuestionAnswer } from '../../renderer/components/PermissionPrompt/questionAnswer';
import { resolveCliTurnResult, interruptedResult, spawnFailureResult } from './turn-result';
import type { AgentResult, SpawnAgentOptions } from './agent-spawner';
import type { ToolType } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from '../../main/parsers/agent-output-parser';
import type { HarnessInteractionOption } from '../../shared/harness-control/types';
import {
	buildAgentLaunchPlan,
	describeUndeliveredSecrets,
} from '../../shared/maestro-lib/launch/launch-plan';
import { readAgentConfig } from './storage';
import { resolveCopilotRuntimeExecutable } from '../../shared/maestro-lib/providers/copilot-runtime';
import { findPackagedAppHost } from '../../shared/maestro-lib/launch/interactive-mode';
import { embedSystemPromptInPrompt } from '../../shared/embeddedSystemPrompt';
import * as acp from '@agentclientprotocol/sdk';
import { acpStdioStream } from '../../main/process-manager/spawners/acp-stdio';
import { AcpEventTranslator } from '../../shared/maestro-lib/harness/acp/events';
import {
	acpPermissionOpenRequest,
	acpPermissionResponse,
} from '../../shared/maestro-lib/harness/acp/interactions';
import {
	buildNativeAcpBaseArgs,
	buildNativeRpcBaseArgs,
	nativeRpcProtocol,
	supportsAcpNativeControl,
} from '../../shared/maestro-lib/providers/native-control';
import { getAgentDefinition } from '../../shared/maestro-lib/providers/definitions';
import { applyAgentConfigOverrides } from '../../shared/maestro-lib/launch/agent-args';
import { startTurn } from '../../shared/maestro-lib/run/start-turn';
import { planSpawnShell } from '../../main/process-manager/utils/windowsSpawnShell';
import { NdJsonConnection } from '../../shared/maestro-lib/harness/rpc/connection';
import { answerRpcExtensionRequestWithBroker } from '../../main/harness-control/rpc-interactions';
import {
	stopProcess,
	INTERACTIVE_STOP_GRACE_MS,
} from '../../shared/maestro-lib/control/termination';
import { isClaudeReadOnlyTool } from '../../shared/maestro-lib/providers/claude-permissions';
import { ANTIGRAVITY_SDK_SIDECAR } from '../../main/process-manager/spawners/antigravitySdkSidecar';
import { resolveHermesGatewayLaunch } from '../../shared/maestro-lib/providers/hermes-launch';
import type { AgentConfig } from '../../main/agents';
import {
	copilotElicitationQuestions,
	copilotElicitationResult,
} from '../../shared/maestro-lib/harness/copilot/elicitation';

function launchDefinition(
	definition: NonNullable<ReturnType<typeof getAgentDefinition>>
): AgentConfig {
	return { ...definition, available: true, capabilities: {} as AgentConfig['capabilities'] };
}
interface NativePreparation {
	env: NodeJS.ProcessEnv;
	prompt: string;
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
	);
}
const NATIVE_SDK_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function prepareNativeLaunch(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	options: SpawnAgentOptions,
	command: string
): NativePreparation | { error: string } {
	const stored = readAgentConfig(toolType);
	const agentCustomEnvVars =
		stored.customEnvVars && typeof stored.customEnvVars === 'object'
			? (stored.customEnvVars as Record<string, string>)
			: undefined;
	const result = buildAgentLaunchPlan({
		surface: 'cli',
		agent: getAgentDefinition(toolType),
		command,
		args: [],
		cwd,
		prompt,
		batchMode: true,
		agentCustomEnvVars,
		sessionCustomEnvVars: options.customEnvVars,
		isResuming: !!agentSessionId,
		querySource: options.querySource,
		requiredSecrets: options.requiredSecrets,
	});
	if (options.customEffort && !NATIVE_SDK_EFFORTS.has(options.customEffort)) {
		return { error: `Native SDK does not support effort '${options.customEffort}'` };
	}
	if (!result.ok) return { error: result.error };
	const warning = describeUndeliveredSecrets(toolType, result.plan.secrets);
	if (warning) console.error(`[maestro-cli] ${warning}`);
	const secretEnv = Object.fromEntries(
		(result.plan.secrets?.injected ?? []).flatMap(({ name }) => {
			const value = result.plan.env?.[name];
			return typeof value === 'string' ? [[name, value]] : [];
		})
	);
	const explicitOverrides = {
		...stringEnvironment(result.plan.envVars ?? {}),
		...secretEnv,
	};
	const environment = options.globalEnvVars
		? buildChildProcessEnv(
				explicitOverrides,
				!!agentSessionId,
				options.globalEnvVars,
				undefined,
				options.querySource
			)
		: (result.plan.env ?? {});
	return {
		env: environment,
		prompt:
			options.appendSystemPrompt &&
			!agentSessionId &&
			toolType !== 'claude-code' &&
			toolType !== 'copilot-cli'
				? embedSystemPromptInPrompt(options.appendSystemPrompt, prompt)
				: prompt,
	};
}

function ownerBroker(options: SpawnAgentOptions): InteractionBroker {
	const broker = new InteractionBroker({
		onRequest: (request) => {
			if (!options.onHarnessInteraction) return false;
			void Promise.resolve(options.onHarnessInteraction(request))
				.then((resolution) => broker.resolve({ requestId: request.requestId, ...resolution }))
				.catch(() => broker.withdraw(request.requestId, 'owner-unavailable'));
			return true;
		},
		onSettled: () => {},
	});
	return broker;
}
const NATIVE_TIMEOUT = Symbol('native-timeout');
const NATIVE_ABORTED = Symbol('native-aborted');
const NATIVE_TEARDOWN_GRACE_MS = 5_000;

async function withNativeTimeout(
	options: SpawnAgentOptions,
	run: (options: SpawnAgentOptions) => Promise<AgentResult>
): Promise<AgentResult> {
	const controller = new AbortController();
	let resolveAborted!: (value: typeof NATIVE_ABORTED) => void;
	const abortedResult = new Promise<typeof NATIVE_ABORTED>((resolve) => {
		resolveAborted = resolve;
	});
	let timeoutTimer: NodeJS.Timeout | undefined;
	let abortFallbackTimer: NodeJS.Timeout | undefined;
	let timeoutCleanupTimer: NodeJS.Timeout | undefined;
	const forwardAbort = () => {
		controller.abort();
		abortFallbackTimer = setTimeout(() => resolveAborted(NATIVE_ABORTED), NATIVE_TEARDOWN_GRACE_MS);
		abortFallbackTimer.unref?.();
	};
	options.signal?.addEventListener('abort', forwardAbort, { once: true });
	const operation = run({ ...options, signal: controller.signal });
	const timeout = options.timeoutMs;
	let timedOut = false;
	const timeoutResult = new Promise<typeof NATIVE_TIMEOUT>((resolve) => {
		if (timeout && timeout > 0) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				timeoutCleanupTimer = setTimeout(() => resolve(NATIVE_TIMEOUT), NATIVE_TEARDOWN_GRACE_MS);
				timeoutCleanupTimer.unref?.();
			}, timeout);
			timeoutTimer.unref?.();
		}
	});
	try {
		const result = await Promise.race([operation, timeoutResult, abortedResult]);
		if (result === NATIVE_TIMEOUT) {
			void operation.catch(() => undefined);
			return spawnFailureResult(`Native turn timed out after ${timeout}ms`);
		}
		if (result === NATIVE_ABORTED) {
			void operation.catch(() => undefined);
			return interruptedResult();
		}
		if (timedOut) {
			return {
				...result,
				success: false,
				outcome: 'crashed',
				error: `Native turn timed out after ${timeout}ms`,
			};
		}
		return result;
	} finally {
		clearTimeout(timeoutTimer);
		clearTimeout(abortFallbackTimer);
		clearTimeout(timeoutCleanupTimer);
		options.signal?.removeEventListener('abort', forwardAbort);
	}
}

function captureEvent(
	capture: TurnCapture,
	parser: AgentOutputParser,
	record: unknown
): ParsedEvent | null {
	const event = parser.parseJsonObject(record);
	if (event) capture.handleEvent(event);
	return event;
}

function settleNativeResult(
	toolType: ToolType,
	parser: AgentOutputParser,
	capture: TurnCapture,
	exitCode: number,
	error?: unknown,
	interrupted = false
): AgentResult {
	return resolveCliTurnResult({
		toolType,
		provider: parser,
		exitCode,
		stderrText: error ? String(error) : '',
		stdoutText: '',
		errorText: capture.errorText ?? (error ? String(error) : undefined),
		signal: null,
		interrupted,
		answerText: capture.answerText,
		resultMessageSeen: capture.resultMessageSeen,
		agentSessionId: capture.sessionId,
		usageStats: capture.usage,
		strictEmptyAnswer: true,
		answerOutranksBareExit: true,
	});
}

/** Execute one local native turn with owner-scoped approvals, usage capture, and bounded cleanup. */
export async function spawnNativeSdkAgent(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	options: SpawnAgentOptions,
	command: string
): Promise<AgentResult> {
	if (options.signal?.aborted) return interruptedResult();
	return withNativeTimeout(options, async (nativeOptions) => {
		const prepared = prepareNativeLaunch(
			toolType,
			cwd,
			prompt,
			agentSessionId,
			nativeOptions,
			command
		);
		if ('error' in prepared) return spawnFailureResult(prepared.error);
		const effectivePrompt = prepared.prompt;
		if (toolType === 'claude-code') {
			return spawnClaudeNative(
				cwd,
				effectivePrompt,
				agentSessionId,
				nativeOptions,
				command,
				prepared.env
			);
		}
		if (toolType === 'copilot-cli') {
			return spawnCopilotNative(
				cwd,
				effectivePrompt,
				agentSessionId,
				nativeOptions,
				command,
				prepared.env
			);
		}
		if (toolType === 'antigravity') {
			return spawnAntigravityNative(
				cwd,
				effectivePrompt,
				agentSessionId,
				nativeOptions,
				prepared.env
			);
		}
		if (toolType === 'hermes') {
			return spawnHermesNative(
				cwd,
				effectivePrompt,
				agentSessionId,
				nativeOptions,
				command,
				prepared.env
			);
		}
		if (supportsAcpNativeControl(toolType)) {
			return spawnAcpNative(
				toolType,
				cwd,
				effectivePrompt,
				agentSessionId,
				nativeOptions,
				command,
				prepared.env
			);
		}
		if (nativeRpcProtocol(toolType)) {
			return spawnRpcNative(
				toolType,
				cwd,
				effectivePrompt,
				agentSessionId,
				nativeOptions,
				command,
				prepared.env
			);
		}
		return spawnFailureResult(`Native CLI control is not available for ${toolType}`);
	});
}

async function spawnClaudeNative(
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	options: SpawnAgentOptions,
	command: string,
	nativeEnv: NodeJS.ProcessEnv
): Promise<AgentResult> {
	const parser = createOutputParser('claude-code');
	if (!parser) return spawnFailureResult('No Claude output parser is registered');
	const capture = new TurnCapture('claude-code', parser, { classifyInBandErrors: false });
	const broker = ownerBroker(options);
	const abortController = new AbortController();
	const abort = () => abortController.abort();
	options.signal?.addEventListener('abort', abort, { once: true });
	let exitCode = 0;
	let failure: unknown;
	const canUseTool: CanUseTool = async (toolName, input) => {
		if (options.readOnlyMode || options.permissionMode === 'readonly') {
			return isClaudeReadOnlyTool(toolName)
				? { behavior: 'allow', updatedInput: input }
				: { behavior: 'deny', message: 'Read-only mode denies this operation.' };
		}
		if (options.permissionMode !== 'standard') {
			return { behavior: 'allow', updatedInput: input };
		}
		const question = parseQuestionRequest(toolName, input);
		const opened = broker.open({
			sessionId: options.nativeSessionId ?? `cli-claude-${Date.now()}`,
			tabId: options.nativeTabId,
			spawnGeneration: 1,
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
		return resolution.outcome === 'selected' && resolution.optionId === 'allow'
			? { behavior: 'allow', updatedInput: input }
			: { behavior: 'deny', message: 'Denied by user.' };
	};
	const nativeQuery = query({
		prompt,
		options: {
			cwd,
			resume: agentSessionId,
			model: options.customModel,
			effort: options.customEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
			env: nativeEnv,
			abortController,
			permissionMode:
				options.readOnlyMode || options.permissionMode === 'readonly'
					? 'plan'
					: options.permissionMode === 'standard'
						? 'default'
						: 'bypassPermissions',
			canUseTool,
			additionalDirectories: options.additionalDirectories?.map((item) => item.path),
			pathToClaudeCodeExecutable: command,
			allowDangerouslySkipPermissions:
				!options.readOnlyMode &&
				options.permissionMode !== 'standard' &&
				options.permissionMode !== 'readonly',
			systemPrompt: options.appendSystemPrompt
				? { type: 'preset', preset: 'claude_code', append: options.appendSystemPrompt }
				: undefined,
		},
	});
	try {
		for await (const message of nativeQuery) {
			captureEvent(capture, parser, message);
			if (message.type === 'result' && message.subtype !== 'success') exitCode = 1;
		}
	} catch (error) {
		exitCode = 1;
		failure = error;
	} finally {
		options.signal?.removeEventListener('abort', abort);
		nativeQuery.close();
		broker.closeAll();
	}
	if (options.signal?.aborted)
		return settleNativeResult('claude-code', parser, capture, exitCode, failure, true);
	return settleNativeResult('claude-code', parser, capture, exitCode, failure);
}

async function spawnCopilotNative(
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	options: SpawnAgentOptions,
	command: string,
	nativeEnv: NodeJS.ProcessEnv
): Promise<AgentResult> {
	const fallback = createOutputParser('copilot-cli');
	if (!fallback) return spawnFailureResult('No Copilot output parser is registered');
	const parser = new AcpOutputParser('copilot-cli', fallback);
	const capture = new TurnCapture('copilot-cli', parser, { classifyInBandErrors: false });
	const broker = ownerBroker(options);
	const client = new CopilotClient({
		connection: RuntimeConnection.forStdio({
			path: resolveCopilotRuntimeExecutable(
				command,
				process.resourcesPath ?? findPackagedAppHost(__dirname)?.resourcesPath
			),
		}),
		workingDirectory: cwd,
		env: nativeEnv,
		logLevel: 'error',
	});
	let session: CopilotSession | undefined;
	let exitCode = 0;
	let failure: unknown;
	let sawMessageDelta = false;
	let unsubscribe: (() => void) | undefined;
	const abort = () => {
		void session?.abort().catch(() => undefined);
		void client.forceStop().catch(() => undefined);
	};
	options.signal?.addEventListener('abort', abort, { once: true });
	if (options.signal?.aborted) abort();
	try {
		await client.start();
		const sessionConfig = {
			model: options.customModel,
			reasoningEffort: options.customEffort as
				| 'low'
				| 'medium'
				| 'high'
				| 'xhigh'
				| 'max'
				| undefined,
			workingDirectory: cwd,
			streaming: true,
			onPermissionRequest:
				options.readOnlyMode || options.permissionMode === 'readonly'
					? (request: PermissionRequest) =>
							request.kind === 'read'
								? ({ kind: 'approve-once' } as const)
								: ({ kind: 'reject', feedback: 'Read-only mode denies this operation.' } as const)
					: options.permissionMode === 'standard'
						? (request: PermissionRequest) => approveCopilot(request, broker, options)
						: approveAll,
			onElicitationRequest: (request: ElicitationContext) =>
				answerCopilotElicitation(request, broker, options),
			onUserInputRequest: (request: {
				question: string;
				choices?: string[];
				allowFreeform?: boolean;
			}) => answerCopilotQuestion(request, broker, options),
			systemMessage: options.appendSystemPrompt
				? { mode: 'append' as const, content: options.appendSystemPrompt }
				: undefined,
		};
		session = agentSessionId
			? await client.resumeSession(agentSessionId, sessionConfig)
			: await client.createSession(sessionConfig);
		captureEvent(capture, parser, { type: 'acp.init', sessionId: session.sessionId });
		const idle = Promise.withResolvers<void>();
		unsubscribe = session.on((event: SessionEvent) => {
			switch (event.type) {
				case 'session.usage_info':
					captureEvent(capture, parser, {
						type: 'acp.usage',
						usage: {
							contextUsed: event.data.currentTokens,
							contextWindow: event.data.tokenLimit,
						},
					});
					break;
				case 'assistant.usage':
					captureEvent(capture, parser, {
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
					});
					break;
				case 'assistant.message_delta':
					sawMessageDelta = true;
					captureEvent(capture, parser, { type: 'acp.text', text: event.data.deltaContent });
					break;
				case 'assistant.message':
					if (!sawMessageDelta && event.data.content) {
						captureEvent(capture, parser, { type: 'acp.text', text: event.data.content });
					}
					break;
				case 'tool.execution_start':
					captureEvent(capture, parser, {
						type: 'acp.tool',
						toolCallId: event.data.toolCallId,
						toolName: event.data.toolName,
						state: { status: 'running', input: event.data.arguments },
					});
					break;
				case 'tool.execution_complete':
					captureEvent(capture, parser, {
						type: 'acp.tool',
						toolCallId: event.data.toolCallId,
						state: {
							status: event.data.success ? 'completed' : 'failed',
							output: event.data.result?.content ?? event.data.error,
						},
					});
					break;
				case 'session.error':
					failure = event.data.message;
					exitCode = 1;
					captureEvent(capture, parser, { type: 'acp.error', message: event.data.message });
					break;
				case 'session.idle':
					captureEvent(capture, parser, { type: 'acp.result', stopReason: 'end_turn' });
					idle.resolve();
					break;
			}
		});
		await session.send({ prompt, mode: 'enqueue' });
		await idle.promise;
	} catch (error) {
		exitCode = 1;
		failure = error;
	} finally {
		options.signal?.removeEventListener('abort', abort);
		unsubscribe?.();
		broker.closeAll();
		try {
			await client.forceStop();
		} catch {
			// Preserve the turn result; cleanup errors are not a second outcome.
		}
	}
	if (options.signal?.aborted)
		return settleNativeResult('copilot-cli', parser, capture, exitCode, failure, true);
	return settleNativeResult('copilot-cli', parser, capture, exitCode, failure);
}

async function approveCopilot(
	request: PermissionRequest,
	broker: InteractionBroker,
	options: SpawnAgentOptions
) {
	const opened = broker.open({
		sessionId: options.nativeSessionId ?? `cli-copilot-${Date.now()}`,
		tabId: options.nativeTabId,
		spawnGeneration: 1,
		kind: 'permission',
		provider: 'copilot-cli',
		title: `Copilot requests ${request.kind} permission`,
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

async function answerCopilotQuestion(
	request: { question: string; choices?: string[]; allowFreeform?: boolean },
	broker: InteractionBroker,
	options: SpawnAgentOptions
) {
	const opened = broker.open({
		sessionId: options.nativeSessionId ?? `cli-copilot-${Date.now()}`,
		tabId: options.nativeTabId,
		spawnGeneration: 1,
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
	return { answer: text, wasFreeform: !(request.choices ?? []).includes(text) };
}

async function answerCopilotElicitation(
	request: ElicitationContext,
	broker: InteractionBroker,
	options: SpawnAgentOptions
) {
	const opened = broker.open({
		sessionId: options.nativeSessionId ?? `cli-copilot-${Date.now()}`,
		tabId: options.nativeTabId,
		spawnGeneration: 1,
		kind: 'elicitation',
		provider: 'copilot-cli',
		title: request.message,
		options: [],
		questions: copilotElicitationQuestions(request),
	});
	const resolution = await opened.completion;
	return copilotElicitationResult(request, resolution);
}

async function spawnAcpNative(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	options: SpawnAgentOptions,
	command: string,
	nativeEnv: NodeJS.ProcessEnv
): Promise<AgentResult> {
	const definition = getAgentDefinition(toolType);
	const fallback = createOutputParser(toolType);
	if (!definition || !fallback) return spawnFailureResult(`No ACP integration for ${toolType}`);
	const mode =
		options.readOnlyMode || options.permissionMode === 'readonly'
			? 'readonly'
			: options.permissionMode === 'standard'
				? 'standard'
				: 'full';
	const baseArgs = buildNativeAcpBaseArgs(launchDefinition(definition), mode);
	if (!baseArgs) return spawnFailureResult(`No native ACP launch for ${toolType}`);
	const args = applyAgentConfigOverrides(launchDefinition(definition), baseArgs, {
		agentConfigValues: options.agentConfigValues,
		sessionCustomModel: options.customModel,
		sessionCustomEffort: options.customEffort,
		sessionCustomEnvVars: options.customEnvVars,
		sessionCustomArgs: options.customArgs,
		readOnlyMode: mode === 'readonly',
	}).args;
	const spawnPlan = planSpawnShell(command, args, { runInShell: false });
	const turn = startTurn(
		{
			command: spawnPlan.command,
			args: spawnPlan.args,
			cwd,
			env: nativeEnv,
			shell: spawnPlan.shell,
		},
		{},
		{
			stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
			keepStdinOpen: true,
			stdoutTailLimit: 0,
			stderrTailLimit: 0,
			label: 'cli-acp',
		}
	);
	const parser = new AcpOutputParser(toolType, fallback);
	const capture = new TurnCapture(toolType, parser, { classifyInBandErrors: false });
	const broker = ownerBroker(options);
	const translator = new AcpEventTranslator();
	let providerSessionId = agentSessionId;
	let promptSent = false;
	let exitCode = 0;
	let failure: unknown;
	const abort = () => {
		if (providerSessionId) {
			void connection.agent.notify(acp.methods.agent.session.cancel, {
				sessionId: providerSessionId,
			});
		}
		stopProcess(
			{ child: turn.child },
			{
				from: 'interrupt',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				label: 'cli-acp-interrupt',
			}
		);
	};
	const app = acp
		.client({ name: 'maestro-cli' })
		.onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
			if (providerSessionId && params.sessionId !== providerSessionId) {
				return { outcome: { outcome: 'cancelled' as const } };
			}
			const opened = broker.open(
				acpPermissionOpenRequest(params, {
					sessionId: options.nativeSessionId ?? `cli-${toolType}-${Date.now()}`,
					tabId: options.nativeTabId,
					spawnGeneration: 1,
					provider: toolType,
				})
			);
			return acpPermissionResponse(await opened.completion);
		})
		.onNotification(acp.methods.client.session.update, ({ params }) => {
			if (!promptSent || (providerSessionId && params.sessionId !== providerSessionId)) return;
			for (const line of translator.handle(params).lines) {
				captureEvent(capture, parser, JSON.parse(line));
			}
		});
	const stream = acpStdioStream(turn.child);
	const connection = app.connect(acp.ndJsonStream(stream.writable, stream.readable));
	options.signal?.addEventListener('abort', abort, { once: true });
	if (options.signal?.aborted) abort();
	try {
		const initialized = await connection.agent.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: 'maestro-cli', version: '1' },
		});
		if (initialized.protocolVersion !== 1) {
			throw new Error(`ACP selected unsupported version ${initialized.protocolVersion}`);
		}
		if (agentSessionId && !initialized.agentCapabilities?.loadSession) {
			throw new Error('ACP agent does not support resume');
		}
		const session = (await connection.agent.request(
			agentSessionId && initialized.agentCapabilities?.loadSession
				? acp.methods.agent.session.load
				: acp.methods.agent.session.new,
			agentSessionId && initialized.agentCapabilities?.loadSession
				? { sessionId: agentSessionId, cwd, mcpServers: [] }
				: { cwd, mcpServers: [] }
		)) as { sessionId?: string };
		providerSessionId = session.sessionId ?? agentSessionId;
		if (!providerSessionId) throw new Error('ACP session returned no session id');
		captureEvent(capture, parser, { type: 'acp.init', sessionId: providerSessionId });
		if (options.signal?.aborted) throw new Error('Native turn interrupted');
		promptSent = true;
		const result = (await connection.agent.request(acp.methods.agent.session.prompt, {
			sessionId: providerSessionId,
			prompt: [{ type: 'text', text: prompt }],
		})) as { stopReason: string };
		captureEvent(capture, parser, {
			type: 'acp.result',
			sessionId: providerSessionId,
			stopReason: result.stopReason,
			text: translator.finalText,
		});
		exitCode = result.stopReason === 'end_turn' || result.stopReason === 'cancelled' ? 0 : 1;
	} catch (error) {
		exitCode = 1;
		failure = error;
	} finally {
		options.signal?.removeEventListener('abort', abort);
		connection.close();
		turn.child.stdin?.end();
		broker.closeAll();
	}
	if (failure) {
		stopProcess(
			{ child: turn.child },
			{
				from: 'terminate',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				label: 'cli-acp-error',
			}
		);
	}
	const exit = await turn.done;
	if (options.signal?.aborted) {
		return settleNativeResult(toolType, parser, capture, exitCode, failure, true);
	}
	return settleNativeResult(
		toolType,
		parser,
		capture,
		failure ? exitCode : (exit.exitCode ?? exitCode),
		failure ?? exit.spawnError
	);
}

async function spawnRpcNative(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	options: SpawnAgentOptions,
	command: string,
	nativeEnv: NodeJS.ProcessEnv
): Promise<AgentResult> {
	const definition = getAgentDefinition(toolType);
	const parser = createOutputParser(toolType);
	const protocol = nativeRpcProtocol(toolType);
	if (!definition || !parser || !protocol)
		return spawnFailureResult(`No RPC integration for ${toolType}`);
	const mode =
		options.readOnlyMode || options.permissionMode === 'readonly'
			? 'readonly'
			: options.permissionMode === 'standard'
				? 'standard'
				: 'full';
	const baseArgs = buildNativeRpcBaseArgs(launchDefinition(definition), mode);
	if (!baseArgs) return spawnFailureResult(`No native RPC launch for ${toolType}`);
	const args = applyAgentConfigOverrides(launchDefinition(definition), baseArgs, {
		agentConfigValues: options.agentConfigValues,
		sessionCustomModel: options.customModel,
		sessionCustomEffort: options.customEffort,
		sessionCustomArgs: options.customArgs,
		sessionCustomEnvVars: options.customEnvVars,
		readOnlyMode: mode === 'readonly',
	}).args;
	const spawnPlan = planSpawnShell(command, args, { runInShell: false });
	const turn = startTurn(
		{
			command: spawnPlan.command,
			args: spawnPlan.args,
			cwd,
			env: nativeEnv,
			shell: spawnPlan.shell,
		},
		{},
		{
			stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
			keepStdinOpen: true,
			stdoutTailLimit: 0,
			stderrTailLimit: 0,
			label: 'cli-native-rpc',
		}
	);
	const capture = new TurnCapture(toolType, parser, { classifyInBandErrors: false });
	const broker = ownerBroker(options);
	const settled = Promise.withResolvers<number>();
	const connection = new NdJsonConnection(turn.child, {
		protocol: 'pi',
		negotiateV2: protocol === 'omp-rpc',
		onNotification: (record) => {
			captureEvent(capture, parser, record);
			if (record.type === 'agent_settled' || record.type === 'session_settled') {
				settled.resolve(record.aborted === true ? 1 : 0);
				turn.child.stdin?.end();
			}
		},
		onServerRequest: (record) =>
			answerRpcExtensionRequestWithBroker(
				record,
				{
					sessionId: options.nativeSessionId ?? `cli-${toolType}-${Date.now()}`,
					tabId: options.nativeTabId,
					spawnGeneration: 1,
					provider: toolType,
				},
				broker
			),
	});
	const abort = () => {
		void connection.request('abort').catch(() => undefined);
		stopProcess(
			{ child: turn.child },
			{
				from: 'interrupt',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				label: 'cli-rpc-interrupt',
			}
		);
	};
	let failure: unknown;
	options.signal?.addEventListener('abort', abort, { once: true });
	if (options.signal?.aborted) abort();
	try {
		if (agentSessionId) await connection.request('switch_session', { sessionPath: agentSessionId });
		if (options.customModel) {
			const separator = options.customModel.indexOf('/');
			if (separator > 0) {
				await connection.request('set_model', {
					provider: options.customModel.slice(0, separator),
					modelId: options.customModel.slice(separator + 1),
				});
			}
		}
		if (options.customEffort) {
			await connection.request('set_thinking_level', { level: options.customEffort });
		}
		const state = (await connection.request('get_state')) as {
			sessionId?: string;
			sessionFile?: string;
		};
		const providerSessionId = state.sessionFile ?? agentSessionId ?? state.sessionId;
		if (providerSessionId)
			captureEvent(capture, parser, { type: 'session', id: providerSessionId });
		if (options.signal?.aborted) throw new Error('Native turn interrupted');
		const submission = (await connection.request('prompt', { message: prompt })) as
			| { disposition?: string }
			| undefined;
		if (submission?.disposition === 'handled') {
			const state = (await connection.request('get_state')) as {
				isStreaming?: boolean;
				pendingMessageCount?: number;
			};
			if (!state.isStreaming && (state.pendingMessageCount ?? 0) === 0) {
				settled.resolve(0);
				turn.child.stdin?.end();
			}
		}
	} catch (error) {
		failure = error;
		settled.resolve(1);
		turn.child.stdin?.end();
	}
	const exitCode = await Promise.race([
		settled.promise,
		turn.done.then((exit) => exit.exitCode ?? 1),
	]);
	options.signal?.removeEventListener('abort', abort);
	connection.close();
	turn.child.stdin?.end();
	broker.closeAll();
	const exit = await turn.done;
	if (options.signal?.aborted) {
		return settleNativeResult(toolType, parser, capture, exitCode, failure, true);
	}
	return settleNativeResult(
		toolType,
		parser,
		capture,
		failure ? 1 : exitCode,
		failure ?? exit.spawnError
	);
}

async function spawnAntigravityNative(
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	options: SpawnAgentOptions,
	nativeEnv: NodeJS.ProcessEnv
): Promise<AgentResult> {
	if (agentSessionId) {
		return spawnFailureResult('Antigravity SDK resume is not supported; use the current transport');
	}
	const fallback = createOutputParser('antigravity');
	if (!fallback) return spawnFailureResult('No Antigravity output parser is registered');
	const parser = new AcpOutputParser('antigravity', fallback);
	const capture = new TurnCapture('antigravity', parser, { classifyInBandErrors: false });
	const broker = ownerBroker(options);
	const python = options.customEnvVars?.ANTIGRAVITY_PYTHON || 'python';
	const args = ['-u', '-c', ANTIGRAVITY_SDK_SIDECAR];
	const spawnPlan = planSpawnShell(python, args, { runInShell: false });
	const turn = startTurn(
		{
			command: spawnPlan.command,
			args: spawnPlan.args,
			cwd,
			env: nativeEnv,
			shell: spawnPlan.shell,
		},
		{},
		{
			stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
			keepStdinOpen: true,
			stdoutTailLimit: 0,
			stderrTailLimit: 0,
			label: 'cli-antigravity-sdk',
		}
	);
	const settled = Promise.withResolvers<number>();
	const connection = new NdJsonConnection(turn.child, {
		protocol: 'jsonrpc',
		onNotification: (record) => {
			const params = (record.params ?? {}) as Record<string, unknown>;
			if (record.method === 'text') {
				captureEvent(capture, parser, { type: 'acp.text', text: params.text ?? '' });
			} else if (record.method === 'error') {
				captureEvent(capture, parser, { type: 'acp.error', message: params.message });
			} else if (record.method === 'complete') {
				captureEvent(capture, parser, { type: 'acp.result', stopReason: 'end_turn' });
				settled.resolve(typeof params.code === 'number' ? params.code : 0);
				turn.child.stdin?.end();
			}
		},
		onServerRequest: async (record) => {
			const params = (record.params ?? {}) as Record<string, unknown>;
			const opened = broker.open({
				sessionId: options.nativeSessionId ?? `cli-antigravity-${Date.now()}`,
				tabId: options.nativeTabId,
				spawnGeneration: 1,
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
		},
	});
	const abort = () => {
		void connection.request('interrupt').catch(() => undefined);
		stopProcess(
			{ child: turn.child },
			{
				from: 'interrupt',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				label: 'cli-antigravity-interrupt',
			}
		);
	};
	let failure: unknown;
	try {
		options.signal?.addEventListener('abort', abort, { once: true });
		if (options.signal?.aborted) abort();
		await connection.request('start', {
			cwd,
			prompt,
			model: options.customModel,
			permission_mode:
				options.readOnlyMode || options.permissionMode === 'readonly'
					? 'readonly'
					: options.permissionMode === 'standard'
						? 'standard'
						: 'full',
		});
		if (options.signal?.aborted) throw new Error('Native turn interrupted');
	} catch (error) {
		failure = error;
		settled.resolve(1);
		turn.child.stdin?.end();
	}
	const exitCode = await Promise.race([
		settled.promise,
		turn.done.then((exit) => exit.exitCode ?? 1),
	]);
	options.signal?.removeEventListener('abort', abort);
	if (failure) {
		stopProcess(
			{ child: turn.child },
			{
				from: 'terminate',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				label: 'cli-antigravity-error',
			}
		);
	}
	connection.close();
	turn.child.stdin?.end();
	broker.closeAll();
	const exit = await turn.done;
	if (options.signal?.aborted) {
		return settleNativeResult('antigravity', parser, capture, exitCode, failure, true);
	}
	return settleNativeResult(
		'antigravity',
		parser,
		capture,
		failure ? 1 : exitCode,
		failure ?? exit.spawnError
	);
}

async function spawnHermesNative(
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	options: SpawnAgentOptions,
	command: string,
	nativeEnv: NodeJS.ProcessEnv
): Promise<AgentResult> {
	if (options.readOnlyMode || options.permissionMode === 'readonly') {
		return spawnFailureResult('Hermes native read-only has no provider-enforced tool restriction');
	}
	const parser = new AcpOutputParser('hermes', createOutputParser('hermes') || undefined);
	const capture = new TurnCapture('hermes', parser, { classifyInBandErrors: false });
	const broker = ownerBroker(options);
	const launch = resolveHermesGatewayLaunch({
		command,
		args: [],
		customEnvVars: options.customEnvVars,
	});
	const spawnPlan = planSpawnShell(launch.command, launch.args!, { runInShell: false });
	const turn = startTurn(
		{
			command: spawnPlan.command,
			args: spawnPlan.args,
			cwd,
			env: { ...nativeEnv, ...launch.customEnvVars },
			shell: spawnPlan.shell,
		},
		{},
		{
			stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
			keepStdinOpen: true,
			stdoutTailLimit: 0,
			stderrTailLimit: 0,
			label: 'cli-hermes-gateway',
		}
	);
	const settled = Promise.withResolvers<number>();
	const pendingRequests = new Map<string, string>();
	let liveSessionId = agentSessionId;
	let durableSessionId = agentSessionId;
	let lastUsage = { input: 0, output: 0 };
	const forwardUsage = (raw: unknown) => {
		if (!raw || typeof raw !== 'object') return;
		const usage = raw as Record<string, unknown>;
		const input = typeof usage.input === 'number' ? usage.input : 0;
		const output = typeof usage.output === 'number' ? usage.output : 0;
		const inputDelta = Math.max(0, input - lastUsage.input);
		const outputDelta = Math.max(0, output - lastUsage.output);
		lastUsage = { input, output };
		captureEvent(capture, parser, {
			type: 'acp.usage',
			usage: {
				inputTokens: inputDelta,
				outputTokens: outputDelta,
				contextUsed: usage.context_used,
				contextWindow: usage.context_max,
				costUsd: usage.cost,
			},
		});
	};
	const answerInteraction = async (method: string, params: Record<string, unknown>) => {
		const nativeId = typeof params.request_id === 'string' ? params.request_id : '';
		if (!nativeId) return;
		const base = method.slice(0, -'.request'.length);
		if (base === 'approval' && options.permissionMode !== 'standard') {
			await connection.request('approval.respond', {
				session_id: liveSessionId,
				request_id: nativeId,
				choice: 'once',
			});
			return;
		}
		const interactionOptions: HarnessInteractionOption[] = [];
		if (base === 'approval') {
			for (const choice of Array.isArray(params.choices) ? params.choices : ['once', 'deny']) {
				if (choice === 'once')
					interactionOptions.push({ optionId: 'once', label: 'Allow once', kind: 'allow-once' });
				else if (choice === 'session')
					interactionOptions.push({
						optionId: 'session',
						label: 'Allow for this session',
						kind: 'allow-always',
					});
				else if (choice === 'always')
					interactionOptions.push({
						optionId: 'always',
						label: 'Always allow',
						kind: 'allow-always',
					});
				else if (choice === 'deny')
					interactionOptions.push({ optionId: 'deny', label: 'Deny', kind: 'reject-once' });
			}
		}
		const questions =
			base === 'clarify'
				? (Array.isArray(params.questions) ? params.questions : []).flatMap((value, index) => {
						if (!value || typeof value !== 'object') return [];
						const question = value as Record<string, unknown>;
						return [
							{
								id: typeof question.id === 'string' ? question.id : `question-${index}`,
								question:
									typeof question.question === 'string'
										? question.question
										: String(question.title ?? 'Continue?'),
								allowCustom: true,
								options: (Array.isArray(question.options) ? question.options : []).flatMap(
									(option, optionIndex) =>
										typeof option === 'string'
											? [
													{
														optionId: `option-${optionIndex}`,
														label: option,
														kind: 'choice' as const,
													},
												]
											: []
								),
							},
						];
					})
				: base === 'secret' || base === 'sudo'
					? [
							{
								id: 'value',
								question: String(params.description ?? base),
								allowCustom: true,
								options: [],
							},
						]
					: [];
		const opened = broker.open({
			sessionId: options.nativeSessionId ?? `cli-hermes-${Date.now()}`,
			tabId: options.nativeTabId,
			spawnGeneration: 1,
			kind: base === 'approval' ? 'permission' : base === 'clarify' ? 'question' : 'elicitation',
			provider: 'hermes',
			title: typeof params.description === 'string' ? params.description : `Hermes ${base} request`,
			detail: typeof params.command === 'string' ? params.command : undefined,
			toolName: base,
			input: params,
			options: interactionOptions,
			questions,
			secret: base === 'secret' || base === 'sudo',
		});
		pendingRequests.set(nativeId, opened.request.requestId);
		const resolution = await opened.completion;
		pendingRequests.delete(nativeId);
		let value: Record<string, unknown>;
		if (base === 'approval') {
			value = { choice: resolution.outcome === 'selected' ? resolution.optionId : 'deny' };
		} else if (base === 'clarify') {
			value = { answers: resolution.outcome === 'answers' ? resolution.answers : {} };
		} else if (base === 'sudo') {
			const answer = resolution.outcome === 'answers' ? resolution.answers.value : '';
			value = { password: Array.isArray(answer) ? answer.join(',') : answer };
		} else {
			const answer = resolution.outcome === 'answers' ? resolution.answers.value : '';
			value = { value: Array.isArray(answer) ? answer.join(',') : answer };
		}
		await connection.request(`${base}.respond`, {
			session_id: liveSessionId,
			request_id: nativeId,
			...value,
		});
	};
	const connection = new NdJsonConnection(turn.child, {
		protocol: 'jsonrpc',
		onNotification: (record) => {
			let method = record.method;
			let params = (record.params ?? {}) as Record<string, unknown>;
			if (method === 'event') {
				method = typeof params.type === 'string' ? params.type : '';
				params = (
					params.payload && typeof params.payload === 'object' ? params.payload : {}
				) as Record<string, unknown>;
			}
			switch (method) {
				case 'approval.request':
				case 'clarify.request':
				case 'secret.request':
				case 'sudo.request':
					void answerInteraction(method, params);
					return;
				case 'approval.expire':
				case 'clarify.expire':
				case 'secret.expire':
				case 'sudo.expire': {
					const id = typeof params.request_id === 'string' ? params.request_id : '';
					const brokerId = pendingRequests.get(id);
					if (brokerId) broker.withdraw(brokerId);
					pendingRequests.delete(id);
					return;
				}
				case 'tool.start':
				case 'tool.complete':
					captureEvent(capture, parser, {
						type: 'acp.tool',
						toolCallId: params.tool_call_id ?? params.tool_id ?? params.id,
						toolName: params.tool ?? params.name,
						state:
							method === 'tool.start'
								? { status: 'running', input: params.preview ?? params.input ?? params.args }
								: {
										status: params.error ? 'failed' : 'completed',
										output: params.preview ?? params.output ?? params.result,
									},
					});
					return;
				case 'session.usage':
					forwardUsage(params.usage);
					return;
				case 'message.delta':
					captureEvent(capture, parser, {
						type: 'acp.text',
						text: params.text ?? params.delta ?? '',
					});
					return;
				case 'message.interim':
					if (params.already_streamed !== true)
						captureEvent(capture, parser, { type: 'acp.text', text: params.text ?? '' });
					return;
				case 'message.complete': {
					const failed = params.status === 'error';
					forwardUsage(params.usage);
					captureEvent(capture, parser, {
						type: 'acp.result',
						sessionId: durableSessionId,
						stopReason: failed ? 'error' : 'end_turn',
						text: params.output ?? params.final_response ?? params.text ?? '',
						usage: params.usage,
					});
					if (failed) captureEvent(capture, parser, { type: 'acp.error', message: params.error });
					settled.resolve(failed ? 1 : 0);
					turn.child.stdin?.end();
					return;
				}
				case 'message.error':
				case 'run.failed':
				case 'run.cancelled':
				case 'run.interrupted':
					captureEvent(capture, parser, { type: 'acp.error', message: params.error ?? method });
					settled.resolve(1);
					turn.child.stdin?.end();
			}
		},
		onServerRequest: async () => ({
			kind: 'error',
			code: -32601,
			message: 'Hermes uses event interactions',
		}),
	});
	const abort = () => {
		void connection
			.request('session.interrupt', { session_id: liveSessionId })
			.catch(() => undefined);
		stopProcess(
			{ child: turn.child },
			{
				from: 'interrupt',
				graceMs: INTERACTIVE_STOP_GRACE_MS,
				label: 'cli-hermes-interrupt',
			}
		);
	};
	let failure: unknown;
	options.signal?.addEventListener('abort', abort, { once: true });
	if (options.signal?.aborted) abort();
	try {
		if (agentSessionId) {
			const resumed = (await connection.request('session.resume', {
				session_id: agentSessionId,
			})) as {
				session_id?: string;
				pending_approval?: Record<string, unknown>;
				pending_clarify?: Record<string, unknown>;
			};
			liveSessionId = resumed.session_id ?? agentSessionId;
			if (resumed.pending_approval)
				void answerInteraction('approval.request', resumed.pending_approval);
			if (resumed.pending_clarify)
				void answerInteraction('clarify.request', resumed.pending_clarify);
		} else {
			const created = (await connection.request('session.create', {
				cwd,
				...(options.customModel ? { model: options.customModel } : {}),
				...(options.customEffort ? { reasoning_effort: options.customEffort } : {}),
			})) as { session_id?: string; stored_session_id?: string };
			liveSessionId = created.session_id;
			durableSessionId = created.stored_session_id ?? created.session_id;
		}
		if (!liveSessionId || !durableSessionId) throw new Error('Hermes did not create a session');
		captureEvent(capture, parser, { type: 'acp.init', sessionId: durableSessionId });
		if (options.signal?.aborted) throw new Error('Native turn interrupted');
		await connection.request('prompt.submit', {
			session_id: liveSessionId,
			text: prompt,
			queued: false,
		});
	} catch (error) {
		failure = error;
		settled.resolve(1);
		turn.child.stdin?.end();
	}
	const exitCode = await Promise.race([
		settled.promise,
		turn.done.then((exit) => exit.exitCode ?? 1),
	]);
	options.signal?.removeEventListener('abort', abort);
	connection.close();
	turn.child.stdin?.end();
	broker.closeAll();
	const exit = await turn.done;
	if (options.signal?.aborted) {
		return settleNativeResult('hermes', parser, capture, exitCode, failure, true);
	}
	return settleNativeResult(
		'hermes',
		parser,
		capture,
		failure ? 1 : exitCode,
		failure ?? exit.spawnError
	);
}
