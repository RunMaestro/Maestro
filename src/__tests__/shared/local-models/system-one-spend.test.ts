/**
 * @file system-one-spend.test.ts
 * @description What System One has cost and what a job would: the usage query
 * both surfaces send through, the sum of a report, and the estimate `s1 cost`
 * prints.
 *
 * Properties worth protecting:
 *
 *   - **A tiny cost is a number, not "<$0.01".** One request costs millionths
 *     of a dollar.
 *   - **A usage query is read whole**, and a bad one names what is wrong.
 *   - **An estimate packs a job the way the service does**: a rank shares the
 *     state across the candidates of a request, a batch repeats it per row.
 *   - **The engine's own overhead is in the estimate**, so a job of many small
 *     requests is not priced at a third of its bill.
 *   - **Only the hosted Jev has a price**, and the local judge has no Jev limit
 *     to fit.
 */

import { describe, it, expect } from 'vitest';

import {
	JEV_CHARS_PER_TOKEN,
	JEV_MAX_STATE_AND_QUESTION_TOKENS,
	JEV_PRICE_PER_MTOK_INPUT_USD,
	estimateSystemOneTokens,
} from '../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_AGENT_MAX_ITEMS,
	SYSTEM_ONE_AGENT_MAX_QUESTIONS,
	SYSTEM_ONE_AGENT_REQUEST_TOKENS,
} from '../../../shared/local-models/system-one-agent';
import {
	JEV_REQUEST_OVERHEAD_TOKENS,
	SYSTEM_ONE_COST_DEFAULT_QUESTION_CHARS,
	estimateSystemOneJob,
	formatSystemOneCost,
	parseSystemOneUsageQuery,
	sumSystemOneUsage,
	systemOneJobShapeProblem,
	type SystemOneAgentSpend,
} from '../../../shared/local-models/system-one-spend';

/** A state the estimate counts as exactly `tokens` tokens. */
function stateOf(tokens: number): string {
	let chars = Math.floor(tokens * JEV_CHARS_PER_TOKEN);
	// The rate is not a whole number, so a product can land a hair over.
	while (estimateSystemOneTokens('x'.repeat(chars)) > tokens) chars -= 1;
	return 'x'.repeat(chars);
}

const QUESTION_TOKENS = Math.ceil(SYSTEM_ONE_COST_DEFAULT_QUESTION_CHARS / JEV_CHARS_PER_TOKEN);

describe('formatSystemOneCost', () => {
	it('prints a cost under a cent to the millionth of a dollar', () => {
		expect(formatSystemOneCost(0.000005)).toBe('$0.000005');
		expect(formatSystemOneCost(0.004321)).toBe('$0.004321');
	});

	it('keeps a cost under a millionth visible', () => {
		expect(formatSystemOneCost(0.0000002)).toBe('$0.00000020');
	});

	it('prints nothing spent and a cent or more the way every other cost is printed', () => {
		expect(formatSystemOneCost(0)).toBe('$0.00');
		expect(formatSystemOneCost(1)).toBe('$1.00');
		expect(formatSystemOneCost(0.25)).toBe('$0.25');
	});
});

describe('parseSystemOneUsageQuery', () => {
	it('reads no query as every agent over the whole window', () => {
		expect(parseSystemOneUsageQuery(undefined)).toEqual({ ok: true, query: {} });
		expect(parseSystemOneUsageQuery({})).toEqual({ ok: true, query: {} });
	});

	it('keeps the agent, trimmed, and the start time', () => {
		expect(parseSystemOneUsageQuery({ agentId: '  agent-1 ', since: 1_800_000_000_000 })).toEqual({
			ok: true,
			query: { agentId: 'agent-1', since: 1_800_000_000_000 },
		});
	});

	it('returns only the fields it checked', () => {
		const parsed = parseSystemOneUsageQuery({ agentId: 'a', budget: 100, engine: 'openjev' });
		expect(parsed).toEqual({ ok: true, query: { agentId: 'a' } });
	});

	it.each([
		['a list', []],
		['text', 'agent-1'],
		['a blank agent', { agentId: '   ' }],
		['an agent that is not text', { agentId: 7 }],
		['an agent id past the limit', { agentId: 'a'.repeat(201) }],
		['a time that is not a number', { since: 'yesterday' }],
		['a negative time', { since: -1 }],
		['a time that is not finite', { since: Number.NaN }],
	])('refuses %s', (_name, raw) => {
		const parsed = parseSystemOneUsageQuery(raw);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.message).not.toBe('');
	});
});

describe('sumSystemOneUsage', () => {
	const row = (overrides: Partial<SystemOneAgentSpend>): SystemOneAgentSpend => ({
		agentId: 'agent-1',
		requests: 0,
		cachedRequests: 0,
		tokensIn: 0,
		tokensOut: 0,
		costUsd: 0,
		averageLatencyMs: 0,
		...overrides,
	});

	it('sums every column of the rows', () => {
		expect(
			sumSystemOneUsage([
				row({ requests: 3, cachedRequests: 1, tokensIn: 900, tokensOut: 12, costUsd: 0.00004 }),
				row({ agentId: null, requests: 2, tokensIn: 100, tokensOut: 3, costUsd: 0.00001 }),
			])
		).toEqual({
			requests: 5,
			cachedRequests: 1,
			tokensIn: 1000,
			tokensOut: 15,
			costUsd: 0.00005,
		});
	});

	it('is all zeros for no rows', () => {
		expect(sumSystemOneUsage([])).toEqual({
			requests: 0,
			cachedRequests: 0,
			tokensIn: 0,
			tokensOut: 0,
			costUsd: 0,
		});
	});
});

describe('systemOneJobShapeProblem', () => {
	it('takes a shape with nothing stated, and one with everything', () => {
		expect(systemOneJobShapeProblem({})).toBeNull();
		expect(
			systemOneJobShapeProblem({ questions: 3, questionChars: 200, items: 400, perItem: true })
		).toBeNull();
	});

	it.each([
		['no questions', { questions: 0 }],
		['a fraction of a question', { questions: 1.5 }],
		['a count that is not a number', { questions: Number.NaN }],
		['more questions than one request takes', { questions: SYSTEM_ONE_AGENT_MAX_QUESTIONS + 1 }],
		['a question of no characters', { questionChars: 0 }],
		['no items', { items: 0 }],
		['more items than one call takes', { items: SYSTEM_ONE_AGENT_MAX_ITEMS + 1 }],
		['one request per item with no items', { perItem: true }],
	])('refuses %s', (_name, shape) => {
		expect(systemOneJobShapeProblem(shape)).toEqual(expect.any(String));
	});
});

describe('estimateSystemOneJob', () => {
	it('prices one request: the state, its questions, and what the engine adds', () => {
		const estimate = estimateSystemOneJob({
			engine: 'jev-cloud',
			state: stateOf(1000),
			questions: 3,
		});

		expect(estimate).toMatchObject({
			shape: 'request',
			stateTokens: 1000,
			questionTokensEach: QUESTION_TOKENS,
			questionsPerRequest: 3,
			overheadTokensPerRequest: JEV_REQUEST_OVERHEAD_TOKENS,
			items: 1,
			requests: 1,
			fits: true,
			pricePerMtokUsd: JEV_PRICE_PER_MTOK_INPUT_USD,
		});
		const expected = 1000 + 3 * QUESTION_TOKENS + JEV_REQUEST_OVERHEAD_TOKENS;
		expect(estimate.tokensPerRequest).toBe(expected);
		expect(estimate.inputTokens).toBe(expected);
		expect(estimate.costUsd).toBeCloseTo((expected / 1_000_000) * JEV_PRICE_PER_MTOK_INPUT_USD, 12);
	});

	it('asks one question of one state when nothing else is said', () => {
		const estimate = estimateSystemOneJob({ engine: 'jev-cloud', state: 'A short ticket.' });
		expect(estimate).toMatchObject({ shape: 'request', questionsPerRequest: 1, requests: 1 });
	});

	it('packs a rank by the question limit, and repeats the state once per request', () => {
		const estimate = estimateSystemOneJob({
			engine: 'jev-cloud',
			state: stateOf(100),
			questionChars: 33,
			items: 600,
		});
		const each = Math.ceil(33 / JEV_CHARS_PER_TOKEN);

		expect(estimate).toMatchObject({
			shape: 'rank',
			questionsPerRequest: SYSTEM_ONE_AGENT_MAX_QUESTIONS,
			requests: 3,
			items: 600,
		});
		expect(estimate.inputTokens).toBe(3 * (100 + JEV_REQUEST_OVERHEAD_TOKENS) + 600 * each);
	});

	it('packs a rank by the token limit when the candidates are long', () => {
		const questionChars = 3_300;
		const each = Math.ceil(questionChars / JEV_CHARS_PER_TOKEN);
		const estimate = estimateSystemOneJob({
			engine: 'jev-cloud',
			state: stateOf(2000),
			questionChars,
			items: 100,
		});
		const perRequest = Math.floor((SYSTEM_ONE_AGENT_REQUEST_TOKENS - 2000) / each);

		expect(estimate.questionsPerRequest).toBe(perRequest);
		expect(estimate.requests).toBe(Math.ceil(100 / perRequest));
	});

	it('sends a candidate too large to share a request alone', () => {
		const estimate = estimateSystemOneJob({
			engine: 'jev-cloud',
			state: stateOf(29_000),
			questionChars: 20_000,
			items: 4,
		});
		expect(estimate).toMatchObject({ questionsPerRequest: 1, requests: 4 });
	});

	it('gives a batch one request per row, each with the whole state and every question', () => {
		const estimate = estimateSystemOneJob({
			engine: 'jev-cloud',
			state: stateOf(50),
			questions: 2,
			items: 1000,
			perItem: true,
		});

		expect(estimate).toMatchObject({ shape: 'batch', requests: 1000, questionsPerRequest: 2 });
		expect(estimate.inputTokens).toBe(
			1000 * (50 + JEV_REQUEST_OVERHEAD_TOKENS + 2 * QUESTION_TOKENS)
		);
	});

	it('says a state past the request limit does not fit', () => {
		const estimate = estimateSystemOneJob({
			engine: 'jev-cloud',
			state: stateOf(JEV_MAX_STATE_AND_QUESTION_TOKENS),
		});
		expect(estimate.fits).toBe(false);
	});

	it('prices an OpenJev server at nothing, with the same limits as Jev', () => {
		const estimate = estimateSystemOneJob({ engine: 'openjev', state: stateOf(1000), items: 600 });
		expect(estimate).toMatchObject({
			costUsd: 0,
			pricePerMtokUsd: 0,
			fits: true,
			overheadTokensPerRequest: JEV_REQUEST_OVERHEAD_TOKENS,
		});
	});

	it('gives the local judge one question a request, no overhead, no price and no Jev limit', () => {
		const estimate = estimateSystemOneJob({
			engine: 'local-judge',
			state: stateOf(100),
			items: 40,
		});
		expect(estimate).toMatchObject({
			shape: 'rank',
			questionsPerRequest: 1,
			requests: 40,
			overheadTokensPerRequest: 0,
			costUsd: 0,
			pricePerMtokUsd: 0,
			fits: null,
		});
	});
});
