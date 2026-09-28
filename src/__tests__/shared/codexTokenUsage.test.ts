/**
 * Tests for CodexTokenCounts: the accumulator that keeps Codex's cumulative
 * `total_token_usage` from being summed into a quadratic overcount.
 */

import { describe, it, expect } from 'vitest';
import { CodexTokenCounts } from '../../shared/codexTokenUsage';

/** One `token_count` event's `info`, in the shape Codex writes it. */
function info(
	total: { input: number; cached: number; output: number; reasoning?: number },
	last?: { input: number; cached: number; output: number; reasoning?: number }
) {
	const shape = (u: { input: number; cached: number; output: number; reasoning?: number }) => ({
		input_tokens: u.input,
		cached_input_tokens: u.cached,
		output_tokens: u.output,
		reasoning_output_tokens: u.reasoning ?? 0,
	});
	return {
		total_token_usage: shape(total),
		...(last ? { last_token_usage: shape(last) } : {}),
	};
}

describe('CodexTokenCounts', () => {
	it('starts empty', () => {
		const counts = new CodexTokenCounts();
		expect(counts.isEmpty).toBe(true);
		expect(counts.inputTokens).toBe(0);
	});

	it('sums last_token_usage rather than the cumulative total', () => {
		const counts = new CodexTokenCounts();
		// Three turns of 100 input each. Summing total_token_usage would give 600.
		counts.addTokenCountEvent(
			info({ input: 100, cached: 50, output: 10 }, { input: 100, cached: 50, output: 10 })
		);
		counts.addTokenCountEvent(
			info({ input: 200, cached: 120, output: 20 }, { input: 100, cached: 70, output: 10 })
		);
		counts.addTokenCountEvent(
			info({ input: 300, cached: 190, output: 30 }, { input: 100, cached: 70, output: 10 })
		);
		expect(counts.inputTokens).toBe(300);
		expect(counts.outputTokens).toBe(30);
		expect(counts.cachedTokens).toBe(190);
		expect(counts.isEmpty).toBe(false);
	});

	it('falls back to the cumulative delta when last_token_usage is absent', () => {
		const counts = new CodexTokenCounts();
		counts.addTokenCountEvent(info({ input: 100, cached: 50, output: 10 }));
		counts.addTokenCountEvent(info({ input: 250, cached: 120, output: 25 }));
		expect(counts.inputTokens).toBe(250);
		expect(counts.outputTokens).toBe(25);
		expect(counts.cachedTokens).toBe(120);
	});

	it('treats a total that moves backwards as a restarted counter', () => {
		const counts = new CodexTokenCounts();
		counts.addTokenCountEvent(info({ input: 500, cached: 400, output: 50 }));
		// Resume: Codex starts a fresh running total rather than continuing.
		counts.addTokenCountEvent(info({ input: 80, cached: 60, output: 5 }));
		counts.addTokenCountEvent(info({ input: 160, cached: 130, output: 12 }));
		expect(counts.inputTokens).toBe(500 + 160);
		expect(counts.outputTokens).toBe(50 + 12);
	});

	it('folds reasoning tokens into output', () => {
		const counts = new CodexTokenCounts();
		counts.addTokenCountEvent(
			info(
				{ input: 10, cached: 0, output: 4, reasoning: 6 },
				{ input: 10, cached: 0, output: 4, reasoning: 6 }
			)
		);
		expect(counts.outputTokens).toBe(10);
	});

	it('sums turn.completed usage, which is already per-turn', () => {
		const counts = new CodexTokenCounts();
		counts.addTurn({ input_tokens: 100, output_tokens: 10, cached_input_tokens: 40 });
		counts.addTurn({ input_tokens: 120, output_tokens: 12, cached_input_tokens: 90 });
		expect(counts.inputTokens).toBe(220);
		expect(counts.outputTokens).toBe(22);
		expect(counts.cachedTokens).toBe(130);
	});

	it('ignores null info and null usage', () => {
		const counts = new CodexTokenCounts();
		counts.addTokenCountEvent(null);
		counts.addTokenCountEvent({ total_token_usage: null, last_token_usage: null });
		counts.addTurn(undefined);
		expect(counts.isEmpty).toBe(true);
	});

	it('keeps the cumulative baseline current across a mixed event stream', () => {
		const counts = new CodexTokenCounts();
		// Turn 1 reports both shapes, turn 2 only the cumulative one.
		counts.addTokenCountEvent(
			info({ input: 100, cached: 50, output: 10 }, { input: 100, cached: 50, output: 10 })
		);
		counts.addTokenCountEvent(info({ input: 250, cached: 120, output: 25 }));
		expect(counts.inputTokens).toBe(250);
		expect(counts.cachedTokens).toBe(120);
	});
});
