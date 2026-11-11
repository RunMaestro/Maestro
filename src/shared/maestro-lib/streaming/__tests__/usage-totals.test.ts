import { describe, it, expect } from 'vitest';
import {
	addUsageStats,
	mergeUsageStats,
	parsedUsageToStats,
	replaceUsageStats,
	subtractUsageStats,
} from '../usage-totals';
import type { UsageAccounting, UsageCost, UsageStats } from '../../../types';

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

describe('Grok scoped usage totals', () => {
	const accounting: UsageAccounting = {
		source: 'runtime-stream',
		scope: 'process-session',
		reporting: 'snapshot',
		cacheReadCounting: 'beside-input',
		cacheCreationCounting: 'beside-input',
		completeness: 'complete',
		cost: { status: 'unknown' },
		childInclusion: 'all',
		childCompleteness: 'complete',
	};

	it.each([
		['native-headless', 100, 'beside-input'],
		['acp', 130, 'inside-input'],
	] as const)(
		'normalizes %s cache buckets without pricing an unknown model',
		(route, inputTokens, counting) => {
			// Matched adapter-boundary fixtures: native input is uncached; ACP input is full.
			const stats = parsedUsageToStats({
				inputTokens,
				outputTokens: 20,
				cacheReadTokens: 20,
				cacheCreationTokens: 10,
				model: 'grok-unpriced-fixture',
				accounting: {
					...accounting,
					scope: 'response',
					route,
					cacheReadCounting: counting,
					cacheCreationCounting: counting,
				},
			});
			expect(stats).toMatchObject({
				inputTokens: 100,
				outputTokens: 20,
				cacheReadInputTokens: 20,
				cacheCreationInputTokens: 10,
				totalCostUsd: 0,
				accounting: {
					cost: { status: 'unknown' },
					cacheReadCounting: 'beside-input',
					cacheCreationCounting: 'beside-input',
					models: [
						{ model: 'grok-unpriced-fixture', inputTokens: 100, cost: { status: 'unknown' } },
					],
				},
			});
			expect(stats.accounting).not.toHaveProperty('estimatedCost');
		}
	);

	it('distinguishes absent cost from authoritative zero', () => {
		const absent = parsedUsageToStats({ inputTokens: 1, outputTokens: 0 });
		const free = parsedUsageToStats({
			inputTokens: 1,
			outputTokens: 0,
			accounting: { ...accounting, cost: { status: 'exact', costUsdTicks: '0' } },
		});
		expect(absent.totalCostUsd).toBe(0);
		expect(absent.accounting?.cost.status).toBe('unknown');
		expect(free.accounting?.cost).toEqual({ status: 'exact', costUsdTicks: '0' });
	});

	it.each([
		['exact', 'exact', 'exact'],
		['partial', 'exact', 'partial'],
		['unknown', 'exact', 'unknown'],
		['exact', 'partial', 'unknown'],
		['exact', 'unknown', 'unknown'],
	] as const)('differences %s cost against %s baseline as %s', (now, prior, expected) => {
		const priorCost: UsageCost =
			prior === 'unknown'
				? { status: 'unknown' }
				: prior === 'exact'
					? { status: 'exact', costUsdTicks: '9007199254740993' }
					: { status: 'partial', costUsdTicks: '9007199254740993' };
		const currentCost: UsageCost =
			now === 'unknown'
				? { status: 'unknown' }
				: now === 'exact'
					? { status: 'exact', costUsdTicks: '9007199254741004' }
					: { status: 'partial', costUsdTicks: '9007199254741004' };
		const model = {
			model: 'grok-a',
			inputTokens: 100,
			completeness: accounting.completeness,
			cost: priorCost,
		};
		const baseline = usage({
			inputTokens: 100,
			outputTokens: 20,
			cacheReadInputTokens: 20,
			cacheCreationInputTokens: 10,
			accounting: {
				...accounting,
				cost: priorCost,
				models: [model],
			},
		});
		const next = usage({
			inputTokens: 130,
			outputTokens: 24,
			cacheReadInputTokens: 25,
			cacheCreationInputTokens: 14,
			accounting: {
				...accounting,
				cost: currentCost,
				models: [
					{ ...model, inputTokens: 120, cost: currentCost },
					{ ...model, model: 'grok-b', inputTokens: 10 },
				],
			},
		});
		const delta = subtractUsageStats(next, baseline)!;
		expect(delta).toMatchObject({
			inputTokens: 30,
			outputTokens: 4,
			cacheReadInputTokens: 5,
			cacheCreationInputTokens: 4,
			accounting: { cost: { status: expected } },
		});
		if (expected !== 'unknown')
			expect(delta.accounting?.cost).toMatchObject({ costUsdTicks: '11' });
		else expect(delta.accounting?.cost).not.toHaveProperty('costUsdTicks');
		expect(delta.accounting?.models?.[0]).toMatchObject({
			inputTokens: 20,
			cost: { status: expected },
		});
		expect(delta.accounting?.models?.[1]).toEqual({
			model: 'grok-b',
			completeness: 'partial',
			cost: { status: 'unknown', reason: expect.any(String) },
		});
	});

	it.each([true, false])('requires an explicit empty model ledger (%s)', (knownEmpty) => {
		const baseline = usage({
			accounting: {
				...accounting,
				cost: { status: 'exact', costUsdTicks: '0' },
				...(knownEmpty ? { models: [] } : {}),
			},
		});
		const next = parsedUsageToStats({
			inputTokens: 7,
			outputTokens: 0,
			model: 'grok-a',
			accounting: {
				...accounting,
				scope: 'response',
				cost: { status: 'exact', costUsdTicks: '7' },
			},
		});
		const model = subtractUsageStats(next, baseline)?.accounting?.models?.[0];
		if (knownEmpty)
			expect(model).toMatchObject({
				inputTokens: 7,
				completeness: 'complete',
				cost: { status: 'exact', costUsdTicks: '7' },
			});
		else {
			expect(model).not.toHaveProperty('inputTokens');
			expect(model?.cost.status).toBe('unknown');
		}
	});
});
