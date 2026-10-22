/**
 * The System One decision ledger: one record per request that was handed to an
 * engine, and the words every surface uses to read them.
 *
 * There are two producers. `runSystemOneTask` (the task router) records every
 * task run that reached the System One path, answered or not, with the outcome
 * the task's fail policy gave it, so "what did System One decide, and what
 * happened when it could not" has one answer. `runAgentSystemOneRequest` (the
 * agent service) records every request an agent's `maestro-cli s1` verb sent to
 * an engine or was answered from the cache, filed under `agent:<verb>` with the
 * agent and tab that asked. A third writes the same record for a decision no
 * System One engine made: `routeTurn` files every model-routing decision here,
 * whichever router made it, so the embedding router's decisions are read in the
 * same place as Jev's ({@link SystemOneLedgerEngine}). The records are kept in `stats.db` (`s1_decisions`)
 * for {@link SYSTEM_ONE_LEDGER_RETENTION_DAYS} days and read by the ledger in
 * Settings > Models > System One and `maestro-cli s1 ledger`.
 *
 * Two rules are written down here so no surface restates them differently:
 *
 *   1. **A record carries the question ids and the typed answers, never the
 *      text.** The state and the questions are the user's content. They are
 *      kept only when "Keep inputs in the ledger" is on (off by default), and
 *      then with secrets redacted ({@link formatSystemOneLedgerInput}).
 *   2. **The outcome says what the fail policy did, the code says why.** A
 *      timeout is not an outcome of its own: it is a `failed-open` or a
 *      `failed-closed` with the code `timeout`, so the record never loses
 *      whether the work went ahead. The `timeout` FILTER matches the code.
 *
 * Everything here is pure and bundle-safe.
 */

import { EMBEDDING_ROUTER_ENGINE_ID, embeddingRouterLabel } from './model-routing-task';
import {
	redactSystemOneRequest,
	type SystemOneAnswer,
	type SystemOneAnswers,
	type SystemOneErrorCode,
	type SystemOneTaskRequest,
	type SystemOneUsage,
} from './system-one';
import {
	isSystemOneAgentSourceId,
	systemOneAgentSourceVerb,
	type SystemOneAgentSourceId,
} from './system-one-agent';
import type { LocalModelRun } from '../stats-types';
import {
	isSystemOneRemoteEngineId,
	systemOneEngineChoiceLabel,
	type SystemOneEngineChoice,
} from './system-one-settings';
import { LOCAL_MODEL_TASKS, isLocalModelTaskId, type LocalModelTaskId } from './tasks';

// ---------------------------------------------------------------------------
// A decision
// ---------------------------------------------------------------------------

/** How long a record is kept. Older ones are pruned and never shown. */
export const SYSTEM_ONE_LEDGER_RETENTION_DAYS = 30;

export const SYSTEM_ONE_LEDGER_RETENTION_MS = SYSTEM_ONE_LEDGER_RETENTION_DAYS * 86_400_000;

/**
 * How a run ended.
 *
 *   - `ok`            - the engine answered every question.
 *   - `failed-open`   - no answer, and the work went ahead unchecked.
 *   - `failed-closed` - no answer, and the work stopped.
 *   - `unavailable`   - no answer, for a task with no fail policy: its caller
 *                       decided what that means.
 *   - `cancelled`     - the caller aborted. Not a fault.
 */
export const SYSTEM_ONE_DECISION_OUTCOMES = [
	'ok',
	'failed-open',
	'failed-closed',
	'unavailable',
	'cancelled',
] as const;

export type SystemOneDecisionOutcome = (typeof SYSTEM_ONE_DECISION_OUTCOMES)[number];

export function isSystemOneDecisionOutcome(value: unknown): value is SystemOneDecisionOutcome {
	return (SYSTEM_ONE_DECISION_OUTCOMES as readonly unknown[]).includes(value);
}

/** Why a run had no answer. `off` when the task was assigned and no engine was chosen. */
export type SystemOneDecisionCode = SystemOneErrorCode | 'off';

/**
 * What a record is filed under: the task that ran, or `agent:<verb>` for a
 * request an agent sent through `maestro-cli s1`.
 */
export type SystemOneLedgerTaskId = LocalModelTaskId | SystemOneAgentSourceId;

export function isSystemOneLedgerTaskId(value: unknown): value is SystemOneLedgerTaskId {
	return isLocalModelTaskId(value) || isSystemOneAgentSourceId(value);
}

/**
 * What a record's source is called: the task's label, or "Agent: rank". A
 * stored record can name a task a later build no longer has; it reads as its id.
 */
export function systemOneLedgerTaskLabel(taskId: SystemOneLedgerTaskId): string {
	if (isSystemOneAgentSourceId(taskId)) return `Agent: ${systemOneAgentSourceVerb(taskId)}`;
	return (LOCAL_MODEL_TASKS as Partial<typeof LOCAL_MODEL_TASKS>)[taskId]?.label ?? taskId;
}

/**
 * Who a record says was asked: a System One engine (`off` when the task was
 * assigned and no engine was chosen), or the embedding router, which decides a
 * model-routing run with no engine and no text model.
 */
export type SystemOneLedgerEngine = SystemOneEngineChoice | typeof EMBEDDING_ROUTER_ENGINE_ID;

/** What a record's engine is called in the ledger. */
export function systemOneLedgerEngineLabel(engine: SystemOneLedgerEngine): string {
	return engine === EMBEDDING_ROUTER_ENGINE_ID
		? embeddingRouterLabel()
		: systemOneEngineChoiceLabel(engine);
}

export interface SystemOneDecision {
	taskId: SystemOneLedgerTaskId;
	/** Who was asked. See {@link SystemOneLedgerEngine}. */
	engine: SystemOneLedgerEngine;
	/** The model the engine says answered. Absent with no answer. */
	model?: string;
	questionIds: string[];
	/** Absent with no answer. */
	answers?: SystemOneAnswers;
	outcome: SystemOneDecisionOutcome;
	/** Why there was no answer. Absent on `ok`. */
	code?: SystemOneDecisionCode;
	/** Epoch ms the run started. */
	startedAt: number;
	/** From the start of the run to its outcome, with machine sleep removed. */
	latencyMs: number;
	/** What the engine counted. Absent with no answer. */
	usage?: SystemOneUsage;
	costUsd?: number;
	/** The agent the run was for, when its caller knows one. */
	agentId?: string;
	/** The AI tab of that agent whose turn asked, for an agent's own request. */
	tabId?: string;
	/**
	 * True when the answers came from the answer cache: nothing was sent, and the
	 * record carries no tokens and no cost. Only an agent's request is cached.
	 */
	cached?: boolean;
	/**
	 * The state and the questions, redacted, as {@link formatSystemOneLedgerInput}
	 * writes them. Present only for a run made while "Keep inputs in the ledger"
	 * was on.
	 */
	input?: string;
}

/**
 * The usage record a decision leaves in `local_model_runs`, or `null` when it
 * leaves none.
 *
 * The ledger is an audit trail kept for {@link SYSTEM_ONE_LEDGER_RETENTION_DAYS}
 * days; the Usage Dashboard counts what every source did over ranges far longer
 * than that. So a request sent to a remote engine (Jev, OpenJev) is also filed
 * as a run, with the source `system-one`, the engine's id where an endpoint's
 * id goes, and no text and no answers.
 *
 * Three kinds of decision are not a run of their own:
 *
 *   - one answered from the answer cache: nothing was sent;
 *   - one with no engine chosen (`off`): there was nothing to send it to;
 *   - one a local router decided (the local judge, the embedding router): its
 *     model ran through the task router, which filed that run under the source
 *     the model is really on. A second row here would count the work twice.
 *
 * A run has three outcomes where a decision has five: what the fail policy did
 * with a missing answer (`failed-open`, `failed-closed`, `unavailable`) is the
 * ledger's to keep, and all three are an `error` with the decision's code.
 */
export function systemOneDecisionRun(
	decision: SystemOneDecision
): Omit<LocalModelRun, 'id'> | null {
	if (decision.cached || !isSystemOneRemoteEngineId(decision.engine)) return null;
	const outcome =
		decision.outcome === 'ok' || decision.outcome === 'cancelled' ? decision.outcome : 'error';
	return {
		taskId: decision.taskId,
		sourceType: 'system-one',
		modelId: decision.model ?? decision.engine,
		endpointId: decision.engine,
		...(decision.agentId ? { agentId: decision.agentId } : {}),
		startedAt: decision.startedAt,
		durationMs: decision.latencyMs,
		outcome,
		...(outcome !== 'ok' && decision.code ? { errorCode: decision.code } : {}),
		...(decision.usage
			? { tokensIn: decision.usage.inputTokens, tokensOut: decision.usage.outputTokens }
			: {}),
	};
}

/** A decision as the ledger holds it. */
export interface SystemOneLedgerEntry extends SystemOneDecision {
	id: string;
}

// ---------------------------------------------------------------------------
// Kept inputs
// ---------------------------------------------------------------------------

/** The longest input one record keeps. A longer state is cut and marked. */
export const SYSTEM_ONE_LEDGER_MAX_INPUT_CHARS = 20_000;

/**
 * The text a record keeps of a request: its state and questions as JSON, with
 * every secret-shaped span removed first. A request too long to keep whole
 * keeps its questions and the start of its state, marked `truncated`.
 */
export function formatSystemOneLedgerInput(request: SystemOneTaskRequest): string {
	const clean = redactSystemOneRequest(request.state, request.questions);
	const whole = JSON.stringify({ state: clean.state, questions: clean.questions });
	if (whole.length <= SYSTEM_ONE_LEDGER_MAX_INPUT_CHARS) return whole;
	const stateText = typeof clean.state === 'string' ? clean.state : JSON.stringify(clean.state);
	return JSON.stringify({
		state: stateText.slice(0, SYSTEM_ONE_LEDGER_MAX_INPUT_CHARS),
		questions: clean.questions,
		truncated: true,
	});
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

/**
 * What the ledger can be filtered by: an outcome, or `timeout`, which matches
 * every run whose engine gave no answer in time whichever way it failed.
 */
export const SYSTEM_ONE_LEDGER_OUTCOME_FILTERS = [
	...SYSTEM_ONE_DECISION_OUTCOMES,
	'timeout',
] as const;

export type SystemOneLedgerOutcomeFilter = (typeof SYSTEM_ONE_LEDGER_OUTCOME_FILTERS)[number];

export function isSystemOneLedgerOutcomeFilter(
	value: unknown
): value is SystemOneLedgerOutcomeFilter {
	return (SYSTEM_ONE_LEDGER_OUTCOME_FILTERS as readonly unknown[]).includes(value);
}

/** What an outcome filter is called, in the ledger's picker and the CLI's help. */
export const SYSTEM_ONE_LEDGER_OUTCOME_LABELS: Readonly<
	Record<SystemOneLedgerOutcomeFilter, string>
> = Object.freeze({
	ok: 'Answered',
	'failed-open': 'Failed open',
	'failed-closed': 'Failed closed',
	unavailable: 'No answer',
	cancelled: 'Cancelled',
	timeout: 'Timed out',
});

/** How many records one read returns when it names no limit, and the most it may ask for. */
export const SYSTEM_ONE_LEDGER_DEFAULT_LIMIT = 100;
export const SYSTEM_ONE_LEDGER_MAX_LIMIT = 1_000;

export interface SystemOneLedgerQuery {
	taskId?: SystemOneLedgerTaskId;
	outcome?: SystemOneLedgerOutcomeFilter;
	/** Epoch ms. Only runs that started at or after it. */
	since?: number;
	limit?: number;
}

export type SystemOneLedgerQueryResult =
	| { ok: true; query: SystemOneLedgerQuery }
	| { ok: false; message: string };

/**
 * Read a ledger query as the view and `maestro-cli s1 ledger` both send it, or
 * say why it cannot be read. This is the one validator. An absent query reads
 * the newest records of every task.
 */
export function parseSystemOneLedgerQuery(raw: unknown): SystemOneLedgerQueryResult {
	if (raw === undefined || raw === null) return { ok: true, query: {} };
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, message: 'A ledger query must be an object.' };
	}
	const record = raw as Record<string, unknown>;
	const query: SystemOneLedgerQuery = {};

	if (record.taskId !== undefined) {
		if (!isSystemOneLedgerTaskId(record.taskId)) {
			return {
				ok: false,
				message: `"${String(record.taskId)}" is not a task, or an agent verb spelled agent:<verb>.`,
			};
		}
		query.taskId = record.taskId;
	}
	if (record.outcome !== undefined) {
		if (!isSystemOneLedgerOutcomeFilter(record.outcome)) {
			return {
				ok: false,
				message: `"${String(record.outcome)}" is not an outcome. Use ${SYSTEM_ONE_LEDGER_OUTCOME_FILTERS.join(', ')}.`,
			};
		}
		query.outcome = record.outcome;
	}
	if (record.since !== undefined) {
		if (typeof record.since !== 'number' || !Number.isFinite(record.since) || record.since < 0) {
			return { ok: false, message: 'since must be a time in epoch milliseconds.' };
		}
		query.since = record.since;
	}
	if (record.limit !== undefined) {
		if (
			typeof record.limit !== 'number' ||
			!Number.isInteger(record.limit) ||
			record.limit < 1 ||
			record.limit > SYSTEM_ONE_LEDGER_MAX_LIMIT
		) {
			return {
				ok: false,
				message: `The limit must be a whole number from 1 to ${SYSTEM_ONE_LEDGER_MAX_LIMIT}.`,
			};
		}
		query.limit = record.limit;
	}
	return { ok: true, query };
}

/** One read of the ledger. */
export interface SystemOneLedgerPage {
	/** Newest first, at most the query's limit. */
	entries: SystemOneLedgerEntry[];
	/** How many records match the query, whatever the limit. */
	total: number;
	retentionDays: number;
	/**
	 * Why the ledger holds nothing new, or cannot be read: usage statistics are
	 * off, or the statistics database is not open. Null when decisions are kept.
	 */
	notice: string | null;
}

// ---------------------------------------------------------------------------
// Words for a person
// ---------------------------------------------------------------------------

/** A number from 0 to 1 as two decimals, the way the Test result prints P(yes). */
function fixed(value: number): string {
	return value.toFixed(2);
}

/** One typed answer in a few words: "yes (0.93)", "bug (0.81)", "level 2.40". */
export function describeSystemOneAnswer(answer: SystemOneAnswer): string {
	switch (answer.type) {
		case 'noul':
			return `${answer.probability >= 0.5 ? 'yes' : 'no'} (${fixed(answer.probability)})`;
		case 'choice':
			return answer.confidence === undefined
				? answer.choice
				: `${answer.choice} (${fixed(answer.confidence)})`;
		case 'score':
			return `level ${Number.isInteger(answer.score) ? answer.score : fixed(answer.score)}`;
	}
}

/**
 * What a record says happened, in one phrase: its answers keyed by question id,
 * or, with no answer, why. A single question's id is left out: it adds nothing.
 */
export function summarizeSystemOneDecision(
	decision: Pick<SystemOneDecision, 'answers' | 'code' | 'outcome'>
): string {
	const answers = Object.entries(decision.answers ?? {});
	if (answers.length === 0) return decision.code ?? decision.outcome;
	if (answers.length === 1) return describeSystemOneAnswer(answers[0][1]);
	return answers.map(([id, answer]) => `${id}: ${describeSystemOneAnswer(answer)}`).join(', ');
}
