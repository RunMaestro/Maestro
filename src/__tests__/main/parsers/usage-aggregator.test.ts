/**
 * Tests for usage aggregator utilities
 */

import {
	aggregateModelUsage,
	estimateContextUsage,
	calculateContextTokens,
	DEFAULT_CONTEXT_WINDOWS,
	type UsageStats,
	type ModelStats,
} from '../../../main/parsers/usage-aggregator';

describe('aggregateModelUsage', () => {
	it('should use MAX (not SUM) across models for token counts', () => {
		// When multiple models are used in one turn, each reads the same conversation
		// context from cache. Using MAX gives actual context size, SUM would double-count.
		const modelUsage: Record<string, ModelStats> = {
			'claude-3-5-sonnet': {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 100,
				contextWindow: 200000,
			},
			'claude-3-haiku': {
				inputTokens: 500,
				outputTokens: 250,
				cacheReadInputTokens: 50,
				cacheCreationInputTokens: 25,
				contextWindow: 200000,
			},
		};

		const result = aggregateModelUsage(modelUsage, {}, 0.05);

		// MAX values, not SUM: max(1000, 500)=1000, max(500, 250)=500, etc.
		expect(result.inputTokens).toBe(1000);
		expect(result.outputTokens).toBe(500);
		expect(result.cacheReadInputTokens).toBe(200);
		expect(result.cacheCreationInputTokens).toBe(100);
		expect(result.totalCostUsd).toBe(0.05);
		expect(result.contextWindow).toBe(200000);
	});

	it('should fall back to top-level usage when modelUsage is empty', () => {
		const usage = {
			input_tokens: 1000,
			output_tokens: 500,
			cache_read_input_tokens: 100,
			cache_creation_input_tokens: 50,
		};

		const result = aggregateModelUsage(undefined, usage, 0.02);

		expect(result.inputTokens).toBe(1000);
		expect(result.outputTokens).toBe(500);
		expect(result.cacheReadInputTokens).toBe(100);
		expect(result.cacheCreationInputTokens).toBe(50);
		expect(result.totalCostUsd).toBe(0.02);
		expect(result.contextWindow).toBe(200000);
	});

	it('should use default context window of 200000', () => {
		const result = aggregateModelUsage(undefined, {}, 0);
		expect(result.contextWindow).toBe(200000);
	});

	it('should use highest context window from models', () => {
		const modelUsage: Record<string, ModelStats> = {
			model1: { inputTokens: 100, contextWindow: 150000 },
			model2: { inputTokens: 100, contextWindow: 300000 },
			model3: { inputTokens: 100, contextWindow: 250000 },
		};

		const result = aggregateModelUsage(modelUsage, {}, 0);
		expect(result.contextWindow).toBe(300000);
	});
});

describe('estimateContextUsage', () => {
	const createStats = (overrides: Partial<UsageStats> = {}): UsageStats => ({
		inputTokens: 10000,
		outputTokens: 5000,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0.01,
		contextWindow: 0,
		...overrides,
	});

	describe('when contextWindow is provided', () => {
		it('should calculate percentage from provided context window', () => {
			const stats = createStats({ contextWindow: 100000 });
			const result = estimateContextUsage(stats, 'claude-code');
			expect(result).toBe(10);
		});

		it('should cap at 100%', () => {
			const stats = createStats({
				inputTokens: 150000,
				outputTokens: 100000,
				contextWindow: 200000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// Output tokens excluded; 150k / 200k = 75%
			expect(result).toBe(75);
		});
	});

	describe('when contextWindow is not provided (fallback)', () => {
		it('should use claude-code default context window (200k)', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'claude-code');
			expect(result).toBe(5);
		});

		it('should use codex default context window (200k) and include output tokens', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'codex');
			// Codex includes output tokens: (10000 + 5000 + 0) / 200000 = 7.5% -> 8%
			expect(result).toBe(8);
		});

		it('should use opencode default context window (128k)', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'opencode');
			expect(result).toBe(8);
		});

		it('should return null for terminal agent', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'terminal');
			expect(result).toBeNull();
		});

		it('should return null when no agent specified', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats);
			expect(result).toBeNull();
		});

		it('should return 0 when no tokens used', () => {
			const stats = createStats({
				inputTokens: 0,
				outputTokens: 0,
				contextWindow: 0,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			expect(result).toBe(0);
		});
	});
});

describe('calculateContextTokens', () => {
	const createStats = (
		overrides: Partial<UsageStats> = {}
	): Pick<
		UsageStats,
		'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
	> => ({
		inputTokens: 10000,
		outputTokens: 5000,
		cacheReadInputTokens: 2000,
		cacheCreationInputTokens: 1000,
		...overrides,
	});

	it('should exclude output tokens for Claude agents', () => {
		const stats = createStats();
		const result = calculateContextTokens(stats, 'claude-code');
		// 10000 + 1000 + 2000 = 13000 (no output tokens)
		expect(result).toBe(13000);
	});

	it('should include output tokens for Codex agents', () => {
		const stats = createStats();
		const result = calculateContextTokens(stats, 'codex');
		// 10000 + 5000 + 1000 + 2000 = 18000 (includes output)
		expect(result).toBe(18000);
	});

	it('should default to Claude behavior when agent is undefined', () => {
		const stats = createStats();
		const result = calculateContextTokens(stats);
		expect(result).toBe(13000);
	});
});

describe('DEFAULT_CONTEXT_WINDOWS', () => {
	it('should have context windows defined for all known agent types', () => {
		expect(DEFAULT_CONTEXT_WINDOWS['claude-code']).toBe(200000);
		expect(DEFAULT_CONTEXT_WINDOWS['claude']).toBe(200000);
		expect(DEFAULT_CONTEXT_WINDOWS['codex']).toBe(200000);
		expect(DEFAULT_CONTEXT_WINDOWS['opencode']).toBe(128000);
		expect(DEFAULT_CONTEXT_WINDOWS['aider']).toBe(128000);
		expect(DEFAULT_CONTEXT_WINDOWS['terminal']).toBe(0);
	});
});
