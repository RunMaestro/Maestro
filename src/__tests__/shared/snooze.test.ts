import { describe, it, expect } from 'vitest';
import {
	parseSnoozeInput,
	formatSnoozeCountdown,
	formatSnoozeTarget,
	SNOOZE_PRESETS,
	SNOOZE_DEFAULT_HOUR,
	MIN_SNOOZE_MS,
} from '../../shared/snooze';

// Fixed reference instant: Wednesday 2026-07-15, 10:30 local time.
// Every relative assertion below is anchored to this so the suite is
// timezone-stable and doesn't drift with the wall clock.
const NOW = new Date(2026, 6, 15, 10, 30, 0, 0).getTime();

/** Resolve an expression, failing loudly if it didn't parse. */
function resolve(input: string, now = NOW): Date {
	const result = parseSnoozeInput(input, now);
	if (!result.ok) throw new Error(`expected "${input}" to parse, got: ${result.error}`);
	return new Date(result.at);
}

describe('parseSnoozeInput - durations', () => {
	it('parses compact duration shorthand', () => {
		expect(resolve('1d').getTime()).toBe(NOW + 24 * 60 * 60 * 1000);
		expect(resolve('10h').getTime()).toBe(NOW + 10 * 60 * 60 * 1000);
		expect(resolve('45m').getTime()).toBe(NOW + 45 * 60 * 1000);
	});

	it('parses spelled-out units and plurals', () => {
		expect(resolve('2 weeks').getTime()).toBe(NOW + 14 * 24 * 60 * 60 * 1000);
		expect(resolve('3 days').getTime()).toBe(NOW + 3 * 24 * 60 * 60 * 1000);
		expect(resolve('1 hour').getTime()).toBe(NOW + 60 * 60 * 1000);
	});

	it('accepts a leading "in" and compound durations', () => {
		expect(resolve('in 2 hours').getTime()).toBe(NOW + 2 * 60 * 60 * 1000);
		expect(resolve('1d 4h').getTime()).toBe(NOW + 28 * 60 * 60 * 1000);
	});

	it('rejects trailing junk rather than silently ignoring it', () => {
		expect(parseSnoozeInput('2 weeks from bob', NOW).ok).toBe(false);
		expect(parseSnoozeInput('5 bananas', NOW).ok).toBe(false);
	});
});

describe('parseSnoozeInput - calendar keywords', () => {
	it('resolves tomorrow to the default hour', () => {
		const result = resolve('tomorrow');
		expect(result.getDate()).toBe(16);
		expect(result.getHours()).toBe(SNOOZE_DEFAULT_HOUR);
		expect(result.getMinutes()).toBe(0);
	});

	it('resolves next month to the 1st of the following month', () => {
		const result = resolve('next month');
		expect(result.getMonth()).toBe(7); // August
		expect(result.getDate()).toBe(1);
	});

	it('resolves this weekend to the upcoming Saturday', () => {
		const result = resolve('this weekend');
		expect(result.getDay()).toBe(6);
		expect(result.getDate()).toBe(18);
	});

	it('resolves next week to the upcoming Monday, not the week after', () => {
		// Regression guard: "next week" on a Wednesday means five days out.
		const result = resolve('next week');
		expect(result.getDay()).toBe(1);
		expect(result.getDate()).toBe(20);
	});

	it('resolves tonight to the evening of the same day', () => {
		const result = resolve('tonight');
		expect(result.getDate()).toBe(15);
		expect(result.getHours()).toBe(18);
	});
});

describe('parseSnoozeInput - weekdays', () => {
	it('resolves a bare weekday to its next occurrence', () => {
		const result = resolve('friday');
		expect(result.getDay()).toBe(5);
		expect(result.getDate()).toBe(17);
	});

	it('treats "next <weekday>" as the following week', () => {
		const result = resolve('next friday');
		expect(result.getDay()).toBe(5);
		expect(result.getDate()).toBe(24);
	});

	it('never resolves a weekday to today', () => {
		// NOW is a Wednesday; "wednesday" must mean the next one.
		const result = resolve('wednesday');
		expect(result.getDate()).toBe(22);
	});

	it('accepts abbreviations and a trailing time', () => {
		const result = resolve('fri 3pm');
		expect(result.getDay()).toBe(5);
		expect(result.getHours()).toBe(15);
	});
});

describe('parseSnoozeInput - times of day', () => {
	it('resolves a bare time later today', () => {
		const result = resolve('3pm');
		expect(result.getDate()).toBe(15);
		expect(result.getHours()).toBe(15);
	});

	it('rolls a bare time that already passed to tomorrow', () => {
		const result = resolve('9am');
		expect(result.getDate()).toBe(16);
		expect(result.getHours()).toBe(9);
	});

	it('accepts 24-hour, minutes, and "at"', () => {
		expect(resolve('15:45').getHours()).toBe(15);
		expect(resolve('15:45').getMinutes()).toBe(45);
		expect(resolve('tomorrow at 9am').getHours()).toBe(9);
	});

	it('handles noon and midnight', () => {
		expect(resolve('noon').getHours()).toBe(12);
		expect(resolve('tomorrow midnight').getHours()).toBe(0);
	});
});

describe('parseSnoozeInput - absolute dates', () => {
	it('parses ISO dates', () => {
		const result = resolve('2026-08-05');
		expect(result.getFullYear()).toBe(2026);
		expect(result.getMonth()).toBe(7);
		expect(result.getDate()).toBe(5);
		expect(result.getHours()).toBe(SNOOZE_DEFAULT_HOUR);
	});

	it('parses month-name forms in both orders', () => {
		expect(resolve('aug 5').getMonth()).toBe(7);
		expect(resolve('aug 5').getDate()).toBe(5);
		expect(resolve('5 august').getDate()).toBe(5);
		expect(resolve('august 5 2027').getFullYear()).toBe(2027);
	});

	it('parses US slash dates with an optional time', () => {
		expect(resolve('12/25').getMonth()).toBe(11);
		expect(resolve('12/25').getDate()).toBe(25);
		expect(resolve('12/25 6pm').getHours()).toBe(18);
	});

	it('rolls a bare month/day that already passed into next year', () => {
		// NOW is July 15 2026, so "jan 5" means January 2027.
		expect(resolve('jan 5').getFullYear()).toBe(2027);
		expect(resolve('1/5').getFullYear()).toBe(2027);
	});

	it('rejects impossible dates instead of overflowing into the next month', () => {
		expect(parseSnoozeInput('2026-02-31', NOW).ok).toBe(false);
		expect(parseSnoozeInput('2026-13-01', NOW).ok).toBe(false);
	});
});

describe('parseSnoozeInput - rejections', () => {
	it('rejects empty input', () => {
		expect(parseSnoozeInput('', NOW).ok).toBe(false);
		expect(parseSnoozeInput('   ', NOW).ok).toBe(false);
	});

	it('rejects unparseable text with a message naming the input', () => {
		const result = parseSnoozeInput('sometime soonish', NOW);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('sometime soonish');
	});

	it('rejects times in the past and sub-minute snoozes', () => {
		expect(parseSnoozeInput('2020-01-01', NOW).ok).toBe(false);
		expect(parseSnoozeInput('10s', NOW).ok).toBe(false);
	});

	it('accepts anything at least the minimum distance out', () => {
		const result = parseSnoozeInput('2m', NOW);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.at - NOW).toBeGreaterThanOrEqual(MIN_SNOOZE_MS);
	});

	it('is case and whitespace insensitive', () => {
		expect(resolve('  NEXT   MONTH  ').getMonth()).toBe(7);
		expect(resolve('ToMoRRoW').getDate()).toBe(16);
	});
});

describe('SNOOZE_PRESETS', () => {
	it('every preset resolves to a future time at the reference instant', () => {
		for (const preset of SNOOZE_PRESETS) {
			const result = parseSnoozeInput(preset.expression, NOW);
			expect(result.ok, `preset "${preset.id}" failed to resolve`).toBe(true);
			if (result.ok) expect(result.at).toBeGreaterThan(NOW);
		}
	});

	it('drops presets that would land in the past', () => {
		// At 11pm, "This evening" (6pm) is gone but "Tomorrow" survives. The modal
		// relies on this filter so it never renders an unusable button.
		const lateNight = new Date(2026, 6, 15, 23, 0, 0, 0).getTime();
		const usable = SNOOZE_PRESETS.filter((p) => parseSnoozeInput(p.expression, lateNight).ok);
		expect(usable.map((p) => p.id)).not.toContain('tonight');
		expect(usable.map((p) => p.id)).toContain('tomorrow');
	});
});

describe('formatters', () => {
	it('formats countdowns at the right granularity', () => {
		expect(formatSnoozeCountdown(NOW + 30 * 60 * 1000, NOW)).toBe('in 30 min');
		expect(formatSnoozeCountdown(NOW + 3 * 60 * 60 * 1000, NOW)).toBe('in 3 hours');
		expect(formatSnoozeCountdown(NOW + 1 * 60 * 60 * 1000, NOW)).toBe('in 1 hour');
		expect(formatSnoozeCountdown(NOW + 3 * 24 * 60 * 60 * 1000, NOW)).toBe('in 3 days');
		expect(formatSnoozeCountdown(NOW + 21 * 24 * 60 * 60 * 1000, NOW)).toBe('in 3 weeks');
	});

	it('reports an elapsed target as "now"', () => {
		expect(formatSnoozeCountdown(NOW - 1000, NOW)).toBe('now');
	});

	it('includes the year only when it differs from the current one', () => {
		const thisYear = new Date(2026, 7, 5, 9, 0).getTime();
		const nextYear = new Date(2027, 7, 5, 9, 0).getTime();
		expect(formatSnoozeTarget(thisYear, NOW)).not.toContain('2026');
		expect(formatSnoozeTarget(nextYear, NOW)).toContain('2027');
	});
});
