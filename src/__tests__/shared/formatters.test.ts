/**
 * Tests for shared/formatters.ts
 * Tests all formatting utility functions used across renderer and web.
 */

import {
	formatSize,
	formatNumber,
	formatTokens,
	formatTokensCompact,
	formatRelativeTime,
	formatActiveTime,
	formatElapsedTime,
	formatElapsedTimeColon,
	formatCost,
	formatPercent,
	estimateTokenCount,
	truncatePath,
	truncateCommand,
	getActiveLocale,
} from '../../shared/formatters';

// Mock i18n to avoid initializing the full i18n stack in tests.
// Includes a basic t() that resolves English time unit translations.
const timeTranslations: Record<string, string> = {
	'common:time.milliseconds_short': '{{count}}ms',
	'common:time.seconds_short': '{{count}}s',
	'common:time.minutes_short': '{{count}}m',
	'common:time.hours_short': '{{count}}h',
	'common:time.days_short': '{{count}}d',
	'common:time.minutes_compact': '{{count}}M',
	'common:time.hours_compact': '{{count}}H',
	'common:time.days_compact': '{{count}}D',
	'common:time.less_than_minute': '<1M',
};
vi.mock('../../shared/i18n/config', () => ({
	default: {
		language: 'en',
		t: (key: string, opts?: Record<string, unknown>) => {
			const template = timeTranslations[key];
			if (!template) return key;
			if (opts?.count !== undefined) {
				return template.replace('{{count}}', String(opts.count));
			}
			return template;
		},
	},
}));

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

		it('should accept optional locale parameter without breaking output', () => {
			expect(formatSize(0, 'en')).toBe('0 B');
			expect(formatSize(1536, 'en')).toBe('1.5 KB');
			expect(formatSize(1024 * 1024 * 1.5, 'en')).toBe('1.5 MB');
		});

		it('should use locale-aware decimal separators', () => {
			// French uses comma as decimal separator
			expect(formatSize(1536, 'fr')).toBe('1,5 KB');
			expect(formatSize(1024 * 1024 * 1.5, 'fr')).toBe('1,5 MB');
			// German also uses comma
			expect(formatSize(1024 * 1024 * 1024 * 2.5, 'de')).toBe('2,5 GB');
		});
	});

	// ==========================================================================
	// formatNumber tests
	// ==========================================================================
	describe('formatNumber', () => {
		it('should format small numbers', () => {
			expect(formatNumber(0)).toBe('0.0');
			expect(formatNumber(1)).toBe('1.0');
			expect(formatNumber(999)).toBe('999.0');
		});

		it('should format thousands with k suffix', () => {
			expect(formatNumber(1000)).toBe('1.0k');
			expect(formatNumber(1500)).toBe('1.5k');
			expect(formatNumber(999999)).toBe('1000.0k');
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

		it('should accept optional locale parameter without breaking output', () => {
			expect(formatTokens(0, 'en')).toBe('0');
			expect(formatTokens(1000, 'en')).toBe('~1K');
			expect(formatTokens(1500, 'en')).toBe('~2K');
			expect(formatTokens(1000000, 'en')).toBe('~1M');
		});

		it('should produce locale-aware compact notation', () => {
			// German uses '.' as thousands separator in some contexts
			const deResult = formatTokens(1000000, 'de');
			expect(deResult).toContain('~');
			expect(deResult.length).toBeGreaterThan(1);

			// Spanish compact notation
			const esResult = formatTokens(1000, 'es');
			expect(esResult).toContain('~');
			expect(esResult.length).toBeGreaterThan(1);
		});
	});

	// ==========================================================================
	// formatTokensCompact tests (without ~ prefix, decimal)
	// ==========================================================================
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

		it('should accept optional locale parameter without breaking output', () => {
			expect(formatTokensCompact(0, 'en')).toBe('0');
			expect(formatTokensCompact(1000, 'en')).toBe('1.0K');
			expect(formatTokensCompact(1500, 'en')).toBe('1.5K');
			expect(formatTokensCompact(1000000, 'en')).toBe('1.0M');
		});

		it('should use locale-aware number formatting', () => {
			// French uses comma as decimal separator
			const frResult = formatTokensCompact(1500, 'fr');
			expect(frResult).toMatch(/1[,.]5/); // locale may use comma or period

			// German uses comma as decimal separator
			const deResult = formatTokensCompact(2500000, 'de');
			expect(deResult).toContain('2,5');
		});
	});

	// ==========================================================================
	// getActiveLocale tests
	// ==========================================================================
	describe('getActiveLocale', () => {
		it('should return override locale when provided', () => {
			expect(getActiveLocale('fr')).toBe('fr');
			expect(getActiveLocale('es')).toBe('es');
		});

		it('should return i18n language when no override', () => {
			expect(getActiveLocale()).toBe('en');
		});
	});

	// ==========================================================================
	// formatRelativeTime tests (locale-aware via Intl.RelativeTimeFormat)
	// ==========================================================================
	describe('formatRelativeTime', () => {
		const now = Date.now();

		it('should format "now" for < 1 minute', () => {
			expect(formatRelativeTime(now)).toBe('now');
			expect(formatRelativeTime(now - 30000)).toBe('now'); // 30 seconds
		});

		it('should format minutes ago', () => {
			expect(formatRelativeTime(now - 60000)).toBe('1 minute ago');
			expect(formatRelativeTime(now - 5 * 60000)).toBe('5 minutes ago');
			expect(formatRelativeTime(now - 59 * 60000)).toBe('59 minutes ago');
		});

		it('should format hours ago', () => {
			expect(formatRelativeTime(now - 60 * 60000)).toBe('1 hour ago');
			expect(formatRelativeTime(now - 5 * 60 * 60000)).toBe('5 hours ago');
			expect(formatRelativeTime(now - 23 * 60 * 60000)).toBe('23 hours ago');
		});

		it('should format days ago', () => {
			expect(formatRelativeTime(now - 24 * 60 * 60000)).toBe('yesterday');
			expect(formatRelativeTime(now - 5 * 24 * 60 * 60000)).toBe('5 days ago');
			expect(formatRelativeTime(now - 6 * 24 * 60 * 60000)).toBe('6 days ago');
		});

		it('should format older dates as localized date', () => {
			const result = formatRelativeTime(now - 10 * 24 * 60 * 60000);
			// Should be formatted like "Dec 10" or similar (locale dependent)
			expect(result).not.toContain('ago');
			expect(result).toMatch(/[A-Za-z]+ \d+/); // e.g., "Dec 10"
		});

		it('should accept Date objects', () => {
			expect(formatRelativeTime(new Date(now))).toBe('now');
			expect(formatRelativeTime(new Date(now - 60000))).toBe('1 minute ago');
		});

		it('should accept ISO date strings', () => {
			expect(formatRelativeTime(new Date(now).toISOString())).toBe('now');
			expect(formatRelativeTime(new Date(now - 60000).toISOString())).toBe('1 minute ago');
		});

		it('should respect locale parameter for Spanish', () => {
			expect(formatRelativeTime(now - 5 * 60000, 'es')).toBe('hace 5 minutos');
		});

		it('should respect locale parameter for French', () => {
			const result = formatRelativeTime(now - 60 * 60000, 'fr');
			expect(result).toContain('1');
			// French: "il y a 1 heure"
			expect(result.length).toBeGreaterThan(0);
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

		it('should accept optional locale parameter without breaking output', () => {
			// Locale parameter is accepted but English output stays the same
			expect(formatActiveTime(0, 'en')).toBe('<1M');
			expect(formatActiveTime(5 * 60000, 'en')).toBe('5M');
			expect(formatActiveTime(90 * 60000, 'en')).toBe('1H 30M');
			expect(formatActiveTime(24 * 60 * 60000, 'en')).toBe('1D');
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

		it('should accept optional locale parameter without breaking output', () => {
			expect(formatElapsedTime(500, 'en')).toBe('500ms');
			expect(formatElapsedTime(5000, 'en')).toBe('5s');
			expect(formatElapsedTime(90000, 'en')).toBe('1m 30s');
			expect(formatElapsedTime(70 * 60000, 'en')).toBe('1h 10m');
		});
	});

	// ==========================================================================
	// formatCost tests
	// ==========================================================================
	describe('formatCost', () => {
		it('should format zero cost', () => {
			expect(formatCost(0)).toBe('$0.00');
			expect(formatCost(0, 'en')).toBe('$0.00');
		});

		it('should format very small costs as <$0.01', () => {
			expect(formatCost(0.001)).toBe('<$0.01');
			expect(formatCost(0.009)).toBe('<$0.01');
			expect(formatCost(0.001, 'en')).toBe('<$0.01');
		});

		it('should format normal costs with 2 decimal places', () => {
			expect(formatCost(0.01)).toBe('$0.01');
			expect(formatCost(0.05)).toBe('$0.05');
			expect(formatCost(1.23)).toBe('$1.23');
			expect(formatCost(100.5)).toBe('$100.50');
		});

		it('should round to 2 decimal places', () => {
			expect(formatCost(1.234, 'en')).toBe('$1.23');
			expect(formatCost(1.235, 'en')).toBe('$1.24'); // rounds up
			expect(formatCost(1.999, 'en')).toBe('$2.00');
		});

		it('should use locale-aware currency formatting with explicit locale', () => {
			// German uses comma for decimal, currency symbol after number
			const deCost = formatCost(1.23, 'de');
			expect(deCost).toContain('1,23');

			// French uses comma for decimal, currency symbol after number
			const frCost = formatCost(1.23, 'fr');
			expect(frCost).toContain('1,23');
		});

		it('should handle locale-aware less-than formatting', () => {
			const deCost = formatCost(0.005, 'de');
			expect(deCost).toContain('<');
			expect(deCost).toContain('0,01');
		});
	});

	// ==========================================================================
	// formatPercent tests
	// ==========================================================================
	describe('formatPercent', () => {
		it('should format 0%', () => {
			expect(formatPercent(0)).toBe('0%');
		});

		it('should format 100%', () => {
			expect(formatPercent(100)).toBe('100%');
		});

		it('should format intermediate values', () => {
			expect(formatPercent(50)).toBe('50%');
			expect(formatPercent(75)).toBe('75%');
			expect(formatPercent(1)).toBe('1%');
		});

		it('should use locale-aware formatting with explicit locale', () => {
			// French uses non-breaking space before %
			const frResult = formatPercent(50, 'fr');
			// French formatting includes the number and % symbol
			expect(frResult).toContain('50');
			expect(frResult).toContain('%');
		});

		it('should round to zero decimal places', () => {
			// formatPercent takes integer 0-100 values; verify no decimals
			expect(formatPercent(33)).toBe('33%');
			expect(formatPercent(67)).toBe('67%');
		});

		it('should handle locale override parameter', () => {
			const enResult = formatPercent(42, 'en');
			expect(enResult).toBe('42%');
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
			expect(truncatePath('C:\\Users\\name\\Projects\\Maestro\\src', 25)).toBe('...\\Maestro\\src');
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
});
