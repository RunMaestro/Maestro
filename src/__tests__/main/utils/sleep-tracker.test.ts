import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	noteSystemSuspend,
	noteSystemResume,
	getTotalSleepMs,
	beginSleepAwareSpan,
	sleepAwareElapsedMs,
	resetSleepTracking,
} from '../../../main/utils/sleep-tracker';

describe('sleep-tracker (main)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		resetSleepTracking();
	});

	afterEach(() => {
		resetSleepTracking();
		vi.useRealTimers();
	});

	it('measures the gap between suspend and resume', () => {
		noteSystemSuspend();
		vi.advanceTimersByTime(3_600_000);

		expect(noteSystemResume()).toBe(3_600_000);
		expect(getTotalSleepMs()).toBe(3_600_000);
	});

	it('reports zero for the duplicate resume events of a single wake', () => {
		noteSystemSuspend();
		vi.advanceTimersByTime(60_000);

		expect(noteSystemResume()).toBe(60_000);
		// lid + display + monitor can each fire a resume; only the first one
		// may subtract the sleep.
		expect(noteSystemResume()).toBe(0);
		expect(getTotalSleepMs()).toBe(60_000);
	});

	it('reports zero for a resume with no recorded suspend', () => {
		expect(noteSystemResume()).toBe(0);
		expect(getTotalSleepMs()).toBe(0);
	});

	it('keeps the sleep out of a span that straddles it', () => {
		const span = beginSleepAwareSpan();

		vi.advanceTimersByTime(30_000);
		noteSystemSuspend();
		vi.advanceTimersByTime(7_200_000);
		noteSystemResume();
		vi.advanceTimersByTime(30_000);

		expect(sleepAwareElapsedMs(span)).toBe(60_000);
	});
});
