import { describe, it, expect } from 'vitest';
import {
	addUsageStats,
	mergeUsageStats,
	parsedUsageToStats,
	replaceUsageStats,
} from '../usage-totals';
import type { UsageStats } from '../../../types';

function usage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 200_000,
		...overrides,
	};
}

const snapshot = (inputTokens: number) => ({
	inputTokens,
	outputTokens: 5,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	reasoningTokens: 0,
});

describe('parsedUsageToStats', () => {
	it('maps the provider-reported window, model and occupancy snapshot', () => {
		const stats = parsedUsageToStats({
			inputTokens: 10,
			outputTokens: 2,
			contextWindow: 400_000,
			contextWindowReported: true,
			model: 'gpt-5-codex',
			absoluteUsage: snapshot(900),
		});

		expect(stats.contextWindowResolved).toBe(true);
		expect(stats.contextWindowModel).toBe('gpt-5-codex');
		expect(stats.absoluteUsage).toEqual(snapshot(900));
	});

	it('leaves a fallback window unresolved and adds no metadata the parser did not send', () => {
		const stats = parsedUsageToStats({ inputTokens: 10, outputTokens: 2, contextWindow: 200_000 });

		expect(stats).not.toHaveProperty('contextWindowResolved');
		expect(stats).not.toHaveProperty('contextWindowModel');
		expect(stats).not.toHaveProperty('absoluteUsage');
	});

	it('does not mark a reported flag resolved when there is no window to resolve', () => {
		const stats = parsedUsageToStats({
			inputTokens: 1,
			outputTokens: 1,
			contextWindowReported: true,
		});
		expect(stats).not.toHaveProperty('contextWindowResolved');
	});
});

describe('mergeUsageStats / addUsageStats', () => {
	it('still sums tokens and cost and keeps the largest window', () => {
		const total = addUsageStats(
			usage({ inputTokens: 10, outputTokens: 1, totalCostUsd: 0.1, contextWindow: 128_000 }),
			usage({ inputTokens: 5, outputTokens: 2, totalCostUsd: 0.2, contextWindow: 200_000 })
		);

		expect(total.inputTokens).toBe(15);
		expect(total.outputTokens).toBe(3);
		expect(total.totalCostUsd).toBeCloseTo(0.3);
		expect(total.contextWindow).toBe(200_000);
	});

	it('carries the latest occupancy snapshot and window metadata forward', () => {
		const first = addUsageStats(
			undefined,
			usage({
				inputTokens: 100,
				contextWindowResolved: true,
				contextWindowModel: 'm1',
				absoluteUsage: snapshot(100),
			})
		);
		const second = addUsageStats(first, usage({ inputTokens: 50, absoluteUsage: snapshot(150) }));

		expect(second.absoluteUsage).toEqual(snapshot(150));
		expect(second.contextWindowResolved).toBe(true);
		expect(second.contextWindowModel).toBe('m1');
	});

	it('does not let a later event without metadata erase the last snapshot', () => {
		const withSnapshot = addUsageStats(
			undefined,
			usage({ inputTokens: 100, contextWindowResolved: true, absoluteUsage: snapshot(100) })
		);
		const later = addUsageStats(withSnapshot, usage({ inputTokens: 7 }));

		expect(later.inputTokens).toBe(107);
		expect(later.absoluteUsage).toEqual(snapshot(100));
		expect(later.contextWindowResolved).toBe(true);
	});

	it('keeps the resolved flag with the window it describes', () => {
		// A resolved 128k window followed by a larger fallback: the max-window
		// rule keeps 200k, which nobody reported, so it must not read as resolved.
		const total = addUsageStats(
			usage({ contextWindow: 128_000, contextWindowResolved: true, contextWindowModel: 'small' }),
			usage({ contextWindow: 200_000 })
		);

		expect(total.contextWindow).toBe(200_000);
		expect(total).not.toHaveProperty('contextWindowResolved');
		expect(total).not.toHaveProperty('contextWindowModel');
	});

	it('accepts metadata from a parser-shaped step', () => {
		const total = mergeUsageStats(undefined, {
			inputTokens: 1,
			outputTokens: 1,
			contextWindow: 400_000,
			contextWindowResolved: true,
			contextWindowModel: 'gpt-5-codex',
			absoluteUsage: snapshot(1),
		});

		expect(total.contextWindowResolved).toBe(true);
		expect(total.contextWindowModel).toBe('gpt-5-codex');
		expect(total.absoluteUsage).toEqual(snapshot(1));
	});
});

describe('replaceUsageStats', () => {
	it('takes the totals from the later report and keeps the earlier snapshot', () => {
		const first = usage({
			inputTokens: 30,
			contextWindowResolved: true,
			absoluteUsage: snapshot(30),
		});
		const replaced = replaceUsageStats(first, usage({ inputTokens: 100, totalCostUsd: 0.5 }));

		expect(replaced.inputTokens).toBe(100);
		expect(replaced.totalCostUsd).toBe(0.5);
		expect(replaced.absoluteUsage).toEqual(snapshot(30));
		expect(replaced.contextWindowResolved).toBe(true);
	});

	it('prefers the later report metadata when it has its own', () => {
		const replaced = replaceUsageStats(
			usage({ absoluteUsage: snapshot(30) }),
			usage({ inputTokens: 100, contextWindowResolved: true, absoluteUsage: snapshot(60) })
		);

		expect(replaced.absoluteUsage).toEqual(snapshot(60));
		expect(replaced.contextWindowResolved).toBe(true);
	});

	it('is the report itself when there is no running total', () => {
		const report = usage({ inputTokens: 100, reasoningTokens: 3 });
		expect(replaceUsageStats(undefined, report)).toEqual(report);
	});
});
