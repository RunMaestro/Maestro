/**
 * Tests for the delegation trend series builder.
 *
 * The main process returns only days with activity, so densification is what
 * keeps the chart honest: without it a two-week silence draws as two adjacent
 * bars and reads as continuous work.
 */

import { describe, it, expect } from 'vitest';
import {
	bucketDelegatedPercent,
	bucketDelegatedValue,
	bucketInteractiveValue,
	buildDelegationSeries,
	toYmd,
} from '../../../../renderer/components/UsageDashboard/delegationTrendUtils';
import type { DelegationDay } from '../../../../shared/delegation';

function day(
	date: string,
	interactiveMs: number,
	autoRunMs: number,
	cueMs = 0,
	counts: [number, number, number] = [1, 1, 1]
): DelegationDay {
	return {
		date,
		interactive: { count: interactiveMs > 0 ? counts[0] : 0, durationMs: interactiveMs },
		autoRun: { count: autoRunMs > 0 ? counts[1] : 0, durationMs: autoRunMs },
		cue: { count: cueMs > 0 ? counts[2] : 0, durationMs: cueMs },
	};
}

describe('buildDelegationSeries', () => {
	it('returns nothing for an empty series', () => {
		expect(buildDelegationSeries([])).toEqual([]);
	});

	it('fills the calendar gap between sparse days with zero buckets', () => {
		const series = buildDelegationSeries([day('2026-01-01', 100, 0), day('2026-01-05', 0, 500)]);
		expect(series.map((b) => b.date)).toEqual([
			'2026-01-01',
			'2026-01-02',
			'2026-01-03',
			'2026-01-04',
			'2026-01-05',
		]);
		expect(series[1].interactive.durationMs).toBe(0);
		expect(series[4].autoRun.durationMs).toBe(500);
	});

	it('sorts an out-of-order series before densifying', () => {
		const series = buildDelegationSeries([day('2026-03-03', 10, 0), day('2026-03-01', 20, 0)]);
		expect(series.map((b) => b.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
	});

	it('extends through `throughDate` so a quiet tail still shows as quiet', () => {
		const series = buildDelegationSeries([day('2026-01-01', 100, 0)], {
			throughDate: '2026-01-04',
		});
		expect(series).toHaveLength(4);
		expect(series[3].date).toBe('2026-01-04');
		expect(series[3].interactive.durationMs).toBe(0);
	});

	it('groups long ranges into equal-width buckets under the cap', () => {
		const days: DelegationDay[] = [];
		const cursor = new Date(2026, 0, 1);
		for (let i = 0; i < 40; i++) {
			days.push(day(toYmd(cursor), 60, 40));
			cursor.setDate(cursor.getDate() + 1);
		}
		const series = buildDelegationSeries(days, { maxBars: 10 });
		expect(series.length).toBeLessThanOrEqual(10);
		// Nothing is dropped by grouping: the totals still add up.
		const totalInteractive = series.reduce((sum, b) => sum + b.interactive.durationMs, 0);
		expect(totalInteractive).toBe(40 * 60);
		expect(series[0].days).toBe(4);
		expect(series[0].endDate).toBe('2026-01-04');
	});
});

describe('bucket metric helpers', () => {
	const [bucket] = buildDelegationSeries([day('2026-02-02', 300, 500, 200, [3, 2, 1])]);

	it('reads the metric the chart is currently showing', () => {
		expect(bucketInteractiveValue(bucket, 'duration')).toBe(300);
		expect(bucketInteractiveValue(bucket, 'count')).toBe(3);
		// Delegated is Auto Run + Cue in both modes.
		expect(bucketDelegatedValue(bucket, 'duration')).toBe(700);
		expect(bucketDelegatedValue(bucket, 'count')).toBe(3);
	});

	it('scores an empty bucket at zero rather than NaN', () => {
		const [empty] = buildDelegationSeries([day('2026-02-02', 0, 0)]);
		expect(bucketDelegatedPercent(empty, 'duration')).toBe(0);
	});

	it('computes the delegated share per bucket', () => {
		expect(bucketDelegatedPercent(bucket, 'duration')).toBe(70);
	});
});
