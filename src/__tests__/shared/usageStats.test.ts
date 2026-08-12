/**
 * Tests for the per-agent UsageStats helpers: token summing, cost resolution
 * (provider-reported vs rate-table estimate), and multi-session aggregation.
 */

import { describe, it, expect } from 'vitest';
import type { UsageStats } from '../../shared/types';
import {
	sumUsageTokens,
	hasUsage,
	resolveUsageCost,
	aggregateUsage,
} from '../../shared/usageStats';
import { calculateModelCost } from '../../shared/modelPricing';

function usage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 0,
		...overrides,
	};
}

describe('sumUsageTokens', () => {
	it('sums all four token buckets', () => {
		expect(
			sumUsageTokens(
				usage({
					inputTokens: 10,
					outputTokens: 20,
					cacheReadInputTokens: 30,
					cacheCreationInputTokens: 40,
				})
			)
		).toBe(100);
	});

	it('returns 0 for null/undefined', () => {
		expect(sumUsageTokens(null)).toBe(0);
		expect(sumUsageTokens(undefined)).toBe(0);
	});
});

describe('hasUsage', () => {
	it('is false when there are no tokens', () => {
		expect(hasUsage(usage())).toBe(false);
		expect(hasUsage(undefined)).toBe(false);
	});

	it('is true once any bucket is non-zero', () => {
		expect(hasUsage(usage({ outputTokens: 1 }))).toBe(true);
	});
});

describe('resolveUsageCost', () => {
	it('trusts a positive provider-reported cost', () => {
		const result = resolveUsageCost(
			usage({ inputTokens: 100, totalCostUsd: 0.42 }),
			'claude-opus-4-8'
		);
		expect(result).toEqual({ costUsd: 0.42, estimated: false });
	});

	it('estimates from the rate table when no cost is reported', () => {
		const u = usage({ inputTokens: 1000, outputTokens: 500 });
		const result = resolveUsageCost(u, 'claude-opus-4-8');
		expect(result.estimated).toBe(true);
		expect(result.costUsd).toBeCloseTo(
			calculateModelCost(
				{ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 },
				'claude-opus-4-8'
			),
			10
		);
	});

	it('returns zero cost for missing usage', () => {
		expect(resolveUsageCost(undefined, 'claude-opus-4-8')).toEqual({
			costUsd: 0,
			estimated: false,
		});
	});
});

describe('aggregateUsage', () => {
	it('sums tokens and cost across sessions, skipping empty ones', () => {
		const agg = aggregateUsage([
			{
				usageStats: usage({ inputTokens: 100, outputTokens: 50, totalCostUsd: 1 }),
				model: 'claude-opus-4-8',
			},
			{ usageStats: usage(), model: 'claude-opus-4-8' }, // empty - skipped
			{
				usageStats: usage({ inputTokens: 200, outputTokens: 100, totalCostUsd: 2 }),
				model: 'claude-opus-4-8',
			},
		]);

		expect(agg.count).toBe(2);
		expect(agg.inputTokens).toBe(300);
		expect(agg.outputTokens).toBe(150);
		expect(agg.totalTokens).toBe(450);
		expect(agg.costUsd).toBe(3);
		expect(agg.costEstimated).toBe(false);
	});

	it('flags the aggregate estimated when any session cost was rate-table derived', () => {
		const agg = aggregateUsage([
			{ usageStats: usage({ inputTokens: 100, totalCostUsd: 1 }), model: 'claude-opus-4-8' },
			{ usageStats: usage({ inputTokens: 1000, outputTokens: 500 }), model: 'claude-opus-4-8' }, // no cost -> estimated
		]);

		expect(agg.count).toBe(2);
		expect(agg.costEstimated).toBe(true);
		expect(agg.costUsd).toBeGreaterThan(1);
	});

	it('returns an empty aggregate for no sessions', () => {
		const agg = aggregateUsage([]);
		expect(agg.count).toBe(0);
		expect(agg.totalTokens).toBe(0);
		expect(agg.costUsd).toBe(0);
		expect(agg.costEstimated).toBe(false);
	});
});
