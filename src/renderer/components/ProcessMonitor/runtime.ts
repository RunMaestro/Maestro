import { humanizeDuration, DURATION_LADDER_DAYS } from '../../../shared/duration';

/**
 * Format how long a process has been running, e.g. "45s", "2m 30s", "1h 5m",
 * "3d 2h". Day-capped: a process alive for 30 hours reads "1d 6h".
 *
 * Zero segments are kept ("2h 0m") so a column of live runtimes does not jitter
 * between one and two segments as the minutes roll over.
 */
export function formatRuntime(startTime: number): string {
	return humanizeDuration(Date.now() - startTime, {
		units: DURATION_LADDER_DAYS,
		keepZeroUnits: true,
	});
}
