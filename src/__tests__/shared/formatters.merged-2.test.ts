// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/formatters.test.ts
// Source: src/__tests__/shared/cue-pipeline-summary.test.ts
// Source: src/__tests__/shared/isLimitError.test.ts
import { describe, it, expect } from 'vitest';
/**
 * Tests for shared/formatters.ts
 * Tests all formatting utility functions used across renderer and web.
 */
import {
	formatSize,
	formatTokensPerSecond,
	formatNumber,
	formatCount,
	formatTokens,
	formatTokensCompact,
	formatRelativeTime,
	formatCacheAge,
	formatAgeShort,
	formatCalendarDay,
	formatActiveTime,
	formatElapsedTime,
	formatElapsedTimeColon,
	formatCost,
	estimateTokenCount,
	truncatePath,
	truncateCommand,
	truncateAtWordBoundary,
	abbreviateGroupName,
	isAbsolutePath,
	getBasename,
	joinPath,
	formatSshTarget,
	formatTimestamp,
} from '../../shared/formatters';
import {
	describePipeline,
	derivePipelineHealth,
	stripPipelinePrefix,
	summarizeCommandNode,
} from '../../shared/cue-pipeline-summary';
import type { CuePipeline, PipelineNode } from '../../shared/cue-pipeline-types';
import type { CueRunResult } from '../../shared/cue/contracts';
import { isLimitError } from '../../shared/types';
import type { AgentError, AgentErrorType } from '../../shared/types';
// Source: src/__tests__/shared/formatters.test.ts
describe('', () => {
	describe('shared/formatters', () => {
		// ==========================================================================
		// formatSize tests
		// ==========================================================================
		describe('formatSize', () => {
			it('should format bytes', () => {
				expect(formatSize(0)).toBe('0 B');
				expect(formatSize(1)).toBe('1 B');
				expect(formatSize(100)).toBe('100 B');
				expect(formatSize(1023)).toBe('1023 B');
			});
			it('should format kilobytes', () => {
				expect(formatSize(1024)).toBe('1.0 KB');
				expect(formatSize(1536)).toBe('1.5 KB');
				expect(formatSize(1024 * 100)).toBe('100.0 KB');
			});
			it('should format megabytes', () => {
				expect(formatSize(1024 * 1024)).toBe('1.0 MB');
				expect(formatSize(1024 * 1024 * 1.5)).toBe('1.5 MB');
				expect(formatSize(1024 * 1024 * 100)).toBe('100.0 MB');
			});
			it('should format gigabytes', () => {
				expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB');
				expect(formatSize(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB');
			});
			it('should format terabytes', () => {
				expect(formatSize(1024 * 1024 * 1024 * 1024)).toBe('1.0 TB');
				expect(formatSize(1024 * 1024 * 1024 * 1024 * 5)).toBe('5.0 TB');
			});
		});
		// ==========================================================================
		// formatNumber tests
		// ==========================================================================
		describe('formatNumber', () => {
			it('should format small numbers', () => {
				expect(formatNumber(0)).toBe('0');
				expect(formatNumber(1)).toBe('1');
				expect(formatNumber(999)).toBe('999');
			});
			it('should format thousands with K suffix', () => {
				expect(formatNumber(1000)).toBe('1.0K');
				expect(formatNumber(1500)).toBe('1.5K');
				expect(formatNumber(999999)).toBe('1000.0K');
			});
			it('should format millions with M suffix', () => {
				expect(formatNumber(1000000)).toBe('1.0M');
				expect(formatNumber(1500000)).toBe('1.5M');
				expect(formatNumber(999999999)).toBe('1000.0M');
			});
			it('should format billions with B suffix', () => {
				expect(formatNumber(1000000000)).toBe('1.0B');
				expect(formatNumber(2500000000)).toBe('2.5B');
			});
		});
		// ==========================================================================
		// formatCount tests (exact counterpart to formatNumber)
		// ==========================================================================
		describe('formatCount', () => {
			it('groups digits instead of rounding to a magnitude', () => {
				expect(formatCount(42)).toBe('42');
				expect(formatCount(1000)).toBe('1,000');
				expect(formatCount(1204993)).toBe('1,204,993');
			});
			it('keeps every digit where formatNumber discards them', () => {
				// The whole reason this exists: a filtered row count is read for its
				// digits, and `1.2M` throws away the part the user was looking at.
				expect(formatNumber(1204993)).toBe('1.2M');
				expect(formatCount(1204993)).toBe('1,204,993');
			});
			it('handles zero and negatives', () => {
				expect(formatCount(0)).toBe('0');
				expect(formatCount(-5)).toBe('-5');
			});
		});
		// ==========================================================================
		// formatTokens tests (with ~ prefix)
		// ==========================================================================
		describe('formatTokens', () => {
			it('should format small token counts without prefix', () => {
				expect(formatTokens(0)).toBe('0');
				expect(formatTokens(1)).toBe('1');
				expect(formatTokens(999)).toBe('999');
			});
			it('should format thousands with ~K suffix', () => {
				expect(formatTokens(1000)).toBe('~1K');
				expect(formatTokens(1500)).toBe('~2K'); // Rounds to nearest K
				expect(formatTokens(5000)).toBe('~5K');
			});
			it('should format millions with ~M suffix', () => {
				expect(formatTokens(1000000)).toBe('~1M');
				expect(formatTokens(2500000)).toBe('~3M'); // Rounds to nearest M
			});
			it('should format billions with ~B suffix', () => {
				expect(formatTokens(1000000000)).toBe('~1B');
				expect(formatTokens(2500000000)).toBe('~3B'); // Rounds to nearest B
			});
		});
		// ==========================================================================
		// formatTokensCompact tests (without ~ prefix, decimal)
		// ==========================================================================
		describe('formatTokensPerSecond', () => {
			it('uses one decimal below 100, whole numbers below 1,000, then compact', () => {
				expect(formatTokensPerSecond(42.66)).toBe('42.7');
				expect(formatTokensPerSecond(412.4)).toBe('412');
				expect(formatTokensPerSecond(38400)).toBe('38.4K');
			});
			it('renders an unmeasured rate as a dash', () => {
				expect(formatTokensPerSecond(0)).toBe('-');
				expect(formatTokensPerSecond(-1)).toBe('-');
				expect(formatTokensPerSecond(Number.NaN)).toBe('-');
			});
		});
		describe('formatTokensCompact', () => {
			it('should format small token counts', () => {
				expect(formatTokensCompact(0)).toBe('0');
				expect(formatTokensCompact(1)).toBe('1');
				expect(formatTokensCompact(999)).toBe('999');
			});
			it('should format thousands with K suffix and decimal', () => {
				expect(formatTokensCompact(1000)).toBe('1.0K');
				expect(formatTokensCompact(1500)).toBe('1.5K');
				expect(formatTokensCompact(50000)).toBe('50.0K');
			});
			it('should format millions with M suffix and decimal', () => {
				expect(formatTokensCompact(1000000)).toBe('1.0M');
				expect(formatTokensCompact(2500000)).toBe('2.5M');
			});
		});
		// ==========================================================================
		// formatRelativeTime tests
		// ==========================================================================
		describe('formatRelativeTime', () => {
			const now = Date.now();
			it('should format just now for < 1 minute', () => {
				expect(formatRelativeTime(now)).toBe('just now');
				expect(formatRelativeTime(now - 30000)).toBe('just now'); // 30 seconds
			});
			it('should format minutes ago', () => {
				expect(formatRelativeTime(now - 60000)).toBe('1m ago');
				expect(formatRelativeTime(now - 5 * 60000)).toBe('5m ago');
				expect(formatRelativeTime(now - 59 * 60000)).toBe('59m ago');
			});
			it('should format hours ago', () => {
				expect(formatRelativeTime(now - 60 * 60000)).toBe('1h ago');
				expect(formatRelativeTime(now - 5 * 60 * 60000)).toBe('5h ago');
				expect(formatRelativeTime(now - 23 * 60 * 60000)).toBe('23h ago');
			});
			it('should format days ago', () => {
				expect(formatRelativeTime(now - 24 * 60 * 60000)).toBe('1d ago');
				expect(formatRelativeTime(now - 5 * 24 * 60 * 60000)).toBe('5d ago');
				expect(formatRelativeTime(now - 6 * 24 * 60 * 60000)).toBe('6d ago');
			});
			it('should format older dates as localized date', () => {
				const result = formatRelativeTime(now - 10 * 24 * 60 * 60000);
				// Should be formatted like "Dec 10" or similar (locale dependent)
				expect(result).not.toContain('ago');
				expect(result).toMatch(/[A-Za-z]+ \d+/); // e.g., "Dec 10"
			});
			it('should accept Date objects', () => {
				expect(formatRelativeTime(new Date(now))).toBe('just now');
				expect(formatRelativeTime(new Date(now - 60000))).toBe('1m ago');
			});
			it('should accept ISO date strings', () => {
				expect(formatRelativeTime(new Date(now).toISOString())).toBe('just now');
				expect(formatRelativeTime(new Date(now - 60000).toISOString())).toBe('1m ago');
			});
			describe('includeSeconds option', () => {
				it('should format sub-minute durations as seconds', () => {
					expect(formatRelativeTime(now, { includeSeconds: true })).toBe('0s ago');
					expect(formatRelativeTime(now - 1000, { includeSeconds: true })).toBe('1s ago');
					expect(formatRelativeTime(now - 10000, { includeSeconds: true })).toBe('10s ago');
					expect(formatRelativeTime(now - 59000, { includeSeconds: true })).toBe('59s ago');
				});
				it('should fall through to minutes/hours/days when over a minute', () => {
					expect(formatRelativeTime(now - 60000, { includeSeconds: true })).toBe('1m ago');
					expect(formatRelativeTime(now - 60 * 60000, { includeSeconds: true })).toBe('1h ago');
					expect(formatRelativeTime(now - 24 * 60 * 60000, { includeSeconds: true })).toBe(
						'1d ago'
					);
				});
			});
		});
		// ==========================================================================
		// formatCacheAge tests
		// ==========================================================================
		describe('formatCacheAge', () => {
			it('should format null and zero as just now', () => {
				expect(formatCacheAge(null)).toBe('just now');
				expect(formatCacheAge(0)).toBe('just now');
			});
			it('should format sub-minute durations as just now', () => {
				expect(formatCacheAge(15000)).toBe('just now');
				expect(formatCacheAge(59999)).toBe('just now');
			});
			it('should format minutes below one hour', () => {
				expect(formatCacheAge(60000)).toBe('1m ago');
				expect(formatCacheAge(45 * 60000)).toBe('45m ago');
				expect(formatCacheAge(59 * 60000)).toBe('59m ago');
			});
			it('should format whole hours without rolling into days', () => {
				expect(formatCacheAge(60 * 60000)).toBe('1h ago');
				expect(formatCacheAge(2 * 60 * 60000)).toBe('2h ago');
				expect(formatCacheAge(25 * 60 * 60000)).toBe('25h ago');
			});
		});
		// ==========================================================================
		// formatCalendarDay tests
		// ==========================================================================
		describe('formatCalendarDay', () => {
			it('formats a YYYY-MM-DD day for display', () => {
				expect(formatCalendarDay('2026-07-10')).toBe('Jul 10, 2026');
				expect(formatCalendarDay('2025-11-26')).toBe('Nov 26, 2025');
			});
			it('renders the day it was given, not the UTC-shifted one', () => {
				// `new Date('2026-01-01')` is UTC midnight, which is Dec 31 anywhere
				// west of Greenwich. The parts are read out of the string instead.
				expect(formatCalendarDay('2026-01-01')).toBe('Jan 1, 2026');
			});
			it('tolerates surrounding whitespace', () => {
				expect(formatCalendarDay('  2026-03-01  ')).toBe('Mar 1, 2026');
			});
			it('returns the input unchanged when it is not a calendar day', () => {
				expect(formatCalendarDay('July 2026')).toBe('July 2026');
				expect(formatCalendarDay('2026-7-1')).toBe('2026-7-1');
				expect(formatCalendarDay('')).toBe('');
			});
		});
		// ==========================================================================
		// formatAgeShort tests
		// ==========================================================================
		describe('formatAgeShort', () => {
			const now = Date.now();
			const MIN = 60000;
			const HOUR = 60 * MIN;
			const DAY = 24 * HOUR;
			it('returns "new" for < 1 minute', () => {
				expect(formatAgeShort(now)).toBe('new');
				expect(formatAgeShort(now - 30000)).toBe('new');
				expect(formatAgeShort(now + 10000)).toBe('new'); // clamp future to 0
			});
			it('formats minutes (< 1 hour)', () => {
				expect(formatAgeShort(now - 1 * MIN)).toBe('1m');
				expect(formatAgeShort(now - 5 * MIN)).toBe('5m');
				expect(formatAgeShort(now - 59 * MIN)).toBe('59m');
			});
			it('formats hours (< 1 day)', () => {
				expect(formatAgeShort(now - 1 * HOUR)).toBe('1h');
				expect(formatAgeShort(now - 5 * HOUR)).toBe('5h');
				expect(formatAgeShort(now - 23 * HOUR)).toBe('23h');
			});
			it('formats days (< 1 week)', () => {
				expect(formatAgeShort(now - 1 * DAY)).toBe('1d');
				expect(formatAgeShort(now - 5 * DAY)).toBe('5d');
				expect(formatAgeShort(now - 6 * DAY)).toBe('6d');
			});
			it('formats weeks (< 30 days)', () => {
				expect(formatAgeShort(now - 7 * DAY)).toBe('1w');
				expect(formatAgeShort(now - 21 * DAY)).toBe('3w');
				expect(formatAgeShort(now - 29 * DAY)).toBe('4w');
			});
			it('formats months (< 365 days)', () => {
				expect(formatAgeShort(now - 30 * DAY)).toBe('1mo');
				expect(formatAgeShort(now - 6 * 30 * DAY)).toBe('6mo');
				expect(formatAgeShort(now - 364 * DAY)).toBe('12mo');
			});
			it('formats years with one decimal under 10 years, integer otherwise', () => {
				expect(formatAgeShort(now - 365 * DAY)).toBe('1y');
				// ~3.5y → 3.5y (rounded to one decimal)
				expect(formatAgeShort(now - Math.round(3.5 * 365) * DAY)).toBe('3.5y');
				// >= 10y: floored integer
				expect(formatAgeShort(now - 12 * 365 * DAY)).toBe('12y');
			});
			it('accepts Date objects and ISO strings', () => {
				expect(formatAgeShort(new Date(now - 5 * MIN))).toBe('5m');
				expect(formatAgeShort(new Date(now - 5 * MIN).toISOString())).toBe('5m');
			});
		});
		// ==========================================================================
		// formatActiveTime tests
		// ==========================================================================
		describe('formatActiveTime', () => {
			it('should format < 1 minute as <1M', () => {
				expect(formatActiveTime(0)).toBe('<1M');
				expect(formatActiveTime(1000)).toBe('<1M');
				expect(formatActiveTime(59000)).toBe('<1M');
			});
			it('should format minutes', () => {
				expect(formatActiveTime(60000)).toBe('1M');
				expect(formatActiveTime(5 * 60000)).toBe('5M');
				expect(formatActiveTime(59 * 60000)).toBe('59M');
			});
			it('should format hours', () => {
				expect(formatActiveTime(60 * 60000)).toBe('1H');
				expect(formatActiveTime(2 * 60 * 60000)).toBe('2H');
			});
			it('should format hours with remaining minutes', () => {
				expect(formatActiveTime(90 * 60000)).toBe('1H 30M');
				expect(formatActiveTime(150 * 60000)).toBe('2H 30M');
			});
			it('should format days', () => {
				expect(formatActiveTime(24 * 60 * 60000)).toBe('1D');
				expect(formatActiveTime(3 * 24 * 60 * 60000)).toBe('3D');
			});
		});
		// ==========================================================================
		// formatElapsedTime tests
		// ==========================================================================
		describe('formatElapsedTime', () => {
			it('should format milliseconds', () => {
				expect(formatElapsedTime(0)).toBe('0ms');
				expect(formatElapsedTime(1)).toBe('1ms');
				expect(formatElapsedTime(500)).toBe('500ms');
				expect(formatElapsedTime(999)).toBe('999ms');
			});
			it('should format seconds', () => {
				expect(formatElapsedTime(1000)).toBe('1s');
				expect(formatElapsedTime(5000)).toBe('5s');
				expect(formatElapsedTime(30000)).toBe('30s');
				expect(formatElapsedTime(59000)).toBe('59s');
			});
			it('should format minutes with seconds', () => {
				expect(formatElapsedTime(60000)).toBe('1m 0s');
				expect(formatElapsedTime(90000)).toBe('1m 30s');
				expect(formatElapsedTime(5 * 60000 + 12000)).toBe('5m 12s');
			});
			it('should format hours with minutes', () => {
				expect(formatElapsedTime(60 * 60000)).toBe('1h 0m');
				expect(formatElapsedTime(70 * 60000)).toBe('1h 10m');
				expect(formatElapsedTime(2 * 60 * 60000 + 30 * 60000)).toBe('2h 30m');
			});
		});
		// ==========================================================================
		// formatCost tests
		// ==========================================================================
		describe('formatCost', () => {
			it('should format zero cost', () => {
				expect(formatCost(0)).toBe('$0.00');
			});
			it('should format very small costs as <$0.01', () => {
				expect(formatCost(0.001)).toBe('<$0.01');
				expect(formatCost(0.009)).toBe('<$0.01');
			});
			it('should format normal costs with 2 decimal places', () => {
				expect(formatCost(0.01)).toBe('$0.01');
				expect(formatCost(0.05)).toBe('$0.05');
				expect(formatCost(1.23)).toBe('$1.23');
				expect(formatCost(100.5)).toBe('$100.50');
			});
			it('should round to 2 decimal places', () => {
				expect(formatCost(1.234)).toBe('$1.23');
				expect(formatCost(1.235)).toBe('$1.24'); // rounds up
				expect(formatCost(1.999)).toBe('$2.00');
			});
			it('should add thousands separators to large costs', () => {
				expect(formatCost(1000)).toBe('$1,000.00');
				expect(formatCost(40950.6)).toBe('$40,950.60');
				expect(formatCost(1234567.89)).toBe('$1,234,567.89');
			});
			it('should not add a separator below 1000', () => {
				expect(formatCost(999.99)).toBe('$999.99');
			});
		});
		// ==========================================================================
		// formatTimestamp tests
		// ==========================================================================
		// These assert against `toLocale*String` rather than literal strings on
		// purpose. formatTimestamp is backed by cached `Intl.DateTimeFormat`
		// singletons (constructing one per call cost 38% of renderer JS in a field
		// trace), and the whole contract of that cache is that output stays
		// byte-identical to the `toLocale*String` calls it replaced - in whatever
		// locale and timezone the test machine happens to run.
		describe('formatTimestamp', () => {
			const sameDayMorning = new Date();
			sameDayMorning.setHours(9, 5, 0, 0);
			const otherDay = new Date('2023-03-05T14:30:45.123Z');
			it("matches toLocaleTimeString for the 'time' style", () => {
				const ts = otherDay.getTime();
				expect(formatTimestamp(ts, 'time')).toBe(
					otherDay.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
				);
			});
			it("matches toLocaleString for the 'datetime' style", () => {
				const ts = otherDay.getTime();
				expect(formatTimestamp(ts, 'datetime')).toBe(
					otherDay.toLocaleString([], {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit',
					})
				);
			});
			it("matches a bare toLocaleString for the 'full' style", () => {
				const ts = otherDay.getTime();
				expect(formatTimestamp(ts, 'full')).toBe(otherDay.toLocaleString());
			});
			it("returns time only for today in the 'smart' style", () => {
				const ts = sameDayMorning.getTime();
				expect(formatTimestamp(ts)).toBe(
					sameDayMorning.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
				);
			});
			it("returns date and time for another day in the 'smart' style", () => {
				const ts = otherDay.getTime();
				expect(formatTimestamp(ts)).toBe(
					otherDay.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
						' ' +
						otherDay.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
				);
			});
			it('accepts an ISO string as well as a numeric timestamp', () => {
				expect(formatTimestamp(otherDay.toISOString(), 'full')).toBe(
					formatTimestamp(otherDay.getTime(), 'full')
				);
			});
			it('returns a stable result across repeated calls (cached formatters)', () => {
				const ts = otherDay.getTime();
				expect(formatTimestamp(ts, 'datetime')).toBe(formatTimestamp(ts, 'datetime'));
				expect(formatTimestamp(ts, 'time')).toBe(formatTimestamp(ts, 'time'));
			});
		});
		// ==========================================================================
		// estimateTokenCount tests
		// ==========================================================================
		describe('estimateTokenCount', () => {
			it('should return 0 for empty or null input', () => {
				expect(estimateTokenCount('')).toBe(0);
			});
			it('should estimate ~1 token per 4 characters', () => {
				expect(estimateTokenCount('abcd')).toBe(1); // 4 chars = 1 token
				expect(estimateTokenCount('ab')).toBe(1); // 2 chars = 1 token (ceil)
				expect(estimateTokenCount('abcde')).toBe(2); // 5 chars = 2 tokens (ceil)
				expect(estimateTokenCount('abcdefgh')).toBe(2); // 8 chars = 2 tokens
			});
			it('should handle longer text', () => {
				const text = 'Hello, this is a sample text for token estimation.';
				expect(estimateTokenCount(text)).toBe(Math.ceil(text.length / 4));
			});
		});
		// ==========================================================================
		// formatElapsedTimeColon tests
		// ==========================================================================
		describe('formatElapsedTimeColon', () => {
			it('should format seconds only as mm:ss', () => {
				expect(formatElapsedTimeColon(0)).toBe('0:00');
				expect(formatElapsedTimeColon(5)).toBe('0:05');
				expect(formatElapsedTimeColon(30)).toBe('0:30');
				expect(formatElapsedTimeColon(59)).toBe('0:59');
			});
			it('should format minutes and seconds as mm:ss', () => {
				expect(formatElapsedTimeColon(60)).toBe('1:00');
				expect(formatElapsedTimeColon(90)).toBe('1:30');
				expect(formatElapsedTimeColon(312)).toBe('5:12');
				expect(formatElapsedTimeColon(3599)).toBe('59:59');
			});
			it('should format hours as hh:mm:ss', () => {
				expect(formatElapsedTimeColon(3600)).toBe('1:00:00');
				expect(formatElapsedTimeColon(3661)).toBe('1:01:01');
				expect(formatElapsedTimeColon(5430)).toBe('1:30:30');
				expect(formatElapsedTimeColon(7200)).toBe('2:00:00');
			});
			it('should pad minutes and seconds with leading zeros', () => {
				expect(formatElapsedTimeColon(65)).toBe('1:05');
				expect(formatElapsedTimeColon(3605)).toBe('1:00:05');
				expect(formatElapsedTimeColon(3660)).toBe('1:01:00');
			});
		});
		// ==========================================================================
		// truncatePath tests
		// ==========================================================================
		describe('truncatePath', () => {
			it('should return empty string for empty input', () => {
				expect(truncatePath('')).toBe('');
			});
			it('should return path unchanged if within maxLength', () => {
				expect(truncatePath('/short/path')).toBe('/short/path');
				expect(truncatePath('/a/b/c', 20)).toBe('/a/b/c');
			});
			it('should truncate long paths showing last two parts', () => {
				expect(truncatePath('/Users/name/Projects/Maestro/src/components', 30)).toBe(
					'.../src/components'
				);
			});
			it('should handle single segment paths', () => {
				const longName = 'a'.repeat(50);
				const result = truncatePath('/' + longName, 20);
				expect(result.startsWith('...')).toBe(true);
				expect(result.length).toBeLessThanOrEqual(20);
			});
			it('should handle Windows paths', () => {
				expect(truncatePath('C:\\Users\\name\\Projects\\Maestro\\src', 25)).toBe(
					'...\\Maestro\\src'
				);
			});
			it('should respect custom maxLength parameter', () => {
				const path = '/Users/name/Projects/Maestro/src/components/Button.tsx';
				const result40 = truncatePath(path, 40);
				expect(result40.length).toBeLessThanOrEqual(40);
				expect(result40.startsWith('...')).toBe(true);
				const result20 = truncatePath(path, 20);
				expect(result20.length).toBeLessThanOrEqual(20);
				expect(result20.startsWith('...')).toBe(true);
			});
			it('should handle paths with two parts', () => {
				expect(truncatePath('/parent/child', 50)).toBe('/parent/child');
			});
		});
		// ==========================================================================
		// truncateAtWordBoundary tests
		// ==========================================================================
		describe('truncateAtWordBoundary', () => {
			it('returns text that already fits unchanged', () => {
				expect(truncateAtWordBoundary('Short Title', 40)).toBe('Short Title');
			});
			it('cuts at the last space that fits, ellipsis included in the limit', () => {
				const result = truncateAtWordBoundary(
					'Donation Appeal Pages Japanese Translation Dates',
					40,
					'...'
				);
				expect(result).toBe('Donation Appeal Pages Japanese...');
				expect(result.length).toBeLessThanOrEqual(40);
			});
			it('hard-cuts a string with no usable space', () => {
				expect(truncateAtWordBoundary('a'.repeat(50), 10)).toBe('aaaaaaaaa…');
			});
		});
		// ==========================================================================
		// truncateCommand tests
		// ==========================================================================
		describe('truncateCommand', () => {
			it('should return command unchanged if within maxLength', () => {
				expect(truncateCommand('npm run build')).toBe('npm run build');
				expect(truncateCommand('git status', 20)).toBe('git status');
			});
			it('should truncate long commands with ellipsis', () => {
				const longCommand = 'npm run build --watch --verbose --output=/path/to/output';
				const result = truncateCommand(longCommand, 30);
				expect(result.length).toBe(30);
				expect(result.endsWith('…')).toBe(true);
			});
			it('should replace newlines with spaces', () => {
				const multilineCommand = 'echo "hello\nworld"';
				const result = truncateCommand(multilineCommand, 50);
				expect(result).toBe('echo "hello world"');
				expect(result.includes('\n')).toBe(false);
			});
			it('should trim whitespace', () => {
				expect(truncateCommand('  git status  ')).toBe('git status');
				expect(truncateCommand('\n\ngit status\n\n')).toBe('git status');
			});
			it('should use default maxLength of 40', () => {
				const longCommand = 'a'.repeat(50);
				const result = truncateCommand(longCommand);
				expect(result.length).toBe(40);
				expect(result.endsWith('…')).toBe(true);
			});
			it('should respect custom maxLength parameter', () => {
				const command = 'a'.repeat(100);
				expect(truncateCommand(command, 20).length).toBe(20);
				expect(truncateCommand(command, 50).length).toBe(50);
				expect(truncateCommand(command, 60).length).toBe(60);
			});
			it('should handle multiple newlines as spaces', () => {
				const command = 'echo "one\ntwo\nthree"';
				const result = truncateCommand(command, 50);
				expect(result).toBe('echo "one two three"');
			});
			it('should handle empty command', () => {
				expect(truncateCommand('')).toBe('');
				expect(truncateCommand('   ')).toBe('');
				expect(truncateCommand('\n\n')).toBe('');
			});
		});
		// ==========================================================================
		// abbreviateGroupName tests
		// ==========================================================================
		describe('abbreviateGroupName', () => {
			it('returns short names unchanged', () => {
				expect(abbreviateGroupName('Work')).toBe('Work');
				expect(abbreviateGroupName('Personal')).toBe('Personal'); // 8 chars
				expect(abbreviateGroupName('Side Gigs')).toBe('Side Gigs'); // 9 chars, under max
				expect(abbreviateGroupName('TenChars10')).toBe('TenChars10'); // exactly max
			});
			it('preserves whitespace trimming', () => {
				expect(abbreviateGroupName('  Work  ')).toBe('Work');
			});
			it('handles empty input', () => {
				expect(abbreviateGroupName('')).toBe('');
				expect(abbreviateGroupName('   ')).toBe('');
			});
			it('builds "&"-joined acronym for "X & Y" names', () => {
				expect(abbreviateGroupName('AMINI & CONANT')).toBe('A&C');
				expect(abbreviateGroupName('amini & conant')).toBe('A&C');
				expect(abbreviateGroupName('Amini&Conant')).toBe('A&C');
				expect(abbreviateGroupName('Foo & Bar & Baz')).toBe('F&B&B');
			});
			it('treats " and " as a conjunction', () => {
				expect(abbreviateGroupName('Research and Development')).toBe('R&D');
				expect(abbreviateGroupName('Sales AND Marketing')).toBe('S&M');
			});
			it('takes initials for multi-word names without conjunctions', () => {
				expect(abbreviateGroupName('Acme Corporation Limited')).toBe('ACL');
				expect(abbreviateGroupName('staging_environment_two')).toBe('SET');
				expect(abbreviateGroupName('client-facing-team')).toBe('CFT');
			});
			it('drops leading numbering/bracket tokens from initials', () => {
				expect(abbreviateGroupName('[1] Aleyemma/Money-Sessions')).toBe('AMS');
				expect(abbreviateGroupName('(2) Research Operations')).toBe('RO');
				expect(abbreviateGroupName('#3 backend-api-gateway')).toBe('BAG');
			});
			it('strips vowels from single long words, preserving the first character', () => {
				expect(abbreviateGroupName('Engineering')).toBe('Engnrng');
				expect(abbreviateGroupName('Documentation')).toBe('Dcmnttn');
				expect(abbreviateGroupName('Astonishment')).toBe('Astnshmnt');
			});
			it('hard-truncates devoweled output that is still too long', () => {
				// 23 chars, devowels to 19 → truncate at default max (10)
				expect(abbreviateGroupName('Pneumonoultramicroscop')).toBe('Pnmnltrmcr');
			});
			it('respects custom target/max', () => {
				expect(abbreviateGroupName('Engineering', { max: 5 })).toBe('Engnr');
				expect(abbreviateGroupName('TenChars10', { max: 5 })).toBe('TnChr');
			});
			// Issue #1017: groups named like "[ARP] Auditoria Relatório Pessoal" used to
			// fall into the multi-word initials path, which took just the leading "[" of
			// the bracketed word and produced "[ARP" with the closing bracket dropped.
			it('uses a bracketed tag prefix as the preferred short form', () => {
				expect(abbreviateGroupName('[ARP] Auditoria Relatório Pessoal')).toBe('ARP');
				expect(abbreviateGroupName('[CEDR] Conteúdo Educação Designer Reuniões')).toBe('CEDR');
				expect(abbreviateGroupName('[GU] Generic User')).toBe('GU');
				// Bracket prefix is honored even when the name is already short.
				expect(abbreviateGroupName('[ARP]')).toBe('ARP');
				// Tag itself is over max → fall through to initials, which skip the
				// leading bracket entirely (no lopped "[" in the output).
				expect(abbreviateGroupName('[VeryLongTagName] X', { max: 5 })).toBe('VX');
				// Pure-numbering prefix is not a tag → dropped, initials of the rest win.
				expect(abbreviateGroupName('[1] Aleyemma/Money-Sessions')).toBe('AMS');
			});
		});
		// ==========================================================================
		// isAbsolutePath tests
		// ==========================================================================
		describe('isAbsolutePath', () => {
			it('recognizes Unix absolute paths', () => {
				expect(isAbsolutePath('/Users/name/file.ts')).toBe(true);
				expect(isAbsolutePath('/')).toBe(true);
			});
			it('recognizes Windows drive paths with either separator', () => {
				expect(isAbsolutePath('C:\\Users\\name\\file.ts')).toBe(true);
				expect(isAbsolutePath('C:/Users/name/file.ts')).toBe(true);
				expect(isAbsolutePath('d:\\temp')).toBe(true);
			});
			it('recognizes backslash-prefixed (UNC / drive-relative) paths', () => {
				expect(isAbsolutePath('\\\\server\\share')).toBe(true);
				expect(isAbsolutePath('\\folder\\file')).toBe(true);
			});
			it('rejects relative paths and non-paths', () => {
				expect(isAbsolutePath('')).toBe(false);
				expect(isAbsolutePath('src/components/Foo.tsx')).toBe(false);
				expect(isAbsolutePath('./file.ts')).toBe(false);
				expect(isAbsolutePath('file.ts')).toBe(false);
				expect(isAbsolutePath('C:file.ts')).toBe(false); // no separator after drive
			});
		});
		// ==========================================================================
		// getBasename tests
		// ==========================================================================
		describe('getBasename', () => {
			it('extracts the final segment of a Unix path', () => {
				expect(getBasename('/Users/name/file.ts')).toBe('file.ts');
			});
			it('extracts the final segment of a Windows path', () => {
				expect(getBasename('C:\\Users\\name\\file.ts')).toBe('file.ts');
			});
			it('ignores a trailing separator', () => {
				expect(getBasename('/Users/name/folder/')).toBe('folder');
				expect(getBasename('C:\\Users\\name\\folder\\')).toBe('folder');
			});
			it('returns the input unchanged when there is no separator', () => {
				expect(getBasename('file.ts')).toBe('file.ts');
			});
			it('handles empty input', () => {
				expect(getBasename('')).toBe('');
			});
		});
		// ==========================================================================
		// joinPath tests
		// ==========================================================================
		describe('joinPath', () => {
			it('joins segments onto a Unix base', () => {
				expect(joinPath('/Users/name', 'a', 'b.svg')).toBe('/Users/name/a/b.svg');
			});
			it('uses backslashes for a Windows base', () => {
				expect(joinPath('C:\\proj', '.maestro/diagrams', 'x.svg')).toBe(
					'C:\\proj\\.maestro\\diagrams\\x.svg'
				);
			});
			it('collapses duplicate separators at the seams', () => {
				expect(joinPath('/proj/', '/a/', '/b')).toBe('/proj/a/b');
			});
			it('drops empty segments', () => {
				expect(joinPath('/proj', '', 'a')).toBe('/proj/a');
			});
			it('returns the base when there is nothing to join', () => {
				expect(joinPath('/proj/')).toBe('/proj');
			});
		});
		// ==========================================================================
		// formatSshTarget tests
		// ==========================================================================
		describe('formatSshTarget', () => {
			it('shows user@host:port when all fields are present', () => {
				expect(formatSshTarget({ host: '10.0.50.63', port: 2222, username: 'linvsw' })).toBe(
					'linvsw@10.0.50.63:2222'
				);
			});
			it('always shows the port, including the default 22 (the bug this prevents)', () => {
				// A remote named "wsl ubuntu 2222" but saved with port 22 must reveal :22
				expect(formatSshTarget({ host: '10.0.50.63', port: 22, username: 'linvsw' })).toBe(
					'linvsw@10.0.50.63:22'
				);
			});
			it('omits the user@ prefix when no username is set (no leading @)', () => {
				expect(formatSshTarget({ host: 'maestro.gosubstrate.com', port: 22 })).toBe(
					'maestro.gosubstrate.com:22'
				);
				expect(formatSshTarget({ host: 'host', port: 22, username: '   ' })).toBe('host:22');
			});
			it('defaults the port to 22 when omitted', () => {
				expect(formatSshTarget({ host: 'host', username: 'me' })).toBe('me@host:22');
			});
		});
		// Duration formatters live in shared/duration.ts and are covered by
		// duration.test.ts. This asserts the compatibility re-export still resolves,
		// since ~50 call sites import them from this module's path.
		describe('duration re-exports', () => {
			it('re-exports the duration formatters', () => {
				expect(formatActiveTime(2 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe('2H 30M');
				expect(formatElapsedTime(500)).toBe('500ms');
			});
		});
	});
});
// Source: src/__tests__/shared/cue-pipeline-summary.test.ts
describe('', () => {
	// ─── Fixtures ────────────────────────────────────────────────────────────────
	function trigger(id: string, extras: Record<string, unknown> = {}): PipelineNode {
		return {
			id,
			type: 'trigger',
			position: { x: 0, y: 0 },
			data: {
				eventType: 'time.scheduled',
				label: 'Scheduled',
				config: { schedule_times: ['09:00'] },
				subscriptionName: 'Daily Digest',
				...extras,
			},
		} as PipelineNode;
	}
	function agent(id: string, sessionName: string, sessionId = `${sessionName}-id`): PipelineNode {
		return {
			id,
			type: 'agent',
			position: { x: 0, y: 0 },
			data: { sessionId, sessionName, toolType: 'claude-code' },
		} as PipelineNode;
	}
	function pipeline(overrides: Partial<CuePipeline> = {}): CuePipeline {
		return {
			id: 'p1',
			name: 'Daily Digest',
			color: '#06b6d4',
			nodes: [trigger('t1'), agent('a1', 'rc'), agent('a2', 'Maestro')],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
			...overrides,
		};
	}
	function run(overrides: Partial<CueRunResult> = {}): CueRunResult {
		return {
			runId: 'r1',
			sessionId: 's1',
			sessionName: 'rc',
			subscriptionName: 'Daily Digest',
			event: { type: 'time.scheduled', payload: {} },
			status: 'completed',
			stdout: '',
			stderr: '',
			exitCode: 0,
			durationMs: 12000,
			startedAt: '2026-08-20T09:00:00.000Z',
			endedAt: '2026-08-20T09:00:12.000Z',
			...overrides,
		} as CueRunResult;
	}
	// ─── describePipeline ────────────────────────────────────────────────────────
	describe('summarizeCommandNode', () => {
		it.each([
			[true, 'agent message → Synapse-Server (new tab)'],
			[false, 'cli send → Synapse-Server'],
			[undefined, 'cli send → Synapse-Server'],
		])('describes new-tab delivery when cliNewTab is %s', (cliNewTab, expected) => {
			expect(
				summarizeCommandNode({
					name: 'Issue triage',
					mode: 'cli',
					cliTarget: 'Synapse-Server',
					cliNewTab,
					owningSessionId: 'synapse-id',
					owningSessionName: 'Synapse-Server',
				})
			).toBe(expected);
		});
	});
	describe('describePipeline', () => {
		it('reads the flow left-to-right from the trigger', () => {
			const desc = describePipeline(pipeline());
			expect(desc.flow).toBe('Scheduled (09:00) → rc → Maestro');
			expect(desc.steps.map((s) => s.label)).toEqual(['rc', 'Maestro']);
			expect(desc.agentIds).toEqual(['rc-id', 'Maestro-id']);
		});
		// Node ORDER in the array is not execution order - a hand-authored YAML can
		// list the last agent first. The flow line must follow the edges instead.
		it('orders steps by edge depth, not array position', () => {
			const desc = describePipeline(
				pipeline({
					nodes: [agent('a2', 'Maestro'), agent('a1', 'rc'), trigger('t1')],
				})
			);
			expect(desc.flow).toBe('Scheduled (09:00) → rc → Maestro');
		});
		it('keeps nodes unreachable from any trigger, sorted last', () => {
			const desc = describePipeline(
				pipeline({
					nodes: [trigger('t1'), agent('a1', 'rc'), agent('orphan', 'Stray')],
					edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
				})
			);
			expect(desc.steps.map((s) => s.label)).toEqual(['rc', 'Stray']);
		});
		it('collapses multiple triggers into a count, naming the kinds', () => {
			const desc = describePipeline(
				pipeline({
					nodes: [
						trigger('t1'),
						trigger('t2', { eventType: 'app.startup', config: {} }),
						agent('a1', 'rc'),
					],
					edges: [
						{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
						{ id: 'e2', source: 't2', target: 'a1', mode: 'pass' },
					],
				})
			);
			expect(desc.triggerHeadline).toBe('2 triggers (Scheduled, App Startup)');
			expect(desc.triggers).toHaveLength(2);
		});
		it('names at most three trigger kinds, then elides', () => {
			const desc = describePipeline(
				pipeline({
					nodes: [
						trigger('t1'),
						trigger('t2', { eventType: 'app.startup', config: {} }),
						trigger('t3', { eventType: 'file.changed', config: { watch: 'src/**' } }),
						trigger('t4', { eventType: 'github.issue', config: {} }),
						agent('a1', 'rc'),
					],
					edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
				})
			);
			expect(desc.triggerHeadline).toBe('4 triggers (Scheduled, App Startup, File Change, …)');
		});
		// The headline is what the collapsed row renders. A small pipeline gets its
		// literal flow; a wide one must NOT, because chaining 39 independent
		// sibling agents with arrows describes a sequence that does not exist.
		it('headline keeps the flow for a small pipeline', () => {
			expect(describePipeline(pipeline()).headline).toBe('Scheduled (09:00) → rc → Maestro');
		});
		it('headline switches to counts once the pipeline is wide', () => {
			const nodes = [trigger('t1')];
			const edges = [];
			for (let i = 0; i < 6; i++) {
				nodes.push(agent(`a${i}`, `Agent${i}`));
				edges.push({ id: `e${i}`, source: 't1', target: `a${i}`, mode: 'pass' as const });
			}
			const desc = describePipeline(pipeline({ nodes, edges }));
			expect(desc.headline).toBe('Scheduled (09:00) → 6 agents');
			expect(desc.headline).not.toContain('Agent5');
			// The full chain stays available for search and for the detail view.
			expect(desc.flow).toContain('Agent5');
		});
		it('stepHeadline counts each kind separately', () => {
			const desc = describePipeline(
				pipeline({
					nodes: [
						trigger('t1'),
						agent('a1', 'rc'),
						{
							id: 'c1',
							type: 'command',
							position: { x: 0, y: 0 },
							data: {
								name: 'Deploy',
								mode: 'shell',
								shell: 'make deploy',
								owningSessionId: 's1',
								owningSessionName: 'rc',
							},
						} as PipelineNode,
					],
					edges: [
						{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
						{ id: 'e2', source: 'a1', target: 'c1', mode: 'pass' },
					],
				})
			);
			expect(desc.stepHeadline).toBe('1 agent, 1 command');
		});
		it('stepHeadline says so when a pipeline has no steps at all', () => {
			expect(describePipeline(pipeline({ nodes: [trigger('t1')], edges: [] })).stepHeadline).toBe(
				'no steps'
			);
		});
		// The prompt is often the ONLY thing distinguishing two steps - a fan-out
		// pipeline renders the same agent name N times.
		describe('prompts', () => {
			it('resolves a step prompt from its incoming edge', () => {
				const desc = describePipeline(
					pipeline({
						edges: [
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'Scan the market.' },
							{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
						],
					})
				);
				expect(desc.steps[0].prompts.prompts).toEqual(['Scan the market.']);
				expect(desc.steps[0].prompts.preview).toBe('Scan the market.');
				expect(desc.steps[0].prompts.count).toBe(1);
			});
			it('reports no prompt when nothing supplies one', () => {
				const desc = describePipeline(pipeline());
				expect(desc.steps[0].prompts.count).toBe(0);
				expect(desc.steps[0].prompts.preview).toBe('');
			});
			// `edge.prompt` is the source of truth for trigger→agent edges, and the
			// loader deliberately clears `inputPrompt` on those. Chain agents have no
			// incoming trigger edge, so `inputPrompt` is the only source they have.
			it('falls back to inputPrompt for a chain agent with no edge prompt', () => {
				const chainAgent = {
					id: 'a1',
					type: 'agent',
					position: { x: 0, y: 0 },
					data: {
						sessionId: 'rc-id',
						sessionName: 'rc',
						toolType: 'claude-code',
						inputPrompt: 'Summarize the upstream output.',
					},
				} as PipelineNode;
				const desc = describePipeline(
					pipeline({
						nodes: [trigger('t1'), chainAgent],
						edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
					})
				);
				expect(desc.steps[0].prompts.prompts).toEqual(['Summarize the upstream output.']);
			});
			it('prefers the edge prompt over inputPrompt when both exist', () => {
				const bothAgent = {
					id: 'a1',
					type: 'agent',
					position: { x: 0, y: 0 },
					data: {
						sessionId: 'rc-id',
						sessionName: 'rc',
						toolType: 'claude-code',
						inputPrompt: 'stale',
					},
				} as PipelineNode;
				const desc = describePipeline(
					pipeline({
						nodes: [trigger('t1'), bothAgent],
						edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'live' }],
					})
				);
				expect(desc.steps[0].prompts.prompts).toEqual(['live']);
			});
			// A multi-trigger agent gets a different prompt per incoming edge; the
			// count is what tells the reader the preview is one of several.
			it('collects every distinct incoming prompt', () => {
				const desc = describePipeline(
					pipeline({
						nodes: [
							trigger('t1'),
							trigger('t2', { eventType: 'app.startup', config: {} }),
							agent('a1', 'rc'),
						],
						edges: [
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'morning' },
							{ id: 'e2', source: 't2', target: 'a1', mode: 'pass', prompt: 'on boot' },
						],
					})
				);
				expect(desc.steps[0].prompts.count).toBe(2);
				expect(desc.steps[0].prompts.prompts).toEqual(['morning', 'on boot']);
			});
			// The trigger side of the same edge. Nothing in the list tab renders this
			// (that would print every prompt twice), but it is a published field for
			// callers describing a trigger on its own, so it has to stay correct.
			it('reads a trigger prompt from its outgoing edge', () => {
				const desc = describePipeline(
					pipeline({
						edges: [
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'summarize the day' },
							{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
						],
					})
				);
				expect(desc.triggers[0].prompts.prompts).toEqual(['summarize the day']);
				expect(desc.triggers[0].prompts.preview).toBe('summarize the day');
			});
			// A fan-out trigger has one prompt per target rather than one of its own,
			// which is the other half of why the prompt renders on the step.
			it('collects one prompt per target for a fan-out trigger', () => {
				const desc = describePipeline(
					pipeline({
						edges: [
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'check the logs' },
							{ id: 'e2', source: 't1', target: 'a2', mode: 'pass', prompt: 'check the queue' },
						],
					})
				);
				expect(desc.triggers[0].prompts.count).toBe(2);
				expect(desc.triggers[0].prompts.prompts).toEqual(['check the logs', 'check the queue']);
			});
			it('reports no trigger prompt when no outgoing edge carries one', () => {
				const desc = describePipeline(pipeline());
				expect(desc.triggers[0].prompts.count).toBe(0);
				expect(desc.triggers[0].prompts.preview).toBe('');
			});
			it('de-duplicates identical prompts rather than counting them twice', () => {
				const desc = describePipeline(
					pipeline({
						nodes: [
							trigger('t1'),
							trigger('t2', { eventType: 'app.startup', config: {} }),
							agent('a1', 'rc'),
						],
						edges: [
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'same' },
							{ id: 'e2', source: 't2', target: 'a1', mode: 'pass', prompt: 'same' },
						],
					})
				);
				expect(desc.steps[0].prompts.count).toBe(1);
			});
			// The preview sits in a one-line slot, so newlines and indentation have to
			// go - the width-based clipping is CSS's job, not this module's.
			it('collapses a multi-line prompt into a single preview line', () => {
				const desc = describePipeline(
					pipeline({
						edges: [
							{
								id: 'e1',
								source: 't1',
								target: 'a1',
								mode: 'pass',
								prompt: '  Check the feed.\n\n    Then write it up.  ',
							},
						],
					})
				);
				expect(desc.steps[0].prompts.preview).toBe('Check the feed. Then write it up.');
				// The full text keeps its structure for the hover card.
				expect(desc.steps[0].prompts.prompts[0]).toContain('\n');
			});
			it('gives a trigger the prompts on its outgoing edges', () => {
				const desc = describePipeline(
					pipeline({
						nodes: [trigger('t1'), agent('a1', 'A'), agent('a2', 'B')],
						edges: [
							{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: 'first' },
							{ id: 'e2', source: 't1', target: 'a2', mode: 'pass', prompt: 'second' },
						],
					})
				);
				expect(desc.triggers[0].prompts.prompts).toEqual(['first', 'second']);
				expect(desc.triggers[0].prompts.count).toBe(2);
			});
			it('ignores a whitespace-only prompt', () => {
				const desc = describePipeline(
					pipeline({
						edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass', prompt: '   \n  ' }],
					})
				);
				expect(desc.steps[0].prompts.count).toBe(0);
			});
		});
		it('prefers a custom trigger label over the event-type label', () => {
			const desc = describePipeline(
				pipeline({ nodes: [trigger('t1', { customLabel: 'Morning Check' }), agent('a1', 'rc')] })
			);
			expect(desc.flow).toBe('Morning Check (09:00) → rc');
		});
		it('counts unresolved-agent error nodes', () => {
			const desc = describePipeline(
				pipeline({
					nodes: [
						trigger('t1'),
						{
							id: 'x1',
							type: 'error',
							position: { x: 0, y: 0 },
							data: {
								reason: 'missing-target',
								subscriptionName: 'Daily Digest',
								message: 'Agent "gone" not found',
							},
						} as PipelineNode,
					],
					edges: [{ id: 'e1', source: 't1', target: 'x1', mode: 'pass' }],
				})
			);
			expect(desc.errorCount).toBe(1);
		});
	});
	// ─── derivePipelineHealth ────────────────────────────────────────────────────
	describe('derivePipelineHealth', () => {
		const empty = { activeRuns: [], activityLog: [] };
		it('reports healthy when the most recent finished run completed', () => {
			const health = derivePipelineHealth(pipeline(), { ...empty, activityLog: [run()] });
			expect(health.status).toBe('healthy');
			expect(health.recentRunCount).toBe(1);
			expect(health.recentFailureCount).toBe(0);
		});
		it('reports failing when the most recent finished run failed', () => {
			const health = derivePipelineHealth(pipeline(), {
				...empty,
				activityLog: [run({ status: 'failed', exitCode: 1 })],
			});
			expect(health.status).toBe('failing');
			expect(health.detail).toContain('exit 1');
		});
		// The log arrives newest-first but is sorted defensively - an out-of-order
		// feed must not make an old success outrank a recent failure.
		it('picks the newest finished run regardless of array order', () => {
			const health = derivePipelineHealth(pipeline(), {
				...empty,
				activityLog: [
					run({ runId: 'old', endedAt: '2026-08-19T09:00:12.000Z' }),
					run({ runId: 'new', status: 'timeout', endedAt: '2026-08-20T09:00:12.000Z' }),
				],
			});
			expect(health.status).toBe('failing');
			expect(health.lastRun?.runId).toBe('new');
			expect(health.detail).toContain('timed out');
		});
		it('matches chain subscriptions back to their pipeline', () => {
			const health = derivePipelineHealth(pipeline(), {
				...empty,
				activityLog: [run({ subscriptionName: 'Daily Digest-chain-2' })],
			});
			expect(health.recentRunCount).toBe(1);
		});
		it('prefers the explicit pipelineName over the subscription-name fallback', () => {
			const health = derivePipelineHealth(pipeline(), {
				...empty,
				activityLog: [run({ subscriptionName: 'unrelated-sub', pipelineName: 'Daily Digest' })],
			});
			expect(health.recentRunCount).toBe(1);
		});
		it('running outranks every other state', () => {
			const health = derivePipelineHealth(pipeline(), {
				activeRuns: [run({ status: 'running' })],
				activityLog: [run({ status: 'failed' })],
				configErrors: ['needs at least one trigger'],
			});
			expect(health.status).toBe('running');
			expect(health.activeRunCount).toBe(1);
			// The config problem is still reported - it just doesn't win the badge.
			expect(health.issues).toContain('needs at least one trigger');
		});
		it('reports invalid ahead of disabled and failing', () => {
			const health = derivePipelineHealth(pipeline(), {
				...empty,
				activityLog: [run({ status: 'failed' })],
				configErrors: ['needs at least one agent or command'],
				disabled: true,
			});
			expect(health.status).toBe('invalid');
		});
		it('reports disabled when every trigger is switched off', () => {
			const health = derivePipelineHealth(pipeline(), { ...empty, disabled: true });
			expect(health.status).toBe('disabled');
		});
		it('surfaces unresolved agent nodes as an issue', () => {
			const withError = pipeline({
				nodes: [
					trigger('t1'),
					{
						id: 'x1',
						type: 'error',
						position: { x: 0, y: 0 },
						data: {
							reason: 'missing-target',
							subscriptionName: 'Daily Digest',
							message: 'gone',
						},
					} as PipelineNode,
				],
				edges: [{ id: 'e1', source: 't1', target: 'x1', mode: 'pass' }],
			});
			const health = derivePipelineHealth(withError, empty);
			expect(health.status).toBe('invalid');
			expect(health.issues[0]).toContain('no longer exists');
		});
		// The activity log is a bounded window, so "no recent runs" must not be
		// overstated as "never run".
		it('reports idle without claiming the pipeline has never run', () => {
			const health = derivePipelineHealth(pipeline(), empty);
			expect(health.status).toBe('idle');
			expect(health.label).toBe('No recent runs');
			expect(health.detail).not.toMatch(/never/i);
		});
		it('treats a stopped run as a failure', () => {
			const health = derivePipelineHealth(pipeline(), {
				...empty,
				activityLog: [run({ status: 'stopped' })],
			});
			expect(health.status).toBe('failing');
			expect(health.detail).toContain('was stopped');
		});
		it('ignores runs belonging to other pipelines', () => {
			const health = derivePipelineHealth(pipeline(), {
				activeRuns: [run({ subscriptionName: 'Other', status: 'running' })],
				activityLog: [run({ subscriptionName: 'Other', status: 'failed' })],
			});
			expect(health.status).toBe('idle');
			expect(health.activeRunCount).toBe(0);
		});
	});
	describe('stripPipelinePrefix', () => {
		it('removes the quoted pipeline name validatePipelines prepends', () => {
			expect(
				stripPipelinePrefix('"Daily Digest": needs at least one trigger', 'Daily Digest')
			).toBe('needs at least one trigger');
		});
		it('leaves an unprefixed message alone', () => {
			expect(stripPipelinePrefix('something else', 'Daily Digest')).toBe('something else');
		});
	});
});
// Source: src/__tests__/shared/isLimitError.test.ts
describe('', () => {
	function makeError(type: AgentErrorType): AgentError {
		return {
			type,
			message: 'boom',
			recoverable: true,
			agentId: 'claude-code',
			timestamp: 0,
		};
	}
	describe('isLimitError', () => {
		it('returns true for the two limit-pause error types', () => {
			expect(isLimitError(makeError('rate_limited'))).toBe(true);
			expect(isLimitError(makeError('token_exhaustion'))).toBe(true);
		});
		it('returns false for every non-limit error type', () => {
			const nonLimit: AgentErrorType[] = [
				'auth_expired',
				'network_error',
				'agent_crashed',
				'permission_denied',
				'session_not_found',
				'hitl_gate',
				'unknown',
			];
			for (const type of nonLimit) {
				expect(isLimitError(makeError(type))).toBe(false);
			}
		});
	});
});
