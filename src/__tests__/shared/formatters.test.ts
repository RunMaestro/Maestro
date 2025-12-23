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
  estimateTokenCount,
  truncatePath,
  truncateCommand,
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
      expect(formatCost(100.50)).toBe('$100.50');
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
      expect(truncatePath('/Users/name/Projects/Maestro/src/components', 30)).toBe('.../src/components');
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
