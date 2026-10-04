/**
 * Computer History viewer - pure model (no React, no IPC).
 *
 * Turns what the service returns (a flat event list, per-window activity
 * buckets) into what the viewer draws: visits (a run of events in one app and
 * window), histogram bars sized to the strip's width, and the range presets.
 */

import type { ActivityBucket } from '../../../shared/computer-history/reader';
import type { StoredEvent, StoredEventKind } from '../../../shared/computer-history/types';
import { SEGMENT_MS } from '../../../shared/computer-history/paths';
import { DURATION_MS } from '../../../shared/duration';

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export type RangeId = '1h' | 'today' | '24h' | '7d' | '30d';

export const RANGE_OPTIONS: ReadonlyArray<{ value: RangeId; label: string; title: string }> = [
	{ value: '1h', label: '1h', title: 'The last hour' },
	{ value: 'today', label: 'Today', title: 'Since local midnight' },
	{ value: '24h', label: '24h', title: 'The last 24 hours' },
	{ value: '7d', label: '7d', title: 'The last 7 days' },
	{ value: '30d', label: '30d', title: 'The last 30 days' },
];

/** Start of a preset range, ms. Every preset ends now. */
export function rangeStartMs(range: RangeId, nowMs: number): number {
	switch (range) {
		case '1h':
			return nowMs - DURATION_MS.hour;
		case 'today': {
			const d = new Date(nowMs);
			d.setHours(0, 0, 0, 0);
			return d.getTime();
		}
		case '24h':
			return nowMs - DURATION_MS.day;
		case '7d':
			return nowMs - 7 * DURATION_MS.day;
		case '30d':
			return nowMs - 30 * DURATION_MS.day;
	}
}

// ---------------------------------------------------------------------------
// Kind filters
// ---------------------------------------------------------------------------

export type KindFilterId = 'typed' | 'selected' | 'screen' | 'navigation';

export const KIND_FILTERS: ReadonlyArray<{
	id: KindFilterId;
	label: string;
	title: string;
	kinds: readonly StoredEventKind[];
}> = [
	{
		id: 'typed',
		label: 'Typed',
		title: 'Text you typed into fields',
		kinds: ['text.committed'],
	},
	{
		id: 'selected',
		label: 'Selected',
		title: 'Text you selected',
		kinds: ['selection.changed'],
	},
	{
		id: 'screen',
		label: 'Screen text',
		title: 'Snapshots of the text visible in the window',
		kinds: ['content.snapshot'],
	},
	{
		id: 'navigation',
		label: 'Apps & windows',
		title: 'App switches and window changes',
		kinds: ['app.activated', 'window.changed'],
	},
];

/** Stored kinds for a set of active filters, or undefined when all are on. */
export function kindsForFilters(active: ReadonlySet<KindFilterId>): StoredEventKind[] | undefined {
	if (active.size === KIND_FILTERS.length) return undefined;
	return KIND_FILTERS.filter((f) => active.has(f.id)).flatMap((f) => f.kinds);
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

/** A run of consecutive events in one app and window. */
export interface Visit {
	key: string;
	appId: string;
	appName: string;
	title?: string;
	url?: string;
	startMs: number;
	endMs: number;
	/** Events worth a row (typed, selected, screen text, other windows), in time order. */
	rows: StoredEvent[];
	/** Every event in the visit (for counts). */
	eventCount: number;
}

/** A pause longer than this splits a visit even when the app is unchanged. */
export const VISIT_GAP_MS = 10 * 60_000;

/** Stable identity for an event (dedupes pages that overlap at a boundary). */
export function eventKey(e: StoredEvent): string {
	return `${e.ts}|${e.seq}|${e.app?.id ?? ''}|${e.kind}`;
}

/**
 * Group events (any order) into visits, NEWEST FIRST. A new visit starts on
 * an app change, an app activation, a different window title, or a gap over
 * VISIT_GAP_MS. App activations and a window change that only names the
 * visit's own window are folded into the visit header, not repeated as rows.
 */
export function groupIntoVisits(events: readonly StoredEvent[]): Visit[] {
	const sorted = [...events].sort(
		(a, b) => Date.parse(a.ts) - Date.parse(b.ts) || (a.seq ?? 0) - (b.seq ?? 0)
	);
	const visits: Visit[] = [];
	let cur: Visit | null = null;
	for (const e of sorted) {
		const ms = Date.parse(e.ts);
		const appId = e.app?.id ?? '';
		const title = e.window?.title;
		const startsNew =
			!cur ||
			appId !== cur.appId ||
			e.kind === 'app.activated' ||
			(title !== undefined && cur.title !== undefined && title !== cur.title) ||
			ms - cur.endMs > VISIT_GAP_MS;
		if (startsNew) {
			cur = {
				key: eventKey(e),
				appId,
				appName: e.app?.name || appId || 'Unknown app',
				title,
				url: e.window?.url,
				startMs: ms,
				endMs: ms,
				rows: [],
				eventCount: 0,
			};
			visits.push(cur);
		}
		const visit = cur!;
		visit.eventCount += 1;
		visit.endMs = Math.max(visit.endMs, ms);
		if (visit.title === undefined && title !== undefined) visit.title = title;
		if (visit.url === undefined && e.window?.url) visit.url = e.window.url;
		if (e.kind === 'app.activated') continue;
		if (e.kind === 'window.changed' && (title === undefined || title === visit.title)) continue;
		visit.rows.push(e);
	}
	return visits.reverse();
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "Today", "Yesterday", or "Sat, Oct 3" (local). */
export function dayLabel(ms: number, nowMs: number): string {
	const day = new Date(ms);
	day.setHours(0, 0, 0, 0);
	const today = new Date(nowMs);
	today.setHours(0, 0, 0, 0);
	const diffDays = Math.round((today.getTime() - day.getTime()) / DURATION_MS.day);
	if (diffDays === 0) return 'Today';
	if (diffDays === 1) return 'Yesterday';
	return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Local day key, for inserting day separators. */
export function localDayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "10:42" local clock time. */
export function clockLabel(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Host of a URL for display, or undefined. Never a link: the URL is untrusted. */
export function urlHostLabel(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).hostname || undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

/** Bar widths the strip can use, smallest first. */
const BAR_STEPS_MS = [
	SEGMENT_MS,
	30 * 60_000,
	DURATION_MS.hour,
	2 * DURATION_MS.hour,
	3 * DURATION_MS.hour,
	6 * DURATION_MS.hour,
	12 * DURATION_MS.hour,
	DURATION_MS.day,
];

/** Narrowest bar step that keeps every bar at least `minBarPx` wide. */
export function chooseBarStepMs(spanMs: number, widthPx: number, minBarPx = 4): number {
	const maxBars = Math.max(1, Math.floor(widthPx / minBarPx));
	return BAR_STEPS_MS.find((step) => spanMs / step <= maxBars) ?? BAR_STEPS_MS.at(-1)!;
}

export interface HistogramBar {
	startMs: number;
	endMs: number;
	events: number;
	/** Per-app weight (foreground ms, or events when no time was recorded). */
	byApp: Record<string, number>;
	total: number;
	/** True when the weights are foreground ms (false: event counts scaled). */
	timed: boolean;
}

/**
 * Fold 15-minute buckets into bars of `stepMs`, aligned to LOCAL time (so a
 * 1-day bar is a calendar day here, not a UTC day). Weight is foreground
 * time, falling back to event count for buckets recorded before time was
 * indexed, so old history still draws.
 */
export function buildHistogram(
	buckets: readonly ActivityBucket[],
	stepMs: number,
	sinceMs: number,
	untilMs: number
): HistogramBar[] {
	const tzOffsetMs = new Date(sinceMs).getTimezoneOffset() * 60_000;
	const align = (ms: number) => Math.floor((ms - tzOffsetMs) / stepMs) * stepMs + tzOffsetMs;
	const bars = new Map<number, HistogramBar>();
	for (let t = align(sinceMs); t < untilMs; t += stepMs) {
		bars.set(t, { startMs: t, endMs: t + stepMs, events: 0, byApp: {}, total: 0, timed: false });
	}
	for (const b of buckets) {
		const bar = bars.get(align(b.startMs));
		if (!bar) continue;
		bar.events += b.events;
		const timed = Object.values(b.activeMs).some((ms) => ms > 0);
		if (timed) bar.timed = true;
		for (const [id, n] of Object.entries(b.apps)) {
			const w = timed ? (b.activeMs[id] ?? 0) : n * 1000;
			bar.byApp[id] = (bar.byApp[id] ?? 0) + w;
			bar.total += w;
		}
	}
	return [...bars.values()];
}
