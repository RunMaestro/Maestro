/**
 * Tests for the Throughput Gauge rate engine.
 *
 * The engine's failures are silent: a wrong reconciliation rule double counts
 * or drives a rate negative, and the needle just reads wrong. These cases pin
 * the credit-ahead-then-correct rule (text estimates and per-call usage), the
 * late-text gates that stop the coalesced
 * tail of a turn from counting twice, the cache-read exclusion, scope
 * isolation, and the rolling window's edges.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	createThroughputTracker,
	DEFAULT_THROUGHPUT_RETENTION_MS,
	DEFAULT_THROUGHPUT_USAGE_SETTLE_MS,
	DEFAULT_THROUGHPUT_WINDOW_MS,
	THROUGHPUT_WINDOWS_MS,
	type ThroughputTracker,
} from '../../shared/throughputRate';

/** Text that `estimateTokenCount()` (ceil(length / 4)) reads as exactly `n` tokens. */
function textOf(tokens: number): string {
	return 'x'.repeat(tokens * 4);
}

/** Tokens per second for `tokens` spread over a window of `windowMs`. */
function perSecond(tokens: number, windowMs: number): number {
	return tokens / (windowMs / 1000);
}

describe('throughputRate', () => {
	let tracker: ThroughputTracker;

	beforeEach(() => {
		tracker = createThroughputTracker();
	});

	describe('constants', () => {
		it('offers the four windows, defaults to 10s, and retains past the largest', () => {
			expect(THROUGHPUT_WINDOWS_MS).toEqual([5000, 10000, 30000, 60000]);
			expect(DEFAULT_THROUGHPUT_WINDOW_MS).toBe(10000);
			expect(DEFAULT_THROUGHPUT_RETENTION_MS).toBeGreaterThan(60000);
		});
	});

	describe('rolling average', () => {
		it.each(THROUGHPUT_WINDOWS_MS)('averages over a %ims window', (windowMs) => {
			tracker.recordStreamedText('s1', 'a1', textOf(100), 1000);
			tracker.recordStreamedText('s1', 'a1', textOf(50), 2000);
			const rates = tracker.rates(2000, windowMs);
			expect(rates.out).toBeCloseTo(perSecond(150, windowMs));
			expect(rates.in).toBe(0);
		});

		it.each(THROUGHPUT_WINDOWS_MS)('ages samples out of a %ims window', (windowMs) => {
			tracker.recordStreamedText('s1', 'a1', textOf(100), 0);
			tracker.recordStreamedText('s1', 'a1', textOf(40), windowMs / 2);
			// Both inside the window.
			expect(tracker.rates(windowMs - 1, windowMs).out).toBeCloseTo(perSecond(140, windowMs));
			// The first sample sits exactly on the edge: the interval is half open.
			expect(tracker.rates(windowMs, windowMs).out).toBeCloseTo(perSecond(40, windowMs));
			// Both gone.
			expect(tracker.rates(windowMs * 2, windowMs).out).toBe(0);
		});

		it('never counts a sample stamped after nowMs', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(100), 5000);
			expect(tracker.rates(4000, 10000).out).toBe(0);
			expect(tracker.rates(5000, 10000).out).toBeCloseTo(perSecond(100, 10000));
		});

		it('returns zero for a non-positive window', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(100), 1000);
			expect(tracker.rates(1000, 0)).toEqual({ in: 0, out: 0, combined: 0 });
			expect(tracker.rates(1000, -5)).toEqual({ in: 0, out: 0, combined: 0 });
		});

		it('ignores empty text', () => {
			tracker.recordStreamedText('s1', 'a1', '', 1000);
			tracker.recordReplyText('s1', 'a1', '', 1000);
			expect(tracker.sampleCount()).toBe(0);
		});
	});

	describe('estimate then correct', () => {
		it('credits streamed text as estimated output', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(30), 1000);
			expect(tracker.rates(1000, 10000).out).toBeCloseTo(perSecond(30, 10000));
		});

		it('credits only the difference when usage reports more than the estimate', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(30), 1000);
			tracker.recordUsage('s1', 'a1', { outputTokens: 100 }, 2000);
			// 30 estimated + 70 corrected lands exactly on the reported 100.
			expect(tracker.rates(2000, 10000).out).toBeCloseTo(perSecond(100, 10000));
		});

		it('credits zero, never negative, when usage reports less than the estimate', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(100), 1000);
			tracker.recordUsage('s1', 'a1', { outputTokens: 40 }, 2000);
			const rates = tracker.rates(2000, 10000);
			expect(rates.out).toBeCloseTo(perSecond(100, 10000));
			expect(rates.out).toBeGreaterThanOrEqual(0);
			// The report added no sample of its own: nothing to credit.
			expect(tracker.sampleCount()).toBe(1);
			// Even with the estimate aged out, the rate floors at zero.
			expect(tracker.rates(20000, 10000).out).toBe(0);
		});

		it('resets the estimate at each report so turns correct independently', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(20), 1000);
			tracker.recordUsage('s1', 'a1', { outputTokens: 50 }, 2000);
			// Next turn's text, well past the settle period.
			tracker.recordStreamedText('s1', 'a1', textOf(10), 4000);
			tracker.recordUsage('s1', 'a1', { outputTokens: 25 }, 5000);
			// 50 + 25 total, not corrected against the first turn's estimate.
			expect(tracker.rates(5000, 10000).out).toBeCloseTo(perSecond(75, 10000));
		});
	});

	describe('per-call usage', () => {
		it('credits each call at once, in both directions, by the input rule', () => {
			tracker.recordCallUsage(
				's1',
				'a1',
				{
					inputTokens: 2,
					cacheCreationInputTokens: 1000,
					cacheReadInputTokens: 160000,
					outputTokens: 300,
				},
				1000,
				'claude-code'
			);
			const rates = tracker.rates(1000, 10000);
			expect(rates.in).toBeCloseTo(perSecond(1002, 10000));
			expect(rates.out).toBeCloseTo(perSecond(300, 10000));
		});

		it('subtracts cache reads for providers that report them inside inputTokens', () => {
			tracker.recordCallUsage(
				's1',
				'a1',
				{ inputTokens: 1000, cacheReadInputTokens: 800, outputTokens: 50 },
				1000,
				'codex'
			);
			expect(tracker.rates(1000, 10000).in).toBeCloseTo(perSecond(200, 10000));
		});

		it('nets the calls out of the turn report, so the turn total is counted once', () => {
			tracker.recordCallUsage(
				's1',
				'a1',
				{ inputTokens: 2, cacheCreationInputTokens: 500, outputTokens: 100 },
				1000
			);
			tracker.recordCallUsage(
				's1',
				'a1',
				{ inputTokens: 3, cacheCreationInputTokens: 700, outputTokens: 200 },
				2000
			);
			tracker.recordUsage(
				's1',
				'a1',
				{ inputTokens: 5, cacheCreationInputTokens: 1300, outputTokens: 350 },
				3000
			);
			const rates = tracker.rates(3000, 10000);
			// Calls covered 1205 in and 300 out; the report adds only what they missed.
			expect(rates.in).toBeCloseTo(perSecond(1305, 10000));
			expect(rates.out).toBeCloseTo(perSecond(350, 10000));
			expect(tracker.sampleCount()).toBe(3);
		});

		it('credits zero, never negative, when the calls already cover the report', () => {
			tracker.recordCallUsage('s1', 'a1', { inputTokens: 400, outputTokens: 300 }, 1000);
			tracker.recordUsage('s1', 'a1', { inputTokens: 100, outputTokens: 200 }, 2000);
			const rates = tracker.rates(2000, 10000);
			expect(rates.in).toBeCloseTo(perSecond(400, 10000));
			expect(rates.out).toBeCloseTo(perSecond(300, 10000));
			expect(tracker.sampleCount()).toBe(1);
		});

		it('refuses text from a source that sends call reports, which already count it', () => {
			tracker.recordCallUsage('s1', 'a1', { outputTokens: 40 }, 1000);
			tracker.recordStreamedText('s1', 'a1', textOf(40), 1050);
			tracker.recordReplyText('s1', 'a1', textOf(40), 1100);
			expect(tracker.rates(1100, 10000).out).toBeCloseTo(perSecond(40, 10000));
			// Another source without call reports still estimates from text.
			tracker.recordStreamedText('s2', 'a1', textOf(10), 1100);
			expect(tracker.rates(1100, 10000).out).toBeCloseTo(perSecond(50, 10000));
		});

		it('starts each turn clean after the report', () => {
			tracker.recordCallUsage('s1', 'a1', { inputTokens: 100, outputTokens: 50 }, 1000);
			tracker.recordUsage('s1', 'a1', { inputTokens: 100, outputTokens: 50 }, 2000);
			tracker.recordCallUsage('s1', 'a1', { inputTokens: 30, outputTokens: 20 }, 3000);
			tracker.recordUsage('s1', 'a1', { inputTokens: 80, outputTokens: 20 }, 4000);
			const rates = tracker.rates(4000, 10000);
			// Second turn: 30 by call + 50 by report, not netted against the first turn.
			expect(rates.in).toBeCloseTo(perSecond(180, 10000));
			expect(rates.out).toBeCloseTo(perSecond(70, 10000));
		});

		it('ignores an all-zero call report', () => {
			tracker.recordCallUsage('s1', 'a1', { inputTokens: 0, outputTokens: 0 }, 1000);
			expect(tracker.sampleCount()).toBe(0);
		});
	});

	describe('input', () => {
		it('credits uncached input plus cache writes and ignores cache reads', () => {
			tracker.recordUsage(
				's1',
				'a1',
				{
					inputTokens: 200,
					cacheCreationInputTokens: 300,
					cacheReadInputTokens: 50000,
					outputTokens: 0,
				},
				1000,
				'claude-code'
			);
			expect(tracker.rates(1000, 10000).in).toBeCloseTo(perSecond(500, 10000));
		});

		it('subtracts cache reads for providers that report them inside inputTokens', () => {
			tracker.recordUsage(
				's1',
				'a1',
				{ inputTokens: 12000, cacheReadInputTokens: 10000, cacheCreationInputTokens: 0 },
				1000,
				'codex'
			);
			expect(tracker.rates(1000, 10000).in).toBeCloseTo(perSecond(2000, 10000));
		});

		it('floors the subtraction at zero when reads exceed input', () => {
			tracker.recordUsage(
				's1',
				'a1',
				{ inputTokens: 100, cacheReadInputTokens: 500 },
				1000,
				'copilot-cli'
			);
			expect(tracker.rates(1000, 10000).in).toBe(0);
			expect(tracker.sampleCount()).toBe(0);
		});

		it('treats missing, negative, and non-finite counts as zero', () => {
			tracker.recordUsage(
				's1',
				'a1',
				{ inputTokens: -5, cacheCreationInputTokens: Number.NaN, outputTokens: Infinity },
				1000
			);
			expect(tracker.rates(1000, 10000)).toEqual({ in: 0, out: 0, combined: 0 });
		});

		it('ignores a context-window correction replay entirely', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(10), 1000);
			tracker.recordUsage(
				's1',
				'a1',
				{ inputTokens: 900, outputTokens: 900, contextWindowCorrectionOnly: true },
				2000
			);
			expect(tracker.rates(2000, 10000)).toEqual({
				in: 0,
				out: perSecond(10, 10000),
				combined: perSecond(10, 10000),
			});
			// The replay did not latch the source: reply text still counts.
			tracker.recordReplyText('s1', 'a1', textOf(5), 3000);
			expect(tracker.rates(3000, 10000).out).toBeCloseTo(perSecond(15, 10000));
		});
	});

	describe('late text gates', () => {
		it('refuses streamed text inside the settle period after a report', () => {
			tracker.recordUsage('s1', 'a1', { outputTokens: 50 }, 1000);
			tracker.recordStreamedText(
				's1',
				'a1',
				textOf(20),
				1000 + DEFAULT_THROUGHPUT_USAGE_SETTLE_MS - 1
			);
			expect(tracker.rates(2000, 10000).out).toBeCloseTo(perSecond(50, 10000));
			// At the settle boundary text counts again.
			tracker.recordStreamedText('s1', 'a1', textOf(20), 1000 + DEFAULT_THROUGHPUT_USAGE_SETTLE_MS);
			expect(tracker.rates(2000, 10000).out).toBeCloseTo(perSecond(70, 10000));
		});

		it('honors a custom usageSettleMs, including zero', () => {
			const noSettle = createThroughputTracker({ usageSettleMs: 0 });
			noSettle.recordUsage('s1', 'a1', { outputTokens: 50 }, 1000);
			noSettle.recordStreamedText('s1', 'a1', textOf(20), 1000);
			expect(noSettle.rates(1000, 10000).out).toBeCloseTo(perSecond(70, 10000));
		});

		it('settles per source, not globally', () => {
			tracker.recordUsage('s1', 'a1', { outputTokens: 50 }, 1000);
			tracker.recordStreamedText('s2', 'a1', textOf(20), 1001);
			expect(tracker.rates(1001, 10000).out).toBeCloseTo(perSecond(70, 10000));
		});

		it('latches reply text off once the source reports usage', () => {
			tracker.recordReplyText('s1', 'a1', textOf(30), 1000);
			tracker.recordUsage('s1', 'a1', { outputTokens: 100 }, 2000);
			// The finished reply re-sent at turn end, long after the settle period.
			tracker.recordReplyText('s1', 'a1', textOf(100), 10000);
			expect(tracker.rates(10000, 10000).out).toBeCloseTo(perSecond(100, 10000));
		});

		it('re-opens reply text after forgetSource', () => {
			tracker.recordUsage('s1', 'a1', { outputTokens: 10 }, 1000);
			tracker.forgetSource('s1');
			tracker.recordReplyText('s1', 'a1', textOf(20), 1001);
			expect(tracker.rates(1001, 10000).out).toBeCloseTo(perSecond(30, 10000));
		});
	});

	describe('sources and scope', () => {
		it('keeps concurrent sources independent', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(80), 1000);
			tracker.recordStreamedText('s2', 'a2', textOf(10), 1000);
			// s2's report corrects only s2's estimate.
			tracker.recordUsage('s2', 'a2', { outputTokens: 30 }, 2000);
			// s1's report corrects only s1's.
			tracker.recordUsage('s1', 'a1', { outputTokens: 100 }, 3000);
			expect(tracker.rates(3000, 10000).out).toBeCloseTo(perSecond(130, 10000));
		});

		it('forgetSource clears only that source', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(40), 1000);
			tracker.recordStreamedText('s2', 'a1', textOf(40), 1000);
			expect(tracker.sourceCount()).toBe(2);
			tracker.forgetSource('s1');
			expect(tracker.sourceCount()).toBe(1);
			// s1's pending estimate is gone: its next report credits in full.
			tracker.recordUsage('s1', 'a1', { outputTokens: 40 }, 2000);
			// s2's estimate survives: its report credits only the difference.
			tracker.recordUsage('s2', 'a1', { outputTokens: 40 }, 2000);
			expect(tracker.rates(2000, 10000).out).toBeCloseTo(perSecond(120, 10000));
			// Samples already credited are not removed by forgetting a source.
			expect(tracker.sampleCount()).toBe(3);
		});

		it('limits rates to one agent through the filter', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(100), 1000);
			tracker.recordStreamedText('s2', 'a2', textOf(20), 1000);
			tracker.recordUsage('s2', 'a2', { inputTokens: 40 }, 2000);
			const onlyA2 = tracker.rates(2000, 10000, (sample) => sample.agentId === 'a2');
			expect(onlyA2.out).toBeCloseTo(perSecond(20, 10000));
			expect(onlyA2.in).toBeCloseTo(perSecond(40, 10000));
			const all = tracker.rates(2000, 10000);
			expect(all.out).toBeCloseTo(perSecond(120, 10000));
		});

		it('caps tracked sources, evicting the oldest', () => {
			for (let i = 0; i < 600; i++) {
				tracker.recordStreamedText(`s${i}`, 'a1', textOf(1), i);
			}
			expect(tracker.sourceCount()).toBe(500);
		});
	});

	describe('prune and invariants', () => {
		it('drops samples older than the retention period', () => {
			const short = createThroughputTracker({ maxRetentionMs: 5000 });
			short.recordStreamedText('s1', 'a1', textOf(10), 0);
			short.recordStreamedText('s1', 'a1', textOf(10), 3000);
			short.recordStreamedText('s1', 'a1', textOf(10), 6000);
			short.prune(7999);
			expect(short.sampleCount()).toBe(2);
			// Same half-open edge as rates(): a sample exactly maxRetentionMs old is gone.
			short.prune(8000);
			expect(short.sampleCount()).toBe(1);
			short.prune(20000);
			expect(short.sampleCount()).toBe(0);
		});

		it('keeps rates intact across a prune that compacts the buffer', () => {
			// Short retention so the prune kills more than half the buffer and compacts.
			const short = createThroughputTracker({ maxRetentionMs: 20000 });
			for (let t = 0; t < 70000; t += 1000) {
				short.recordStreamedText('s1', 'a1', textOf(10), t);
			}
			const before = short.rates(69000, 10000);
			short.prune(69000);
			expect(short.sampleCount()).toBe(20);
			expect(short.rates(69000, 10000)).toEqual(before);
			// More samples after the compaction still land in order.
			short.recordStreamedText('s1', 'a1', textOf(10), 70000);
			expect(short.sampleCount()).toBe(21);
			expect(short.rates(70000, 10000).out).toBeCloseTo(perSecond(100, 10000));
		});

		it('combined always equals in + out', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(17), 1000);
			tracker.recordUsage(
				's1',
				'a1',
				{ inputTokens: 333, cacheCreationInputTokens: 21, outputTokens: 90 },
				2000
			);
			tracker.recordStreamedText('s2', 'a2', textOf(7), 2500);
			for (const windowMs of THROUGHPUT_WINDOWS_MS) {
				for (const nowMs of [1000, 2000, 2500, 9000, 40000]) {
					const rates = tracker.rates(nowMs, windowMs);
					expect(rates.combined).toBe(rates.in + rates.out);
					expect(rates.in).toBeGreaterThanOrEqual(0);
					expect(rates.out).toBeGreaterThanOrEqual(0);
				}
			}
		});

		it('clamps a clock that steps backward so samples stay in order', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(10), 5000);
			tracker.recordStreamedText('s1', 'a1', textOf(10), 4000);
			// The second sample was stamped 5000, not 4000.
			expect(tracker.rates(5000, 1).out).toBeCloseTo(perSecond(20, 1));
		});

		it('clear drops every sample and source', () => {
			tracker.recordStreamedText('s1', 'a1', textOf(10), 1000);
			tracker.recordUsage('s1', 'a1', { outputTokens: 50 }, 2000);
			tracker.clear();
			expect(tracker.sampleCount()).toBe(0);
			expect(tracker.sourceCount()).toBe(0);
			expect(tracker.rates(2000, 10000)).toEqual({ in: 0, out: 0, combined: 0 });
			// The clock clamp resets too: an earlier stamp is accepted.
			tracker.recordStreamedText('s1', 'a1', textOf(10), 100);
			expect(tracker.rates(100, 10000).out).toBeCloseTo(perSecond(10, 10000));
		});
	});
});
