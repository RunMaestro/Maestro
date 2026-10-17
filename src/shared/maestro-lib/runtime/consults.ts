/**
 * The runtime's consults (XM-1 to XM-4): `maestro-cli ask` and a typed `@mention` answered by the
 * library's consult service running in this process, with no renderer to hand the work through.
 *
 * A consult is one question put to another agent, read-only, answered once, and completely in the
 * background on the consulted agent: it runs in a hidden consult tab of its own, with no tab chip
 * and no unread mark, and changes nothing the person sees there. It is NOT a `turns.send` to the
 * target, which would land in whatever conversation they have open.
 *
 * | Step | Piece |
 * | --- | --- |
 * | Check | a question, a target, not itself |
 * | Context | none, unless asked for: then the asking tab, windowed by the question |
 * | The consult tab | `repository.openConsultTab`: found or created per asking agent, hidden, never active |
 * | Order | consults sharing a consult tab run one at a time (two processes resuming one provider session corrupt it); consults to different agents run at once |
 * | Run | `createConsultService` over the background runner, with the target's own system prompt: the 10 and 30 minute budgets |
 * | Access | a consult is read-only unless `crossAgentMentionsWritable`; a hand-off may write unless `crossAgentHandoffsWritable` is off |
 * | Record | the answer or the failure on the consult tab, a History entry on the target |
 * | Answer | the text, or a failure that says why |
 *
 * A HAND-OFF (`handoffAnswer`) goes through the same steps: the asking agent already did the work,
 * and the target is told it is receiving that answer to act on, not a question to answer.
 *
 * The caller's `timeoutMs` stops the consult when it runs out (GD19), and Stop on the asking agent
 * stops every consult it started (B20).
 *
 * Design: `Plans/maestro-tui-group-chat.md` section 7.
 */

import { normalizeMaxConsultationsPerTurn } from '../../consultBudget';
import {
	deriveConsultSubject,
	inferContextStrategy,
	selectContextWindow,
} from '../../crossAgentContext';
import {
	CROSS_AGENT_ASK_SESSION_ID,
	CROSS_AGENT_ASK_TAB_ID,
	type CrossAgentRequest,
	type CrossAgentResponseChunk,
	type CrossAgentTranscriptEntry,
} from '../../crossAgentTypes';
import { createKeyedWriteQueue } from '../../keyedWriteQueue';
import type { ToolType } from '../../types';
import { createConsultService, type CrossAgentTargetSession } from '../agents/consult';
import {
	buildConsultHistoryEntry,
	buildConsultTabName,
	crossAgentTerminationNote,
} from '../agents/consult-prompt';
import type { AgentRepository } from '../agents/repository';
import { DEFAULT_RULE_CONTEXT, type RuleContext } from '../agents/rules';
import type {
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
	ConsultAnswer,
	ConsultAskInput,
} from '../client/types';
import { logger } from '../host';
import type { MaestroPaths } from '../paths/resolve';
import { readAgentConfigsStore, readSettingsStore } from '../store/read-stores';
import type { AgentRecord } from '../store/records';
import { transcriptOf, type LogEntryRecord } from '../store/transcript';
import { loadStandInSystemPrompt, type SystemPromptSources } from '../turns/context';
import { toTurnAgent } from '../turns/records';
import { createHistoryWriter, type HistoryWriter } from '../turns/history';
import type { BackgroundTurns } from './background-turns';
import type { DataDirVerdict } from './data-dir-lock';
import type { RuntimeTurnOptions } from './turns';

const LOG_CONTEXT = '[RuntimeConsults]';

/** The bounds the caller's `timeoutMs` is held to, as the desktop's handler holds it. */
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 600_000;

/** What the consult tab is called when nobody named themselves. */
const UNNAMED_ASKER = 'CLI';

export interface RuntimeConsultsOptions {
	paths: MaestroPaths;
	repository: AgentRepository;
	fence(): DataDirVerdict;
	background: BackgroundTurns;
	rules?: Partial<RuleContext>;
	/** Test seam: where the target's History entry goes. Default: the library writer over the data directory. */
	historyWriter?: HistoryWriter;
	now?: () => number;
	/** Test seam: the shortest wait a caller may ask for. Default 10 seconds, the desktop's floor. */
	minTimeoutMs?: number;
	/** Where the bundled prompts and the CLI are, as chat turns read them for the target's system prompt. */
	options?: Pick<RuntimeTurnOptions, 'bundledPromptsDir' | 'moduleDirectory' | 'maestroCliPath'>;
}

/**
 * `ConsultsApi.ask`'s input. With `handoffAnswer` it is a hand-off: the asking agent's final answer,
 * forwarded because the person said to pass the result on ("then send what you find to @X"), and
 * `question` is the person's message that asked for it.
 */
export type RuntimeConsultInput = ConsultAskInput;

export interface RuntimeConsults {
	/** A `ConsultsApi`, which also takes a hand-off. */
	readonly api: { ask(input: RuntimeConsultInput): Promise<ClientResult<ConsultAnswer>> };
	/** Stop every consult `agentId` asked for. Answers how many were stopped. */
	cancelForSource(agentId: string): number;
	/** Consults running now. With the group chat rounds, the work `host stop` refuses to cut off. */
	inFlight(): number;
	/**
	 * Stop every consult and refuse any more, including ones waiting behind another on the same
	 * consult tab: a runtime that is closing, or that lost the data directory, must not start a
	 * process it can no longer record.
	 */
	dispose(): void;
	/** Resolves once every consult that was asked has finished writing down how it ended. */
	settled(): Promise<void>;
}

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });

function fail<T = never>(
	method: ClientMethod,
	code: ClientErrorCode,
	message: string
): ClientResult<T> {
	const error: ClientError = { code, message, method };
	return { ok: false, error };
}

const str = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

/** An agent record as the consult service launches it. A record with no directory has none to run in. */
function toTargetSession(record: AgentRecord): CrossAgentTargetSession | undefined {
	const agent = toTurnAgent(record);
	if (!agent) return undefined;
	const mode = record.maestroPMode;
	return {
		id: agent.id,
		name: agent.name,
		toolType: agent.toolType as ToolType,
		cwd: agent.cwd,
		customPath: agent.customPath,
		customArgs: agent.customArgs,
		customEnvVars: agent.customEnvVars,
		customModel: agent.customModel,
		customEffort: agent.customEffort,
		customContextWindow: agent.customContextWindow,
		enableMaestroP: record.enableMaestroP === true ? true : undefined,
		maestroPMode: mode === 'interactive' || mode === 'dynamic' ? mode : undefined,
		maestroPPath: str(record.maestroPPath),
		sshRemoteConfig: agent.sessionSshRemoteConfig,
	};
}

export function createRuntimeConsults(options: RuntimeConsultsOptions): RuntimeConsults {
	const { paths, repository, background } = options;
	const ctx: RuleContext = { ...DEFAULT_RULE_CONTEXT, ...options.rules };
	const now = options.now ?? (() => Date.now());
	const service = createConsultService();
	const history = options.historyWriter ?? createHistoryWriter({ paths, fence: options.fence });

	/** Consults that share a consult tab run one at a time; different tabs and agents run at once (GD18). */
	const order = createKeyedWriteQueue();
	let inFlight = 0;
	let disposed = false;
	/** Every ask not yet finished, so shutdown can wait for what each one writes down. */
	const pending = new Set<Promise<unknown>>();

	const agentConfigs = (): Record<string, Record<string, unknown>> => {
		const read = readAgentConfigsStore(paths.agentConfigsFile);
		return read.status === 'ok'
			? ((read.data.configs ?? {}) as Record<string, Record<string, unknown>>)
			: {};
	};

	/**
	 * Whether the request may modify files, as the desktop's `resolveCrossAgentWritable` decides
	 * it. A consult answers a question, so it is read-only unless the user opted in
	 * (`crossAgentMentionsWritable`, default off, B19). A hand-off passes work on, which usually
	 * means the target should save it, so it may write unless the user opted out
	 * (`crossAgentHandoffsWritable`, default on). Settings that cannot be read are "nothing set".
	 */
	const writableFor = (isHandoff: boolean): boolean => {
		const settings = readSettingsStore(paths.settingsFile);
		const data = settings.status === 'ok' ? settings.data : {};
		return isHandoff
			? data.crossAgentHandoffsWritable !== false
			: data.crossAgentMentionsWritable === true;
	};

	// The target's system prompt is read from the sources its own chat turn reads.
	const host = options.options ?? {};
	const promptSources: SystemPromptSources = {
		paths,
		...(host.bundledPromptsDir ? { bundledPromptsDir: host.bundledPromptsDir } : {}),
		...(host.moduleDirectory ? { moduleDirectory: host.moduleDirectory } : {}),
		...(host.maestroCliPath ? { maestroCliPath: host.maestroCliPath } : {}),
		now: () => new Date(now()),
	};

	/** The windowed transcript of the asking tab, or none: a consult sends a self-contained question. */
	function contextOf(
		fromAgentId: string | undefined,
		fromTabId: string | undefined,
		question: string
	): { transcript: CrossAgentTranscriptEntry[]; strategy: CrossAgentRequest['strategy'] } {
		const strategy = inferContextStrategy(question);
		const agent = fromAgentId ? repository.getAgent(fromAgentId) : undefined;
		// The tab the caller named, else its active one: a caller that says nothing has a conversation too.
		const tabId = fromTabId ?? str(agent?.activeTabId);
		const tab = agent && tabId ? repository.getTab(agent.id, tabId) : undefined;
		const logs: LogEntryRecord[] = tab ? transcriptOf(tab) : [];
		return {
			strategy,
			transcript: selectContextWindow(logs, strategy).map((entry) => ({
				source: entry.source,
				text: entry.text,
				timestamp: entry.timestamp,
			})),
		};
	}

	type AnswerValue = ConsultAnswer;
	type Answer = ClientResult<AnswerValue>;

	function ask(input: RuntimeConsultInput): Promise<Answer> {
		const running = askNow(input);
		pending.add(running);
		const forget = (): void => void pending.delete(running);
		running.then(forget, forget);
		return running;
	}

	async function askNow(input: RuntimeConsultInput): Promise<Answer> {
		const method: ClientMethod = 'consults.ask';
		if (disposed) return fail(method, 'host-unavailable', 'The runtime is closing.');
		const question = input.question.trim();
		if (!question) return fail(method, 'invalid', 'The question is empty.');
		const record = repository.getAgent(input.targetAgentId);
		if (!record) return fail(method, 'not-found', `No agent ${input.targetAgentId}.`);
		if (input.fromAgentId && input.fromAgentId === input.targetAgentId) {
			return fail(method, 'invalid', 'An agent cannot consult itself.');
		}
		const isHandoff = input.handoffAnswer !== undefined;
		const target = toTargetSession(record);
		if (!target) {
			return fail(method, 'rejected', `${record.name} has no working directory to run in.`);
		}

		const source = input.fromAgentId ? repository.getAgent(input.fromAgentId) : undefined;
		const sourceName = source?.name ?? UNNAMED_ASKER;
		// Keyed on the CALLING AGENT and a constant tab, never the caller's active tab, so one consult
		// tab per pairing survives the agent switching tabs and a follow-up resumes the thread (req-D2).
		const key = {
			sourceSessionId: source?.id ?? CROSS_AGENT_ASK_SESSION_ID,
			sourceTabId: CROSS_AGENT_ASK_TAB_ID,
		};
		const timeoutMs = Math.min(
			Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.minTimeoutMs ?? MIN_TIMEOUT_MS),
			MAX_TIMEOUT_MS
		);
		const { transcript, strategy } = input.withContext
			? contextOf(source?.id, input.fromTabId, question)
			: { transcript: [], strategy: inferContextStrategy(question) };

		// The caller's clock covers the wait for an earlier consult on the same tab, too.
		const requestId = ctx.newId();
		const timer: { expired: boolean; handle?: ReturnType<typeof setTimeout> } = { expired: false };
		timer.handle = setTimeout(() => {
			timer.expired = true;
			service.cancel(requestId);
		}, timeoutMs);
		timer.handle.unref?.();

		inFlight += 1;
		try {
			return await order.enqueue(`${target.id}\u0000${key.sourceSessionId}`, async () => {
				// A runtime that closed while this waited its turn starts nothing it cannot record.
				if (disposed)
					return fail<AnswerValue>(method, 'host-unavailable', 'The runtime is closing.');
				if (timer.expired) {
					return fail<AnswerValue>(
						method,
						'timeout',
						`${target.name} was not asked: an earlier consult ran past the ${Math.round(timeoutMs / 1000)}s wait.`
					);
				}

				// The question is written to the consult tab BEFORE the process starts, so a crash
				// leaves the question and not a silent loss.
				const questionEntry: LogEntryRecord = {
					id: ctx.newId(),
					timestamp: now(),
					source: 'user',
					text: question,
				};
				const opened = await repository.openConsultTab(target.id, {
					key,
					name: buildConsultTabName(sourceName),
					question: questionEntry,
				});
				if (!opened.ok) return opened;
				const tabId = opened.value.tabId;
				// The wait ran out while the question was being written: nothing is started for it.
				if (timer.expired) {
					return fail<AnswerValue>(
						method,
						'timeout',
						`${target.name} did not answer within ${Math.round(timeoutMs / 1000)}s.`
					);
				}

				const request: CrossAgentRequest = {
					...(input.consultChain ? { consultChain: input.consultChain } : {}),
					requestId,
					sourceSessionId: key.sourceSessionId,
					sourceAgentName: sourceName,
					sourceTabId: key.sourceTabId,
					targetSessionId: target.id,
					targetTabId: tabId,
					...(opened.value.resumeAgentSessionId
						? { resumeAgentSessionId: opened.value.resumeAgentSessionId }
						: {}),
					userPrompt: question,
					transcript,
					strategy,
					...(source?.cwd ? { sourceCwd: source.cwd } : {}),
					...(isHandoff ? { handoffAnswer: input.handoffAnswer } : {}),
					createdAt: now(),
				};

				const chunk = await new Promise<CrossAgentResponseChunk>((resolve) => {
					const settings = readSettingsStore(paths.settingsFile);
					void service.start(request, {
						runner: background.consultRunner(),
						resolveAgent: (providerId) => background.resolveAgent(providerId),
						sshStore: background.sshStore,
						getTargetSession: (id) => {
							const found = repository.getAgent(id);
							return found ? (toTargetSession(found) ?? null) : null;
						},
						getCustomEnvVars: (toolType) =>
							agentConfigs()[toolType]?.customEnvVars as Record<string, string> | undefined,
						getAgentConfig: (toolType) => agentConfigs()[toolType],
						writable: writableFor(isHandoff),
						maxConsultationsPerTurn: normalizeMaxConsultationsPerTurn(
							settings.status === 'ok' ? settings.data.maxConsultationsPerTurn : undefined
						),
						consultBudgetStore: { dataDir: paths.userDataDir },
						// The target answers as itself: the system prompt its own chat turn carries.
						getSystemPrompt: (consulted) => {
							const stored = repository.getAgent(consulted.id);
							return loadStandInSystemPrompt(
								stored ? toTurnAgent(stored) : undefined,
								promptSources,
								{
									isSsh: consulted.sshRemoteConfig?.enabled === true,
								}
							);
						},
						onChunk: (piece) => {
							if (piece.done) resolve(piece);
						},
					});
				});

				// A failed or stopped consult keeps what the target managed to say, and the reason after it.
				const note = crossAgentTerminationNote(chunk);
				const shown = chunk.chunk
					? note
						? `${chunk.chunk}\n\n${note}`
						: chunk.chunk
					: (note ?? '');
				const recorded = await repository.recordConsultAnswer(target.id, tabId, {
					entry: {
						id: ctx.newId(),
						timestamp: now(),
						source: chunk.error ? 'error' : 'ai',
						text: shown,
					},
					provider: target.toolType,
					// The service sets this only for a consult that succeeded (B18).
					...(chunk.targetAgentSessionId ? { agentSessionId: chunk.targetAgentSessionId } : {}),
				});
				if (!recorded.ok) {
					logger.warn(
						`The consult answer was not written to ${target.name}'s consult tab: ${recorded.error.message}`,
						LOG_CONTEXT
					);
				}

				// The target keeps a History entry saying who consulted it and about what (W5: no summary pass).
				const consultTab = repository.getTab(target.id, tabId);
				const appended = await history.append(
					target.id,
					buildConsultHistoryEntry({
						entryId: ctx.newId(),
						timestamp: now(),
						sourceAgentName: sourceName,
						subject: deriveConsultSubject(question),
						accumulated: chunk.chunk,
						error: chunk.error,
						canceled: chunk.canceled,
						agentSessionId:
							chunk.targetAgentSessionId ?? str(consultTab?.agentSessionId) ?? undefined,
						consultTabName: consultTab?.name,
						targetName: target.name,
						historySessionId: target.id,
						projectPath: target.cwd,
					})
				);
				if (!appended.ok) {
					logger.warn(
						`The consult's History entry was not written: ${appended.message}`,
						LOG_CONTEXT
					);
				}

				if (chunk.canceled) {
					return timer.expired
						? fail<AnswerValue>(
								method,
								'timeout',
								`${target.name} did not answer within ${Math.round(timeoutMs / 1000)}s and was stopped.`
							)
						: fail(method, 'rejected', `The consult with ${target.name} was stopped.`);
				}
				if (chunk.error) return fail(method, 'failed', chunk.error);
				return ok({ answer: chunk.chunk.trim(), agentName: target.name });
			});
		} finally {
			inFlight -= 1;
			clearTimeout(timer.handle);
		}
	}

	return {
		api: { ask },
		cancelForSource: (agentId) => service.cancelForSource(agentId),
		inFlight: () => inFlight,
		dispose() {
			disposed = true;
			service.cancelAll();
		},
		settled: async () => {
			await Promise.allSettled([...pending]);
		},
	};
}
