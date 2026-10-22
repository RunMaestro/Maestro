/**
 * Local-calendar day keys (`YYYY-MM-DD`).
 *
 * Every per-day stat in Maestro buckets by the user's LOCAL calendar day, the
 * same boundary SQLite's `date(..., 'localtime')` draws. Never derive a key from
 * `toISOString()`: that is UTC, so everything west of Greenwich files an evening
 * under tomorrow. Never parse one with `new Date('2026-07-10')` either: that is
 * read as UTC midnight and lands on the previous day.
 *
 * Pure and import-free so the main process, the renderer, and the CLI share it.
 */

/** Local `YYYY-MM-DD` for a timestamp (ms) or Date. */
export function toLocalYmd(value: number | Date): string {
	const d = typeof value === 'number' ? new Date(value) : value;
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
		d.getDate()
	).padStart(2, '0')}`;
}

/** Parse a local `YYYY-MM-DD` into a local-midnight Date, or null if malformed. */
export function parseLocalYmd(value: string): Date | null {
	const parts = value.split('-').map(Number);
	if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
	return new Date(parts[0], parts[1] - 1, parts[2]);
}

/**
 * Shift a local `YYYY-MM-DD` by whole calendar days. Goes through `setDate`
 * rather than adding 86400000ms, which drifts an hour across a DST change.
 */
export function addLocalDays(ymd: string, days: number): string {
	const date = parseLocalYmd(ymd);
	if (!date) return ymd;
	date.setDate(date.getDate() + days);
	return toLocalYmd(date);
}
