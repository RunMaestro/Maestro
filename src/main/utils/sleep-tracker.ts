/**
 * System Sleep Tracking (main) - keeps machine sleep out of measured durations.
 *
 * `powerMonitor` is the only observer of a suspend/resume pair, so this module
 * is the authority on how long the machine slept. Main-process durations (Cue
 * run duration, and anything else timing an agent) subtract it through spans,
 * and `index.ts` forwards each measured gap to the renderers so their Auto Run
 * timers can subtract the same number.
 *
 * Wire-up lives in `src/main/index.ts` (the powerMonitor listeners); this
 * module stays free of Electron imports so it can be unit tested.
 */

import { createSleepTracker } from '../../shared/sleepTracking';
import type { SleepAwareSpan } from '../../shared/sleepTracking';
import { logger } from './logger';

export type { SleepAwareSpan } from '../../shared/sleepTracking';

const CONTEXT = 'SleepTracker';

const tracker = createSleepTracker({
	onRecord: (sleptMs) =>
		logger.info(`Excluding ${Math.round(sleptMs / 1000)}s of machine sleep`, CONTEXT),
});

/** Timestamp of the suspend that started the current sleep, or null when awake. */
let suspendedAt: number | null = null;

/** Call from `powerMonitor.on('suspend')`. */
export function noteSystemSuspend(): void {
	suspendedAt = Date.now();
}

/**
 * Call from `powerMonitor.on('resume')`. Returns the measured sleep gap in ms
 * and folds it into the cumulative counter.
 *
 * Clearing `suspendedAt` here is what stops the duplicate resume events from a
 * single wake (lid + display + monitor) from subtracting the same sleep more
 * than once: the later ones measure 0.
 */
export function noteSystemResume(): number {
	const sleptMs = suspendedAt !== null ? Math.max(0, Date.now() - suspendedAt) : 0;
	suspendedAt = null;
	tracker.recordSleep(sleptMs);
	return sleptMs;
}

/** Cumulative machine sleep measured since this process started, in ms. */
export function getTotalSleepMs(): number {
	return tracker.getTotalSleepMs();
}

/** Start a span whose elapsed time will exclude any machine sleep. */
export function beginSleepAwareSpan(): SleepAwareSpan {
	return tracker.beginSpan();
}

/** Elapsed time of a span with machine sleep removed. Never negative. */
export function sleepAwareElapsedMs(span: SleepAwareSpan): number {
	return tracker.elapsedMs(span);
}

/** Test-only: drop the counter, subscribers, and any pending suspend. */
export function resetSleepTracking(): void {
	tracker.reset();
	suspendedAt = null;
}
