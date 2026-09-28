/**
 * System Sleep Tracking (renderer) - keeps machine sleep out of measured durations.
 *
 * The renderer cannot see a suspend: the window stays "visible" for the whole
 * sleep (no `visibilitychange`) while `Date.now()` advances with the wall
 * clock, so any span measured as `Date.now() - start` counts an overnight
 * sleep as work. The main process measures the real gap with `powerMonitor`
 * and reports it over `app:systemResume`; this module is where the renderer
 * accumulates it.
 *
 * Two ways to consume it:
 *
 * 1. One-off span (per task, per loop, per run):
 *      const span = beginSleepAwareSpan();
 *      ...
 *      const activeMs = sleepAwareElapsedMs(span);
 *
 * 2. Live tracker that pauses and resumes its own clock: subscribe with
 *    `onSystemSleep()` and shift your stored timestamps forward by the gap.
 *
 * Singleton on purpose: one IPC listener and one counter, so every consumer
 * measures the same sleep. The main-process counterpart is
 * `src/main/utils/sleep-tracker.ts`; both share `shared/sleepTracking.ts`.
 */

import { createSleepTracker } from '../../shared/sleepTracking';
import type { SleepAwareSpan, SleepHandler } from '../../shared/sleepTracking';
import { logger } from '../utils/logger';

export type { SleepAwareSpan } from '../../shared/sleepTracking';

const tracker = createSleepTracker({
	onRecord: (sleptMs) =>
		logger.info(`[SystemSleep] Excluding ${Math.round(sleptMs / 1000)}s of machine sleep`),
});

/** Unsubscribe for the IPC listener, or null when not subscribed yet. */
let unsubscribeResume: (() => void) | null = null;

/**
 * Attach the single IPC listener the first time anyone asks for sleep data.
 * No-op when the preload bridge isn't available (tests, web build).
 */
function ensureSubscribed(): void {
	if (unsubscribeResume) {
		return;
	}
	const onSystemResume = window.maestro?.app?.onSystemResume;
	if (!onSystemResume) {
		return;
	}
	unsubscribeResume = onSystemResume((info) => tracker.recordSleep(info?.sleptMs ?? 0));
}

/** Cumulative machine sleep measured since this renderer started, in ms. */
export function getTotalSleepMs(): number {
	ensureSubscribed();
	return tracker.getTotalSleepMs();
}

/**
 * Subscribe to measured sleep gaps. The handler receives the length of the
 * sleep that just ended, in ms. Returns an unsubscribe function.
 */
export function onSystemSleep(handler: SleepHandler): () => void {
	ensureSubscribed();
	return tracker.onSleep(handler);
}

/** Start a span whose elapsed time will exclude any machine sleep. */
export function beginSleepAwareSpan(): SleepAwareSpan {
	ensureSubscribed();
	return tracker.beginSpan();
}

/** Elapsed time of a span with machine sleep removed. Never negative. */
export function sleepAwareElapsedMs(span: SleepAwareSpan): number {
	ensureSubscribed();
	return tracker.elapsedMs(span);
}

/**
 * Live elapsed time since a start timestamp, with machine sleep removed. For
 * displays that only have a stored `startTime` and cannot hold a span.
 */
export function sleepAwareElapsedSince(startTime: number): number {
	ensureSubscribed();
	return Math.max(0, Date.now() - startTime - tracker.sleepMsSince(startTime));
}

/** Record a sleep gap directly. Exported for tests that simulate a suspend. */
export function recordSystemSleep(sleptMs: number): void {
	tracker.recordSleep(sleptMs);
}

/** Test-only: drop the counter, subscribers, and IPC listener. */
export function resetSystemSleepTracking(): void {
	tracker.reset();
	unsubscribeResume?.();
	unsubscribeResume = null;
}
