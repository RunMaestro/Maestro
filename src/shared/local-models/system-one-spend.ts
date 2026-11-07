/**
 * System One spend: what agents' own requests came to (`maestro-cli s1 usage`),
 * and what a job would come to before it is run (`maestro-cli s1 cost`).
 *
 * Usage is read from the decision ledger, per agent, by one function in the
 * main process (`readSystemOneAgentUsage`); this module is its query, its
 * report and the validator both surfaces send through. Cost is arithmetic on
 * the caller's own text: nothing is sent to an engine to work it out.
 *
 * Everything here is pure and bundle-safe.
 */

import { formatCost } from '../formatters';
import {
	JEV_CHARS_PER_TOKEN,
	JEV_MAX_REQUEST_TOKENS,
	JEV_MAX_STATE_AND_QUESTION_TOKENS,
	JEV_PRICE_PER_MTOK_INPUT_USD,
	estimateSystemOneTokens,
	systemOneCostUsd,
	type SystemOneEngineId,
	type SystemOneState,
} from './system-one';
import {
	SYSTEM_ONE_AGENT_MAX_ITEMS,
	SYSTEM_ONE_AGENT_MAX_KEY_CHARS,
	SYSTEM_ONE_AGENT_MAX_QUESTIONS,
	systemOneAgentRequestLimits,
	type SystemOneAgentBudget,
} from './system-one-agent';
import type { SystemOneEngineChoice } from './system-one-settings';

// ---------------------------------------------------------------------------
// Cost as text
// ---------------------------------------------------------------------------

/**
 * A System One cost as a person reads it. One request costs millionths of a
 * dollar, which `formatCost` prints as "<$0.01": true, and no use to someone
 * deciding whether a job of 5,000 items is worth running.
 */
export function formatSystemOneCost(usd: number): string {
	if (usd > 0 && usd < 0.01) return `$${usd.toFixed(usd < 0.000001 ? 8 : 6)}`;
	return formatCost(usd);
}

// ---------------------------------------------------------------------------
// Usage: what agents' requests came to
// ---------------------------------------------------------------------------

/** What one agent's own requests came to. `agentId` is null for requests that named none. */
export interface SystemOneAgentSpend {
	agentId: string | null;
	requests: number;
	/** Requests answered from the cache: nothing was sent for them. */
	cachedRequests: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	/** Mean round trip of the requests that were sent and answered. 0 when there were none. */
	averageLatencyMs: number;
}

/** What `s1 usage` asks for. */
export interface SystemOneUsageQuery {
	/** Only this agent's requests. */
	agentId?: string;
	/** Epoch ms. Nothing older than the ledger keeps is returned, whatever this asks for. */
	since?: number;
}

/** One agent's row, with the name it has now. */
export interface SystemOneAgentUsageRow extends SystemOneAgentSpend {
	/** Null for requests that named no agent, and for an agent that no longer exists. */
	agentName: string | null;
}

/** The rows of a report, summed. */
export interface SystemOneUsageTotals {
	requests: number;
	cachedRequests: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
}

/** What agents' own requests came to since a time, and today's spend against the budget. */
export interface SystemOneUsageReport {
	/** Epoch ms the rows start at, after the ledger's own window is applied. */
	since: number;
	retentionDays: number;
	/** Highest spend first. */
	rows: SystemOneAgentUsageRow[];
	totals: SystemOneUsageTotals;
	/** Today's count against the budgets. Counted in the process, so it holds while the ledger keeps nothing. */
	budget: SystemOneAgentBudget;
	engine: SystemOneEngineChoice;
	engineLabel: string;
	/** Why the rows may be short of what was spent: the ledger is not open, or it keeps nothing new. */
	notice: string | null;
}

export type SystemOneUsageQueryParse =
	| { ok: true; query: SystemOneUsageQuery }
	| { ok: false; message: string };

/** Read a usage query as a surface sends it, or say why it cannot be read. The one validator. */
export function parseSystemOneUsageQuery(raw: unknown): SystemOneUsageQueryParse {
	if (raw === undefined || raw === null) return { ok: true, query: {} };
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, message: 'A usage query must be an object.' };
	}
	const { agentId, since } = raw as Record<string, unknown>;
	const query: SystemOneUsageQuery = {};
	if (agentId !== undefined) {
		const id = typeof agentId === 'string' ? agentId.trim() : '';
		if (id === '' || id.length > SYSTEM_ONE_AGENT_MAX_KEY_CHARS) {
			return { ok: false, message: 'Name the agent by its id.' };
		}
		query.agentId = id;
	}
	if (since !== undefined) {
		if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) {
			return { ok: false, message: 'since is a time in epoch milliseconds.' };
		}
		query.since = since;
	}
	return { ok: true, query };
}

/** Sum the rows of a usage report. */
export function sumSystemOneUsage(rows: readonly SystemOneAgentSpend[]): SystemOneUsageTotals {
	const totals: SystemOneUsageTotals = {
		requests: 0,
		cachedRequests: 0,
		tokensIn: 0,
		tokensOut: 0,
		costUsd: 0,
	};
	for (const row of rows) {
		totals.requests += row.requests;
		totals.cachedRequests += row.cachedRequests;
		totals.tokensIn += row.tokensIn;
		totals.tokensOut += row.tokensOut;
		totals.costUsd += row.costUsd;
	}
	return totals;
}

// ---------------------------------------------------------------------------
// Cost: what a job would come to
// ---------------------------------------------------------------------------

/**
 * What Jev bills on top of the state and the questions, per request. MEASURED
 * on the hosted API on 2026-10-12: three one-question requests billed 375
 * input tokens each where the text came to about 119. An estimate without it is
 * a floor, and on a job of many small requests the overhead is most of the
 * bill.
 */
export const JEV_REQUEST_OVERHEAD_TOKENS = 256;

/** The characters one question is taken to have, criteria included, when the caller gives no figure. */
export const SYSTEM_ONE_COST_DEFAULT_QUESTION_CHARS = 120;

/** The shape of a job, as `s1 cost` is told it. */
export interface SystemOneJobShape {
	engine: SystemOneEngineId;
	/** The state of one request: the text judged, or one row of a batch. */
	state: SystemOneState;
	/** Questions asked of each state. A `rank` asks one of each candidate, so it ignores this. */
	questions?: number;
	/** Average characters of one question with its criteria. For a `rank`, of one candidate with its question. */
	questionChars?: number;
	/** Candidates of a `rank`, or rows of a `batch`. Absent for one request. */
	items?: number;
	/** True for a `batch`: each item is its own request with the whole state. */
	perItem?: boolean;
}

export interface SystemOneJobEstimate {
	engine: SystemOneEngineId;
	shape: 'request' | 'rank' | 'batch';
	stateTokens: number;
	questionTokensEach: number;
	/** Questions in one request: what was asked for, or how many candidates one request of a `rank` holds. */
	questionsPerRequest: number;
	/** What the engine adds to each request. 0 on the local judge, which bills nothing. */
	overheadTokensPerRequest: number;
	/** The state, the questions of one request, and the overhead. */
	tokensPerRequest: number;
	/**
	 * Whether one request is inside Jev's budget. An estimate: the engine has the
	 * last word (`too-large`). Null on the local judge, whose limit is the context
	 * of the model it runs and is checked by the judge itself.
	 */
	fits: boolean | null;
	items: number;
	requests: number;
	inputTokens: number;
	costUsd: number;
	/** USD per million input tokens. 0 on an engine that runs on the user's own hardware. */
	pricePerMtokUsd: number;
}

/** Why a job cannot be estimated, or `null` when it can. */
export function systemOneJobShapeProblem(
	shape: Pick<SystemOneJobShape, 'questions' | 'questionChars' | 'items' | 'perItem'>
): string | null {
	const whole = (value: number | undefined, least: number) =>
		value === undefined || (Number.isInteger(value) && value >= least);
	if (!whole(shape.questions, 1) || (shape.questions ?? 1) > SYSTEM_ONE_AGENT_MAX_QUESTIONS) {
		return `The number of questions is a whole number from 1 to ${SYSTEM_ONE_AGENT_MAX_QUESTIONS}.`;
	}
	if (!whole(shape.questionChars, 1)) {
		return 'The characters in a question are a whole number, 1 or more.';
	}
	if (!whole(shape.items, 1) || (shape.items ?? 1) > SYSTEM_ONE_AGENT_MAX_ITEMS) {
		return `The number of items is a whole number from 1 to ${SYSTEM_ONE_AGENT_MAX_ITEMS.toLocaleString('en-US')}: one call takes no more.`;
	}
	if (shape.perItem && shape.items === undefined) {
		return 'A job with one request per item needs the number of items.';
	}
	return null;
}

/**
 * Estimate a job before it is run: its requests, its input tokens and its
 * price, by the limits the agent service packs a job to. Nothing is sent.
 *
 *   - one request  - the state and `questions` questions.
 *   - a `rank`     - `items` candidates, one question each, packed into as few
 *                    requests as the limits allow, the state repeated in each.
 *   - a `batch`    - `items` rows, one request each, every one with the whole
 *                    state and `questions` questions.
 */
export function estimateSystemOneJob(shape: SystemOneJobShape): SystemOneJobEstimate {
	const { engine } = shape;
	const limits = systemOneAgentRequestLimits(engine);
	const stateTokens = estimateSystemOneTokens(shape.state);
	const questionTokensEach = Math.ceil(
		(shape.questionChars ?? SYSTEM_ONE_COST_DEFAULT_QUESTION_CHARS) / JEV_CHARS_PER_TOKEN
	);
	const overhead = engine === 'local-judge' ? 0 : JEV_REQUEST_OVERHEAD_TOKENS;
	const kind = shape.items === undefined ? 'request' : shape.perItem ? 'batch' : 'rank';
	const items = shape.items ?? 1;

	let questionsPerRequest: number;
	let requests: number;
	let questionTokens: number;
	if (kind === 'rank') {
		const room = Math.floor((limits.maxTokens - stateTokens) / questionTokensEach);
		// A candidate too large to share a request goes alone, as the service sends it.
		questionsPerRequest = Math.min(items, Math.max(1, Math.min(limits.maxQuestions, room)));
		requests = Math.ceil(items / questionsPerRequest);
		questionTokens = items * questionTokensEach;
	} else {
		questionsPerRequest = shape.questions ?? 1;
		requests = items;
		questionTokens = items * questionsPerRequest * questionTokensEach;
	}

	const tokensPerRequest = stateTokens + questionsPerRequest * questionTokensEach + overhead;
	const inputTokens = requests * (stateTokens + overhead) + questionTokens;
	return {
		engine,
		shape: kind,
		stateTokens,
		questionTokensEach,
		questionsPerRequest,
		overheadTokensPerRequest: overhead,
		tokensPerRequest,
		fits:
			engine === 'local-judge'
				? null
				: tokensPerRequest <= JEV_MAX_REQUEST_TOKENS &&
					stateTokens + questionTokensEach <= JEV_MAX_STATE_AND_QUESTION_TOKENS,
		items,
		requests,
		inputTokens,
		costUsd: systemOneCostUsd(engine, inputTokens),
		pricePerMtokUsd: engine === 'jev-cloud' ? JEV_PRICE_PER_MTOK_INPUT_USD : 0,
	};
}
