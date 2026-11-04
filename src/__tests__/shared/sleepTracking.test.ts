import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSleepTracker } from '../../shared/sleepTracking';

describe('sleepTracking', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Advance both the fake timers and the wall clock, as a real sleep would. */
	const advance = (ms: number) => vi.advanceTimersByTime(ms);

	describe('span elapsed time', () => {
		it('measures wall clock when the machine never slept', () => {
			const tracker = createSleepTracker();
			const span = tracker.beginSpan();

			advance(90_000);

			expect(tracker.elapsedMs(span)).toBe(90_000);
		});

		it('excludes a sleep that happened inside the span', () => {
			const tracker = createSleepTracker();
			const span = tracker.beginSpan();

			advance(60_000);
			// The wall clock runs through the sleep; the measured gap arrives on wake.
			advance(8 * 60 * 60 * 1000);
			tracker.recordSleep(8 * 60 * 60 * 1000);
			advance(30_000);

			expect(tracker.elapsedMs(span)).toBe(90_000);
		});

		it('ignores sleep that happened before the span started', () => {
			const tracker = createSleepTracker();
			tracker.recordSleep(3_600_000);

			const span = tracker.beginSpan();
			advance(45_000);

			expect(tracker.elapsedMs(span)).toBe(45_000);
		});

		it('never returns a negative duration', () => {
			const tracker = createSleepTracker();
			const span = tracker.beginSpan();

			// A gap reported longer than the span itself (duplicate resume events,
			// clock adjustment) must clamp to zero rather than go negative.
			tracker.recordSleep(10_000);

			expect(tracker.elapsedMs(span)).toBe(0);
		});
	});

	describe('recordSleep', () => {
		it('accumulates across several sleeps', () => {
			const tracker = createSleepTracker();

			tracker.recordSleep(1000);
			tracker.recordSleep(2000);

			expect(tracker.getTotalSleepMs()).toBe(3000);
		});

		it('ignores non-positive and non-finite gaps', () => {
			const tracker = createSleepTracker();

			tracker.recordSleep(0);
			tracker.recordSleep(-5000);
			tracker.recordSleep(Number.NaN);
			tracker.recordSleep(Number.POSITIVE_INFINITY);

			expect(tracker.getTotalSleepMs()).toBe(0);
		});

		it('notifies subscribers and the onRecord option', () => {
			const onRecord = vi.fn();
			const tracker = createSleepTracker({ onRecord });
			const handler = vi.fn();
			const unsubscribe = tracker.onSleep(handler);

			tracker.recordSleep(5000);
			expect(onRecord).toHaveBeenCalledWith(5000);
			expect(handler).toHaveBeenCalledWith(5000);

			unsubscribe();
			tracker.recordSleep(1000);
			expect(handler).toHaveBeenCalledTimes(1);
		});
	});

	describe('sleepMsSince', () => {
		it('sums only the wakes after the given timestamp', () => {
			const tracker = createSleepTracker();

			tracker.recordSleep(1000);
			advance(10_000);
			const startedAt = Date.now();
			advance(10_000);
			tracker.recordSleep(2000);
			advance(10_000);
			tracker.recordSleep(4000);

			expect(tracker.sleepMsSince(startedAt)).toBe(6000);
		});

		it('returns zero when nothing slept since the timestamp', () => {
			const tracker = createSleepTracker();
			tracker.recordSleep(1000);
			advance(1000);

			expect(tracker.sleepMsSince(Date.now())).toBe(0);
		});
	});

	describe('reset', () => {
		it('drops the counter, the wake log, and subscribers', () => {
			const tracker = createSleepTracker();
			const handler = vi.fn();
			tracker.onSleep(handler);
			const since = Date.now();
			tracker.recordSleep(5000);

			tracker.reset();

			expect(tracker.getTotalSleepMs()).toBe(0);
			expect(tracker.sleepMsSince(since)).toBe(0);

			tracker.recordSleep(1000);
			expect(handler).toHaveBeenCalledTimes(1);
		});
	});
});
