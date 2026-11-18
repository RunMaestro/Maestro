/**
 * Small pure helpers shared by the Cue tab's panels.
 */

import type { CueStatsTotals, CueTimeBucket } from '../../../../shared/cue-stats-types';
import { safeStorageGet, safeStorageSet } from '../../../utils/safeLocalStorage';

export function totalTokens(t: CueStatsTotals): number {
	return t.totalInputTokens + t.totalOutputTokens;
}

/** Completed over completed + failed; in-flight runs are in neither. */
export function successRate(t: CueStatsTotals): number {
	const tracked = t.successCount + t.failureCount;
	return tracked === 0 ? 0 : t.successCount / tracked;
}

/**
 * Mean run time over the runs that HAVE a run time (completed runs), not over
 * every run: a failed or still-running run would otherwise drag the mean down
 * as if it had taken no time.
 */
export function averageRunMs(t: CueStatsTotals): number {
	return t.timedRunCount > 0 ? t.totalDurationMs / t.timedRunCount : 0;
}

export function formatPercent(ratio: number): string {
	return `${Math.round(ratio * 100)}%`;
}

export const SUMMARY_SPARKLINE_LIMIT = 14;

/**
 * Right-aligned slice of the time-series buckets for the summary cards'
 * sparklines, padded with leading zeros so the geometry stays stable.
 */
export function lastBucketCounts(
	buckets: CueTimeBucket[],
	pick: (b: CueTimeBucket) => number
): number[] {
	const slice = buckets.slice(-SUMMARY_SPARKLINE_LIMIT).map(pick);
	if (slice.length >= SUMMARY_SPARKLINE_LIMIT) return slice;
	return [...new Array(SUMMARY_SPARKLINE_LIMIT - slice.length).fill(0), ...slice];
}

export const EXCLUDED_TRIGGERS_STORAGE_KEY = 'maestro.usageDashboard.cueExcludedTriggers';

/**
 * Read the persisted exclusion set. Survives reopening the dashboard because
 * the filter is a standing preference ("stop showing me heartbeats"), not a
 * per-visit choice. Malformed storage is treated as "nothing excluded" rather
 * than thrown - a bad key must never blank the tab.
 */
export function loadExcludedTriggers(): string[] {
	const raw = safeStorageGet(EXCLUDED_TRIGGERS_STORAGE_KEY);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
	} catch {
		return [];
	}
}

export function saveExcludedTriggers(keys: string[]): void {
	safeStorageSet(EXCLUDED_TRIGGERS_STORAGE_KEY, JSON.stringify(keys));
}
