/**
 * Sleep Tracking - the math behind "duration, minus the time the machine slept".
 *
 * A span measured as `Date.now() - start` counts machine sleep as work: the
 * wall clock keeps running while the process is frozen. Neither process can
 * notice that on its own - the renderer's Page Visibility state never changes
 * across a suspend, and a timer that should have fired during sleep simply
 * fires late. Only `powerMonitor` in the main process sees the suspend/resume
 * pair, so it measures the gap and every tracker subtracts it.
 *
 * Each process owns ONE tracker instance:
 * - main: `src/main/utils/sleep-tracker.ts` (fed by `powerMonitor`)
 * - renderer: `src/renderer/services/systemSleep.ts` (fed by `app:systemResume`)
 *
 * This module is the shared implementation so those two can't drift.
 */

/**
 * A measured span. Keep the pair together: a start timestamp alone cannot tell
 * you how much of the elapsed wall clock was sleep.
 */
export interface SleepAwareSpan {
	/** Wall-clock timestamp the span started (`Date.now()`). */
	startedAt: number;
	/** Value of the tracker's `getTotalSleepMs()` when the span started. */
	sleptMsAtStart: number;
}

export type SleepHandler = (sleptMs: number) => void;

export interface SleepTracker {
	/** Record a measured sleep gap and notify subscribers. Ignores non-positive values. */
	recordSleep(sleptMs: number): void;
	/** Cumulative measured sleep since this process started, in ms. */
	getTotalSleepMs(): number;
	/**
	 * Sleep measured since a wall-clock timestamp. For callers that only kept a
	 * start time (a live "elapsed" display reading a start timestamp out of
	 * state) and so cannot hold a span. Reads a bounded log of recent wakes, so
	 * it is exact until the log rolls over; `beginSpan()`/`elapsedMs()` have no
	 * such bound and are preferred whenever the caller can keep the span.
	 */
	sleepMsSince(sinceTimestamp: number): number;
	/** Subscribe to measured sleep gaps. Returns an unsubscribe function. */
	onSleep(handler: SleepHandler): () => void;
	/** Start a span whose elapsed time will exclude machine sleep. */
	beginSpan(): SleepAwareSpan;
	/** Elapsed time of a span with machine sleep removed. Never negative. */
	elapsedMs(span: SleepAwareSpan): number;
	/** Drop the counter and all subscribers (tests, teardown). */
	reset(): void;
}

export interface SleepTrackerOptions {
	/** Called for each recorded gap, before subscribers. Use for logging. */
	onRecord?: SleepHandler;
}

/** How many recent wakes `sleepMsSince()` can look back over. */
const WAKE_LOG_LIMIT = 500;

export function createSleepTracker(options: SleepTrackerOptions = {}): SleepTracker {
	let totalSleepMs = 0;
	const handlers = new Set<SleepHandler>();
	/** Recent wakes, oldest first: when the machine woke and how long it slept. */
	const wakeLog: Array<{ wokeAt: number; sleptMs: number }> = [];

	const getTotalSleepMs = () => totalSleepMs;

	return {
		recordSleep(sleptMs: number): void {
			if (!Number.isFinite(sleptMs) || sleptMs <= 0) {
				return;
			}
			totalSleepMs += sleptMs;
			wakeLog.push({ wokeAt: Date.now(), sleptMs });
			if (wakeLog.length > WAKE_LOG_LIMIT) {
				wakeLog.shift();
			}
			options.onRecord?.(sleptMs);
			for (const handler of handlers) {
				handler(sleptMs);
			}
		},
		getTotalSleepMs,
		sleepMsSince(sinceTimestamp: number): number {
			let total = 0;
			// Walk backwards: the entries of interest are the newest ones.
			for (let i = wakeLog.length - 1; i >= 0; i--) {
				if (wakeLog[i].wokeAt < sinceTimestamp) break;
				total += wakeLog[i].sleptMs;
			}
			return total;
		},
		onSleep(handler: SleepHandler): () => void {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		beginSpan(): SleepAwareSpan {
			return { startedAt: Date.now(), sleptMsAtStart: totalSleepMs };
		},
		elapsedMs(span: SleepAwareSpan): number {
			const wallClockMs = Date.now() - span.startedAt;
			const sleptDuringSpan = totalSleepMs - span.sleptMsAtStart;
			return Math.max(0, wallClockMs - sleptDuringSpan);
		},
		reset(): void {
			totalSleepMs = 0;
			handlers.clear();
			wakeLog.length = 0;
		},
	};
}
