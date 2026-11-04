/**
 * Tests for the per-turn token ledger.
 *
 * The bug this module exists to prevent is silent and expensive: writing an
 * agent's running lifetime usage into a per-turn row inflates every cost figure
 * downstream. These cases pin the properties that keep the recorded value a
 * true delta - accumulate within a turn, isolate between concurrent turns, and
 * report nothing rather than zero when a provider is silent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	recordTurnUsage,
	drainTurnUsage,
	turnUsageStatsFields,
	usageStatsToTurnFields,
	getTurnUsageLedgerSize,
	resetTurnUsageLedgerForTests,
} from '../../shared/turnUsageLedger';
import type { UsageStats } from '../../shared/types';

function usage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 200000,
		...overrides,
	};
}

describe('turnUsageLedger', () => {
	beforeEach(() => {
		resetTurnUsageLedgerForTests();
	});

	it('accumulates multiple usage events within one turn', () => {
		recordTurnUsage('s1-ai-tab1', usage({ inputTokens: 100, outputTokens: 20, totalCostUsd: 0.1 }));
		recordTurnUsage('s1-ai-tab1', usage({ inputTokens: 50, outputTokens: 30, totalCostUsd: 0.05 }));

		const drained = drainTurnUsage('s1-ai-tab1');

		expect(drained).toEqual({
			inputTokens: 150,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: expect.closeTo(0.15) as unknown as number,
			events: 2,
		});
	});

	it('maps cache fields onto the stats column names', () => {
		recordTurnUsage(
			's1-ai-tab1',
			usage({ cacheReadInputTokens: 900, cacheCreationInputTokens: 400 })
		);

		const drained = drainTurnUsage('s1-ai-tab1');

		expect(drained?.cacheReadTokens).toBe(900);
		expect(drained?.cacheCreationTokens).toBe(400);
	});

	it('keeps concurrent turns on the same agent separate', () => {
		// A forced-parallel turn is a different process on the same tab. Keying
		// by the agent id instead of the raw process id would hand one turn's
		// tokens to whichever finished first.
		recordTurnUsage('s1-ai-tab1', usage({ outputTokens: 10 }));
		recordTurnUsage('s1-ai-tab1-fp-1700000000', usage({ outputTokens: 999 }));

		expect(drainTurnUsage('s1-ai-tab1')?.outputTokens).toBe(10);
		expect(drainTurnUsage('s1-ai-tab1-fp-1700000000')?.outputTokens).toBe(999);
	});

	it('drains once - a second drain reports nothing', () => {
		// Draining has to clear, or the next turn on the same tab would inherit
		// this turn's tokens and double-count them.
		recordTurnUsage('s1-ai-tab1', usage({ outputTokens: 10 }));

		expect(drainTurnUsage('s1-ai-tab1')).not.toBeNull();
		expect(drainTurnUsage('s1-ai-tab1')).toBeNull();
	});

	it('starts a fresh total after a drain', () => {
		recordTurnUsage('s1-ai-tab1', usage({ outputTokens: 10 }));
		drainTurnUsage('s1-ai-tab1');
		recordTurnUsage('s1-ai-tab1', usage({ outputTokens: 7 }));

		expect(drainTurnUsage('s1-ai-tab1')?.outputTokens).toBe(7);
	});

	it('reports null for a turn that never produced a usage event', () => {
		expect(drainTurnUsage('never-seen')).toBeNull();
	});

	it('bounds the ledger so undrained turns cannot leak forever', () => {
		for (let i = 0; i < 600; i++) {
			recordTurnUsage(`orphan-${i}`, usage({ outputTokens: 1 }));
		}

		expect(getTurnUsageLedgerSize()).toBeLessThanOrEqual(500);
		// The oldest insertions are the ones evicted.
		expect(drainTurnUsage('orphan-0')).toBeNull();
		expect(drainTurnUsage('orphan-599')).not.toBeNull();
	});

	describe('turnUsageStatsFields', () => {
		it('returns an empty object for a turn with no usage, leaving columns NULL', () => {
			expect(turnUsageStatsFields(null)).toEqual({});
		});

		it('shapes a drained turn into recordQuery fields', () => {
			recordTurnUsage(
				's1-ai-tab1',
				usage({
					inputTokens: 5,
					outputTokens: 6,
					cacheReadInputTokens: 7,
					cacheCreationInputTokens: 8,
					totalCostUsd: 0.09,
				})
			);

			expect(turnUsageStatsFields(drainTurnUsage('s1-ai-tab1'))).toEqual({
				inputTokens: 5,
				outputTokens: 6,
				cacheReadTokens: 7,
				cacheCreationTokens: 8,
				costUsd: 0.09,
			});
		});

		it('reports a genuine zero-token turn as zeros, not as absent', () => {
			// A provider that reported usage of zero is different from one that
			// reported nothing; only the latter should leave the columns NULL.
			recordTurnUsage('s1-ai-tab1', usage());

			expect(turnUsageStatsFields(drainTurnUsage('s1-ai-tab1'))).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0,
			});
		});
	});

	describe('usageStatsToTurnFields', () => {
		it('returns an empty object when the Auto Run task reported no usage', () => {
			expect(usageStatsToTurnFields(undefined)).toEqual({});
		});

		it('converts a per-task UsageStats to the same field names', () => {
			expect(
				usageStatsToTurnFields(
					usage({
						inputTokens: 11,
						outputTokens: 22,
						cacheReadInputTokens: 33,
						cacheCreationInputTokens: 44,
						totalCostUsd: 0.55,
					})
				)
			).toEqual({
				inputTokens: 11,
				outputTokens: 22,
				cacheReadTokens: 33,
				cacheCreationTokens: 44,
				costUsd: 0.55,
			});
		});
	});
});
