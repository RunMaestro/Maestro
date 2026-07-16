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
	formatCacheAge,
	formatAgeShort,
	formatActiveTime,
	formatElapsedTime,
	formatElapsedTimeColon,
	formatCost,
	estimateTokenCount,
	truncatePath,
	truncateCommand,
	abbreviateGroupName,
	isAbsolutePath,
	getBasename,
	joinPath,
	formatSshTarget,
	formatDurationLong,
} from '../../shared/formatters';

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

	it('uses binary units with a fixed one-decimal precision and a TB suffix', () => {
		expect(formatSize(1024)).toBe('1.0 KB');
		expect(formatSize(1536)).toBe('1.5 KB');
		expect(formatSize(1024 ** 4)).toBe('1.0 TB');
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
				expect(formatRelativeTime(now - 24 * 60 * 60000, { includeSeconds: true })).toBe('1d ago');
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
			expect(formatCacheAge(15_000)).toBe('just now');
			expect(formatCacheAge(59_999)).toBe('just now');
		});

		it('should format minutes below one hour', () => {
			expect(formatCacheAge(60_000)).toBe('1m ago');
			expect(formatCacheAge(45 * 60_000)).toBe('45m ago');
			expect(formatCacheAge(59 * 60_000)).toBe('59m ago');
		});

		it('should format whole hours without rolling into days', () => {
			expect(formatCacheAge(60 * 60_000)).toBe('1h ago');
			expect(formatCacheAge(2 * 60 * 60_000)).toBe('2h ago');
			expect(formatCacheAge(25 * 60 * 60_000)).toBe('25h ago');
		});
	});

	// ==========================================================================
	// formatAgeShort tests
	// ==========================================================================
	describe('formatAgeShort', () => {
		const now = Date.now();
		const MIN = 60_000;
		const HOUR = 60 * MIN;
		const DAY = 24 * HOUR;

		it('returns "new" for < 1 minute', () => {
			expect(formatAgeShort(now)).toBe('new');
			expect(formatAgeShort(now - 30_000)).toBe('new');
			expect(formatAgeShort(now + 10_000)).toBe('new'); // clamp future to 0
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

	// ==========================================================================
	// formatDurationLong tests
	// ==========================================================================
	describe('formatDurationLong', () => {
		it('returns 0s for sub-second, zero, negative, and non-finite inputs', () => {
			expect(formatDurationLong(0)).toBe('0s');
			expect(formatDurationLong(999)).toBe('0s');
			expect(formatDurationLong(-5000)).toBe('0s');
			expect(formatDurationLong(NaN)).toBe('0s');
			expect(formatDurationLong(Infinity)).toBe('0s');
		});

		it('formats seconds and minutes', () => {
			expect(formatDurationLong(45_000)).toBe('45s');
			expect(formatDurationLong(90_000)).toBe('1m 30s');
			expect(formatDurationLong(300_000)).toBe('5m');
		});

		it('formats hours with trailing minutes', () => {
			expect(formatDurationLong(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m');
			expect(formatDurationLong(3_600_000)).toBe('1h');
		});

		it('ladders into days and weeks instead of dumping raw seconds', () => {
			// The bug this fixes: 546831.66s of time-spent used to render literally.
			expect(formatDurationLong(546_831_660)).toBe('6d 7h');
			expect(formatDurationLong(23 * 86_400_000)).toBe('3w 2d');
		});

		it('ladders into years and skips months (weeks feed straight into years)', () => {
			// 420 days = 1y (365d) + 55d remainder -> 7w
			expect(formatDurationLong(420 * 86_400_000)).toBe('1y 7w');
		});

		it('shows only the top unit when the next unit is zero', () => {
			expect(formatDurationLong(7 * 86_400_000)).toBe('1w');
		});
	});
});
