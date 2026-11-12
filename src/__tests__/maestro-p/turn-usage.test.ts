/**
 * @file turn-usage.test.ts
 * @description Tests for src/maestro-p/turn-usage.ts - one turn's main-thread
 * token spend, counted once per message rather than once per transcript row.
 */

import { describe, expect, it } from 'vitest';

import { TurnUsage } from '../../maestro-p/turn-usage';
import { calculateModelCost } from '../../shared/modelPricing';

const usage = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({
	input_tokens: input,
	output_tokens: output,
	cache_read_input_tokens: cacheRead,
	cache_creation_input_tokens: cacheCreation,
});

describe('TurnUsage', () => {
	// claude writes one row per content block and repeats the message's usage
	// on each; summing rows counted a three-block reply three times.
	it('counts a message once however many rows carry it', () => {
		const turn = new TurnUsage();
		const thinking = { id: 'msg_1', model: 'claude-sonnet-5-5', usage: usage(2, 40, 1000, 50) };
		turn.note(thinking);
		turn.note({ ...thinking });
		turn.note({ ...thinking });
		turn.note({ id: 'msg_2', model: 'claude-sonnet-5-5', usage: usage(1, 3, 1100, 10) });

		expect(turn.totals()).toEqual({
			input_tokens: 3,
			output_tokens: 43,
			cache_read_input_tokens: 2100,
			cache_creation_input_tokens: 60,
		});
	});

	it('keeps the last row of a message', () => {
		const turn = new TurnUsage();
		turn.note({ id: 'msg_1', model: 'm', usage: usage(1, 1) });
		turn.note({ id: 'msg_1', model: 'm', usage: usage(1, 9) });

		expect(turn.totals().output_tokens).toBe(9);
	});

	it('counts each row of a message with no id', () => {
		const turn = new TurnUsage();
		turn.note({ model: 'm', usage: usage(1, 1) });
		turn.note({ model: 'm', usage: usage(1, 1) });

		expect(turn.totals().output_tokens).toBe(2);
	});

	it('ignores a message with no usage', () => {
		const turn = new TurnUsage();
		turn.note({ id: 'msg_1', model: 'm' });
		turn.note(null);

		expect(turn.totals().input_tokens).toBe(0);
	});

	it('prices the turn per model when claude wrote no cost-state row', () => {
		const turn = new TurnUsage();
		turn.note({ id: 'msg_1', model: 'claude-opus-5-5', usage: usage(10, 20, 300, 40) });
		turn.note({ id: 'msg_2', model: 'claude-haiku-5-5', usage: usage(5, 5) });

		const modelUsage = turn.estimatedModelUsage();

		expect(modelUsage['claude-opus-5-5']).toEqual({
			inputTokens: 10,
			outputTokens: 20,
			cacheReadInputTokens: 300,
			cacheCreationInputTokens: 40,
			webSearchRequests: 0,
			costUSD: calculateModelCost(
				{ inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 40 },
				'claude-opus-5-5'
			),
		});
		expect(modelUsage['claude-haiku-5-5'].costUSD).toBeGreaterThan(0);
	});

	it('adds the 1M window to a [1m] model in the estimate', () => {
		const turn = new TurnUsage();
		turn.note({ id: 'msg_1', model: 'claude-opus-5-5[1m]', usage: usage(1, 1) });

		expect(turn.estimatedModelUsage()['claude-opus-5-5[1m]'].contextWindow).toBe(1_000_000);
	});
});
