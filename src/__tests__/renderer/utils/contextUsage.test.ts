/**
 * Tests for context usage estimation utilities
 *
 * Claude Code reports per-turn context window usage directly (no normalization needed).
 * Codex reports cumulative session totals, which are normalized in StdoutHandler.
 *
 * Per Anthropic documentation:
 *   total_context = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */

import {
	estimateContextUsage,
	calculateContextTokens,
	DEFAULT_CONTEXT_WINDOWS,
} from '../../../renderer/utils/contextUsage';
import type { UsageStats } from '../../../shared/types';

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
			// (10000 + 0 + 0) / 100000 = 10%
			expect(result).toBe(10);
		});

		it('should include cacheReadInputTokens in context calculation (per Anthropic docs)', () => {
			// Per Anthropic docs: total_context = input + cacheRead + cacheCreation
			// Claude Code reports per-turn values directly, Codex is normalized in StdoutHandler
			const stats = createStats({
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 50000, // INCLUDED - represents cached context for this turn
				cacheCreationInputTokens: 5000,
				contextWindow: 100000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (1000 + 50000 + 5000) / 100000 = 56%
			expect(result).toBe(56);
		});

		it('should cap at 100%', () => {
			const stats = createStats({
				inputTokens: 50000,
				outputTokens: 50000,
				cacheReadInputTokens: 100000, // Large cached context
				cacheCreationInputTokens: 100000, // Large new cache
				contextWindow: 200000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (50000 + 100000 + 100000) / 200000 = 125% -> capped at 100%
			expect(result).toBe(100);
		});

		it('should round to nearest integer', () => {
			const stats = createStats({
				inputTokens: 33333,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				contextWindow: 100000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// 33333 / 100000 = 33.333% -> 33%
			expect(result).toBe(33);
		});
	});

	describe('when contextWindow is not provided (fallback)', () => {
		it('should use claude-code default context window (200k)', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'claude-code');
			// (10000 + 0 + 0) / 200000 = 5%
			expect(result).toBe(5);
		});

		it('should use codex default context window (200k) and include output tokens', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'codex');
			// Codex includes output tokens: (10000 + 5000 + 0 + 0) / 200000 = 7.5% -> 8%
			expect(result).toBe(8);
		});

		it('should use opencode default context window (128k)', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'opencode');
			// (10000 + 0 + 0) / 128000 = 7.8% -> 8%
			expect(result).toBe(8);
		});

		it('should use factory-droid default context window (200k)', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'factory-droid');
			// (10000 + 0 + 0) / 200000 = 5%
			expect(result).toBe(5);
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
				cacheReadInputTokens: 0,
				contextWindow: 0,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			expect(result).toBe(0);
		});
	});

	describe('cacheReadInputTokens handling', () => {
		it('should handle undefined cacheReadInputTokens', () => {
			const stats = createStats({
				inputTokens: 10000,
				outputTokens: 5000,
				contextWindow: 100000,
			});
			// @ts-expect-error - testing undefined case
			stats.cacheReadInputTokens = undefined;
			const result = estimateContextUsage(stats, 'claude-code');
			// (10000 + 0 + 0) / 100000 = 10%
			expect(result).toBe(10);
		});

		it('should include cache read tokens in context (represents context window usage)', () => {
			// Per Anthropic docs, cacheRead represents tokens retrieved from cache
			// and DOES occupy context window space for this turn.
			const stats = createStats({
				inputTokens: 500,
				outputTokens: 1000,
				cacheReadInputTokens: 100000, // Large cached context for this turn
				cacheCreationInputTokens: 50000,
				contextWindow: 200000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (500 + 100000 + 50000) / 200000 = 75%
			expect(result).toBe(75);
		});
	});

	describe('edge cases', () => {
		it('should handle negative context window as missing', () => {
			const stats = createStats({ contextWindow: -100 });
			const result = estimateContextUsage(stats, 'claude-code');
			// Should use fallback since contextWindow is invalid
			expect(result).toBe(5);
		});

		it('should handle undefined context window', () => {
			const stats = createStats();
			// @ts-expect-error - testing undefined case
			stats.contextWindow = undefined;
			const result = estimateContextUsage(stats, 'claude-code');
			// Should use fallback
			expect(result).toBe(5);
		});

		it('should handle very large token counts', () => {
			const stats = createStats({
				inputTokens: 250000,
				outputTokens: 500000,
				cacheReadInputTokens: 50000,
				cacheCreationInputTokens: 50000,
				contextWindow: 0,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (250000 + 50000 + 50000) / 200000 = 175% -> capped at 100%
			expect(result).toBe(100);
		});

		it('should handle very small percentages', () => {
			const stats = createStats({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				contextWindow: 0,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (100 + 0 + 0) / 200000 = 0.05% -> 0% (output excluded for Claude)
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

	describe('Claude agents (per Anthropic formula: input + cacheRead + cacheCreation)', () => {
		it('should include all input-related tokens for claude-code', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats, 'claude-code');
			// Per Anthropic docs: 10000 + 2000 + 1000 = 13000
			expect(result).toBe(13000);
		});

		it('should include all input-related tokens when agent is undefined (defaults to Claude)', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats);
			// Defaults to Claude behavior: input + cacheRead + cacheCreation
			expect(result).toBe(13000);
		});
	});

	describe('OpenAI agents (includes output tokens in combined limit)', () => {
		it('should include output tokens for codex', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats, 'codex');
			// 10000 + 2000 + 1000 + 5000 = 18000 (input + cacheRead + cacheCreation + output)
			expect(result).toBe(18000);
		});
	});

	describe('edge cases', () => {
		it('should handle zero values', () => {
			const stats = createStats({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			});
			const result = calculateContextTokens(stats, 'claude-code');
			expect(result).toBe(0);
		});

		it('should handle undefined cache tokens', () => {
			const stats = {
				inputTokens: 10000,
				outputTokens: 5000,
				cacheReadInputTokens: undefined as unknown as number,
				cacheCreationInputTokens: undefined as unknown as number,
			};
			const result = calculateContextTokens(stats, 'claude-code');
			expect(result).toBe(10000);
		});

		it('should include cacheRead in context calculation (per Anthropic docs)', () => {
			// Per Anthropic documentation, total_context = input + cacheRead + cacheCreation
			// All three components occupy context window space.
			const stats = createStats({
				inputTokens: 50000,
				outputTokens: 9000,
				cacheReadInputTokens: 100000, // INCLUDED - represents cached context
				cacheCreationInputTokens: 25000,
			});
			const result = calculateContextTokens(stats, 'claude-code');
			// 50000 + 100000 + 25000 = 175000
			expect(result).toBe(175000);
		});
	});
});

describe('DEFAULT_CONTEXT_WINDOWS', () => {
	it('should have context windows defined for all known agent types', () => {
		expect(DEFAULT_CONTEXT_WINDOWS['claude-code']).toBe(200000);
		expect(DEFAULT_CONTEXT_WINDOWS['codex']).toBe(200000);
		expect(DEFAULT_CONTEXT_WINDOWS['opencode']).toBe(128000);
		expect(DEFAULT_CONTEXT_WINDOWS['factory-droid']).toBe(200000);
		expect(DEFAULT_CONTEXT_WINDOWS['terminal']).toBe(0);
	});
});
