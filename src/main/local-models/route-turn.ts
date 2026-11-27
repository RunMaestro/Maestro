/**
 * `routeTurn`: how much model and effort one turn needs, decided by whichever
 * router the `model-routing` task is assigned, inside a hard timeout.
 *
 * The task's one assignment names the router (`modelRouterKind`):
 *
 *   - an embedding model  - the embedding router votes by the prompt's nearest
 *                           labeled prompts (`runEmbeddingRouteTask`);
 *   - a text model        - a local judge answers the task's two `score`
 *                           questions on THAT model (`askLocalJudge`, with the
 *                           task as the owner of the model);
 *   - `system-one`        - the System One engine in force answers the same two
 *                           questions (`runSystemOneTask`).
 *
 * What holds for every caller:
 *
 *   1. **A send never waits past the timeout, and never fails here.** The
 *      answer is a route or a skip with its reason. A router that is slow, down
 *      or broken costs the turn its decision, and the turn runs at the agent's
 *      default tier. The wait is raced against the deadline, because not every
 *      router can be stopped (a model that is still loading finishes loading);
 *      work the deadline overtook is left to end by itself and is not waited
 *      on. An unclassified failure is reported to Sentry and answered as
 *      `unavailable`: a bug in routing must not become a failed send.
 *   2. **No router stands in for another.** An embedding model that will not
 *      load is not answered by asking Jev. The skip names the router assigned.
 *   3. **Every routing that asked a router is in the decision ledger**, under
 *      the task `model-routing`, whichever router it was. `runSystemOneTask`
 *      writes its own record; the two local routers are recorded here, in the
 *      same shape. `off` and a blank prompt ask nothing and record nothing.
 *
 * The embedding router is handed the prompt ALONE: its labeled examples are
 * bare prompts, and the recent exchange would dilute the match. The two
 * routers that read text are handed the recent exchange too, capped and
 * redacted, so a short prompt ("do it") can be judged.
 */

import {
	normalizeModelRoutingText,
	type ModelRouteVote,
} from '../../shared/local-models/model-routing';
import {
	EMBEDDING_ROUTER_ENGINE_ID,
	MODEL_ROUTING_QUESTION_IDS,
	MODEL_ROUTING_TASK_ID,
	MODEL_ROUTING_TIMEOUT_MS,
	modelRouteAnswers,
	modelRouteFromSystemOne,
	modelRouterEngineLabel,
	modelRouterKind,
	modelRoutingSystemOneRequest,
	parseRouteTurnRequest,
	type ModelRoute,
	type ModelRouterKind,
	type ModelRoutingEngine,
	type ModelRoutingInput,
	type ModelRoutingSkipReason,
	type RouteTurnResult,
} from '../../shared/local-models/model-routing-task';
import { taskAssignmentLocation } from '../../shared/local-models/settings-location';
import {
	isSystemOneEngineCalibrated,
	type SystemOneTaskRequest,
	type SystemOneUsage,
} from '../../shared/local-models/system-one';
import type { SystemOneDecisionCode } from '../../shared/local-models/system-one-ledger';
import {
	LOCAL_MODEL_TASKS,
	formatLocalModelAssignmentSpec,
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
	type LocalModelAssignment,
} from '../../shared/local-models/tasks';
import type Store from 'electron-store';

import type { MaestroSettings } from '../stores/types';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { beginSleepAwareSpan, sleepAwareElapsedMs } from '../utils/sleep-tracker';
import { getConfiguredLocalModelEndpoints } from './endpoint-service';
import {
	isLocalModelCancelled,
	isLocalModelEndpointError,
	isLocalModelError,
	isSystemOneError,
} from './errors';
import { getEmbeddingRouter } from './model-router';
import { readLocalModelAssignments, sourceForAssignment } from './sources';
import { keepSystemOneDecision } from './system-one/decisions';
import { askLocalJudge } from './system-one/local-judge';
import { systemOneKeepsInputs } from './system-one/service';
import { runEmbeddingRouteTask, runSystemOneTask } from './task-router';

const LOG_CONTEXT = 'ModelRouting';

const TASK_ID = MODEL_ROUTING_TASK_ID;

/** What one turn hands the router. */
export interface RouteTurnInput extends ModelRoutingInput {
	/** The agent the turn is for, and its AI tab. Kept on the decision record. */
	agent?: { id: string; tabId?: string };
}

export interface RouteTurnOptions {
	/** The most the caller waits. Defaults to {@link MODEL_ROUTING_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** The caller stopped waiting (the send was cancelled). */
	signal?: AbortSignal;
}

/** How one attempt ended, before it is turned into the caller's answer. */
type Attempt =
	| {
			route: ModelRoute;
			engine: ModelRoutingEngine;
			usage?: SystemOneUsage;
			/** True when the path that ran has already kept the decision. */
			recorded: boolean;
	  }
	| {
			skipped: Exclude<ModelRoutingSkipReason, 'off' | 'no-prompt'>;
			/** The ledger's word for why. */
			code: SystemOneDecisionCode;
			detail: string;
			engine?: ModelRoutingEngine;
			recorded: boolean;
	  };

/** What both local routers need to file a decision. */
interface LocalRouter {
	engine: ModelRoutingEngine;
	/** The assigned source, spelled `local:<id>` or `endpoint:<id>:<model>`. */
	model: string;
	/** What the router was given, kept only while "Keep inputs in the ledger" is on. */
	request: SystemOneTaskRequest;
}

const TIMED_OUT = Symbol('timed-out');

/**
 * Decide a tier and an effort for one turn, or say why there is no decision.
 *
 * Never rejects: see rule 1 in the module comment.
 */
export async function routeTurn(
	input: RouteTurnInput,
	options: RouteTurnOptions = {}
): Promise<RouteTurnResult> {
	const span = beginSleepAwareSpan();
	const startedAt = Date.now();
	const elapsed = (): number => sleepAwareElapsedMs(span);
	const task = LOCAL_MODEL_TASKS[TASK_ID];

	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), TASK_ID);
	const kind = modelRouterKind(assignment);
	if (!kind) {
		return {
			skipped: 'off',
			detail: `${task.label} is off. Assign it a router in ${taskAssignmentLocation(TASK_ID)}.`,
			latencyMs: elapsed(),
		};
	}
	const prompt = normalizeModelRoutingText(input.prompt);
	if (!prompt) {
		return { skipped: 'no-prompt', detail: 'There is no prompt to route.', latencyMs: elapsed() };
	}

	if (options.signal?.aborted) {
		// Stopped before anything was asked, so there is nothing to record.
		return { skipped: 'cancelled', detail: CANCELLED_DETAIL, latencyMs: elapsed() };
	}

	const timeoutMs = options.timeoutMs ?? MODEL_ROUTING_TIMEOUT_MS;
	const local = kind === 'system-one' ? null : localRouter(kind, assignment, input, prompt);

	// The deadline is this module's own timer, not the routers': it is the one
	// thing that holds whether or not the work underneath can be stopped.
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), timeoutMs);
	const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
		deadline.signal.addEventListener('abort', () => resolve(TIMED_OUT), { once: true });
	});

	let attempt: Attempt;
	const work = attemptRoute(kind, input, prompt, local, {
		timeoutMs,
		deadline: deadline.signal,
		...(options.signal ? { caller: options.signal } : {}),
	});
	try {
		const settled = await Promise.race([work, timedOut]);
		if (settled === TIMED_OUT) {
			// Overtaken, and possibly still running. It ends by itself; a failure it
			// meets on the way is still a bug worth knowing about.
			work.catch((error) => reportUnexpected(error, kind));
			attempt = {
				skipped: 'timeout',
				code: 'timeout',
				detail: `${local?.engine.label ?? task.label}: no decision within ${timeoutMs} ms.`,
				...(local ? { engine: local.engine } : {}),
				// System One's own budget ends with this one, and it files the timeout.
				recorded: kind === 'system-one',
			};
		} else {
			attempt = settled;
		}
	} catch (error) {
		reportUnexpected(error, kind);
		attempt = {
			skipped: 'unavailable',
			code: 'unavailable',
			detail: `${local?.engine.label ?? task.label} failed: ${error instanceof Error ? error.message : String(error)}`,
			...(local ? { engine: local.engine } : {}),
			// A System One run that threw recorded nothing; neither path did.
			recorded: false,
		};
	} finally {
		clearTimeout(timer);
	}

	const latencyMs = elapsed();
	if (!attempt.recorded) {
		void keepRoutingDecision(attempt, local, {
			startedAt,
			latencyMs,
			...(input.agent ? { agent: input.agent } : {}),
		});
	}
	if ('route' in attempt) {
		return { ...attempt.route, engine: attempt.engine, latencyMs };
	}
	return {
		skipped: attempt.skipped,
		detail: attempt.detail,
		...(attempt.engine ? { engine: attempt.engine } : {}),
		latencyMs,
	};
}

/**
 * `routeTurn` for a request that crossed a process boundary: the renderer's
 * send path (`localModels:routeTurn`) and the CLI (`model_route_turn`). A
 * request that cannot be read is the caller's bug and rejects with what is
 * wrong with it; a routing itself never rejects.
 */
export async function routeTurnRequest(request: unknown): Promise<RouteTurnResult> {
	const parsed = parseRouteTurnRequest(request);
	if (!parsed.ok) throw new Error(parsed.error);
	const { prompt, recent, agentId, tabId, timeoutMs } = parsed.request;
	return routeTurn(
		{
			prompt,
			...(recent ? { recent } : {}),
			...(agentId ? { agent: { id: agentId, ...(tabId ? { tabId } : {}) } } : {}),
		},
		timeoutMs !== undefined ? { timeoutMs } : {}
	);
}

// ---------------------------------------------------------------------------
// The three routers
// ---------------------------------------------------------------------------

interface AttemptSignals {
	timeoutMs: number;
	/** Fires at the hard timeout. */
	deadline: AbortSignal;
	/** Fires when the caller stops waiting. */
	caller?: AbortSignal;
}

const CANCELLED_DETAIL = 'The send was stopped before a router answered.';

function cancelled(engine: ModelRoutingEngine | undefined): Attempt {
	return {
		skipped: 'cancelled',
		code: 'cancelled',
		detail: CANCELLED_DETAIL,
		...(engine ? { engine } : {}),
		recorded: false,
	};
}

/** The router an assigned model makes, and what a record of its decision keeps. */
function localRouter(
	kind: Exclude<ModelRouterKind, 'system-one'>,
	assignment: LocalModelAssignment,
	input: ModelRoutingInput,
	prompt: string
): LocalRouter {
	const name = localModelAssignmentSourceLabel(assignment, getConfiguredLocalModelEndpoints());
	const model = formatLocalModelAssignmentSpec(assignment);
	if (kind === EMBEDDING_ROUTER_ENGINE_ID) {
		return {
			engine: { id: kind, label: modelRouterEngineLabel(kind, name), calibrated: false },
			model,
			// The embedding router reads the prompt and asks no question.
			request: { state: prompt, questions: {} },
		};
	}
	return {
		engine: {
			id: kind,
			label: modelRouterEngineLabel(kind, name),
			calibrated: isSystemOneEngineCalibrated(kind),
		},
		model,
		request: modelRoutingSystemOneRequest(input),
	};
}

function attemptRoute(
	kind: ModelRouterKind,
	input: RouteTurnInput,
	prompt: string,
	local: LocalRouter | null,
	signals: AttemptSignals
): Promise<Attempt> {
	if (kind === 'system-one' || !local) return routeOnSystemOne(input, signals);
	// The agent rides on the run a local router's model leaves (`local_model_runs`).
	const agentId = input.agent?.id;
	return kind === EMBEDDING_ROUTER_ENGINE_ID
		? routeOnEmbeddings(prompt, local, signals, agentId)
		: routeOnLocalJudge(local, signals, agentId);
}

/** The embedding router: the prompt's nearest labeled prompts vote. */
async function routeOnEmbeddings(
	prompt: string,
	local: LocalRouter,
	signals: AttemptSignals,
	agentId: string | undefined
): Promise<Attempt> {
	const { engine } = local;
	const verdict = await runEmbeddingRouteTask(TASK_ID, {
		text: prompt,
		...(agentId ? { agentId } : {}),
		// The router has no budget of its own, so the deadline is its signal too.
		signal: signals.caller ? AbortSignal.any([signals.caller, signals.deadline]) : signals.deadline,
	});
	switch (verdict.status) {
		case 'ok':
			return { route: routeFromVote(verdict.decision), engine, recorded: false };
		case 'cancelled':
			return signals.caller?.aborted
				? cancelled(engine)
				: {
						skipped: 'timeout',
						code: 'timeout',
						detail: `${engine.label}: no decision within ${signals.timeoutMs} ms.`,
						engine,
						recorded: false,
					};
		case 'unavailable':
			return {
				skipped: 'unavailable',
				code: 'unavailable',
				detail: `${engine.label}: could not route. ${verdict.reason}`,
				engine,
				recorded: false,
			};
		case 'off':
			return assignmentChanged(engine);
	}
}

function routeFromVote(vote: ModelRouteVote): ModelRoute {
	return {
		tier: vote.tier,
		effort: vote.effort,
		tierConfidence: vote.tierConfidence,
		effortConfidence: vote.effortConfidence,
	};
}

/** A local judge: the task's own text model answers the two questions. */
async function routeOnLocalJudge(
	local: LocalRouter,
	signals: AttemptSignals,
	agentId: string | undefined
): Promise<Attempt> {
	const { engine, request } = local;
	try {
		const result = await askLocalJudge(request.state, request.questions, {
			taskId: TASK_ID,
			...(agentId ? { agentId } : {}),
			// The judge keeps its own budget, so a deadline reads as `timeout` and
			// only the caller's signal reads as `cancelled`.
			timeoutMs: signals.timeoutMs,
			...(signals.caller ? { signal: signals.caller } : {}),
		});
		const route = modelRouteFromSystemOne(result.answers);
		if (!route) return noRoute(engine, false);
		return { route, engine, usage: result.usage, recorded: false };
	} catch (error) {
		if (!isSystemOneError(error)) throw error;
		if (error.code === 'cancelled') return cancelled(engine);
		return {
			skipped: error.code === 'timeout' ? 'timeout' : 'unavailable',
			code: error.code,
			detail: error.message,
			engine,
			recorded: false,
		};
	}
}

/** System One: the engine in force answers, and the task router keeps the record. */
async function routeOnSystemOne(input: RouteTurnInput, signals: AttemptSignals): Promise<Attempt> {
	const verdict = await runSystemOneTask(
		TASK_ID,
		{ prompt: input.prompt, ...(input.recent ? { recent: input.recent } : {}) },
		{
			timeoutMs: signals.timeoutMs,
			...(signals.caller ? { signal: signals.caller } : {}),
			...(input.agent ? { agentId: input.agent.id } : {}),
			...(input.agent?.tabId ? { tabId: input.agent.tabId } : {}),
		}
	);
	if (verdict.status === 'not-assigned') return assignmentChanged(undefined);

	const engine: ModelRoutingEngine | undefined =
		verdict.engine === 'off'
			? undefined
			: {
					id: verdict.engine,
					label: verdict.engineLabel,
					calibrated: isSystemOneEngineCalibrated(verdict.engine),
				};
	switch (verdict.status) {
		case 'ok': {
			const route = modelRouteFromSystemOne(verdict.answers);
			// `ok` always names an engine; the guard is for the type.
			if (!route || !engine) return noRoute(engine, true);
			return { route, engine, recorded: true };
		}
		case 'cancelled':
			return { ...cancelled(engine), recorded: true };
		case 'failed-open':
		case 'failed-closed':
		case 'unavailable':
			return {
				skipped: verdict.code === 'timeout' ? 'timeout' : 'unavailable',
				code: verdict.code,
				detail: verdict.reason,
				...(engine ? { engine } : {}),
				recorded: true,
			};
	}
}

/** The router answered, and not with a tier and an effort. */
function noRoute(engine: ModelRoutingEngine | undefined, recorded: boolean): Attempt {
	return {
		skipped: 'unavailable',
		code: 'unavailable',
		detail: `${engine?.label ?? LOCAL_MODEL_TASKS[TASK_ID].label}: the answer was not a tier and an effort.`,
		...(engine ? { engine } : {}),
		recorded,
	};
}

/**
 * The assignment was read a moment ago and is another one now: the user changed
 * it while this turn was being routed. Nothing was asked, so nothing is kept.
 */
function assignmentChanged(engine: ModelRoutingEngine | undefined): Attempt {
	return {
		skipped: 'unavailable',
		code: 'unavailable',
		detail: `${LOCAL_MODEL_TASKS[TASK_ID].label} was reassigned while this turn was being routed.`,
		...(engine ? { engine } : {}),
		recorded: true,
	};
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * File a decision one of the two local routers made, in the shape
 * `runSystemOneTask` files its own. Best-effort: a record that cannot be kept
 * never changes what the turn was told.
 */
async function keepRoutingDecision(
	attempt: Attempt,
	local: LocalRouter | null,
	run: { startedAt: number; latencyMs: number; agent?: { id: string; tabId?: string } }
): Promise<void> {
	// A System One run that failed unexpectedly names no router to file under.
	if (!local) return;
	let keepInputs = false;
	try {
		keepInputs = await systemOneKeepsInputs();
	} catch (error) {
		// The setting could not be read. The decision is kept without its text.
		reportUnexpected(error, local.engine.id);
	}
	const answered = 'route' in attempt;
	keepSystemOneDecision(
		{
			taskId: TASK_ID,
			engine: local.engine.id,
			model: local.model,
			questionIds: [...MODEL_ROUTING_QUESTION_IDS],
			startedAt: run.startedAt,
			latencyMs: run.latencyMs,
			...(run.agent ? { agentId: run.agent.id } : {}),
			...(run.agent?.tabId ? { tabId: run.agent.tabId } : {}),
			...(answered
				? {
						outcome: 'ok' as const,
						answers: modelRouteAnswers(attempt.route),
						...(attempt.usage ? { usage: attempt.usage } : {}),
						// Both local routers run on hardware the user already pays for.
						costUsd: 0,
					}
				: {
						outcome: attempt.skipped === 'cancelled' ? ('cancelled' as const) : 'unavailable',
						code: attempt.code,
					}),
		},
		keepInputs ? local.request : null
	);
}

/** A failure no router classified is a bug: logged and sent to Sentry, never thrown at a send. */
function reportUnexpected(error: unknown, router: string): void {
	if (isLocalModelCancelled(error)) return;
	logger.error(`Model routing failed unexpectedly: ${error}`, LOG_CONTEXT, { router });
	void captureException(error instanceof Error ? error : new Error(String(error)), {
		operation: 'modelRouting:routeTurn',
		router,
	});
}

// ---------------------------------------------------------------------------
// Keeping the embedding router's vectors in step with the assignment
// ---------------------------------------------------------------------------

/** The embedding source routing was last seen on. `undefined` before the first look. */
let embeddingRouterKey: string | null | undefined;

/**
 * Bring the embedding router in step with the task's assignment. Call it
 * whenever `localModelAssignments` may have changed.
 *
 * A change TO an embedding model embeds the labeled examples now
 * (`EmbeddingRouter.warm`), so the first routed send does not find the vectors
 * missing and time out. A change away from one drops the vectors. The first
 * look only notes where routing stands: a start is not a change, and loading an
 * embedding model at every start, for sends that may never come, is work
 * nobody asked for.
 */
export function refreshModelRouting(): void {
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), TASK_ID);
	const source =
		modelRouterKind(assignment) === EMBEDDING_ROUTER_ENGINE_ID
			? sourceForAssignment(assignment)
			: null;
	const key = source ? formatLocalModelAssignmentSpec(source) : null;
	if (key === embeddingRouterKey) return;
	const firstLook = embeddingRouterKey === undefined;
	embeddingRouterKey = key;
	if (!source) {
		if (!firstLook) getEmbeddingRouter().reset();
		return;
	}
	if (firstLook) return;
	void getEmbeddingRouter()
		.warm(source)
		.catch((error) => {
			// A model that is not downloaded, or a server that is down, is what the
			// task's readiness reports. Anything else is a bug.
			if (isLocalModelError(error) || isLocalModelEndpointError(error)) {
				logger.info(`The embedding router could not be warmed: ${error.message}`, LOG_CONTEXT);
				return;
			}
			reportUnexpected(error, EMBEDDING_ROUTER_ENGINE_ID);
		});
}

/**
 * Note where routing stands at a start, and follow the setting from there.
 * In-app changes arrive through the store's own change events; a change written
 * by another process (`maestro-cli models assign`) is the settings watcher's to
 * report, by calling {@link refreshModelRouting}.
 */
export function startModelRouting(settingsStore: Store<MaestroSettings>): void {
	refreshModelRouting();
	settingsStore.onDidChange('localModelAssignments', () => refreshModelRouting());
}

/** Forget where routing stood, so each test starts from a fresh process. */
export function resetModelRoutingForTests(): void {
	embeddingRouterKey = undefined;
}
