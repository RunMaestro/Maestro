import { describe, it, expect } from 'vitest';
import {
	computePromptCadence,
	emptyPromptCadence,
	localDayStartMs,
	promptWindowStart,
	PROMPT_STRETCH_BREAK_MS,
} from '../../shared/promptCadence';
import { toLocalYmd } from '../../shared/localDay';

// Fixed local "now": Friday 2026-10-16, 15:00.
const NOW = new Date(2026, 9, 16, 15, 0).getTime();
const at = (day: number, hour: number, minute = 0) =>
	new Date(2026, 9, day, hour, minute).getTime();

describe('promptWindowStart', () => {
	it('returns null with no prompt history', () => {
		expect(promptWindowStart('week', null, NOW)).toBeNull();
	});

	it('opens a bounded range N-1 local days before today', () => {
		expect(promptWindowStart('week', at(1, 9), NOW)).toBe('2026-10-10');
		expect(promptWindowStart('day', at(1, 9), NOW)).toBe('2026-10-16');
	});

	it('never opens before the first prompt ever', () => {
		expect(promptWindowStart('month', at(14, 9), NOW)).toBe('2026-10-14');
	});

	it('opens all-time on the first prompt day', () => {
		expect(promptWindowStart('all', at(3, 23), NOW)).toBe('2026-10-03');
	});
});

describe('localDayStartMs', () => {
	it('is local midnight', () => {
		expect(localDayStartMs('2026-10-16')).toBe(new Date(2026, 9, 16).getTime());
	});
});

describe('computePromptCadence', () => {
	it('returns the empty shape without a window', () => {
		expect(computePromptCadence({ timestamps: [], windowStart: null, now: NOW })).toEqual(
			emptyPromptCadence(NOW)
		);
	});

	it('builds a dense calendar with zero days and today last', () => {
		const cadence = computePromptCadence({
			timestamps: [at(12, 9), at(14, 9), at(14, 10)],
			windowStart: '2026-10-12',
			now: NOW,
		});
		expect(cadence.days.map((d) => d.count)).toEqual([1, 0, 2, 0, 0]);
		expect(cadence.calendarDays).toBe(5);
		expect(cadence.activeDays).toBe(2);
		expect(cadence.windowEnd).toBe('2026-10-16');
	});

	it('leaves today out of per-day averages, min, and median but not totals or max', () => {
		const cadence = computePromptCadence({
			// 10-13: 4, 10-14: 2, 10-15: 0, today 10-16: 9
			timestamps: [
				...[1, 2, 3, 4].map((m) => at(13, 9, m)),
				at(14, 9),
				at(14, 11),
				...Array.from({ length: 9 }, (_, m) => at(16, 9, m)),
			],
			windowStart: '2026-10-13',
			now: NOW,
		});
		expect(cadence.total).toBe(15);
		expect(cadence.sampleDays).toBe(3);
		expect(cadence.avgPerDay).toBe(2); // (4 + 2 + 0) / 3
		expect(cadence.avgPerActiveDay).toBe(3); // (4 + 2) / 2
		expect(cadence.perDay.min).toBe(0);
		expect(cadence.perDay.max).toBe(4);
		expect(cadence.busiestDay).toEqual({ date: '2026-10-16', count: 9 });
		expect(cadence.quietestActiveDay).toEqual({ date: '2026-10-14', count: 2 });
	});

	it('treats a single-day window as its own sample', () => {
		const cadence = computePromptCadence({
			timestamps: [at(16, 9), at(16, 10)],
			windowStart: '2026-10-16',
			now: NOW,
		});
		expect(cadence.sampleDays).toBe(1);
		expect(cadence.avgPerDay).toBe(2);
		expect(cadence.quietestActiveDay).toEqual({ date: '2026-10-16', count: 2 });
	});

	it('does not break the current streak on a today with no prompts yet', () => {
		const cadence = computePromptCadence({
			timestamps: [at(11, 9), at(13, 9), at(14, 9), at(15, 9)],
			windowStart: '2026-10-10',
			now: NOW,
		});
		expect(cadence.currentStreak).toBe(3);
		expect(cadence.longestStreak).toBe(3);
	});

	it('counts today in the current streak once it has a prompt', () => {
		const cadence = computePromptCadence({
			timestamps: [at(15, 9), at(16, 9)],
			windowStart: '2026-10-14',
			now: NOW,
		});
		expect(cadence.currentStreak).toBe(2);
	});

	it('finds the peak hour of day and the busiest single clock hour', () => {
		const cadence = computePromptCadence({
			timestamps: [at(13, 9), at(14, 9), at(14, 14), at(14, 14, 5), at(14, 14, 10)],
			windowStart: '2026-10-13',
			now: NOW,
		});
		expect(cadence.byHour[9]).toBe(2);
		expect(cadence.byHour[14]).toBe(3);
		expect(cadence.peakHour).toBe(14);
		expect(cadence.busiestHour).toEqual({ date: '2026-10-14', hour: 14, count: 3 });
	});

	it('averages weekdays over complete calendar occurrences', () => {
		// 2026-10-09 and 2026-10-16 are Fridays; today (the 16th) is excluded.
		const cadence = computePromptCadence({
			timestamps: [at(9, 9), at(9, 10), at(10, 9)],
			windowStart: '2026-10-09',
			now: NOW,
		});
		expect(cadence.avgByWeekday[5]).toBe(2); // one complete Friday with 2
		expect(cadence.avgByWeekday[6]).toBe(1); // Saturday the 10th
		expect(cadence.avgByWeekday[0]).toBe(0);
	});

	it('splits working stretches on long breaks and keeps only in-stretch gaps', () => {
		const cadence = computePromptCadence({
			timestamps: [at(14, 9, 0), at(14, 9, 2), at(14, 9, 6), at(14, 13, 0), at(14, 13, 1)],
			windowStart: '2026-10-14',
			now: NOW,
		});
		expect(cadence.stretches).toBe(2);
		expect(cadence.gapMs.count).toBe(3);
		expect(cadence.gapMs.max).toBeLessThanOrEqual(PROMPT_STRETCH_BREAK_MS);
		expect(cadence.gapMs.p50).toBe(2 * 60 * 1000);
	});

	it('ignores timestamps before the window and non-finite values', () => {
		const cadence = computePromptCadence({
			timestamps: [at(1, 9), Number.NaN, at(15, 9)],
			windowStart: '2026-10-14',
			now: NOW,
		});
		expect(cadence.total).toBe(1);
		expect(toLocalYmd(at(15, 9))).toBe(cadence.days[1].date);
	});
});
