/**
 * Gap-filled per-day series.
 *
 * The stats database returns per-day rows only for days that saw activity. A
 * chart that plots those rows by index silently drops idle days, which makes a
 * quiet week look continuous. Every per-day chart fills its series over the
 * aggregation's `window` with these helpers before drawing.
 *
 * Pure and import-light so the main process, the renderer, and the CLI share it.
 */

import { addLocalDays } from './localDay';

/** Every local `YYYY-MM-DD` from `startYmd` to `endYmd` inclusive. */
export function localDaysBetween(startYmd: string, endYmd: string): string[] {
	const days: string[] = [];
	for (let day = startYmd; day <= endYmd; day = addLocalDays(day, 1)) {
		days.push(day);
		// addLocalDays returns its input on a malformed key; stop instead of looping.
		if (addLocalDays(day, 1) === day) break;
	}
	return days;
}

/**
 * One row per day from `startYmd` to `endYmd`: the matching row from `rows`,
 * or `empty(date)` where there is none. Rows outside the window are dropped.
 */
export function fillDaySeries<T extends { date: string }>(
	rows: readonly T[],
	startYmd: string,
	endYmd: string,
	empty: (date: string) => T
): T[] {
	const byDate = new Map<string, T>();
	for (const row of rows) byDate.set(row.date, row);
	return localDaysBetween(startYmd, endYmd).map((date) => byDate.get(date) ?? empty(date));
}
