/**
 * Tests for context usage estimation utilities
 */

import { describe, it, expect } from 'vitest';
import {
	estimateContextUsage,
	calculateContextTokens,
	calculateContextDisplay,
	estimateAccumulatedGrowth,
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

		it('should include cacheReadInputTokens in calculation (part of total input context)', () => {
			const stats = createStats({
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 50000,
				cacheCreationInputTokens: 5000,
				contextWindow: 100000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (1000 + 50000 + 5000) / 100000 = 56%
			expect(result).toBe(56);
		});

		it('should return null when accumulated tokens exceed context window', () => {
			const stats = createStats({
				inputTokens: 50000,
				outputTokens: 50000,
				cacheReadInputTokens: 150000,
				cacheCreationInputTokens: 200000,
				contextWindow: 200000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (50000 + 150000 + 200000) = 400000 > 200000 -> null (accumulated values)
			expect(result).toBeNull();
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
			// Codex includes output tokens: (10000 + 5000 + 0) / 200000 = 7.5% -> 8%
			expect(result).toBe(8);
		});

		it('should use gemini-cli default context window (1M) and include output tokens', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'gemini-cli');
			// Gemini includes output tokens: (10000 + 5000 + 0) / 1048576 = 1.4% -> 1%
			expect(result).toBe(1);
		});

		it('should use opencode default context window (128k)', () => {
			const stats = createStats({ contextWindow: 0 });
			const result = estimateContextUsage(stats, 'opencode');
			// (10000 + 0 + 0) / 128000 = 7.8% -> 8%
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

		it('should return null when accumulated cacheRead tokens cause total to exceed context window', () => {
			// During multi-tool turns, Claude Code accumulates token values across
			// internal API calls. When accumulated total exceeds context window,
			// return null to signal callers should preserve previous valid percentage.
			const stats = createStats({
				inputTokens: 500,
				outputTokens: 1000,
				cacheReadInputTokens: 758000, // accumulated across multi-tool turn
				cacheCreationInputTokens: 50000,
				contextWindow: 200000,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (500 + 758000 + 50000) = 808500 > 200000 -> null (accumulated values)
			expect(result).toBeNull();
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

		it('should return null for very large accumulated token counts', () => {
			const stats = createStats({
				inputTokens: 250000,
				outputTokens: 500000,
				cacheReadInputTokens: 500000,
				cacheCreationInputTokens: 250000,
				contextWindow: 0,
			});
			const result = estimateContextUsage(stats, 'claude-code');
			// (250000 + 500000 + 250000) = 1000000 > 200000 -> null (accumulated values)
			expect(result).toBeNull();
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

	describe('Claude agents (input + cacheRead + cacheCreation)', () => {
		it('should include input, cacheRead, and cacheCreation tokens for claude-code', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats, 'claude-code');
			// 10000 + 2000 + 1000 = 13000 (excludes output only)
			expect(result).toBe(13000);
		});

		it('should include input, cacheRead, and cacheCreation tokens for claude', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats, 'claude');
			expect(result).toBe(13000);
		});

		it('should include input, cacheRead, and cacheCreation tokens when agent is undefined', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats);
			// Defaults to Claude behavior
			expect(result).toBe(13000);
		});
	});

	describe('Combined context agents (includes output tokens)', () => {
		it('should include input, output, and cacheCreation tokens for codex', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats, 'codex');
			// 10000 + 5000 + 1000 = 16000 (input + output + cacheCreation, excludes cacheRead)
			expect(result).toBe(16000);
		});

		it('should include input, output, and cacheCreation tokens for gemini-cli', () => {
			const stats = createStats();
			const result = calculateContextTokens(stats, 'gemini-cli');
			// 10000 + 5000 + 1000 = 16000 (input + output + cacheCreation, excludes cacheRead)
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

		it('should include cacheRead in raw calculation (callers detect accumulated values)', () => {
			// calculateContextTokens returns the raw total including cacheRead.
			// Callers (estimateContextUsage) detect when total > contextWindow
			// and return null to signal accumulated values from multi-tool turns.
			const stats = createStats({
				inputTokens: 50000,
				outputTokens: 9000,
				cacheReadInputTokens: 758000,
				cacheCreationInputTokens: 75000,
			});
			const result = calculateContextTokens(stats, 'claude-code');
			// 50000 + 758000 + 75000 = 883000 (raw total, callers check against window)
			expect(result).toBe(883000);
		});
	});
});

describe('estimateAccumulatedGrowth', () => {
	it('should grow by 1% for typical multi-tool turn with many internal calls', () => {
		// 31% usage, 40 internal API calls
		// outputTokens: 10026 (accumulated), cacheRead: 2.5M, window: 200K
		const result = estimateAccumulatedGrowth(31, 10026, 2500000, 200000);
		// prevTokens = 62000, estCalls = 2500000/62000 ≈ 40
		// singleTurnGrowth = 10026/40 ≈ 251, growthPercent = 251/200000*100 ≈ 0 → min 1%
		expect(result).toBe(32);
	});

	it('should cap per-turn growth at 3%', () => {
		// Fewer calls, more output per call
		const result = estimateAccumulatedGrowth(40, 100000, 400000, 200000);
		// prevTokens = 80000, estCalls = 400000/80000 = 5
		// singleTurnGrowth = 100000/5 = 20000, growthPercent = 20000/200000*100 = 10 → cap 3%
		expect(result).toBe(43);
	});

	it('should guarantee minimum 1% growth', () => {
		const result = estimateAccumulatedGrowth(50, 100, 5000000, 200000);
		// Very small output → growthPercent ≈ 0 → min 1%
		expect(result).toBe(51);
	});

	it('should return currentUsage unchanged when currentUsage is 0', () => {
		const result = estimateAccumulatedGrowth(0, 10000, 500000, 200000);
		expect(result).toBe(0);
	});

	it('should return currentUsage unchanged when contextWindow is 0', () => {
		const result = estimateAccumulatedGrowth(30, 10000, 500000, 0);
		expect(result).toBe(30);
	});

	it('should handle zero cacheRead tokens', () => {
		const result = estimateAccumulatedGrowth(30, 5000, 0, 200000);
		// estCalls = max(1, 0/60000) = 1, singleTurnGrowth = 5000
		// growthPercent = 5000/200000*100 = 3% (at cap)
		expect(result).toBe(33);
	});

	it('should grow monotonically across consecutive accumulated turns', () => {
		let usage = 31;
		for (let i = 0; i < 5; i++) {
			const prev = usage;
			usage = estimateAccumulatedGrowth(usage, 10000, 2500000, 200000);
			expect(usage).toBeGreaterThan(prev);
		}
		expect(usage).toBeGreaterThanOrEqual(36);
	});

	it('should not be capped internally (caller handles threshold cap)', () => {
		// At 98% with substantial output, growth of 3% still applies (bounded max).
		// The function intentionally does not cap at 100% — the caller in App.tsx
		// applies Math.min(estimated, yellowThreshold - 5) to prevent exceeding thresholds.
		const result = estimateAccumulatedGrowth(98, 50000, 500000, 200000);
		// prevTokens=196000, estCalls=3, singleTurnGrowth=16667, growthPercent=8 → cap 3%
		expect(result).toBeGreaterThan(98);
		expect(result).toBe(101); // 98 + 3% (max bounded growth)
	});

	it('should use minimum context floor for low usage to avoid inflated call estimates', () => {
		// At 1% usage, prevTokens would be 2000 without the floor.
		// With MIN_PREV_CONTEXT_FRACTION (5%), floor is 10000.
		// This prevents dividing cacheRead by a tiny number and inflating estCalls.
		const result = estimateAccumulatedGrowth(1, 50000, 100000, 200000);
		// minTokens = 10000, prevTokens = max(10000, 2000) = 10000
		// estCalls = max(1, round(100000/10000)) = 10
		// singleTurnGrowth = 50000/10 = 5000, growthPercent = round(5000/200000*100) = 3 → cap 3%
		expect(result).toBe(4); // 1 + 3%
	});
});

describe('calculateContextDisplay', () => {
	it('should calculate tokens and percentage for normal usage', () => {
		const result = calculateContextDisplay(
			{ inputTokens: 50000, cacheReadInputTokens: 30000, cacheCreationInputTokens: 20000 },
			200000,
			'claude-code'
		);
		// (50000 + 30000 + 20000) / 200000 = 50%
		expect(result.tokens).toBe(100000);
		expect(result.percentage).toBe(50);
		expect(result.contextWindow).toBe(200000);
	});

	it('should fall back to fallbackPercentage when tokens exceed context window', () => {
		const result = calculateContextDisplay(
			{
				inputTokens: 50000,
				cacheReadInputTokens: 758000,
				cacheCreationInputTokens: 200000,
			},
			200000,
			'claude-code',
			75 // preserved contextUsage from session
		);
		// Raw = 1008000 > 200000, so falls back: tokens = round(75/100 * 200000) = 150000
		expect(result.tokens).toBe(150000);
		expect(result.percentage).toBe(75);
	});

	it('should cap percentage at 100 when tokens are close to window', () => {
		const result = calculateContextDisplay(
			{ inputTokens: 190000, cacheReadInputTokens: 15000, cacheCreationInputTokens: 0 },
			200000,
			'claude-code'
		);
		// (190000 + 15000) / 200000 = 102.5% -> capped at 100%
		expect(result.percentage).toBe(100);
	});

	it('should return zeros when context window is 0', () => {
		const result = calculateContextDisplay({ inputTokens: 50000 }, 0, 'claude-code');
		expect(result.tokens).toBe(0);
		expect(result.percentage).toBe(0);
		expect(result.contextWindow).toBe(0);
	});

	it('should not fall back when no fallbackPercentage is provided', () => {
		const result = calculateContextDisplay(
			{
				inputTokens: 50000,
				cacheReadInputTokens: 758000,
				cacheCreationInputTokens: 200000,
			},
			200000,
			'claude-code'
			// no fallback
		);
		// Raw = 1008000 > 200000, but no fallback, so tokens stay at raw value
		// Percentage is capped at 100%
		expect(result.tokens).toBe(1008000);
		expect(result.percentage).toBe(100);
	});

	it('should use Codex semantics (includes output tokens)', () => {
		const result = calculateContextDisplay(
			{ inputTokens: 50000, outputTokens: 30000, cacheCreationInputTokens: 20000 },
			200000,
			'codex'
		);
		// Codex: (50000 + 20000 + 30000) / 200000 = 50%
		expect(result.tokens).toBe(100000);
		expect(result.percentage).toBe(50);
	});

	it('should handle history entries with accumulated tokens and preserved contextUsage', () => {
		// Simulates what HistoryDetailModal sees: accumulated stats + entry.contextUsage
		const result = calculateContextDisplay(
			{
				inputTokens: 5676,
				outputTokens: 8522,
				cacheReadInputTokens: 1128700,
				cacheCreationInputTokens: 0,
			},
			200000,
			undefined, // history entries don't have agent type
			100 // the screenshot showed 100% context
		);
		// Raw = 5676 + 1128700 + 0 = 1134376 > 200000
		// Falls back to: round(100/100 * 200000) = 200000
		expect(result.tokens).toBe(200000);
		expect(result.percentage).toBe(100);
	});
});

describe('DEFAULT_CONTEXT_WINDOWS', () => {
	it('should have context windows defined for all ToolType agent types', () => {
		// Only ToolType values have context windows defined
		// 'claude' was consolidated to 'claude-code', and 'aider' is not a ToolType
		expect(DEFAULT_CONTEXT_WINDOWS['claude-code']).toBe(200000);
		expect(DEFAULT_CONTEXT_WINDOWS['codex']).toBe(200000);
		expect(DEFAULT_CONTEXT_WINDOWS['opencode']).toBe(128000);
		expect(DEFAULT_CONTEXT_WINDOWS['factory-droid']).toBe(200000);
		expect(DEFAULT_CONTEXT_WINDOWS['gemini-cli']).toBe(1048576);
		expect(DEFAULT_CONTEXT_WINDOWS['terminal']).toBe(0);
	});
});
