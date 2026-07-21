import { LOOKBACK_PERIODS, type LookbackHours } from '../History/lookbackOptions';

/** Convert lookbackHours to lookbackDays for the IPC call. null => 0 (all time). */
export function lookbackHoursToDays(hours: LookbackHours): number {
	if (hours === null) return 0;
	return Math.ceil(hours / 24);
}

/**
 * Resolve the activity-graph bucket count for a given lookback selection. Each
 * lookback option carries its own preferred resolution (24 for short windows,
 * 28 for "1 week", 30 for "1 month", etc.); unknown windows fall back to 24.
 */
export function bucketCountForLookback(hours: LookbackHours): number {
	const config = LOOKBACK_PERIODS.find((option) => option.hours === hours);
	return config?.bucketCount ?? 24;
}

/** Find the smallest stored lookback value that covers the given days. 0 => all time. */
export function daysToLookbackHours(days: number): LookbackHours {
	if (days <= 0) return null;
	const targetHours = days * 24;
	for (const option of LOOKBACK_PERIODS) {
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
	hours: LookbackHours,
	now: number = Date.now()
): string | null {
	if (hours === null) return null;
	const since = new Date(now - hours * 60 * 60 * 1000);
	const weekday = since.toLocaleDateString('en-US', { weekday: 'long' });
	const month = since.toLocaleDateString('en-US', { month: 'long' });
	const day = since.getDate();
	return `${weekday} ${month} ${day}${ordinalSuffix(day)}`;
}
