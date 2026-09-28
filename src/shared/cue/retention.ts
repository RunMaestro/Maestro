/**
 * Cue history retention
 *
 * How long a Cue run stays in `cue_events` before the engine prunes it. The
 * value is a user setting (`cueHistoryRetentionDays`), so the default lives
 * here rather than being spelled out again in settings metadata, the renderer
 * store, and the main-process defaults - three copies of `14` is three places
 * for the number to drift, and a prune window that disagrees with the value the
 * UI shows deletes rows the user believes they still have.
 */

/**
 * Days of Cue run history kept by default.
 *
 * Two weeks covers the Activity Log's useful lookback (a user asking "did this
 * pipeline fire last Tuesday?") without letting a heartbeat-heavy fleet grow
 * the database without bound - the measured fleet writes ~2,800 Cue rows a day.
 */
export const DEFAULT_CUE_HISTORY_RETENTION_DAYS = 14;

/** Milliseconds in a day. Used to turn the day-count setting into a prune window. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Default prune window in milliseconds.
 *
 * The fallback the Cue engine prunes with when the setting is missing or
 * unusable. Derived from {@link DEFAULT_CUE_HISTORY_RETENTION_DAYS} rather than
 * written out, so the window the engine deletes by can never disagree with the
 * number the Activity Log shows.
 */
export const DEFAULT_CUE_HISTORY_RETENTION_MS = DEFAULT_CUE_HISTORY_RETENTION_DAYS * MS_PER_DAY;

/**
 * Resolve the Cue retention window (in days) from a raw setting value.
 *
 * Every reader MUST run the stored value through this. The prune is
 * destructive and irreversible, so a reader that trusts the raw value can
 * delete rows the user believes they still have: `0` would mean "delete
 * everything", and a `NaN` from a hand-edited settings file would make the
 * cutoff `NaN` and prune unpredictably. The renderer store runs the same
 * function, so the number shown in the UI and the number the engine deletes by
 * are always the same number.
 *
 * Mirrors `resolveHistoryEntryLimit()` in `src/shared/history.ts`, including
 * its acceptance of numeric strings - settings can arrive from a hand-edited
 * JSON file or the CLI, where `"30"` is a realistic value.
 *
 * @param value - Raw setting value (may be undefined, a string, or garbage)
 * @returns A whole day count >= 1, or DEFAULT_CUE_HISTORY_RETENTION_DAYS when unusable
 */
export function resolveCueHistoryRetentionDays(value: unknown): number {
	const parsed = typeof value === 'string' ? Number(value) : value;
	if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 1) {
		return DEFAULT_CUE_HISTORY_RETENTION_DAYS;
	}
	return Math.floor(parsed);
}

/**
 * Resolve the Cue retention window as a prune age in milliseconds.
 *
 * Convenience wrapper for `pruneCueEvents(olderThanMs)`, which takes an age
 * rather than a day count.
 *
 * @param value - Raw setting value (may be undefined, a string, or garbage)
 * @returns The window in milliseconds, never zero or NaN
 */
export function resolveCueHistoryRetentionMs(value: unknown): number {
	return resolveCueHistoryRetentionDays(value) * MS_PER_DAY;
}

/**
 * Day counts offered by the Activity Log's retention control.
 *
 * A short ladder rather than a free-text number box: the choice is "how far
 * back do I want to be able to look", not a value anyone tunes to the day, and
 * a typo in a free-text box is a destructive prune. The default must appear in
 * this list so the control can render it without a custom entry.
 */
export const CUE_HISTORY_RETENTION_DAY_OPTIONS: readonly number[] = [7, 14, 30, 60, 90, 365];

/** A single choice in the retention control: the day count and its label. */
export interface CueHistoryRetentionOption {
	days: number;
	label: string;
}

/**
 * Label a retention window for display ("30 days", "1 year").
 *
 * @param days - A whole day count >= 1
 */
export function formatCueHistoryRetention(days: number): string {
	if (days === 365) return '1 year';
	if (days === 1) return '1 day';
	return `${days} days`;
}

/**
 * Build the retention control's option list, including the current value.
 *
 * A day count can reach the settings file from the CLI or by hand, so the
 * stored value is not guaranteed to be one of the offered rungs. A native
 * `<select>` whose `value` matches no `<option>` renders BLANK, which would
 * show the user no retention window at all while the engine happily prunes by
 * one. So a custom value is folded into the ladder in sorted position instead.
 *
 * @param currentDays - The resolved current setting (run it through
 *   {@link resolveCueHistoryRetentionDays} first)
 * @returns Ascending options, always containing `currentDays`
 */
export function cueHistoryRetentionOptions(currentDays: number): CueHistoryRetentionOption[] {
	const days = new Set<number>(CUE_HISTORY_RETENTION_DAY_OPTIONS);
	days.add(currentDays);
	return [...days]
		.sort((a, b) => a - b)
		.map((d) => ({ days: d, label: formatCueHistoryRetention(d) }));
}
