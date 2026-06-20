import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	estimateTokenCount,
	formatActiveTime,
	formatCost,
	formatElapsedTime,
	formatElapsedTimeColon,
	formatNumber,
	formatRelativeTime,
	formatSize,
	formatTokens,
	formatTokensCompact,
	getParentDir,
	truncateCommand,
	truncatePath,
} from '../../shared/formatters';

describe('shared formatters integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-27T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('formats large size, number, and token boundaries', () => {
		expect(formatSize(512)).toBe('512 B');
		expect(formatSize(1536)).toBe('1.5 KB');
		expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
		expect(formatSize(6 * 1024 * 1024 * 1024)).toBe('6.0 GB');
		expect(formatSize(7 * 1024 * 1024 * 1024 * 1024)).toBe('7.0 TB');

		expect(formatNumber(12)).toBe('12');
		expect(formatNumber(1200)).toBe('1.2K');
		expect(formatNumber(2_500_000)).toBe('2.5M');
		expect(formatNumber(3_200_000_000)).toBe('3.2B');

		expect(formatTokens(500)).toBe('500');
		expect(formatTokens(1_400)).toBe('~1K');
		expect(formatTokens(2_400_000)).toBe('~2M');
		expect(formatTokens(3_600_000_000)).toBe('~4B');

		expect(formatTokensCompact(500)).toBe('500');
		expect(formatTokensCompact(1500)).toBe('1.5K');
		expect(formatTokensCompact(4_500_000)).toBe('4.5M');
		expect(formatTokensCompact(5_800_000_000)).toBe('5.8B');
	});

	it('formats date objects and active durations across every display branch', () => {
		expect(formatRelativeTime(new Date('2026-05-27T11:59:30Z'))).toBe('just now');
		expect(formatRelativeTime(Date.parse('2026-05-27T11:55:00Z'))).toBe('5m ago');
		expect(formatRelativeTime('2026-05-27T10:00:00Z')).toBe('2h ago');
		expect(formatRelativeTime(new Date('2026-05-24T12:00:00Z'))).toBe('3d ago');
		expect(formatRelativeTime('2026-05-17T12:00:00Z')).toBe('May 17');

		expect(formatActiveTime(500)).toBe('<1M');
		expect(formatActiveTime(15 * 60 * 1000)).toBe('15M');
		expect(formatActiveTime(2 * 60 * 60 * 1000)).toBe('2H');
		expect(formatActiveTime(3 * 60 * 60 * 1000 + 45 * 60 * 1000)).toBe('3H 45M');
		expect(formatActiveTime(2 * 24 * 60 * 60 * 1000)).toBe('2D');
	});

	it('formats elapsed time, costs, token estimates, and timer displays', () => {
		expect(formatElapsedTime(500)).toBe('500ms');
		expect(formatElapsedTime(30_000)).toBe('30s');
		expect(formatElapsedTime(5 * 60_000 + 12_000)).toBe('5m 12s');
		expect(formatElapsedTime(70 * 60_000)).toBe('1h 10m');

		expect(formatCost(0)).toBe('$0.00');
		expect(formatCost(0.005)).toBe('<$0.01');
		expect(formatCost(1.234)).toBe('$1.23');

		expect(estimateTokenCount('')).toBe(0);
		expect(estimateTokenCount('abcd')).toBe(1);
		expect(estimateTokenCount('abcde')).toBe(2);

		expect(formatElapsedTimeColon(5 * 60 + 12)).toBe('5:12');
		expect(formatElapsedTimeColon(90 * 60 + 45)).toBe('1:30:45');
	});

	it('truncates paths and commands while preserving useful suffixes', () => {
		expect(truncatePath('', 10)).toBe('');
		expect(truncatePath('/short/path', 20)).toBe('/short/path');
		expect(truncatePath('////', 2)).toBe('////');
		expect(truncatePath('averylongfilename', 8)).toBe('...ename');
		expect(truncatePath('/short/averyverylongfilename.txt', 15)).toBe('.../lename.txt');
		expect(truncatePath('C:\\workspaces\\maestro\\package.json', 24)).toBe(
			'...\\maestro\\package.json'
		);

		expect(getParentDir('/workspaces/maestro/package.json')).toBe('/workspaces/maestro');
		expect(getParentDir('')).toBe('');
		expect(getParentDir('/')).toBe('/');

		expect(truncateCommand('  npm\nrun test  ', 20)).toBe('npm run test');
		expect(truncateCommand('pnpm vitest run integration coverage', 12)).toBe(`pnpm vitest\u2026`);
	});
});
