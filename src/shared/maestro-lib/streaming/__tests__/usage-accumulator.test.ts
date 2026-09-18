import { describe, it, expect } from 'vitest';
import { UsageAccumulator } from '../usage-accumulator';
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

describe('UsageAccumulator', () => {
	it('returns the first event verbatim - nothing to delta against yet', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const first = usage({ inputTokens: 500, outputTokens: 100 });

		expect(acc.normalize(first)).toEqual(first);
	});

	it('computes a per-turn delta from cumulative, monotonically increasing totals', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 50 }));

		const second = acc.normalize(
			usage({ inputTokens: 800, outputTokens: 150, cacheReadInputTokens: 90 })
		);

		expect(second.inputTokens).toBe(300);
		expect(second.outputTokens).toBe(50);
		expect(second.cacheReadInputTokens).toBe(40);
	});

	it('re-attaches absoluteUsage with the pre-normalization cumulative totals when attachesAbsoluteUsage is true', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: true });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

		const second = acc.normalize(usage({ inputTokens: 800, outputTokens: 150 }));

		expect(second.absoluteUsage).toEqual({
			inputTokens: 800,
			outputTokens: 150,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
		});
	});

	it('does not attach absoluteUsage when attachesAbsoluteUsage is false, but preserves an incoming one untouched', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

		const incomingAbsolute = {
			inputTokens: 42,
			outputTokens: 7,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
		};
		const second = acc.normalize(
			usage({ inputTokens: 800, outputTokens: 150, absoluteUsage: incomingAbsolute })
		);

		// This provider doesn't get a computed absoluteUsage, but the one its
		// own parser already attached (e.g. Claude Code's last-call snapshot)
		// must survive the delta computation unmodified.
		expect(second.absoluteUsage).toEqual(incomingAbsolute);
	});

	it('detects a non-cumulative (already per-turn) stream and passes every event through unmodified', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

		// A decrease means this provider reports per-turn, not cumulative.
		const second = usage({ inputTokens: 300, outputTokens: 80 });
		expect(acc.normalize(second)).toEqual(second);

		// Once flagged non-cumulative, every subsequent event passes through
		// verbatim too, even one that would otherwise look monotonic.
		const third = usage({ inputTokens: 900, outputTokens: 200 });
		expect(acc.normalize(third)).toEqual(third);
	});

	it('defaults reasoningTokens to 0 when absent and includes it in the delta', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 100, reasoningTokens: 10 }));

		const second = acc.normalize(usage({ inputTokens: 200, reasoningTokens: 25 }));

		expect(second.reasoningTokens).toBe(15);
	});

	it('keeps separate instances fully independent (matches one-accumulator-per-process scoping)', () => {
		const accA = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const accB = new UsageAccumulator({ attachesAbsoluteUsage: false });

		accA.normalize(usage({ inputTokens: 1000, outputTokens: 500 }));
		// B has seen nothing yet, so its first event is still verbatim even
		// though A has already established a baseline.
		const firstForB = usage({ inputTokens: 10, outputTokens: 5 });
		expect(accB.normalize(firstForB)).toEqual(firstForB);
	});

	describe('lastTotals / isCumulative getters', () => {
		it('start undefined before any event is seen', () => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			expect(acc.lastTotals).toBeUndefined();
			expect(acc.isCumulative).toBeUndefined();
		});

		it('expose the raw totals and cumulative flag after a monotonic second event, for a caller mirroring state externally (e.g. ManagedProcess.lastUsageTotals / usageIsCumulative)', () => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));
			acc.normalize(usage({ inputTokens: 800, outputTokens: 150 }));

			expect(acc.isCumulative).toBe(true);
			expect(acc.lastTotals).toEqual({
				inputTokens: 800,
				outputTokens: 150,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			});
		});

		it('returns a defensive copy from lastTotals - mutating the getter result does not affect internal state', () => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

			const snapshot = acc.lastTotals;
			expect(snapshot).toBeDefined();
			if (snapshot) {
				snapshot.inputTokens = 999999;
			}

			expect(acc.lastTotals?.inputTokens).toBe(500);
		});
	});
});
