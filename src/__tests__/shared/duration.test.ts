/**
 * Tests for shared/duration.ts - the single unit ladder every humanized
 * duration in Maestro renders from.
 *
 * The preset cases below are not decoration: each one is the exact output some
 * surface shipped before those formatters were folded onto the shared engine.
 * They exist so a future change to the engine cannot quietly restyle the Usage
 * Dashboard, the retry countdown, or a conductor badge.
 */

import {
	humanizeDuration,
	formatDurationHuman,
	formatDurationCompact,
	formatDurationVerbose,
	formatDurationParts,
	formatDurationDecimal,
	formatDurationLong,
	formatDurationWords,
	formatActiveTime,
	formatElapsedTime,
	DURATION_MS,
	DURATION_LADDER_DAYS,
	DURATION_LADDER_HOURS,
} from '../../shared/duration';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

describe('shared/duration', () => {
	// ==========================================================================
	// humanizeDuration - the engine
	// ==========================================================================
	describe('humanizeDuration', () => {
		it('shows the two largest non-zero units by default', () => {
			expect(humanizeDuration(2 * HOUR + 15 * MINUTE + 30 * SECOND)).toBe('2h 15m');
			expect(humanizeDuration(6 * DAY + 7 * HOUR)).toBe('6d 7h');
		});

		it('skips zero units instead of padding them', () => {
			expect(humanizeDuration(2 * DAY + 30 * SECOND)).toBe('2d 30s');
		});

		it('pads zero units when asked, for steady-width columns', () => {
			expect(
				humanizeDuration(2 * HOUR, { keepZeroUnits: true, units: DURATION_LADDER_HOURS })
			).toBe('2h 0m');
		});

		it('never pads a leading zero unit', () => {
			expect(humanizeDuration(45 * SECOND, { keepZeroUnits: true })).toBe('45s');
		});

		it('honors the unit budget', () => {
			const span = DAY + 12 * HOUR + 20 * MINUTE;
			expect(humanizeDuration(span, { maxUnits: 1 })).toBe('1d');
			expect(humanizeDuration(span, { maxUnits: 3 })).toBe('1d 12h 20m');
			expect(humanizeDuration(span, { maxUnits: 0 })).toBe('1d');
		});

		it('stops at the ladder ceiling it is given', () => {
			// 30 hours is "1d 6h" on the day ladder but "30h 0m" on the hour ladder.
			expect(humanizeDuration(30 * HOUR, { units: DURATION_LADDER_DAYS })).toBe('1d 6h');
			expect(
				humanizeDuration(30 * HOUR, { units: DURATION_LADDER_HOURS, keepZeroUnits: true })
			).toBe('30h 0m');
		});

		it('renders each label style', () => {
			const span = 2 * HOUR + 30 * MINUTE;
			expect(humanizeDuration(span, { style: 'short' })).toBe('2h 30m');
			expect(humanizeDuration(span, { style: 'long' })).toBe('2 hours 30 minutes');
			expect(humanizeDuration(span, { style: 'caps' })).toBe('2H 30M');
		});

		it('pluralizes only in the long style', () => {
			expect(humanizeDuration(SECOND, { style: 'long' })).toBe('1 second');
			expect(humanizeDuration(2 * SECOND, { style: 'long' })).toBe('2 seconds');
		});

		it('accepts a custom separator', () => {
			expect(humanizeDuration(DAY + 12 * HOUR, { style: 'long', separator: ', ' })).toBe(
				'1 day, 12 hours'
			);
		});

		it('labels months "mo" so short output cannot collide with minutes', () => {
			expect(humanizeDuration(10 * WEEK, { maxUnits: 1 })).toBe('2mo');
			expect(humanizeDuration(10 * MINUTE, { maxUnits: 1 })).toBe('10m');
		});

		describe('adjacentUnits', () => {
			it('drops a distant second unit to keep near-exact spans round', () => {
				expect(humanizeDuration(HOUR + 59 * SECOND, { adjacentUnits: true })).toBe('1h');
				expect(humanizeDuration(YEAR + 3 * DAY, { adjacentUnits: true })).toBe('1y');
			});

			it('keeps the second unit when it is the very next rung', () => {
				expect(humanizeDuration(HOUR + 30 * MINUTE, { adjacentUnits: true })).toBe('1h 30m');
			});

			it('differs from the default, which reports both non-zero units', () => {
				expect(humanizeDuration(HOUR + 59 * SECOND)).toBe('1h 59s');
			});
		});

		describe('rounding', () => {
			it('floors by default, so not-quite-a-minute is not a minute', () => {
				expect(humanizeDuration(59_400, { units: DURATION_LADDER_HOURS })).toBe('59s');
			});

			it('rounds up for countdowns, so time left never reads as zero', () => {
				expect(humanizeDuration(59_400, { units: DURATION_LADDER_HOURS, round: 'ceil' })).toBe(
					'1m'
				);
				expect(humanizeDuration(1, { round: 'ceil' })).toBe('1s');
			});
		});

		describe('fallback', () => {
			it('renders a zero of the smallest rung by default', () => {
				expect(humanizeDuration(0)).toBe('0s');
				expect(humanizeDuration(0, { style: 'long' })).toBe('0 seconds');
				expect(humanizeDuration(0, { units: ['hour', 'minute'] })).toBe('0m');
			});

			it('uses an explicit fallback when given', () => {
				expect(humanizeDuration(0, { fallback: '<1M' })).toBe('<1M');
			});

			it('collapses spans below the smallest rung', () => {
				expect(humanizeDuration(999)).toBe('0s');
				expect(humanizeDuration(59 * SECOND, { units: ['hour', 'minute'] })).toBe('0m');
			});

			it('collapses negative and non-finite input rather than throwing', () => {
				// These arrive from clock deltas; a backwards jump must not blank a panel.
				expect(humanizeDuration(-5000)).toBe('0s');
				expect(humanizeDuration(Number.NaN)).toBe('0s');
				expect(humanizeDuration(Number.POSITIVE_INFINITY)).toBe('0s');
			});
		});

		it('falls back to the full ladder when handed an empty one', () => {
			expect(humanizeDuration(2 * HOUR, { units: [] })).toBe('2h');
		});
	});

	// ==========================================================================
	// Presets - each case is output that shipped before the consolidation
	// ==========================================================================
	describe('formatDurationHuman', () => {
		it('pads to two segments above a minute', () => {
			expect(formatDurationHuman(0)).toBe('0s');
			expect(formatDurationHuman(45 * SECOND)).toBe('45s');
			expect(formatDurationHuman(5 * MINUTE + 30 * SECOND)).toBe('5m 30s');
			expect(formatDurationHuman(5 * MINUTE)).toBe('5m 0s');
			expect(formatDurationHuman(2 * HOUR + 15 * MINUTE)).toBe('2h 15m');
		});

		it('counts past a day in hours', () => {
			expect(formatDurationHuman(30 * HOUR)).toBe('30h 0m');
		});
	});

	describe('formatDurationCompact', () => {
		it('drops seconds once the span reaches a minute', () => {
			expect(formatDurationCompact(0)).toBe('0s');
			expect(formatDurationCompact(45 * SECOND)).toBe('45s');
			expect(formatDurationCompact(5 * MINUTE + 30 * SECOND)).toBe('5m');
			expect(formatDurationCompact(2 * HOUR + 15 * MINUTE)).toBe('2h 15m');
			expect(formatDurationCompact(2 * HOUR)).toBe('2h 0m');
		});
	});

	describe('formatDurationVerbose', () => {
		it('spells the units out', () => {
			expect(formatDurationVerbose(45 * SECOND)).toBe('45 seconds');
			expect(formatDurationVerbose(5 * MINUTE + 30 * SECOND)).toBe('5 minutes 30 seconds');
			expect(formatDurationVerbose(HOUR + 15 * MINUTE)).toBe('1 hour 15 minutes');
		});

		it('stays round rather than trailing a distant unit', () => {
			expect(formatDurationVerbose(HOUR)).toBe('1 hour');
			expect(formatDurationVerbose(HOUR + 59 * SECOND)).toBe('1 hour');
		});

		it('pluralizes a zero span', () => {
			expect(formatDurationVerbose(0)).toBe('0 seconds');
		});
	});

	describe('formatDurationParts', () => {
		it('reports raw milliseconds below a second', () => {
			expect(formatDurationParts(500)).toBe('500ms');
		});

		it('lists every non-zero segment', () => {
			expect(formatDurationParts(5 * SECOND)).toBe('5s');
			expect(formatDurationParts(2 * MINUTE + 30 * SECOND)).toBe('2m 30s');
			expect(formatDurationParts(HOUR + 15 * MINUTE + 20 * SECOND)).toBe('1h 15m 20s');
		});

		it('drops seconds once the span reaches a day', () => {
			expect(formatDurationParts(3 * DAY + 2 * HOUR + 15 * MINUTE + 30 * SECOND)).toBe('3d 2h 15m');
		});
	});

	describe('formatDurationDecimal', () => {
		it('uses one decimal and a single unit', () => {
			expect(formatDurationDecimal(500)).toBe('500ms');
			expect(formatDurationDecimal(5200)).toBe('5.2s');
			expect(formatDurationDecimal(3 * MINUTE + 6 * SECOND)).toBe('3.1m');
			expect(formatDurationDecimal(HOUR + 30 * MINUTE)).toBe('1.5h');
		});
	});

	describe('formatDurationLong', () => {
		it('ladders to years without months', () => {
			expect(formatDurationLong(45 * SECOND)).toBe('45s');
			expect(formatDurationLong(2 * HOUR + 15 * MINUTE)).toBe('2h 15m');
			expect(formatDurationLong(6 * DAY + 7 * HOUR)).toBe('6d 7h');
			expect(formatDurationLong(3 * WEEK + 2 * DAY)).toBe('3w 2d');
			expect(formatDurationLong(YEAR + 7 * WEEK)).toBe('1y 7w');
		});

		it('collapses sub-second and invalid spans', () => {
			expect(formatDurationLong(999)).toBe('0s');
			expect(formatDurationLong(Number.NaN)).toBe('0s');
		});
	});

	describe('formatDurationWords', () => {
		it('singularizes a lone unit', () => {
			expect(formatDurationWords(SECOND)).toBe('1 second');
			expect(formatDurationWords(MINUTE)).toBe('1 minute');
			expect(formatDurationWords(DAY)).toBe('1 day');
		});

		it('pluralizes counts above one', () => {
			expect(formatDurationWords(45 * SECOND)).toBe('45 seconds');
			expect(formatDurationWords(3 * WEEK)).toBe('3 weeks');
		});

		it('shows the two largest non-zero units by default', () => {
			expect(formatDurationWords(5 * MINUTE + 30 * SECOND)).toBe('5 minutes, 30 seconds');
			expect(formatDurationWords(DAY + 12 * HOUR)).toBe('1 day, 12 hours');
			// The 130127.72s snooze gap that motivated this formatter.
			expect(formatDurationWords(130_127_720)).toBe('1 day, 12 hours');
		});

		it('skips units that are zero rather than padding them', () => {
			expect(formatDurationWords(2 * DAY + 30 * SECOND)).toBe('2 days, 30 seconds');
		});

		it('ladders up through months and years', () => {
			expect(formatDurationWords(10 * WEEK)).toBe('2 months, 1 week');
			expect(formatDurationWords(400 * DAY)).toBe('1 year, 1 month');
		});

		it('never reports twelve months instead of a year', () => {
			expect(formatDurationWords(364 * DAY)).toBe('11 months, 4 weeks');
		});

		it('honors an explicit unit budget', () => {
			expect(formatDurationWords(DAY + 12 * HOUR + 20 * MINUTE, 3)).toBe(
				'1 day, 12 hours, 20 minutes'
			);
			expect(formatDurationWords(DAY + 12 * HOUR, 1)).toBe('1 day');
			expect(formatDurationWords(DAY + 12 * HOUR, 0)).toBe('1 day');
		});

		it('collapses sub-second and invalid spans', () => {
			expect(formatDurationWords(0)).toBe('less than a second');
			expect(formatDurationWords(999)).toBe('less than a second');
			expect(formatDurationWords(-5000)).toBe('less than a second');
			expect(formatDurationWords(Number.NaN)).toBe('less than a second');
		});
	});

	describe('formatActiveTime', () => {
		it('uses uppercase units and shows only days past a day', () => {
			expect(formatActiveTime(30 * SECOND)).toBe('<1M');
			expect(formatActiveTime(5 * MINUTE)).toBe('5M');
			expect(formatActiveTime(2 * HOUR + 30 * MINUTE)).toBe('2H 30M');
			expect(formatActiveTime(2 * HOUR)).toBe('2H');
			expect(formatActiveTime(DAY + 3 * HOUR)).toBe('1D');
		});
	});

	describe('formatElapsedTime', () => {
		it('adds millisecond precision below a second', () => {
			expect(formatElapsedTime(500)).toBe('500ms');
			expect(formatElapsedTime(30 * SECOND)).toBe('30s');
			expect(formatElapsedTime(5 * MINUTE + 12 * SECOND)).toBe('5m 12s');
			expect(formatElapsedTime(HOUR + 10 * MINUTE)).toBe('1h 10m');
		});
	});

	describe('DURATION_MS', () => {
		it('exposes the unit sizes callers would otherwise redeclare', () => {
			expect(DURATION_MS.second).toBe(1000);
			expect(DURATION_MS.minute).toBe(60_000);
			expect(DURATION_MS.hour).toBe(3_600_000);
			expect(DURATION_MS.day).toBe(86_400_000);
			expect(DURATION_MS.week).toBe(604_800_000);
			expect(DURATION_MS.year).toBe(365 * DURATION_MS.day);
		});

		it('uses the average Gregorian month, so twelve exceed a year', () => {
			expect(DURATION_MS.month * 12).toBeGreaterThan(DURATION_MS.year);
		});
	});
});
