/**
 * Tests for per-model pricing: resolution (exact / suffix / family / default),
 * model-aware cost, and per-model bucketing of Claude session JSONL.
 */

import { describe, it, expect } from 'vitest';
import {
	resolveModelPricing,
	normalizeModelId,
	calculateModelCost,
	computeClaudeUsageCost,
	DEFAULT_MODEL_PRICING,
	MODEL_PRICING,
} from '../../shared/modelPricing';

describe('resolveModelPricing', () => {
	it('resolves exact current-gen models to their tier', () => {
		expect(resolveModelPricing('claude-fable-5').INPUT_PER_MILLION).toBe(10);
		expect(resolveModelPricing('claude-fable-5').OUTPUT_PER_MILLION).toBe(50);
		expect(resolveModelPricing('claude-opus-4-8').INPUT_PER_MILLION).toBe(5);
		expect(resolveModelPricing('claude-opus-4-8').OUTPUT_PER_MILLION).toBe(25);
		expect(resolveModelPricing('claude-sonnet-4-6').INPUT_PER_MILLION).toBe(3);
		expect(resolveModelPricing('claude-haiku-4-5').INPUT_PER_MILLION).toBe(1);
	});

	it('prices legacy Opus (4.1/4.0) at the old $15/$75 tier, not current Opus', () => {
		expect(resolveModelPricing('claude-opus-4-1').INPUT_PER_MILLION).toBe(15);
		expect(resolveModelPricing('claude-opus-4-0').OUTPUT_PER_MILLION).toBe(75);
	});

	it('derives cache prices from the input rate (read 0.1x, creation 1.25x)', () => {
		const fable = resolveModelPricing('claude-fable-5');
		expect(fable.CACHE_READ_PER_MILLION).toBeCloseTo(1, 10); // 10 * 0.1
		expect(fable.CACHE_CREATION_PER_MILLION).toBeCloseTo(12.5, 10); // 10 * 1.25
	});

	it('strips the [1m] extended-context marker', () => {
		expect(resolveModelPricing('claude-opus-4-8[1m]')).toBe(resolveModelPricing('claude-opus-4-8'));
	});

	it('strips a trailing date snapshot suffix', () => {
		expect(resolveModelPricing('claude-haiku-4-5-20251001')).toBe(
			resolveModelPricing('claude-haiku-4-5')
		);
	});

	it('is case-insensitive', () => {
		expect(resolveModelPricing('Claude-Opus-4-8')).toBe(resolveModelPricing('claude-opus-4-8'));
	});

	it('falls back to the family tier for unknown versioned IDs', () => {
		// A future opus version not in the table should still price at the opus tier.
		expect(resolveModelPricing('claude-opus-4-9').INPUT_PER_MILLION).toBe(5);
		expect(resolveModelPricing('claude-fable-6').INPUT_PER_MILLION).toBe(10);
		expect(resolveModelPricing('claude-haiku-9-0').INPUT_PER_MILLION).toBe(1);
	});

	it('falls back to the default tier for unknown, family-less, or empty input', () => {
		// gpt-4o is outside the GPT-5 family the OpenAI table covers, so it still
		// takes the default rather than being priced off a family it isn't in.
		expect(resolveModelPricing('gpt-4o')).toBe(DEFAULT_MODEL_PRICING);
		expect(resolveModelPricing(undefined)).toBe(DEFAULT_MODEL_PRICING);
		expect(resolveModelPricing(null)).toBe(DEFAULT_MODEL_PRICING);
		expect(resolveModelPricing('')).toBe(DEFAULT_MODEL_PRICING);
	});

	it('default tier matches the historical flat Sonnet rates', () => {
		expect(DEFAULT_MODEL_PRICING.INPUT_PER_MILLION).toBe(3);
		expect(DEFAULT_MODEL_PRICING.OUTPUT_PER_MILLION).toBe(15);
		expect(DEFAULT_MODEL_PRICING.CACHE_READ_PER_MILLION).toBe(0.3);
		expect(DEFAULT_MODEL_PRICING.CACHE_CREATION_PER_MILLION).toBe(3.75);
	});
});

describe('normalizeModelId', () => {
	it('lowercases and strips [1m] + date suffix', () => {
		expect(normalizeModelId('Claude-Opus-4-8[1m]')).toBe('claude-opus-4-8');
		expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
	});
});

describe('calculateModelCost', () => {
	it('prices the same tokens differently per model', () => {
		const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
		expect(calculateModelCost(tokens, 'claude-fable-5')).toBeCloseTo(60, 10); // 10 + 50
		expect(calculateModelCost(tokens, 'claude-opus-4-8')).toBeCloseTo(30, 10); // 5 + 25
		expect(calculateModelCost(tokens, 'claude-sonnet-4-6')).toBeCloseTo(18, 10); // 3 + 15
		expect(calculateModelCost(tokens, 'claude-haiku-4-5')).toBeCloseTo(6, 10); // 1 + 5
	});

	it('Fable costs more than 3x the flat default for the same usage', () => {
		const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
		const fable = calculateModelCost(tokens, 'claude-fable-5');
		const flat = calculateModelCost(tokens); // default Sonnet
		expect(fable / flat).toBeGreaterThan(3);
	});

	it('unknown model uses the default tier', () => {
		const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
		expect(calculateModelCost(tokens, 'mystery-model')).toBeCloseTo(18, 10);
	});
});

describe('computeClaudeUsageCost', () => {
	function assistantLine(model: string | null, usage: Record<string, number>): string {
		const message: Record<string, unknown> = { usage };
		if (model !== null) message.model = model;
		return JSON.stringify({ type: 'assistant', message });
	}

	it('buckets tokens by model and prices each bucket separately', () => {
		const content = [
			assistantLine('claude-opus-4-8', { input_tokens: 1_000_000 }),
			assistantLine('claude-fable-5', { output_tokens: 1_000_000 }),
		].join('\n');

		const result = computeClaudeUsageCost(content);
		expect(result.inputTokens).toBe(1_000_000);
		expect(result.outputTokens).toBe(1_000_000);
		// Opus 1M input ($5) + Fable 1M output ($50) = $55 (NOT a single flat rate).
		expect(result.costUsd).toBeCloseTo(55, 10);
	});

	it('sums grand totals across all token types', () => {
		const content = [
			assistantLine('claude-sonnet-4-6', {
				input_tokens: 100,
				output_tokens: 200,
				cache_read_input_tokens: 300,
				cache_creation_input_tokens: 400,
			}),
		].join('\n');

		const result = computeClaudeUsageCost(content);
		expect(result.inputTokens).toBe(100);
		expect(result.outputTokens).toBe(200);
		expect(result.cacheReadTokens).toBe(300);
		expect(result.cacheCreationTokens).toBe(400);
	});

	it('ignores malformed lines, non-usage lines, and synthetic-model usage falls back to default', () => {
		const content = [
			'not valid json at all',
			JSON.stringify({ type: 'user', message: { content: 'hello' } }),
			assistantLine('<synthetic>', { input_tokens: 1_000_000 }), // unknown -> default $3
			'',
		].join('\n');

		const result = computeClaudeUsageCost(content);
		expect(result.inputTokens).toBe(1_000_000);
		expect(result.costUsd).toBeCloseTo(3, 10); // default Sonnet input rate
	});

	it('prices usage with a missing model field at the default tier', () => {
		const content = assistantLine(null, { input_tokens: 1_000_000 });
		const result = computeClaudeUsageCost(content);
		expect(result.costUsd).toBeCloseTo(3, 10);
	});

	it('returns zeros for content with no usage', () => {
		const content = JSON.stringify({ type: 'user', message: { content: 'hi' } });
		const result = computeClaudeUsageCost(content);
		expect(result).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: 0,
		});
	});

	it('tolerates usage/model at the entry top level (not nested under message)', () => {
		const content = [
			JSON.stringify({
				type: 'result',
				model: 'claude-fable-5',
				usage: { input_tokens: 1_000_000 },
			}),
		].join('\n');

		const result = computeClaudeUsageCost(content);
		expect(result.inputTokens).toBe(1_000_000);
		expect(result.costUsd).toBeCloseTo(10, 10); // Fable input rate, top-level shape
	});

	it('aggregates repeated turns of the same model', () => {
		const content = [
			assistantLine('claude-opus-4-8', { input_tokens: 500_000 }),
			assistantLine('claude-opus-4-8', { input_tokens: 500_000 }),
		].join('\n');

		const result = computeClaudeUsageCost(content);
		expect(result.inputTokens).toBe(1_000_000);
		expect(result.costUsd).toBeCloseTo(5, 10); // 1M Opus input
	});
});

describe('OpenAI (Codex) pricing', () => {
	it('resolves gpt slugs to the OpenAI tier instead of the Anthropic default', () => {
		expect(resolveModelPricing('gpt-5-codex').INPUT_PER_MILLION).toBe(1.25);
		expect(resolveModelPricing('gpt-5-codex').OUTPUT_PER_MILLION).toBe(10);
		// Point releases Codex discovers at runtime inherit the family rate.
		expect(resolveModelPricing('gpt-5.4').INPUT_PER_MILLION).toBe(1.25);
		expect(resolveModelPricing('gpt-5.6-sol').OUTPUT_PER_MILLION).toBe(10);
		expect(resolveModelPricing('gpt-5.4-mini').INPUT_PER_MILLION).toBe(0.25);
		expect(resolveModelPricing('gpt-5-nano').INPUT_PER_MILLION).toBe(0.05);
	});

	it('never prices a gpt model at the Sonnet default', () => {
		expect(resolveModelPricing('gpt-5.4')).not.toBe(DEFAULT_MODEL_PRICING);
	});

	it('bills cached tokens once, as the cheap half of input', () => {
		// OpenAI reports cached tokens INSIDE input_tokens, so a 1M-input turn that
		// was 80% cache costs 200k at the input rate + 800k at the cache rate.
		const cost = calculateModelCost(
			{ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 800_000 },
			'gpt-5-codex'
		);
		expect(cost).toBeCloseTo(0.2 * 1.25 + 0.8 * 0.125, 10);
	});

	it('a cache hit is cheaper than a cache miss', () => {
		const miss = calculateModelCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'gpt-5-codex');
		const hit = calculateModelCost(
			{ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 },
			'gpt-5-codex'
		);
		expect(hit).toBeLessThan(miss);
	});

	it('leaves Anthropic cache reads additive', () => {
		// Claude reports cache reads BESIDE input_tokens, so both are billed.
		const cost = calculateModelCost(
			{ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 },
			'claude-sonnet-4-6'
		);
		expect(cost).toBeCloseTo(3 + 0.3, 10);
	});
});

describe('MODEL_PRICING table', () => {
	it('covers the current generation of models', () => {
		for (const id of [
			'claude-fable-5',
			'claude-opus-4-8',
			'claude-opus-4-7',
			'claude-opus-4-6',
			'claude-sonnet-4-6',
			'claude-haiku-4-5',
		]) {
			expect(MODEL_PRICING[id]).toBeDefined();
		}
	});
});
