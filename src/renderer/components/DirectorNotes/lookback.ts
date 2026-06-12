import { LOOKBACK_OPTIONS } from '../History';

/** Convert lookbackHours to lookbackDays for the IPC call. null => 0 (all time). */
export function lookbackHoursToDays(hours: number | null): number {
	if (hours === null) return 0;
	return Math.ceil(hours / 24);
}

/** Find the smallest LOOKBACK_OPTIONS entry that covers the given number of days. 0 => null (All time). */
export function daysToLookbackHours(days: number): number | null {
	if (days <= 0) return null;
	const targetHours = days * 24;
	for (const option of LOOKBACK_OPTIONS) {
		if (option.hours !== null && option.hours >= targetHours) return option.hours;
	}
	return null;
}

function ordinalSuffix(n: number): string {
	const v = n % 100;
	if (v >= 11 && v <= 13) return 'th';
	switch (n % 10) {
		case 1:
			return 'st';
		case 2:
			return 'nd';
		case 3:
			return 'rd';
		default:
			return 'th';
	}
}

/**
 * Format the lookback cutoff as "Weekday Month Dayth" (e.g. "Friday May 8th").
 * Returns null for "All time" (no cutoff to display).
 */
export function formatLookbackSinceDate(
	hours: number | null,
	now: number = Date.now()
): string | null {
	if (hours === null) return null;
	const since = new Date(now - hours * 60 * 60 * 1000);
	const weekday = since.toLocaleDateString('en-US', { weekday: 'long' });
	const month = since.toLocaleDateString('en-US', { month: 'long' });
	const day = since.getDate();
	return `${weekday} ${month} ${day}${ordinalSuffix(day)}`;
}
