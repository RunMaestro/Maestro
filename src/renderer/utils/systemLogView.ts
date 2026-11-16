/**
 * The pure half of the System Log Viewer: entry keys and the timeline strip.
 * Search matching is `logEntryMatchesSearch()` in `shared/logSources.ts`, which
 * `maestro-cli logs` uses too. Kept out of the component so a list of thousands of entries
 * pays for each of these once, not once per render.
 */

/** The fields of a log entry this module reads. */
export interface SystemLogViewEntry {
	timestamp: number;
	level: string;
	message: string;
	context?: string;
	data?: unknown;
	source?: string;
}

/** Longest part of a message that goes into an entry's key. */
const KEY_MESSAGE_CHARS = 120;

/**
 * One key per entry, stable across renders and across new entries arriving.
 *
 * An index key is wrong here: the list runs newest first, so every new entry
 * shifted every index, and React remounted every card for each line logged.
 * The key is built from the entry's content instead. File log lines are parsed
 * again on every read, so object identity cannot carry it either. Identical
 * entries (same source, time, level and message) are told apart by an
 * occurrence count taken from the OLDEST end, so a new entry at the top never
 * renames the ones below it.
 */
export function buildSystemLogKeys(entries: readonly SystemLogViewEntry[]): string[] {
	const keys = new Array<string>(entries.length);
	const seen = new Map<string, number>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		const base = `${e.source ?? 'maestro'}|${e.timestamp}|${e.level}|${e.message.length}|${e.message.slice(0, KEY_MESSAGE_CHARS)}`;
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		keys[i] = n === 0 ? base : `${base}#${n}`;
	}
	return keys;
}

/** One stripe of the timeline strip: a run of consecutive shown entries. */
export interface SystemLogTimelineSegment {
	key: string;
	/** Index of the first entry the stripe covers, in list order. */
	startIndex: number;
	/** How many entries it covers. */
	count: number;
	/** The level it is drawn in: the most severe one among its entries. */
	level: string;
	title: string;
}

/**
 * The most stripes the strip draws. One element per entry made the strip a
 * flex row of thousands of children, laid out again on every new line; past
 * this many, neighboring entries share a stripe. The strip is a few hundred
 * pixels to a couple of thousand wide, so a stripe stays at least a few pixels.
 */
export const MAX_TIMELINE_SEGMENTS = 240;

// Higher draws over lower when entries share a stripe: a problem is never
// hidden by the routine lines around it.
const LEVEL_SEVERITY: Record<string, number> = {
	debug: 0,
	info: 1,
	toast: 2,
	cue: 3,
	autorun: 4,
	warn: 5,
	error: 6,
};

function entryTitle(entry: SystemLogViewEntry): string {
	const message =
		entry.message.length > 50 ? `${entry.message.substring(0, 50)}...` : entry.message;
	return `${new Date(entry.timestamp).toLocaleTimeString()} - ${entry.level.toUpperCase()}: ${message}`;
}

/**
 * The timeline strip for the shown entries: one stripe per entry up to
 * {@link MAX_TIMELINE_SEGMENTS}, evenly sized runs of entries past it.
 */
export function buildSystemLogTimeline(
	entries: readonly SystemLogViewEntry[],
	keys: readonly string[],
	maxSegments: number = MAX_TIMELINE_SEGMENTS
): SystemLogTimelineSegment[] {
	const total = entries.length;
	if (total === 0) return [];
	if (total <= maxSegments) {
		return entries.map((entry, i) => ({
			key: keys[i],
			startIndex: i,
			count: 1,
			level: entry.level,
			title: entryTitle(entry),
		}));
	}

	const segments: SystemLogTimelineSegment[] = [];
	for (let s = 0; s < maxSegments; s++) {
		const start = Math.floor((s * total) / maxSegments);
		const end = Math.floor(((s + 1) * total) / maxSegments);
		if (end <= start) continue;
		let level = entries[start].level;
		let errors = 0;
		let warnings = 0;
		for (let i = start; i < end; i++) {
			const l = entries[i].level;
			if (l === 'error') errors++;
			else if (l === 'warn') warnings++;
			if ((LEVEL_SEVERITY[l] ?? 0) > (LEVEL_SEVERITY[level] ?? 0)) level = l;
		}
		// Newest first: the run's first entry is its latest.
		const newest = new Date(entries[start].timestamp).toLocaleTimeString();
		const oldest = new Date(entries[end - 1].timestamp).toLocaleTimeString();
		const problems = [
			errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : '',
			warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '',
		]
			.filter(Boolean)
			.join(', ');
		segments.push({
			key: keys[start],
			startIndex: start,
			count: end - start,
			level,
			title: `${oldest} - ${newest}: ${end - start} entries${problems ? ` (${problems})` : ''}`,
		});
	}
	return segments;
}
