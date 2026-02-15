/**
 * Shared utilities for account multiplexing.
 */

/**
 * Calculate the window boundaries for a given timestamp and window size.
 * Windows are aligned to fixed intervals from midnight.
 */
export function getWindowBounds(timestamp: number, windowMs: number): { start: number; end: number } {
	const dayStart = new Date(timestamp);
	dayStart.setHours(0, 0, 0, 0);
	const dayStartMs = dayStart.getTime();
	const windowsSinceDayStart = Math.floor((timestamp - dayStartMs) / windowMs);
	const start = dayStartMs + windowsSinceDayStart * windowMs;
	const end = start + windowMs;
	return { start, end };
}
