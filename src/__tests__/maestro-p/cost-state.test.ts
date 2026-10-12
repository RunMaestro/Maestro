/**
 * @file cost-state.test.ts
 * @description Tests for src/maestro-p/cost-state.ts - reading claude's own
 * spend tracker off the transcript row the TUI writes as it exits.
 */

import { describe, expect, it } from 'vitest';

import { parseCostStateRow, withContextWindow } from '../../maestro-p/cost-state';

// Shape captured from a real TUI transcript (claude 2.1.296).
const costStateRow = {
	type: 'cost-state',
	sessionId: 'be866c57-87b5-4397-9af0-00688c9ec73b',
	totalCostUSD: 1.7517958999999996,
	totalAPIDuration: 149739,
	startTime: 1791819695144,
	modelUsage: {
		'claude-haiku-5-5': {
			inputTokens: 15936,
			outputTokens: 1551,
			thinkingTokens: 801,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			webSearchRequests: 1,
			costUSD: 0.012369100000000001,
		},
		'claude-opus-5-5[1m]': {
			inputTokens: 52,
			outputTokens: 13418,
			thinkingTokens: 2016,
			cacheReadInputTokens: 2871014,
			cacheCreationInputTokens: 112082,
			webSearchRequests: 0,
			costUSD: 1.7394267999999997,
		},
	},
	hasUnknownModelCost: false,
};

describe('parseCostStateRow', () => {
	it('reads the total and every model the session used', () => {
		const state = parseCostStateRow(costStateRow);

		expect(state?.totalCostUSD).toBe(1.7517958999999996);
		expect(state?.modelUsage['claude-haiku-5-5']).toEqual({
			inputTokens: 15936,
			outputTokens: 1551,
			thinkingTokens: 801,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			webSearchRequests: 1,
			costUSD: 0.012369100000000001,
		});
	});

	// The `[1m]` id is the only window the tracker proves; `claude -p` reports one.
	it('adds the 1M window to a [1m] model and no window to the rest', () => {
		const state = parseCostStateRow(costStateRow);

		expect(state?.modelUsage['claude-opus-5-5[1m]'].contextWindow).toBe(1_000_000);
		expect(state?.modelUsage['claude-haiku-5-5'].contextWindow).toBeUndefined();
	});

	it('ignores every other row', () => {
		expect(parseCostStateRow({ type: 'assistant', message: {} })).toBeNull();
		expect(parseCostStateRow(null)).toBeNull();
		expect(parseCostStateRow('cost-state')).toBeNull();
	});

	it('reads missing or non-numeric fields as zero', () => {
		const state = parseCostStateRow({
			type: 'cost-state',
			modelUsage: { 'claude-sonnet-5-5': { inputTokens: 'x' }, broken: null },
		});

		expect(state).toEqual({
			totalCostUSD: 0,
			modelUsage: {
				'claude-sonnet-5-5': {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					webSearchRequests: 0,
					costUSD: 0,
				},
			},
		});
	});
});

describe('withContextWindow', () => {
	it('leaves an entry without a window marker untouched', () => {
		const entry = {
			inputTokens: 1,
			outputTokens: 1,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			webSearchRequests: 0,
			costUSD: 0,
		};
		expect(withContextWindow('claude-sonnet-5-5', entry)).toBe(entry);
	});
});
