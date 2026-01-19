/**
 * Tests for context usage estimation utilities
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

		it('should exclude cacheReadInputTokens from calculation (cumulative, not per-request)', () => {
			const stats = createStats({
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 50000, // Should be ignored
				cacheCreationInputTokens: 5000,
				contextWindow: 100000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (1000 + 5000) / 100000 = 6% (cacheRead excluded)
			expect(result).toBe(6);
		});

		it('should cap at 100%', () => {
			const stats = createStats({
				inputTokens: 50000,
				outputTokens: 50000,
				cacheReadInputTokens: 150000, // Ignored
				cacheCreationInputTokens: 200000,
				contextWindow: 200000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (50000 + 200000) / 200000 = 125% -> capped at 100%
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

		it('should use claude default context window (200k)', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'claude');
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
			// (10000 + 0 + 0) / 128000 = 7.8% -> 8%
			expect(result).toBe(8);
		});

		it('should use aider default context window (128k)', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'aider');
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
			// (10000 + 0) / 100000 = 10%
			expect(result).toBe(10);
		});

		it('should ignore large cache read tokens (they are cumulative, not per-request)', () => {
			// Claude Code reports cacheReadInputTokens as cumulative session totals.
			// They can exceed the context window, so we exclude them from calculation.
			const stats = createStats({
				inputTokens: 500, // small new turn input
				outputTokens: 1000, // small response
				cacheReadInputTokens: 758000, // cumulative across session - should be IGNORED
				cacheCreationInputTokens: 50000, // new cache this turn
				contextWindow: 200000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (500 + 50000) / 200000 = 25% (cacheRead excluded)
			expect(result).toBe(25);
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
				cacheReadInputTokens: 500000, // Ignored
				cacheCreationInputTokens: 250000,
				contextWindow: 0,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (250000 + 250000) / 200000 = 250% -> capped at 100%
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
			// (100 + 0) / 200000 = 0.05% -> 0% (output excluded for Claude)
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

	describe('Claude agents (excludes output and cacheRead tokens)', () => {
		it('should exclude output and cacheRead tokens for claude-code', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats, 'claude-code');
			// 10000 + 1000 = 11000 (no output, no cacheRead)
			// cacheRead is excluded because Claude Code reports it as cumulative
			expect(result).toBe(11000);
		});

		it('should exclude output and cacheRead tokens for claude', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats, 'claude');
			expect(result).toBe(11000);
		});

		it('should exclude output and cacheRead tokens when agent is undefined', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats);
			// Defaults to Claude behavior
			expect(result).toBe(11000);
		});
	});

	describe('OpenAI agents (includes output tokens)', () => {
		it('should include output tokens for codex', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats, 'codex');
			// 10000 + 5000 + 1000 = 16000 (includes output, excludes cacheRead)
			expect(result).toBe(16000);
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

		it('should ignore large cacheRead values (cumulative session data)', () => {
			// This tests the real bug scenario: Claude Code reports cumulative cacheRead
			// that exceeds context window, which would cause 100%+ display
			const stats = createStats({
				inputTokens: 50000,
				outputTokens: 9000,
				cacheReadInputTokens: 758000, // Cumulative - should be IGNORED
				cacheCreationInputTokens: 75000,
			});
			const result = calculateContextTokens(stats, 'claude-code');
			// 50000 + 75000 = 125000 (cacheRead excluded)
			expect(result).toBe(125000);
		});
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
