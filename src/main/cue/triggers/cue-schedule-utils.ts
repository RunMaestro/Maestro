/**
 * Schedule helpers shared by the scheduled trigger source.
 *
 * `calculateNextScheduledTime` previously lived in cue-subscription-setup.ts.
 * It moved here as part of the Phase 4 trigger source isolation so the
 * scheduled-trigger source can own its scheduling math without depending on
 * the (now-deleted) subscription setup module.
 */

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type ScheduleDayName = (typeof DAY_NAMES)[number];

export function getDayName(date: Date): ScheduleDayName {
	return DAY_NAMES[date.getDay()];
}

/**
 * Calculates the next occurrence of a scheduled time given a list of
 * `HH:MM` time strings and an optional day-of-week filter.
 *
 * Returns a timestamp in ms-since-epoch, or `null` if `times` is empty or
 * every entry is unparseable. Looks up to 8 days ahead so that a day-of-week
 * subscription with today already past still finds next week's slot.
 */
export function calculateNextScheduledTime(times: string[], days?: string[]): number | null {
	if (times.length === 0) return null;

	const now = new Date();
	const candidates: number[] = [];

	// Check up to 8 days ahead (0..7) to cover same-day-next-week when today's slot has passed
	for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
		const candidate = new Date(now);
		candidate.setDate(candidate.getDate() + dayOffset);
		const dayName = DAY_NAMES[candidate.getDay()];

		if (days && days.length > 0 && !days.includes(dayName)) continue;

		for (const time of times) {
			const [hourStr, minStr] = time.split(':');
			const hour = parseInt(hourStr, 10);
			const min = parseInt(minStr, 10);
			if (isNaN(hour) || isNaN(min)) continue;
			if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
			if (!Number.isInteger(min) || min < 0 || min > 59) continue;

			const target = new Date(candidate);
			target.setHours(hour, min, 0, 0);

			if (target.getTime() > now.getTime()) {
				candidates.push(target.getTime());
			}
		}
	}

	return candidates.length > 0 ? Math.min(...candidates) : null;
}
