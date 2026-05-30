import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRuntime } from '../../../../renderer/components/ProcessMonitor/runtime';

describe('formatRuntime', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('formats sub-minute elapsed time as seconds', () => {
		const startedSecondsAgo = Date.now() - 45_000;
		expect(formatRuntime(startedSecondsAgo)).toBe('45s');
	});

	it('formats minutes plus seconds', () => {
		expect(formatRuntime(Date.now() - (3 * 60_000 + 12_000))).toBe('3m 12s');
	});

	it('formats hours plus minutes', () => {
		expect(formatRuntime(Date.now() - (2 * 3_600_000 + 7 * 60_000))).toBe('2h 7m');
	});

	it('formats days plus hours', () => {
		expect(formatRuntime(Date.now() - (3 * 86_400_000 + 5 * 3_600_000))).toBe('3d 5h');
	});

	it('renders 0s for a startTime equal to now', () => {
		expect(formatRuntime(Date.now())).toBe('0s');
	});
});
