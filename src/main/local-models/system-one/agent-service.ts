/**
 * System One for agents: the one function an agent's `maestro-cli s1 yes | pick
 * | rate | ask | rank | batch` reaches.
 *
 * The CLI sends a request over the WS bridge and {@link runAgentSystemOneRequest}
 * answers it. The engine's key is opened in this process (`resolveSystemOneKey`)
 * and never crosses the bridge, so an agent that can ask System One still holds
 * nothing it could ask TypeSafe with by itself.
 *
 * The caller is an agent, which makes it untrusted. In order:
 *
 *   1. **The request is read whole** (`parseSystemOneAgentRequest`). A request
 *      that cannot be read asks nothing and costs nothing.
 *   2. **Off is off.** No engine chosen, "Let agents use System One" switched
 *      off, this agent switched off in its own settings, an engine that cannot
 *      answer as it is set up, or one that has not passed its Test: each is a
 *      refusal that says which, and none sends anything.
 *   3. **The budget.** What agents spend in a local day is capped across all of
 *      them, and optionally per agent. A request over budget is refused by
 *      name. The count is asked again before every request that is SENT, so a
 *      long `rank` stops when the money does and says how far it got.
 *   4. **A long job is split** into requests under the engine's limits, a few
 *      at a time. A `rank` puts each candidate inside its own question, so no
 *      request points at a position in a list.
 *   5. **An answer already given is given again** from the answer cache: no
 *      request, no tokens, no cost, and the answer says it was cached.
 *   6. **Every request is recorded** in the decision ledger under
 *      `agent:<verb>`, with the agent and tab that asked: answered, cached or
 *      failed.
 *   7. **Every answer names its engine** and whether its numbers are
 *      calibrated. No engine is ever asked in place of another.
 *
 * The identity of the caller is what the CLI read from its own environment
 * (`readCallerIdentity`), so it is a claim. It decides the per-agent switch,
 * the per-agent cap and the name on the record. The switches that are not about
 * one agent, and the budget across all agents, hold for a caller that names
 * nobody.
 */

import type { CallerIdentity } from '../../../shared/agentDelegation';
import {
	isSystemOneEngineCalibrated,
	redactSystemOneRequest,
	type SystemOneAnswer,
	type SystemOneAnswers,
	type SystemOneQuestion,
	type SystemOneQuestions,
	type SystemOneState,
	type SystemOneUsage,
} from '../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_AGENT_JUDGE_MAX_TIMEOUT_MS,
	SYSTEM_ONE_AGENT_MAX_KEY_CHARS,
	SYSTEM_ONE_AGENT_TIMEOUT_MS,
	buildSystemOneCompleteness,
	chunkSystemOneQuestions,
	isSystemOneOptedOut,
	parseSystemOneAgentRequest,
	systemOneAgentGateMessage,
	systemOneAgentGateReason,
	systemOneAgentRequestLimits,
	systemOneAgentRequestVerb,
	systemOneAgentSourceId,
	systemOneRankQuestion,
	systemOneRankQuestionId,
	systemOneRankQuestionWarning,
	systemOneRankState,
	type SystemOneAgentAccess,
	type SystemOneAgentAnswerMeta,
	type SystemOneAgentAskRequest,
	type SystemOneAgentBatchRequest,
	type SystemOneAgentBudget,
	type SystemOneAgentGate,
	type SystemOneAgentGateDetail,
	type SystemOneAgentRankRequest,
	type SystemOneAgentRefusal,
	type SystemOneAgentRefusalCode,
	type SystemOneAgentResponse,
	type SystemOneAgentVerb,
	type SystemOneBatchResultRow,
	type SystemOneCompletenessError,
	type SystemOneRankResult,
} from '../../../shared/local-models/system-one-agent';
import {
	SYSTEM_ONE_LEDGER_RETENTION_DAYS,
	SYSTEM_ONE_LEDGER_RETENTION_MS,
	type SystemOneDecision,
} from '../../../shared/local-models/system-one-ledger';
import type { SystemOneAgentSettings } from '../../../shared/local-models/system-one-settings';
import {
	parseSystemOneUsageQuery,
	sumSystemOneUsage,
	type SystemOneUsageReport,
} from '../../../shared/local-models/system-one-spend';
import { mapWithConcurrency } from '../../utils/concurrency';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { beginSleepAwareSpan, sleepAwareElapsedMs } from '../../utils/sleep-tracker';
import { isSystemOneError } from '../errors';
import {
	readCachedSystemOneAnswer,
	storeCachedSystemOneAnswer,
	systemOneCacheKey,
	type SystemOneCacheScope,
} from './answer-cache';
import { keepSystemOneDecision, readSystemOneAgentSpend, systemOneLedgerNotice } from './decisions';
import {
	askResolvedSystemOne,
	resolveSystemOneForAgents,
	systemOneDataDir,
	type ResolvedSystemOneEngine,
	type SystemOneForAgents,
} from './service';

const LOG_CONTEXT = 'SystemOne';

/** Requests in flight at once on a remote engine. The local judge has one model: one at a time. */
const REMOTE_CONCURRENCY = 4;

/**
 * The gap between two requests SENT by one job. It holds a long `batch` near
 * 1,000 requests a minute, under the hosted API's published 1,200, so a job is
 * not failed by its own speed. A cached answer sends nothing and does not wait.
 */
export const SYSTEM_ONE_AGENT_REQUEST_SPACING_MS = 60;

// ---------------------------------------------------------------------------
// The app's services
// ---------------------------------------------------------------------------

export interface AgentSystemOneDeps {
	/** The stored agent records (the main-process sessions store). */
	sessions?: () => Array<Record<string, unknown>>;
	/** The clock a day's budget is counted by. Defaults to `Date.now`. */
	now?: () => number;
	/** The wait between two sent requests. A seam for tests. */
	sleep?: (ms: number) => Promise<void>;
	/** The clock that wait is measured on. Defaults to `performance.now`. A seam for tests. */
	monotonicNow?: () => number;
}

let deps: AgentSystemOneDeps = {};

/** Point the agent service at the app's stores. Reads nothing and sends nothing. */
export function configureAgentSystemOne(next: AgentSystemOneDeps): void {
	deps = next;
}

function clock(): number {
	return (deps.now ?? Date.now)();
}

function sleep(ms: number): Promise<void> {
	return (deps.sleep ?? ((wait: number) => new Promise((resolve) => setTimeout(resolve, wait))))(
		ms
	);
}

/** The stored record of one agent, or undefined when there is none. */
function agentRecord(agentId: string): Record<string, unknown> | undefined {
	return deps.sessions?.().find((record) => record?.id === agentId);
}

// ---------------------------------------------------------------------------
// The caller
// ---------------------------------------------------------------------------

/** Who a request is counted against and recorded for. Empty for a caller that names nobody. */
interface Caller {
	agentId?: string;
	tabId?: string;
}

function clipId(value: unknown): string {
	return typeof value === 'string' ? value.trim().slice(0, SYSTEM_ONE_AGENT_MAX_KEY_CHARS) : '';
}

/** The caller as it is kept: trimmed and bounded, and a tab only with its agent. */
function readCaller(caller: CallerIdentity | undefined): Caller {
	const agentId = clipId(caller?.agentId);
	if (!agentId) return {};
	const tabId = clipId(caller?.tabId);
	return tabId ? { agentId, tabId } : { agentId };
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/** What agents have spent since a local midnight. */
interface SpendTally {
	dayStartedAt: number;
	/** True once the day's earlier spend was read from the ledger. */
	seeded: boolean;
	total: number;
	perAgent: Map<string, number>;
}

let tally: SpendTally | null = null;

function startOfLocalDay(now: number): number {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
}

/**
 * Add what the ledger holds for the day to the count, once.
 *
 * The ledger is how a day's spend survives a restart. It is read once per day
 * and per process: after that this process counts what it spends itself, which
 * is also what keeps the budget working while usage statistics are switched off
 * and the ledger keeps nothing new (the count then restarts when Maestro does).
 * A database that is not open yet leaves the count unseeded, and the next
 * request tries again; `max` keeps a late read from counting a request twice.
 */
function seedTally(target: SpendTally): void {
	let rows: ReturnType<typeof readSystemOneAgentSpend>;
	try {
		rows = readSystemOneAgentSpend(target.dayStartedAt);
	} catch (error) {
		// The budget still holds on what this process counted; the read is a bug to hear about.
		logger.warn(`Could not read today's System One spend: ${error}`, LOG_CONTEXT);
		void captureException(error instanceof Error ? error : new Error(String(error)), {
			operation: 'systemOne:agentSpend',
		});
		return;
	}
	if (rows === null) return;
	let total = 0;
	for (const row of rows) {
		total += row.costUsd;
		if (row.agentId !== null) {
			target.perAgent.set(
				row.agentId,
				Math.max(target.perAgent.get(row.agentId) ?? 0, row.costUsd)
			);
		}
	}
	target.total = Math.max(target.total, total);
	target.seeded = true;
}

function currentTally(now: number): SpendTally {
	const dayStartedAt = startOfLocalDay(now);
	if (!tally || tally.dayStartedAt !== dayStartedAt) {
		tally = { dayStartedAt, seeded: false, total: 0, perAgent: new Map() };
	}
	if (!tally.seeded) seedTally(tally);
	return tally;
}

function addSpend(caller: Caller, costUsd: number): void {
	if (!(costUsd > 0)) return;
	const day = currentTally(clock());
	day.total += costUsd;
	if (caller.agentId) {
		day.perAgent.set(caller.agentId, (day.perAgent.get(caller.agentId) ?? 0) + costUsd);
	}
}

/** Today's spend against the budgets, for all agents and for the caller. */
function budgetSnapshot(settings: SystemOneAgentSettings, caller: Caller): SystemOneAgentBudget {
	const day = currentTally(clock());
	const budget: SystemOneAgentBudget = {
		dayStartedAt: day.dayStartedAt,
		dailyBudgetUsd: settings.dailyBudgetUsd,
		spentTodayUsd: day.total,
		remainingTodayUsd: Math.max(0, settings.dailyBudgetUsd - day.total),
	};
	if (caller.agentId) {
		const spent = day.perAgent.get(caller.agentId) ?? 0;
		const cap = settings.perAgentBudgetUsd;
		budget.agent = {
			agentId: caller.agentId,
			budgetUsd: cap,
			spentTodayUsd: spent,
			remainingTodayUsd: cap === null ? null : Math.max(0, cap - spent),
		};
	}
	return budget;
}

/** The budget that is spent, or null while there is room in both. */
function spentBudget(budget: SystemOneAgentBudget): 'budget-day' | 'budget-agent' | null {
	if (budget.spentTodayUsd >= budget.dailyBudgetUsd) return 'budget-day';
	const own = budget.agent;
	if (own && own.budgetUsd !== null && own.spentTodayUsd >= own.budgetUsd) return 'budget-agent';
	return null;
}

// ---------------------------------------------------------------------------
// The switches
// ---------------------------------------------------------------------------

/**
 * The switch that refuses this caller, or null. What the user switched off
 * comes first: it is the answer whatever state the engine is in.
 */
function accessGate(setup: SystemOneForAgents, caller: Caller): SystemOneAgentGate | null {
	const { resolved } = setup;
	if (resolved.id === 'off') return 'engine-off';
	if (!setup.agents.enabled) return 'agents-off';
	if (caller.agentId && isSystemOneOptedOut(agentRecord(caller.agentId))) return 'agent-opted-out';
	if (resolved.refusal) return 'engine-not-ready';
	if (setup.testPassedAt === null) return 'engine-untested';
	return null;
}

/** What a gate's sentence is worded from: the engine, why it cannot answer, and the day's count. */
function gateDetail(
	setup: SystemOneForAgents,
	budget: SystemOneAgentBudget
): SystemOneAgentGateDetail {
	const { resolved } = setup;
	return {
		engineLabel: setup.engineLabel,
		problem: resolved.id === 'off' ? null : (resolved.refusal?.message ?? null),
		budget,
	};
}

function gateMessage(
	gate: SystemOneAgentGate,
	setup: SystemOneForAgents,
	budget: SystemOneAgentBudget
): string {
	return systemOneAgentGateMessage(gate, gateDetail(setup, budget));
}

/**
 * Whether an agent's request would be answered right now, and by which engine.
 * Reads the settings, the key and the day's count; sends nothing. `agentId` is
 * the agent asked about; without one, the switches that are not about one agent
 * are what is reported.
 */
export async function getSystemOneAgentAccess(agentId?: string): Promise<SystemOneAgentAccess> {
	const caller = readCaller(agentId ? { agentId } : undefined);
	const setup = await resolveSystemOneForAgents();
	const budget = budgetSnapshot(setup.agents, caller);
	const gate = accessGate(setup, caller) ?? spentBudget(budget);
	return {
		allowed: gate === null,
		gate,
		message: gate ? gateMessage(gate, setup, budget) : null,
		reason: gate ? systemOneAgentGateReason(gate, gateDetail(setup, budget)) : null,
		engine: setup.resolved.id,
		engineLabel: setup.engineLabel,
		calibrated: setup.resolved.id === 'off' ? null : isSystemOneEngineCalibrated(setup.resolved.id),
		budget,
	};
}

/**
 * {@link getSystemOneAgentAccess} for an agent id as a surface sends it: the
 * one function the renderer's IPC channel and the CLI's WS message both call,
 * so the system prompt builders of all three processes read one answer. An id
 * that is not text reads as "no agent named".
 */
export function getSystemOneAgentAccessRequest(rawAgentId: unknown): Promise<SystemOneAgentAccess> {
	return getSystemOneAgentAccess(typeof rawAgentId === 'string' ? rawAgentId : undefined);
}

/**
 * What agents' own requests came to since a time, per agent, with today's spend
 * against the budget: what `maestro-cli s1 usage` prints. Read from the decision
 * ledger and the day's count; sends nothing. A query that cannot be read
 * rejects with the reason.
 *
 * `callerAgentId` is the agent that asked, when one did: with no agent named in
 * the query, the budget is reported with that agent's own count beside the
 * day's.
 */
export async function readSystemOneAgentUsage(
	raw: unknown,
	callerAgentId?: string
): Promise<SystemOneUsageReport> {
	const parsed = parseSystemOneUsageQuery(raw);
	if (!parsed.ok) throw new Error(parsed.message);
	const { query } = parsed;
	const since = Math.max(query.since ?? 0, clock() - SYSTEM_ONE_LEDGER_RETENTION_MS);
	const access = await getSystemOneAgentAccess(query.agentId ?? callerAgentId);

	const spend = readSystemOneAgentSpend(since) ?? [];
	const rows = spend
		.filter((row) => query.agentId === undefined || row.agentId === query.agentId)
		.map((row) => {
			const name = row.agentId === null ? undefined : agentRecord(row.agentId)?.name;
			return { ...row, agentName: typeof name === 'string' && name !== '' ? name : null };
		});
	return {
		since,
		retentionDays: SYSTEM_ONE_LEDGER_RETENTION_DAYS,
		rows,
		totals: sumSystemOneUsage(rows),
		budget: access.budget,
		engine: access.engine,
		engineLabel: access.engineLabel,
		notice: systemOneLedgerNotice(),
	};
}

// ---------------------------------------------------------------------------
// One request to the engine
// ---------------------------------------------------------------------------

type ReadyEngine = Exclude<ResolvedSystemOneEngine, { id: 'off' }>;

/** What every request of one call shares. */
interface CallContext {
	verb: SystemOneAgentVerb;
	setup: SystemOneForAgents;
	engine: ReadyEngine;
	scope: SystemOneCacheScope;
	caller: Caller;
	noCache: boolean;
	signal?: AbortSignal;
	/** Waits for this request's turn to be sent. Absent for a call that is one request. */
	pace?: () => Promise<void>;
}

/** How one request ended. */
type RequestOutcome =
	| {
			status: 'answered';
			answers: SystemOneAnswers;
			model: string;
			cached: boolean;
			usage: SystemOneUsage;
			costUsd: number;
			redacted: boolean;
	  }
	/** The engine was asked and gave no answer. */
	| { status: 'failed'; code: SystemOneAgentRefusalCode; message: string }
	/** Not sent: the budget is spent. */
	| { status: 'over-budget'; gate: 'budget-day' | 'budget-agent'; message: string }
	/** Not sent: an earlier request of the same job ended it. */
	| { status: 'skipped' };

function requestTimeoutMs(engine: ReadyEngine, questionCount: number): number {
	if (engine.id === 'local-judge') {
		return Math.min(engine.timeoutMs * questionCount, SYSTEM_ONE_AGENT_JUDGE_MAX_TIMEOUT_MS);
	}
	return Math.max(engine.timeoutMs, SYSTEM_ONE_AGENT_TIMEOUT_MS);
}

/** Record one request of a call. Never throws (`keepSystemOneDecision`). */
function record(
	context: CallContext,
	state: SystemOneState,
	questions: SystemOneQuestions,
	rest: Pick<SystemOneDecision, 'outcome' | 'startedAt' | 'latencyMs'> &
		Partial<Pick<SystemOneDecision, 'model' | 'answers' | 'code' | 'usage' | 'costUsd' | 'cached'>>
): void {
	keepSystemOneDecision(
		{
			taskId: systemOneAgentSourceId(context.verb),
			engine: context.engine.id,
			questionIds: Object.keys(questions),
			...(context.caller.agentId ? { agentId: context.caller.agentId } : {}),
			...(context.caller.tabId ? { tabId: context.caller.tabId } : {}),
			...rest,
		},
		context.setup.keepInputs ? { state, questions } : null
	);
}

/**
 * Answer one request: from the cache when it holds it, else from the engine.
 *
 * The budget is asked here, before a request is sent, and not for a cached
 * answer, which costs nothing. Rejects only for a failure no engine classified,
 * which is a bug and belongs in Sentry.
 */
async function answerRequest(
	context: CallContext,
	state: SystemOneState,
	questions: SystemOneQuestions
): Promise<RequestOutcome> {
	const { engine, scope, caller } = context;
	// The key is of the request as it is sent, so a secret is never hashed into a file name.
	const sent = redactSystemOneRequest(state, questions);
	const key = systemOneCacheKey(scope, sent.state, sent.questions);
	const startedAt = clock();

	if (!context.noCache) {
		const hit = await readCachedSystemOneAnswer(
			systemOneDataDir(),
			key,
			scope,
			questions,
			startedAt
		);
		if (hit) {
			const usage = { inputTokens: 0, outputTokens: 0 };
			record(context, state, questions, {
				outcome: 'ok',
				startedAt,
				latencyMs: 0,
				model: hit.model,
				answers: hit.answers,
				usage,
				costUsd: 0,
				cached: true,
			});
			return {
				status: 'answered',
				answers: hit.answers,
				model: hit.model,
				cached: true,
				usage,
				costUsd: 0,
				redacted: sent.redacted,
			};
		}
	}

	const budget = budgetSnapshot(context.setup.agents, caller);
	const spent = spentBudget(budget);
	if (spent) {
		return {
			status: 'over-budget',
			gate: spent,
			message: gateMessage(spent, context.setup, budget),
		};
	}

	await context.pace?.();
	const span = beginSleepAwareSpan();
	try {
		const result = await askResolvedSystemOne(engine, state, questions, {
			timeoutMs: requestTimeoutMs(engine, Object.keys(questions).length),
			...(context.signal ? { signal: context.signal } : {}),
			...(caller.agentId ? { agentId: caller.agentId } : {}),
		});
		addSpend(caller, result.costUsd);
		await storeCachedSystemOneAnswer(systemOneDataDir(), key, {
			storedAt: clock(),
			engine: result.engine,
			model: result.model,
			answers: result.answers,
		});
		record(context, state, questions, {
			outcome: 'ok',
			startedAt,
			latencyMs: result.latencyMs,
			model: result.model,
			answers: result.answers,
			usage: result.usage,
			costUsd: result.costUsd,
		});
		return {
			status: 'answered',
			answers: result.answers,
			model: result.model,
			cached: false,
			usage: result.usage,
			costUsd: result.costUsd,
			redacted: result.redacted,
		};
	} catch (error) {
		// Anything an engine did not classify is a bug, and stays one.
		if (!isSystemOneError(error)) throw error;
		record(context, state, questions, {
			outcome: error.code === 'cancelled' ? 'cancelled' : 'unavailable',
			code: error.code,
			startedAt,
			latencyMs: sleepAwareElapsedMs(span),
		});
		return { status: 'failed', code: error.code, message: error.message };
	}
}

// ---------------------------------------------------------------------------
// Many requests
// ---------------------------------------------------------------------------

/** Lets one request start every {@link SYSTEM_ONE_AGENT_REQUEST_SPACING_MS}. */
function createPacer(): () => Promise<void> {
	let nextAt = 0;
	return async () => {
		const now = (deps.monotonicNow ?? (() => performance.now()))();
		const startAt = Math.max(now, nextAt);
		nextAt = startAt + SYSTEM_ONE_AGENT_REQUEST_SPACING_MS;
		if (startAt > now) await sleep(startAt - now);
	};
}

/**
 * A failure that ends a job: every request after it would fail the same way.
 * A refused key is refused for all of them, and a cancelled call is over.
 */
function endsJob(outcome: RequestOutcome): boolean {
	if (outcome.status === 'over-budget') return true;
	return outcome.status === 'failed' && (outcome.code === 'auth' || outcome.code === 'cancelled');
}

interface Job {
	state: SystemOneState;
	questions: SystemOneQuestions;
}

/**
 * Run a job's requests, a few at a time, and answer with how each ended, in
 * order. A request that fails does not stop the others, unless it is a failure
 * every one of them would repeat ({@link endsJob}); the ones not sent are
 * `skipped`.
 */
async function runJobs(context: CallContext, jobs: Job[]): Promise<RequestOutcome[]> {
	const paced: CallContext = { ...context, pace: createPacer() };
	const concurrency = context.engine.id === 'local-judge' ? 1 : REMOTE_CONCURRENCY;
	let ended = false;
	return mapWithConcurrency(jobs, concurrency, async (job): Promise<RequestOutcome> => {
		if (ended) return { status: 'skipped' };
		const outcome = await answerRequest(paced, job.state, job.questions);
		if (endsJob(outcome)) ended = true;
		return outcome;
	});
}

/** What a job's requests came to, for the answer's own account of itself. */
interface JobTotals {
	model: string;
	answered: number;
	cachedRequests: number;
	failedRequests: number;
	skippedRequests: number;
	tokens: SystemOneUsage;
	costUsd: number;
	redacted: boolean;
	errors: SystemOneCompletenessError[];
}

function totalsOf(outcomes: RequestOutcome[]): JobTotals {
	const totals: JobTotals = {
		model: '',
		answered: 0,
		cachedRequests: 0,
		failedRequests: 0,
		skippedRequests: 0,
		tokens: { inputTokens: 0, outputTokens: 0 },
		costUsd: 0,
		redacted: false,
		errors: [],
	};
	const note = (code: SystemOneAgentRefusalCode, message: string): void => {
		const same = totals.errors.find((error) => error.code === code && error.message === message);
		if (same) same.requests += 1;
		else totals.errors.push({ code, message, requests: 1 });
	};
	for (const outcome of outcomes) {
		switch (outcome.status) {
			case 'answered':
				totals.answered += 1;
				if (outcome.cached) totals.cachedRequests += 1;
				if (!totals.model) totals.model = outcome.model;
				totals.tokens.inputTokens += outcome.usage.inputTokens;
				totals.tokens.outputTokens += outcome.usage.outputTokens;
				totals.costUsd += outcome.costUsd;
				totals.redacted ||= outcome.redacted;
				break;
			case 'failed':
				totals.failedRequests += 1;
				note(outcome.code, outcome.message);
				break;
			case 'over-budget':
				totals.skippedRequests += 1;
				note('budget', outcome.message);
				break;
			case 'skipped':
				totals.skippedRequests += 1;
				break;
		}
	}
	return totals;
}

/** What every answer says about itself. */
function answerMeta(
	context: CallContext,
	totals: Pick<
		JobTotals,
		'model' | 'answered' | 'cachedRequests' | 'tokens' | 'costUsd' | 'redacted'
	>,
	latencyMs: number
): SystemOneAgentAnswerMeta {
	return {
		engine: context.engine.id,
		engineLabel: context.setup.engineLabel,
		calibrated: isSystemOneEngineCalibrated(context.engine.id),
		model: totals.model,
		cached: totals.answered > 0 && totals.cachedRequests === totals.answered,
		latencyMs,
		tokens: totals.tokens,
		costUsd: totals.costUsd,
		redacted: totals.redacted,
		budget: budgetSnapshot(context.setup.agents, context.caller),
	};
}

// ---------------------------------------------------------------------------
// The three kinds of request
// ---------------------------------------------------------------------------

function refusal(
	context: CallContext,
	code: SystemOneAgentRefusalCode,
	message: string,
	gate?: SystemOneAgentGate
): SystemOneAgentRefusal {
	return {
		ok: false,
		code,
		...(gate ? { gate } : {}),
		message,
		engine: context.engine.id,
		engineLabel: context.setup.engineLabel,
		budget: budgetSnapshot(context.setup.agents, context.caller),
	};
}

async function runAsk(
	context: CallContext,
	request: SystemOneAgentAskRequest
): Promise<SystemOneAgentResponse> {
	const started = performance.now();
	const outcome = await answerRequest(context, request.state, request.questions);
	if (outcome.status === 'failed') return refusal(context, outcome.code, outcome.message);
	if (outcome.status === 'over-budget') {
		return refusal(context, 'budget', outcome.message, outcome.gate);
	}
	if (outcome.status === 'skipped') throw new Error('A single request is never skipped.');
	return {
		ok: true,
		kind: 'ask',
		verb: request.verb,
		answers: outcome.answers,
		...answerMeta(
			context,
			totalsOf([outcome]),
			outcome.cached ? 0 : Math.round(performance.now() - started)
		),
	};
}

/** A candidate's answer as a place in the ranking: 0 to 1, whatever the question's type. */
function rankResult(
	key: string,
	question: SystemOneQuestion,
	answer: SystemOneAnswer
): SystemOneRankResult | null {
	if (question.type === 'noul' && answer.type === 'noul') return { key, p: answer.probability };
	if (question.type === 'score' && answer.type === 'score') {
		return {
			key,
			p: answer.score / (question.criteria.length - 1),
			score: answer.score,
			...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
		};
	}
	return null;
}

async function runRank(
	context: CallContext,
	request: SystemOneAgentRankRequest
): Promise<SystemOneAgentResponse> {
	const started = performance.now();
	const state = systemOneRankState(request);
	// Each candidate is INSIDE its own question. The id is how its answer is
	// found again, by lookup; no engine is ever asked about a position.
	const keyed = request.candidates.map((candidate, ordinal) => ({
		key: candidate.key,
		id: systemOneRankQuestionId(ordinal),
		question: systemOneRankQuestion(request, candidate.item),
	}));
	const chunks = chunkSystemOneQuestions(
		state,
		keyed.map(({ id, question }) => [id, question] as const),
		systemOneAgentRequestLimits(context.engine.id)
	);
	const outcomes = await runJobs(
		context,
		chunks.map((questions) => ({ state, questions }))
	);

	const answers = new Map<string, SystemOneAnswer>();
	outcomes.forEach((outcome) => {
		if (outcome.status !== 'answered') return;
		for (const [id, answer] of Object.entries(outcome.answers)) answers.set(id, answer);
	});
	const ranked: SystemOneRankResult[] = [];
	const unjudged: string[] = [];
	for (const { key, id, question } of keyed) {
		const answer = answers.get(id);
		const result = answer ? rankResult(key, question, answer) : null;
		if (result) ranked.push(result);
		else unjudged.push(key);
	}
	// `sort` is stable: candidates that tie keep the order they were given in.
	ranked.sort((a, b) => b.p - a.p);
	const { min, top } = request;
	const kept = min === undefined ? ranked : ranked.filter((result) => result.p >= min);
	const results = top === undefined ? kept : kept.slice(0, top);

	const totals = totalsOf(outcomes);
	const warning = systemOneRankQuestionWarning(request.instructions);
	return {
		ok: true,
		kind: 'rank',
		results,
		unjudged,
		completeness: buildSystemOneCompleteness(
			'rank',
			{
				total: keyed.length,
				judged: ranked.length,
				requests: chunks.length,
				failedRequests: totals.failedRequests,
				skippedRequests: totals.skippedRequests,
				errors: totals.errors,
			},
			results.length
		),
		cachedRequests: totals.cachedRequests,
		warnings: warning ? [warning] : [],
		...answerMeta(context, totals, Math.round(performance.now() - started)),
	};
}

async function runBatch(
	context: CallContext,
	request: SystemOneAgentBatchRequest
): Promise<SystemOneAgentResponse> {
	const started = performance.now();
	const outcomes = await runJobs(
		context,
		request.rows.map((row) => ({ state: row.state, questions: request.questions }))
	);
	const totals = totalsOf(outcomes);
	// A row that was never sent says why the job ended, so no row is left with no reason.
	const ended = totals.errors.find(
		(error) => error.code === 'budget' || error.code === 'auth' || error.code === 'cancelled'
	);
	const rows = request.rows.map((row, index): SystemOneBatchResultRow => {
		const from = { line: row.line, ...(row.id !== undefined ? { id: row.id } : {}) };
		const outcome = outcomes[index];
		switch (outcome.status) {
			case 'answered':
				return { ...from, answers: outcome.answers, cached: outcome.cached };
			case 'failed':
				return { ...from, error: { code: outcome.code, message: outcome.message } };
			case 'over-budget':
				return { ...from, error: { code: 'budget', message: outcome.message } };
			case 'skipped':
				return {
					...from,
					error: {
						code: ended?.code ?? 'unavailable',
						message: `Not sent. ${ended?.message ?? 'An earlier request ended the job.'}`,
					},
				};
		}
	});
	return {
		ok: true,
		kind: 'batch',
		rows,
		completeness: buildSystemOneCompleteness('batch', {
			total: rows.length,
			judged: totals.answered,
			requests: rows.length,
			failedRequests: totals.failedRequests,
			skippedRequests: totals.skippedRequests,
			errors: totals.errors,
		}),
		cachedRequests: totals.cachedRequests,
		...answerMeta(context, totals, Math.round(performance.now() - started)),
	};
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Answer one request from an agent's `maestro-cli s1` verb.
 *
 * Resolves with typed answers that name the engine, or with a refusal that
 * names why there are none: a request that cannot be read (`invalid`), a switch
 * (`off`), the budget (`budget`), or the engine's own failure code. A `rank` or
 * a `batch` resolves with whatever it judged and a completeness record; an item
 * with no answer is unknown, never a low score.
 *
 * `caller` is the agent and tab the CLI says it is running under. Rejects only
 * for a failure no engine classified, which is a bug.
 */
export async function runAgentSystemOneRequest(
	raw: unknown,
	caller: CallerIdentity | undefined,
	options: { signal?: AbortSignal } = {}
): Promise<SystemOneAgentResponse> {
	const parsed = parseSystemOneAgentRequest(raw);
	if (!parsed.ok) return { ok: false, code: 'invalid', message: parsed.message };
	const { request } = parsed;
	const who = readCaller(caller);

	const setup = await resolveSystemOneForAgents();
	const budget = budgetSnapshot(setup.agents, who);
	const gate = accessGate(setup, who);
	const spent = gate ? null : spentBudget(budget);
	const refused = gate ?? spent;
	const { resolved } = setup;
	if (refused || resolved.id === 'off') {
		const by = refused ?? 'engine-off';
		logger.debug('System One refused an agent request', LOG_CONTEXT, {
			gate: by,
			verb: systemOneAgentRequestVerb(request),
			...(who.agentId ? { agentId: who.agentId } : {}),
		});
		return {
			ok: false,
			code: spent ? 'budget' : 'off',
			gate: by,
			message: gateMessage(by, setup, budget),
			...(resolved.id !== 'off' ? { engine: resolved.id, engineLabel: setup.engineLabel } : {}),
			budget,
		};
	}

	const context: CallContext = {
		verb: systemOneAgentRequestVerb(request),
		setup,
		engine: resolved,
		scope: { engine: resolved.id, ...setup.cacheScope },
		caller: who,
		noCache: request.noCache === true,
		...(options.signal ? { signal: options.signal } : {}),
	};
	switch (request.kind) {
		case 'ask':
			return runAsk(context, request);
		case 'rank':
			return runRank(context, request);
		case 'batch':
			return runBatch(context, request);
	}
}

/** Forget the configured stores and the day's count, so each test starts from a fresh process. */
export function resetAgentSystemOneForTests(): void {
	deps = {};
	tally = null;
}
