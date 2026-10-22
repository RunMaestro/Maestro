/**
 * The Local Models task router: the one choke point every housekeeping task
 * goes through before it touches a model.
 *
 * A caller names a task (`tab-naming`, `git-drafts`, ...) and hands over its
 * input: a prompt for a text-generation task ({@link runLocalTask}), texts for
 * an embedding task ({@link runEmbeddingTask}), one text for a classifier task
 * ({@link runClassifierTask}), one clip of audio for a speech-to-text task
 * ({@link runSpeechToTextTask}), one prompt for the embedding router
 * ({@link runEmbeddingRouteTask}). The router reads the user's assignment for that task
 * (`localModelAssignments`, with utility-source inheritance and registry defaults in
 * `src/shared/local-models/tasks.ts`) and answers with one of:
 *
 *   - `off`               - the task does not run. The caller hides or skips it.
 *   - `use-utility-agent` - the caller keeps its EXISTING agent path. The router
 *                           never spawns an agent: that path already exists at
 *                           every caller, honors `utilityAgentId` /
 *                           `utilityModelId`, and a second copy here would drift.
 *   - `ok`                - the assigned local model or endpoint answered.
 *   - `unavailable`       - the assigned source could not run (not downloaded,
 *                           runtime will not load, server down, key missing).
 *                           The reason names that model or endpoint.
 *   - `cancelled`         - the caller aborted.
 *
 * **There is no fallback.** An unavailable local model is never swapped for an
 * endpoint, and nothing here ever reaches for a cloud agent on its own: that
 * would spend money (or ship text somewhere) the user did not choose. The
 * caller decides what an `unavailable` task means for its surface.
 *
 * Every call that reaches a model is recorded in the stats database
 * (`local_model_runs`), success or failure, honoring `statsCollectionEnabled`.
 * A run the Maestro model server answered is filed as `server`, whichever way
 * the assignment named it ({@link localModelRunSourceType}), and a caller that
 * knows which agent a run is for says so ({@link LocalTaskAttribution}).
 *
 * The router also knows when someone is WAITING on a model. A call is
 * interactive unless its caller marks it `background` (the semantic indexer
 * does), and {@link isInteractiveLocalTaskRunning} /
 * {@link whenNoInteractiveLocalTask} let background work stand aside while one
 * is in flight instead of competing with it for the same cores.
 *
 * One assignment is not a model: `system-one` hands the task's typed questions
 * to the System One engine in force. It has its own entry,
 * {@link runSystemOneTask}, which a task that accepts the assignment calls
 * FIRST: it answers `not-assigned` for any other assignment, and the caller
 * then runs its model twin as before. With no answer it applies the task's fail
 * policy; it never asks a different engine, and never falls back to a model.
 */

import { MODEL_SERVER_ENDPOINT_ID } from '../../shared/local-models/model-server';
import { modelsSettingsLocation } from '../../shared/local-models/settings-location';
import type {
	SystemOneEngineId,
	SystemOneErrorCode,
	SystemOneFailPolicy,
	SystemOneResult,
} from '../../shared/local-models/system-one';
import type { SystemOneEngineChoice } from '../../shared/local-models/system-one-settings';
import {
	buildSystemOneTaskRequest,
	isLocalModelTaskId,
	LOCAL_MODEL_TASKS,
	resolveLocalModelAssignment,
	taskAcceptsLocalKind,
	type LocalModelTaskDefinition,
	type LocalModelTaskId,
	type SystemOneTaskId,
	type SystemOneTaskInputs,
} from '../../shared/local-models/tasks';
import type { LocalModelRun, LocalModelRunSourceType } from '../../shared/stats-types';
import { getStatsDB } from '../stats/singleton';
import { isStatsCollectionEnabled, LOG_CONTEXT as STATS_LOG_CONTEXT } from '../stats/utils';
import { getSettingsStore } from '../stores/getters';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { beginSleepAwareSpan, sleepAwareElapsedMs } from '../utils/sleep-tracker';
import { classifyText, type ClassificationResult } from './classifier';
import { embedTexts, type EmbeddingMode } from './embeddings';
import {
	isLocalModelCancelled,
	isLocalModelEndpointError,
	isLocalModelError,
	isSystemOneError,
} from './errors';
import { getEmbeddingRouter, type EmbeddingRouteDecision } from './model-router';
import { readLocalModelAssignments, sourceForAssignment, type LocalModelSource } from './sources';
import { transcribeSpeech } from './speech-to-text';
import { keepSystemOneDecision, type SystemOneDecision } from './system-one/decisions';
import { askResolvedSystemOne, resolveSystemOneForTask } from './system-one/service';
import { generateText } from './text-gen';

/** Token budget when a caller names none. Housekeeping output is short. */
export const DEFAULT_TASK_MAX_TOKENS = 512;

/** The most a caller may ask for. A housekeeping task never needs more. */
export const MAX_TASK_MAX_TOKENS = 8192;

/**
 * Who a run is for. It is recorded with the run (`local_model_runs.agent_id`)
 * and never sent to a model. Every task input carries it; a caller that knows
 * no agent leaves it out.
 */
export interface LocalTaskAttribution {
	agentId?: string;
}

/** What a text-generation task hands the router. */
export interface LocalTaskInput extends LocalTaskAttribution {
	prompt: string;
	system?: string;
	/** Defaults to {@link DEFAULT_TASK_MAX_TOKENS}. */
	maxTokens?: number;
	/** Defaults to 0 (see `generateText`). */
	temperature?: number;
	/** Constrain the reply to a JSON Schema; `json` is set when it parsed. */
	jsonSchema?: Record<string, unknown>;
	/** In-process callers only: an abort signal cannot cross IPC or the CLI bridge. */
	signal?: AbortSignal;
	/**
	 * Nobody is waiting on this call (a Computer History digest). It is not
	 * counted by {@link isInteractiveLocalTaskRunning}. In-process callers only.
	 */
	background?: boolean;
}

export type LocalTaskResult =
	| { status: 'off' }
	| { status: 'use-utility-agent' }
	| {
			status: 'ok';
			text: string;
			json?: unknown;
			source: LocalModelSource;
			durationMs: number;
			tokensIn?: number;
			tokensOut?: number;
	  }
	| LocalTaskUnavailable
	| { status: 'cancelled'; source: LocalModelSource };

/** The assigned source could not run. Shared by every task kind. */
export interface LocalTaskUnavailable {
	status: 'unavailable';
	source: LocalModelSource;
	/** Written for a person; names the model or endpoint and what to do. */
	reason: string;
	/** The classified failure (`model-not-installed`, `network`, ...). */
	code: string;
}

export type LocalTaskStatus = LocalTaskResult['status'];

/** What an embedding task hands the router. */
export interface EmbeddingTaskInput extends LocalTaskAttribution {
	texts: readonly string[];
	/** Which side of a search the texts are on (see `embedTexts`). */
	mode: EmbeddingMode;
	signal?: AbortSignal;
	/**
	 * Nobody is waiting on this call (the semantic indexer's batches). It is not
	 * counted by {@link isInteractiveLocalTaskRunning}, so background work never
	 * holds itself up.
	 */
	background?: boolean;
}

/**
 * An embedding task's verdict. No `use-utility-agent`: an agent cannot produce
 * vectors, so no embedding task accepts that assignment.
 */
export type EmbeddingTaskResult =
	| { status: 'off' }
	| {
			status: 'ok';
			/** One L2-normalized vector per input text, in order. */
			vectors: Float32Array[];
			source: LocalModelSource;
			durationMs: number;
	  }
	| LocalTaskUnavailable
	| { status: 'cancelled'; source: LocalModelSource };

/** What a classifier task hands the router. */
export interface ClassifierTaskInput extends LocalTaskAttribution {
	/** The untrusted text to score. Read in full, however long (see `classifyText`). */
	text: string;
	signal?: AbortSignal;
}

/**
 * A classifier task's verdict. No `use-utility-agent`: no classifier task has
 * an agent path to hand back to.
 */
export type ClassifierTaskResult =
	| { status: 'off' }
	| ({
			status: 'ok';
			source: LocalModelSource;
			durationMs: number;
	  } & ClassificationResult)
	| LocalTaskUnavailable
	| { status: 'cancelled'; source: LocalModelSource };

/** What a speech-to-text task hands the router. */
export interface SpeechToTextTaskInput extends LocalTaskAttribution {
	vocabulary?: readonly string[];
	/** One whole clip of mono audio, normalised to -1..1. */
	audio: Float32Array;
	/** The rate `audio` was captured at. Resampled to 16 kHz by the service. */
	sampleRate: number;
	signal?: AbortSignal;
}

/**
 * A speech-to-text task's verdict. No `use-utility-agent`: an agent cannot hear,
 * so no speech-to-text task accepts that assignment.
 */
export type SpeechToTextTaskResult =
	| { status: 'off' }
	| {
			status: 'ok';
			/** The transcript. Empty when the clip held no speech. */
			text: string;
			/** Length of the clip, in milliseconds. */
			audioMs: number;
			source: LocalModelSource;
			durationMs: number;
	  }
	| LocalTaskUnavailable
	| { status: 'cancelled'; source: LocalModelSource };

/**
 * Run a text-generation task through its assignment.
 *
 * Throws only for a caller bug (a task that is not text-generation) or an
 * unclassified failure inside the engine, which is a bug and belongs in Sentry.
 */
export async function runLocalTask(
	taskId: LocalModelTaskId,
	input: LocalTaskInput
): Promise<LocalTaskResult> {
	requireTaskNeed(taskId, 'text-gen', 'runLocalTask');
	const verdict = await runThroughAssignment(
		taskId,
		(source) =>
			generateText({
				source,
				prompt: input.prompt,
				maxTokens: input.maxTokens ?? DEFAULT_TASK_MAX_TOKENS,
				...(input.system !== undefined ? { system: input.system } : {}),
				...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
				...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
				...(input.signal ? { signal: input.signal } : {}),
			}),
		{
			agentId: input.agentId,
			background: input.background === true,
			metrics: (result) => ({
				durationMs: result.durationMs,
				tokensIn: result.tokensIn,
				tokensOut: result.tokensOut,
				onModelServer: result.servedByModelServer === true,
			}),
		}
	);
	if (verdict.status !== 'ok') return verdict;
	const { value: result, source, durationMs } = verdict;
	return {
		status: 'ok',
		text: result.text,
		...(result.json !== undefined ? { json: result.json } : {}),
		source,
		durationMs,
		...(result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
		...(result.tokensOut !== undefined ? { tokensOut: result.tokensOut } : {}),
	};
}

/**
 * Run an embedding task (`semantic-search`) through its assignment.
 *
 * Throws only for a caller bug (a task that is not an embedding task) or an
 * unclassified failure inside the service.
 */
export async function runEmbeddingTask(
	taskId: LocalModelTaskId,
	input: EmbeddingTaskInput
): Promise<EmbeddingTaskResult> {
	requireTaskNeed(taskId, 'embedding', 'runEmbeddingTask');
	const verdict = await runThroughAssignment(
		taskId,
		(source) =>
			embedTexts(source, input.texts, {
				mode: input.mode,
				...(input.signal ? { signal: input.signal } : {}),
			}),
		{ agentId: input.agentId, background: input.background === true }
	);
	if (verdict.status === 'use-utility-agent') {
		// The registry refuses this assignment for every embedding task.
		throw new Error(`${LOCAL_MODEL_TASKS[taskId].label} cannot run on the Utility Agent.`);
	}
	if (verdict.status !== 'ok') return verdict;
	return {
		status: 'ok',
		vectors: verdict.value,
		source: verdict.source,
		durationMs: verdict.durationMs,
	};
}

/**
 * Run a classifier task (`injection-screen`, `secret-screen`) through its
 * assignment.
 *
 * Throws only for a caller bug (a task that is not a classifier task) or an
 * unclassified failure inside the service.
 */
export async function runClassifierTask(
	taskId: LocalModelTaskId,
	input: ClassifierTaskInput
): Promise<ClassifierTaskResult> {
	requireTaskNeed(taskId, 'classifier', 'runClassifierTask');
	const verdict = await runThroughAssignment(
		taskId,
		(source) => classifyText(source, input.text, input.signal ? { signal: input.signal } : {}),
		{ agentId: input.agentId }
	);
	if (verdict.status === 'use-utility-agent') {
		// The registry refuses this assignment for every classifier task.
		throw new Error(`${LOCAL_MODEL_TASKS[taskId].label} cannot run on the Utility Agent.`);
	}
	if (verdict.status !== 'ok') return verdict;
	return {
		status: 'ok',
		...verdict.value,
		source: verdict.source,
		durationMs: verdict.durationMs,
	};
}

/**
 * Run a speech-to-text task (`dictation`) through its assignment.
 *
 * Throws only for a caller bug (a task that is not a speech-to-text task, a
 * sample rate that is not one) or an unclassified failure inside the service.
 */
export async function runSpeechToTextTask(
	taskId: LocalModelTaskId,
	input: SpeechToTextTaskInput
): Promise<SpeechToTextTaskResult> {
	requireTaskNeed(taskId, 'stt', 'runSpeechToTextTask');
	const verdict = await runThroughAssignment(
		taskId,
		(source) =>
			transcribeSpeech(source, input.audio, input.sampleRate, {
				...(input.signal ? { signal: input.signal } : {}),
				...(input.vocabulary ? { vocabulary: input.vocabulary } : {}),
			}),
		{ agentId: input.agentId }
	);
	if (verdict.status === 'use-utility-agent') {
		// The registry refuses this assignment for every speech-to-text task.
		throw new Error(`${LOCAL_MODEL_TASKS[taskId].label} cannot run on the Utility Agent.`);
	}
	if (verdict.status !== 'ok') return verdict;
	return {
		status: 'ok',
		text: verdict.value.text,
		audioMs: verdict.value.audioMs,
		source: verdict.source,
		durationMs: verdict.durationMs,
	};
}

/** What the embedding router is handed. */
export interface EmbeddingRouteTaskInput extends LocalTaskAttribution {
	/** The prompt to route. The router normalizes it (`normalizeModelRoutingText`). */
	text: string;
	/** Stops the caller's wait. It never stops the build of the example vectors. */
	signal?: AbortSignal;
}

/**
 * The embedding router's verdict. No `use-utility-agent`: an agent cannot
 * produce vectors, so no task that takes an embedding model accepts it.
 */
export type EmbeddingRouteTaskResult =
	| { status: 'off' }
	| {
			status: 'ok';
			decision: EmbeddingRouteDecision;
			source: LocalModelSource;
			durationMs: number;
	  }
	| LocalTaskUnavailable
	| { status: 'cancelled'; source: LocalModelSource };

/**
 * Route one prompt on the embedding model a task is assigned (`model-routing`
 * assigned an embedding model): its nearest labeled prompts vote for a tier and
 * an effort (`getEmbeddingRouter`). The run is recorded like every other, and a
 * source that cannot run is `unavailable` as itself.
 *
 * The caller checks that the assignment IS an embedding model first
 * (`modelRouterKind`): a text model handed here fails as a model that cannot
 * embed, which is `unavailable` too.
 *
 * Throws only for a caller bug (a task that takes no embedding model, no text to
 * route) or an unclassified failure inside the service.
 */
export async function runEmbeddingRouteTask(
	taskId: LocalModelTaskId,
	input: EmbeddingRouteTaskInput
): Promise<EmbeddingRouteTaskResult> {
	const task = LOCAL_MODEL_TASKS[taskId];
	if (!taskAcceptsLocalKind(task, 'embedding')) {
		throw new Error(`${task.label} takes no embedding model; runEmbeddingRouteTask cannot run it.`);
	}
	const verdict = await runThroughAssignment(
		taskId,
		(source) =>
			getEmbeddingRouter().route(source, input.text, input.signal ? { signal: input.signal } : {}),
		{ agentId: input.agentId }
	);
	if (verdict.status === 'use-utility-agent') {
		// The registry refuses this assignment for every such task.
		throw new Error(`${task.label} cannot run on the Utility Agent.`);
	}
	if (verdict.status !== 'ok') return verdict;
	return {
		status: 'ok',
		decision: verdict.value,
		source: verdict.source,
		durationMs: verdict.durationMs,
	};
}

/** What a caller may tell {@link runSystemOneTask} beyond the task's input. */
export interface SystemOneTaskOptions {
	/** In-process callers only. The engine's own budget still applies. */
	signal?: AbortSignal;
	/**
	 * Replaces the engine's stored budget for this one request. For a task that
	 * asks many questions at once while a person watches it work (tab cleanup
	 * asks one per tab, and the local judge answers them one generation each):
	 * the budget sized for one quick decision would fail every such run.
	 */
	timeoutMs?: number;
	/**
	 * A more specific rule the caller holds for this run (a Cue subscription's
	 * `gate_on_unavailable`). It replaces the task's fail policy, so the outcome
	 * recorded is the one that happened.
	 */
	failPolicy?: SystemOneFailPolicy;
	/** The agent this run is for, when the caller knows one. Kept on the decision record. */
	agentId?: string;
	/** The AI tab of that agent whose turn this run is for, when there is one. */
	tabId?: string;
}

/** A run the engine did not answer. It names the engine that was asked, never another. */
export interface SystemOneTaskNoAnswer {
	/** `off` when the task is assigned to System One and no engine is chosen. */
	engine: SystemOneEngineChoice;
	engineLabel: string;
	/** Why there was no answer. `off` when no engine is chosen. */
	code: SystemOneErrorCode | 'off';
	/** Written for a person; names the engine and what to do. */
	reason: string;
}

/**
 * A System One task's verdict.
 *
 *   - `not-assigned`  - the task's assignment is not `system-one`. Nothing was
 *                       asked and nothing was recorded; the caller runs its
 *                       model twin.
 *   - `ok`            - the engine answered every question.
 *   - `failed-open`   - no answer, and the fail policy lets the work go ahead
 *                       unchecked.
 *   - `failed-closed` - no answer, and the fail policy stops the work.
 *   - `unavailable`   - no answer, for a task with no fail policy. The caller
 *                       decides, as it does for every other twin.
 *   - `cancelled`     - the caller aborted.
 */
export type SystemOneTaskResult =
	| { status: 'not-assigned' }
	| ({ status: 'ok'; engineLabel: string } & SystemOneResult)
	| ({ status: 'failed-open' | 'failed-closed' | 'unavailable' } & SystemOneTaskNoAnswer)
	| { status: 'cancelled'; engine: SystemOneEngineId; engineLabel: string };

/**
 * Run a task on System One when that is its assignment.
 *
 * The task's own `systemOneQuestions` turns `input` into typed questions, the
 * engine in force answers them, and the outcome is recorded
 * (`recordSystemOneDecision`). With no answer the task's fail policy applies:
 * no other engine and no model is asked instead. A task assigned to System One
 * while no engine is chosen has nothing to answer it, which is no answer too.
 *
 * Throws only for a caller bug (a task that declares no questions) or an
 * unclassified failure inside an engine, which is a bug and belongs in Sentry.
 */
export async function runSystemOneTask<T extends SystemOneTaskId>(
	taskId: T,
	input: SystemOneTaskInputs[T],
	options: SystemOneTaskOptions = {}
): Promise<SystemOneTaskResult> {
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), taskId);
	if (assignment.type !== 'system-one') return { status: 'not-assigned' };

	const request = buildSystemOneTaskRequest(taskId, input);
	const startedAt = Date.now();
	const span = beginSleepAwareSpan();
	const {
		resolved,
		engineLabel,
		failPolicy: taskPolicy,
		keepInputs,
	} = await resolveSystemOneForTask(taskId);
	const failPolicy = options.failPolicy ?? taskPolicy;
	const decision = (
		rest: Omit<
			SystemOneDecision,
			'taskId' | 'engine' | 'questionIds' | 'startedAt' | 'agentId' | 'tabId' | 'input'
		>
	): void =>
		keepSystemOneDecision(
			{
				taskId,
				engine: resolved.id,
				questionIds: Object.keys(request.questions),
				startedAt,
				...(options.agentId ? { agentId: options.agentId } : {}),
				...(options.tabId ? { tabId: options.tabId } : {}),
				...rest,
			},
			keepInputs ? request : null
		);
	const noAnswer = (code: SystemOneErrorCode | 'off', reason: string): SystemOneTaskResult => {
		const status =
			failPolicy === 'open'
				? 'failed-open'
				: failPolicy === 'closed'
					? 'failed-closed'
					: 'unavailable';
		decision({ outcome: status, code, latencyMs: sleepAwareElapsedMs(span) });
		return { status, engine: resolved.id, engineLabel, code, reason };
	};

	if (resolved.id === 'off') {
		return noAnswer(
			'off',
			`${LOCAL_MODEL_TASKS[taskId].label} is assigned to System One, and System One is off. Choose an engine in ${modelsSettingsLocation('system-one')}.`
		);
	}
	try {
		const result = await askResolvedSystemOne(resolved, request.state, request.questions, {
			...(options.signal ? { signal: options.signal } : {}),
			...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
			...(options.agentId ? { agentId: options.agentId } : {}),
		});
		decision({
			outcome: 'ok',
			model: result.model,
			answers: result.answers,
			latencyMs: result.latencyMs,
			usage: result.usage,
			costUsd: result.costUsd,
		});
		return { status: 'ok', engineLabel, ...result };
	} catch (error) {
		// Anything an engine did not classify is a bug, and stays one.
		if (!isSystemOneError(error)) throw error;
		if (error.code === 'cancelled') {
			decision({ outcome: 'cancelled', code: 'cancelled', latencyMs: sleepAwareElapsedMs(span) });
			return { status: 'cancelled', engine: resolved.id, engineLabel };
		}
		return noAnswer(error.code, error.message);
	}
}

function requireTaskNeed(
	taskId: LocalModelTaskId,
	need: LocalModelTaskDefinition['needs'],
	entry: string
): void {
	const task = LOCAL_MODEL_TASKS[taskId];
	if (task.needs !== need) {
		throw new Error(`${task.label} is a ${task.needs} task; ${entry} runs ${need} tasks only.`);
	}
}

/** What a model call measured, for the stats row. */
interface RunMetrics {
	durationMs?: number;
	tokensIn?: number;
	tokensOut?: number;
	/** The Maestro model server answered a call that named a local model. */
	onModelServer?: boolean;
}

/** What {@link runThroughAssignment} is told beyond the call itself. */
interface AssignedRunOptions<T> extends LocalTaskAttribution {
	/**
	 * For a service that measures its own call (text generation does): the
	 * duration, the token counts, and whether the model server answered. Without
	 * it the router's own sleep-aware span is the duration.
	 */
	metrics?: (value: T) => RunMetrics;
	/** Keeps the call out of the interactive count. */
	background?: boolean;
}

type AssignedVerdict<T> =
	| { status: 'off' }
	| { status: 'use-utility-agent' }
	| { status: 'ok'; value: T; source: LocalModelSource; durationMs: number }
	| LocalTaskUnavailable
	| { status: 'cancelled'; source: LocalModelSource };

/** Interactive calls that have reached a model and not settled yet. */
let interactiveInFlight = 0;

/** Resolved, then dropped, when {@link interactiveInFlight} returns to zero. */
let idleWaiters: Array<() => void> = [];

/** Whether a task someone is waiting on is running on a model right now. */
export function isInteractiveLocalTaskRunning(): boolean {
	return interactiveInFlight > 0;
}

/**
 * Resolves once no interactive task is running: immediately when none is.
 * Background work awaits it between batches, so a search or a tab name never
 * queues behind an index pass for longer than the batch already in flight.
 */
export function whenNoInteractiveLocalTask(): Promise<void> {
	if (interactiveInFlight === 0) return Promise.resolve();
	return new Promise((resolve) => idleWaiters.push(resolve));
}

function endInteractiveCall(): void {
	interactiveInFlight--;
	if (interactiveInFlight > 0) return;
	const waiters = idleWaiters;
	idleWaiters = [];
	for (const resolve of waiters) resolve();
}

/**
 * The part every task kind shares: read the assignment, run the call on its
 * source, classify a failure, and record the run. There is no fallback branch:
 * a source that fails is reported as itself.
 */
async function runThroughAssignment<T>(
	taskId: LocalModelTaskId,
	call: (source: LocalModelSource) => Promise<T>,
	options: AssignedRunOptions<T> = {}
): Promise<AssignedVerdict<T>> {
	const { metrics, background = false, agentId } = options;
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), taskId);
	if (assignment.type === 'system-one') {
		// A caller bug, or a prompt sent by hand (`maestro-cli models run`): an
		// engine answers the task's typed questions, and no model stands in for it.
		throw new Error(
			`${LOCAL_MODEL_TASKS[taskId].label} is assigned to System One, which answers the task's typed questions and takes no prompt (runSystemOneTask runs it).`
		);
	}
	const source = sourceForAssignment(assignment);
	if (!source) return { status: assignment.type === 'off' ? 'off' : 'use-utility-agent' };

	const startedAt = Date.now();
	const span = beginSleepAwareSpan();
	const record = (
		durationMs: number,
		outcome: LocalModelRun['outcome'],
		extra: RunRecordExtra
	): void => recordRun(taskId, source, startedAt, durationMs, outcome, { ...extra, agentId });
	if (!background) interactiveInFlight++;
	try {
		const value = await call(source);
		const measured = metrics?.(value) ?? {};
		const durationMs = measured.durationMs ?? sleepAwareElapsedMs(span);
		record(durationMs, 'ok', {
			tokensIn: measured.tokensIn,
			tokensOut: measured.tokensOut,
			onModelServer: measured.onModelServer,
		});
		return { status: 'ok', value, source, durationMs };
	} catch (error) {
		const durationMs = sleepAwareElapsedMs(span);
		// A local model fails with an endpoint error only when the model server
		// was answering for it: the in-process engine throws `LocalModelError`.
		const onModelServer = isLocalModelEndpointError(error);
		if (isLocalModelCancelled(error)) {
			record(durationMs, 'cancelled', { errorCode: 'cancelled', onModelServer });
			return { status: 'cancelled', source };
		}
		if (isLocalModelError(error)) {
			record(durationMs, 'error', { errorCode: error.code });
			return {
				status: 'unavailable',
				source,
				reason: `${error.message} ${error.recovery}`,
				code: error.code,
			};
		}
		if (isLocalModelEndpointError(error)) {
			record(durationMs, 'error', { errorCode: error.kind, onModelServer });
			return { status: 'unavailable', source, reason: error.message, code: error.kind };
		}
		record(durationMs, 'error', { errorCode: 'unexpected' });
		throw error;
	} finally {
		if (!background) endInteractiveCall();
	}
}

/**
 * The transport-facing entry: IPC (`localModels:runTask`) and the CLI bridge
 * (`maestro-cli models run`) hand over untrusted values, so the task id and
 * input are checked here, once, for both. A bad request throws with a message
 * a person can act on.
 */
export async function runLocalTaskRequest(
	taskId: unknown,
	input: unknown
): Promise<LocalTaskResult> {
	if (!isLocalModelTaskId(taskId)) {
		throw new Error(`Unknown task "${String(taskId)}".`);
	}
	return runLocalTask(taskId, parseLocalTaskInput(input));
}

/** Validate a task input that crossed a process boundary. */
export function parseLocalTaskInput(value: unknown): LocalTaskInput {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Task input must be an object with a prompt.');
	}
	const record = value as Record<string, unknown>;
	if (typeof record.prompt !== 'string' || record.prompt.trim() === '') {
		throw new Error('Task input needs a non-empty prompt.');
	}
	const input: LocalTaskInput = { prompt: record.prompt };

	if (record.system !== undefined) {
		if (typeof record.system !== 'string') throw new Error('system must be a string.');
		input.system = record.system;
	}
	if (record.maxTokens !== undefined) {
		const maxTokens = record.maxTokens;
		if (
			typeof maxTokens !== 'number' ||
			!Number.isInteger(maxTokens) ||
			maxTokens < 1 ||
			maxTokens > MAX_TASK_MAX_TOKENS
		) {
			throw new Error(`maxTokens must be an integer from 1 to ${MAX_TASK_MAX_TOKENS}.`);
		}
		input.maxTokens = maxTokens;
	}
	if (record.temperature !== undefined) {
		const temperature = record.temperature;
		if (typeof temperature !== 'number' || !(temperature >= 0 && temperature <= 2)) {
			throw new Error('temperature must be a number from 0 to 2.');
		}
		input.temperature = temperature;
	}
	if (record.jsonSchema !== undefined) {
		const schema = record.jsonSchema;
		if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
			throw new Error('jsonSchema must be an object.');
		}
		input.jsonSchema = schema as Record<string, unknown>;
	}
	return input;
}

/** What one run adds to the fields every run has. */
interface RunRecordExtra extends LocalTaskAttribution {
	errorCode?: string;
	tokensIn?: number;
	tokensOut?: number;
	/** The Maestro model server answered a call that named a local model. */
	onModelServer?: boolean;
}

/**
 * Where a run is filed (`local_model_runs.source_type`).
 *
 * The Maestro model server is one place however a run reached it: a task
 * assigned to the server's own endpoint, or a task assigned to a local model
 * the running server already holds (`generateText` sends that call to the
 * server instead of opening a second copy). Both are `server`, so the Usage
 * Dashboard counts the server's work once and counts none of it as in-process.
 */
export function localModelRunSourceType(
	source: LocalModelSource,
	onModelServer = false
): LocalModelRunSourceType {
	if (source.type === 'endpoint') {
		return source.endpointId === MODEL_SERVER_ENDPOINT_ID ? 'server' : 'endpoint';
	}
	return onModelServer ? 'server' : 'local';
}

/**
 * Record one run. Best-effort: a stats write that fails must never turn a task
 * that worked into one that did not, so an unexpected failure is reported to
 * Sentry and swallowed (the same contract as multi-window telemetry).
 */
function recordRun(
	taskId: LocalModelTaskId,
	source: LocalModelSource,
	startedAt: number,
	durationMs: number,
	outcome: LocalModelRun['outcome'],
	extra: RunRecordExtra
): void {
	try {
		if (!isStatsCollectionEnabled(getSettingsStore())) return;
		const db = getStatsDB();
		if (!db.isReady()) return;
		const sourceType = localModelRunSourceType(source, extra.onModelServer);
		db.recordLocalModelRun({
			taskId,
			sourceType,
			modelId: source.type === 'local' ? source.modelId : source.model,
			// The server is named by its source type; only a saved endpoint has an id to keep.
			...(source.type === 'endpoint' && sourceType === 'endpoint'
				? { endpointId: source.endpointId }
				: {}),
			...(extra.agentId ? { agentId: extra.agentId } : {}),
			startedAt,
			durationMs,
			outcome,
			...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
			...(extra.tokensIn !== undefined ? { tokensIn: extra.tokensIn } : {}),
			...(extra.tokensOut !== undefined ? { tokensOut: extra.tokensOut } : {}),
		});
	} catch (error) {
		logger.warn(`Failed to record local model run: ${error}`, STATS_LOG_CONTEXT);
		void captureException(error instanceof Error ? error : new Error(String(error)), {
			operation: 'stats:recordLocalModelRun',
			taskId,
		});
	}
}
