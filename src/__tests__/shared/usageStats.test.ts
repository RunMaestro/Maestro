/**
 * Tests for the per-agent UsageStats helpers: token summing, cost resolution
 * (provider-reported vs rate-table estimate), and multi-session aggregation.
 */

import { describe, it, expect } from 'vitest';
import type { UsageStats } from '../../shared/types';
import type { SessionTokenTotals } from '../../shared/stats-types';
import {
	sumUsageTokens,
	hasUsage,
	resolveUsageCost,
	aggregateRangeUsage,
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

describe('aggregateRangeUsage', () => {
	const totals = (over: Partial<SessionTokenTotals> = {}): SessionTokenTotals => ({
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0,
		pricedQueries: 1,
		...over,
	});

	it('sums every bucket across the sessions in the range', () => {
		const agg = aggregateRangeUsage({
			s1: totals({ inputTokens: 100, outputTokens: 50, costUsd: 1, pricedQueries: 3 }),
			s2: totals({ cacheReadTokens: 200, cacheCreationTokens: 25, costUsd: 2, pricedQueries: 4 }),
		});

		expect(agg.count).toBe(2);
		expect(agg.inputTokens).toBe(100);
		expect(agg.outputTokens).toBe(50);
		expect(agg.cacheReadInputTokens).toBe(200);
		expect(agg.cacheCreationInputTokens).toBe(25);
		expect(agg.totalTokens).toBe(375);
		expect(agg.costUsd).toBe(3);
		expect(agg.pricedQueries).toBe(7);
		expect(agg.costEstimated).toBe(false);
	});

	it('leaves cost at the reported total when no model resolver is supplied', () => {
		const agg = aggregateRangeUsage({
			s1: totals({ inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 0 }),
		});

		expect(agg.totalTokens).toBe(2_000_000);
		expect(agg.costUsd).toBe(0);
		expect(agg.costEstimated).toBe(false);
	});

	it('estimates cost from the rate table only for sessions that reported none', () => {
		const agg = aggregateRangeUsage(
			{
				reported: totals({ inputTokens: 100, costUsd: 5 }),
				unpriced: totals({ inputTokens: 1_000_000, outputTokens: 500_000 }),
			},
			() => 'claude-opus-4-8'
		);

		expect(agg.costEstimated).toBe(true);
		expect(agg.costUsd).toBeGreaterThan(5);
	});

	it('returns an empty aggregate when the range holds nothing', () => {
		expect(aggregateRangeUsage(undefined).count).toBe(0);
		expect(aggregateRangeUsage({}).totalTokens).toBe(0);
		expect(aggregateRangeUsage({}).pricedQueries).toBe(0);
	});
});
