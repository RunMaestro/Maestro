/**
 * Lifetime peak usage counters (the "Peak Usage" row on the achievement card).
 *
 * These are high-water marks, not samples: a value only ever moves up, and it
 * is never aged out, pruned, or recomputed from live state. That invariant is
 * the whole point of the stat, and it used to be broken in two ways:
 *
 *  1. The renderer maxed against its own in-memory copy and wrote the result
 *     straight to disk. During `loadAllSettings` that copy is still the zeroed
 *     default, so the first `sessions` ref flip after launch persisted a LIVE
 *     SNAPSHOT as the all-time peak and destroyed the real one. (Observed: a
 *     stored `maxSimultaneousQueries` of 3 against a backup holding 6.)
 *  2. With multiple windows open, each window maxed against its own copy, so
 *     whichever window wrote last could lower a peak another window had raised.
 *
 * Both collapse into one rule: the merge belongs at the persistence layer,
 * against what is actually on disk. `settings:set` applies `mergeUsagePeaks`
 * for the `usageStats` key, so no caller - renderer, peer window, or future
 * one - can write a value lower than the stored peak, whatever state it is in.
 * The renderer keeps its own guard so it does not display or send a regression
 * in the first place.
 */

export const USAGE_PEAK_KEYS = [
	'maxAgents',
	'maxDefinedAgents',
	'maxSimultaneousAutoRuns',
	'maxSimultaneousQueries',
	'maxQueueDepth',
] as const;

export type UsagePeakKey = (typeof USAGE_PEAK_KEYS)[number];

/** Structurally identical to `MaestroUsageStats` in renderer types. */
export type UsagePeaks = Record<UsagePeakKey, number>;

export const ZERO_USAGE_PEAKS: UsagePeaks = {
	maxAgents: 0,
	maxDefinedAgents: 0,
	maxSimultaneousAutoRuns: 0,
	maxSimultaneousQueries: 0,
	maxQueueDepth: 0,
};

/**
 * Coerce one stored/incoming counter to a usable number.
 *
 * A peak read back from JSON can be anything: missing (a key added after the
 * file was written), a string, NaN, or negative. Any of those must degrade to
 * 0 rather than poisoning the Math.max - `Math.max(89, NaN)` is NaN, which
 * would wipe the peak it was supposed to defend.
 */
function toPeak(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.floor(n);
}

/**
 * Merge a set of observed values into the stored peaks, keeping the larger of
 * each. Never lowers a stored value and never drops a key.
 */
export function mergeUsagePeaks(
	stored: Partial<UsagePeaks> | null | undefined,
	incoming: Partial<UsagePeaks> | null | undefined
): UsagePeaks {
	const merged = { ...ZERO_USAGE_PEAKS };
	for (const key of USAGE_PEAK_KEYS) {
		merged[key] = Math.max(toPeak(stored?.[key]), toPeak(incoming?.[key]));
	}
	return merged;
}

/** True when every peak matches, so callers can skip a write and a re-render. */
export function usagePeaksEqual(
	a: Partial<UsagePeaks> | null | undefined,
	b: Partial<UsagePeaks> | null | undefined
): boolean {
	return USAGE_PEAK_KEYS.every((key) => toPeak(a?.[key]) === toPeak(b?.[key]));
}
