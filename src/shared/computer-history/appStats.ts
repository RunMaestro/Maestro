/**
 * Computer History - per-app counters for one segment (pure, bundle-safe).
 *
 * The segment writer folds every stored event through `addEventToAppStats`
 * and writes the result into the segment's index line, so "which apps, how
 * long, under what name" over any range is answered from `index.jsonl`
 * alone. Without this, a week of the viewer's app list meant parsing ~700
 * segment files. The reader folds the open (unindexed) segment through the
 * same function, so indexed and live windows agree.
 *
 * Time model (same as `summarizeApps`): each event's app owns the gap to the
 * next event, capped at APP_TIME_IDLE_CAP_MS so a machine left on overnight
 * does not credit the last app with eight hours. Gaps across a segment
 * boundary are not credited (at most one gap per 15 minutes).
 */

/** Gaps longer than this between events are counted as idle, not app time. */
export const APP_TIME_IDLE_CAP_MS = 5 * 60_000;

export interface AppStats {
	/** Event count per `app.id`. */
	apps: Record<string, number>;
	/** Latest display name per `app.id`. */
	names: Record<string, string>;
	/** Foreground ms per `app.id`. */
	activeMs: Record<string, number>;
	/** App of the previous event (null when it had none), and its time. */
	prevAppId: string | null;
	prevTsMs: number | null;
}

export function createAppStats(): AppStats {
	return { apps: {}, names: {}, activeMs: {}, prevAppId: null, prevTsMs: null };
}

/** Fold one event (in time order) into `stats`. Mutates and returns it. */
export function addEventToAppStats(
	stats: AppStats,
	event: { ts: string; app?: { id: string; name?: string } }
): AppStats {
	const ms = Date.parse(event.ts);
	if (Number.isNaN(ms)) return stats;
	if (stats.prevAppId !== null && stats.prevTsMs !== null) {
		const gap = Math.max(0, Math.min(ms - stats.prevTsMs, APP_TIME_IDLE_CAP_MS));
		stats.activeMs[stats.prevAppId] = (stats.activeMs[stats.prevAppId] ?? 0) + gap;
	}
	const id = event.app?.id;
	if (id) {
		stats.apps[id] = (stats.apps[id] ?? 0) + 1;
		if (event.app?.name) stats.names[id] = event.app.name;
		stats.activeMs[id] = stats.activeMs[id] ?? 0;
	}
	stats.prevAppId = id ?? null;
	stats.prevTsMs = ms;
	return stats;
}

/** The index-line fields for `stats` (copies, so later appends do not leak in). */
export function appStatsIndexFields(stats: AppStats): {
	apps: Record<string, number>;
	names: Record<string, string>;
	activeMs: Record<string, number>;
} {
	return { apps: { ...stats.apps }, names: { ...stats.names }, activeMs: { ...stats.activeMs } };
}
