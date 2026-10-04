/**
 * Computer History - store reader (Node only: CLI and main).
 *
 * The CLI reads the store straight from disk (D7: it works with the app
 * closed), and the main-process service uses the same functions for the UI's
 * recent-activity view, so both answer every question identically.
 *
 * Scale: the store can reach 25 GB. Nothing here walks every file. Segment
 * selection uses `index.jsonl` (one line per closed segment, keyed by its
 * 15-minute window) plus a scan of the newest two day folders for segments
 * that have no index line yet (the open segment, or one a crash left
 * unclosed). Only files whose window overlaps the requested range are opened,
 * and `limit` queries walk newest-first and stop early.
 *
 * Robustness: a segment is append-only and may end in a torn line (the app
 * was killed mid-write). Any line that does not parse as a stored event is
 * skipped, never fatal.
 *
 * NOT renderer-safe (imports `fs`). The renderer goes through IPC.
 */

import * as fs from 'fs/promises';
import { normalizeConfig } from './config';
import {
	CONFIG_FILE,
	DIGESTS_DIR,
	INDEX_FILE,
	ROLLUP_MS,
	parseDigestRelativePath,
	type DigestKind,
	SEGMENTS_DIR,
	SEGMENT_MS,
	parseSegmentRelativePath,
	resolveStorePath,
} from './paths';
import { APP_TIME_IDLE_CAP_MS, addEventToAppStats, createAppStats } from './appStats';
import { STORED_EVENT_KINDS } from './types';
import type {
	ComputerHistoryConfig,
	SegmentIndexEntry,
	StoredEvent,
	StoredEventKind,
} from './types';

/** A segment selected for a range: from the index, or found on disk without one. */
export interface SegmentInfo {
	/** Store-relative path, forward slashes. */
	file: string;
	/** Window start / end (ms). */
	startMs: number;
	endMs: number;
	/** False for the open segment (or a crash leftover) that has no index line yet. */
	indexed: boolean;
	events?: number;
	bytes?: number;
	apps?: Record<string, number>;
	names?: Record<string, string>;
	activeMs?: Record<string, number>;
}

export interface TimeRange {
	sinceMs?: number;
	untilMs?: number;
}

export interface EventFilter extends TimeRange {
	/** Match `app.id` exactly or `app.name` as a substring, case-insensitive. */
	apps?: readonly string[];
	kinds?: readonly StoredEventKind[];
	/** Tested against text, window title/url, element label, and app name. */
	grep?: RegExp;
}

export interface QueryOptions extends EventFilter {
	/** Return at most this many events: the MOST RECENT matches, in time order. */
	limit?: number;
}

export interface QueryResult {
	events: StoredEvent[];
	/** True when `limit` was reached and older matches may exist. */
	limited: boolean;
	segmentsScanned: number;
}

export interface AppUsage {
	id: string;
	name: string;
	events: number;
	/** Foreground time attributed from event spacing, idle gaps capped. */
	activeMs: number;
	firstSeen: string;
	lastSeen: string;
}

export { APP_TIME_IDLE_CAP_MS };

const STORED_KINDS = new Set<string>(STORED_EVENT_KINDS);

async function readTextIfExists(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
}

function isIndexEntry(v: unknown): v is SegmentIndexEntry {
	if (!v || typeof v !== 'object') return false;
	const e = v as Record<string, unknown>;
	return typeof e.file === 'string' && typeof e.events === 'number';
}

/**
 * Parse `index.jsonl`. Torn lines are skipped. A file closed twice (an app
 * restart inside the same 15-minute window reopens and re-closes it) has
 * more than one line; the LAST one wins because it counts every event.
 */
export function parseIndexText(text: string): SegmentIndexEntry[] {
	const byFile = new Map<string, SegmentIndexEntry>();
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isIndexEntry(parsed)) continue;
		if (parseSegmentRelativePath(parsed.file) === null) continue;
		byFile.delete(parsed.file);
		byFile.set(parsed.file, parsed);
	}
	return [...byFile.values()];
}

export async function readIndex(storeDir: string): Promise<SegmentIndexEntry[]> {
	const text = await readTextIfExists(resolveStorePath(storeDir, INDEX_FILE));
	return text ? parseIndexText(text) : [];
}

/** Parse one stored-event line, or null for a torn / foreign line. */
export function parseStoredLine(line: string): StoredEvent | null {
	if (!line.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const e = parsed as Record<string, unknown>;
	if (typeof e.kind !== 'string' || !STORED_KINDS.has(e.kind)) return null;
	if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) return null;
	return parsed as StoredEvent;
}

/** Parse a whole segment file's text, skipping invalid lines. */
export function parseSegmentText(text: string): StoredEvent[] {
	const out: StoredEvent[] = [];
	for (const line of text.split('\n')) {
		const event = parseStoredLine(line);
		if (event) out.push(event);
	}
	return out;
}

async function listDir(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
}

const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC day folders under `segments/`, ascending. */
export async function listDayFolders(storeDir: string): Promise<string[]> {
	const names = await listDir(resolveStorePath(storeDir, SEGMENTS_DIR));
	return names.filter((n) => DAY_DIR_RE.test(n)).sort();
}

/** Every segment file on disk in the given day folders (store-relative). */
export async function listSegmentFilesIn(
	storeDir: string,
	days: readonly string[]
): Promise<string[]> {
	const out: string[] = [];
	for (const day of days) {
		for (const name of await listDir(resolveStorePath(storeDir, `${SEGMENTS_DIR}/${day}`))) {
			const rel = `${SEGMENTS_DIR}/${day}/${name}`;
			if (parseSegmentRelativePath(rel) !== null) out.push(rel);
		}
	}
	return out.sort();
}

function overlaps(startMs: number, range: TimeRange): boolean {
	const endMs = startMs + SEGMENT_MS;
	if (range.sinceMs !== undefined && endMs <= range.sinceMs) return false;
	if (range.untilMs !== undefined && startMs > range.untilMs) return false;
	return true;
}

/**
 * Segments whose 15-minute window overlaps `range`, ascending by start. Index
 * entries whose file no longer exists are dropped only when actually read.
 */
export async function listSegments(
	storeDir: string,
	range: TimeRange = {}
): Promise<SegmentInfo[]> {
	const byFile = new Map<string, SegmentInfo>();
	for (const entry of await readIndex(storeDir)) {
		const startMs = parseSegmentRelativePath(entry.file);
		if (startMs === null || !overlaps(startMs, range)) continue;
		byFile.set(entry.file, {
			file: entry.file,
			startMs,
			endMs: startMs + SEGMENT_MS,
			indexed: true,
			events: entry.events,
			bytes: entry.bytes,
			apps: entry.apps,
			names: entry.names,
			activeMs: entry.activeMs,
		});
	}
	// The open segment (and a crash leftover) has no index line yet. They can
	// only be in the newest folders: older windows were closed by the writer
	// or recovered into the index at its next start.
	const days = await listDayFolders(storeDir);
	for (const rel of await listSegmentFilesIn(storeDir, days.slice(-2))) {
		if (byFile.has(rel)) continue;
		const startMs = parseSegmentRelativePath(rel);
		if (startMs === null || !overlaps(startMs, range)) continue;
		byFile.set(rel, { file: rel, startMs, endMs: startMs + SEGMENT_MS, indexed: false });
	}
	return [...byFile.values()].sort((a, b) => a.startMs - b.startMs);
}

/** Read and parse one segment; a missing file reads as empty. */
export async function readSegment(storeDir: string, rel: string): Promise<StoredEvent[]> {
	const text = await readTextIfExists(resolveStorePath(storeDir, rel));
	return text ? parseSegmentText(text) : [];
}

/**
 * Compile a user `--grep`: a case-insensitive regex when it is valid, else
 * the same text matched literally (a stray `(` should search, not fail).
 */
export function compileGrep(grep: string | undefined): RegExp | undefined {
	if (!grep) return undefined;
	try {
		return new RegExp(grep, 'i');
	} catch {
		return new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
	}
}

/** Whether `event` passes `filter`. */
export function eventMatches(event: StoredEvent, filter: EventFilter): boolean {
	const ms = Date.parse(event.ts);
	if (filter.sinceMs !== undefined && ms < filter.sinceMs) return false;
	if (filter.untilMs !== undefined && ms > filter.untilMs) return false;
	if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) return false;
	if (filter.apps && filter.apps.length > 0) {
		const id = event.app?.id?.toLowerCase() ?? '';
		const name = event.app?.name?.toLowerCase() ?? '';
		const hit = filter.apps.some((a) => {
			const q = a.trim().toLowerCase();
			return q.length > 0 && (id === q || name.includes(q));
		});
		if (!hit) return false;
	}
	if (filter.grep) {
		const re = filter.grep;
		const fields = [
			event.text,
			event.window?.title,
			event.window?.url,
			event.element?.label,
			event.app?.name,
		];
		// A /g or /y regex keeps lastIndex between calls; reset per field.
		const hit = fields.some((f) => {
			if (!f) return false;
			re.lastIndex = 0;
			return re.test(f);
		});
		if (!hit) return false;
	}
	return true;
}

/**
 * Matching events in time order. With `limit`, walks segments newest-first
 * and stops as soon as it has the most recent `limit` matches.
 */
export async function queryEvents(
	storeDir: string,
	options: QueryOptions = {}
): Promise<QueryResult> {
	const segments = await listSegments(storeDir, options);
	const limit = options.limit !== undefined && options.limit > 0 ? options.limit : undefined;
	let segmentsScanned = 0;
	if (limit === undefined) {
		const events: StoredEvent[] = [];
		for (const seg of segments) {
			segmentsScanned++;
			for (const e of await readSegment(storeDir, seg.file)) {
				if (eventMatches(e, options)) events.push(e);
			}
		}
		events.sort(compareEvents);
		return { events, limited: false, segmentsScanned };
	}
	const newestFirst: StoredEvent[] = [];
	let limited = false;
	for (let i = segments.length - 1; i >= 0; i--) {
		segmentsScanned++;
		const matches = (await readSegment(storeDir, segments[i].file))
			.filter((e) => eventMatches(e, options))
			.sort(compareEvents);
		for (let j = matches.length - 1; j >= 0; j--) {
			if (newestFirst.length >= limit) {
				limited = true;
				break;
			}
			newestFirst.push(matches[j]);
		}
		if (newestFirst.length >= limit) {
			// Older segments were not read, so more matches may exist there.
			limited = limited || i > 0;
			break;
		}
	}
	return { events: newestFirst.reverse(), limited, segmentsScanned };
}

function compareEvents(a: StoredEvent, b: StoredEvent): number {
	const d = Date.parse(a.ts) - Date.parse(b.ts);
	return d !== 0 ? d : (a.seq ?? 0) - (b.seq ?? 0);
}

/**
 * Per-app event counts and foreground time over a range. Time is attributed
 * from the spacing between consecutive events (each event's app owns the gap
 * to the next event), with gaps over `APP_TIME_IDLE_CAP_MS` capped so a
 * machine left on overnight does not credit the last app with eight hours.
 */
export async function summarizeApps(storeDir: string, range: TimeRange = {}): Promise<AppUsage[]> {
	const byId = new Map<string, AppUsage>();
	let prev: StoredEvent | null = null;
	const credit = (event: StoredEvent, ms: number) => {
		if (!event.app) return;
		const id = event.app.id;
		let usage = byId.get(id);
		if (!usage) {
			usage = {
				id,
				name: event.app.name || id,
				events: 0,
				activeMs: 0,
				firstSeen: event.ts,
				lastSeen: event.ts,
			};
			byId.set(id, usage);
		}
		usage.activeMs += ms;
	};
	for (const seg of await listSegments(storeDir, range)) {
		const events = (await readSegment(storeDir, seg.file))
			.filter((e) => eventMatches(e, range))
			.sort(compareEvents);
		for (const e of events) {
			if (prev) {
				const gap = Date.parse(e.ts) - Date.parse(prev.ts);
				credit(prev, Math.max(0, Math.min(gap, APP_TIME_IDLE_CAP_MS)));
			}
			if (e.app) {
				credit(e, 0);
				const usage = byId.get(e.app.id)!;
				usage.events += 1;
				usage.lastSeen = e.ts;
				if (e.app.name) usage.name = e.app.name;
			}
			prev = e;
		}
	}
	return [...byId.values()].sort((a, b) => b.activeMs - a.activeMs || b.events - a.events);
}

export interface StoreStats {
	/** Whether the store directory exists at all. */
	exists: boolean;
	segments: number;
	bytes: number;
	/** Window start of the oldest / newest segment, ISO, or null when empty. */
	oldest: string | null;
	newest: string | null;
}

/** Segment count, bytes on disk, and the time span covered. One stat per file. */
export async function readStoreStats(storeDir: string): Promise<StoreStats> {
	try {
		await fs.access(storeDir);
	} catch {
		return { exists: false, segments: 0, bytes: 0, oldest: null, newest: null };
	}
	const files = await listSegmentFilesIn(storeDir, await listDayFolders(storeDir));
	let bytes = 0;
	for (const rel of files) {
		try {
			bytes += (await fs.stat(resolveStorePath(storeDir, rel))).size;
		} catch {
			// Deleted between listing and stat (retention): skip.
		}
	}
	const first = files.length > 0 ? parseSegmentRelativePath(files[0]) : null;
	const last = files.length > 0 ? parseSegmentRelativePath(files[files.length - 1]) : null;
	return {
		exists: true,
		segments: files.length,
		bytes,
		oldest: first !== null ? new Date(first).toISOString() : null,
		newest: last !== null ? new Date(last).toISOString() : null,
	};
}

/** `config.json` as the service would see it (defaults when missing or corrupt). */
export async function readStoreConfig(storeDir: string): Promise<ComputerHistoryConfig> {
	const text = await readTextIfExists(resolveStorePath(storeDir, CONFIG_FILE));
	if (!text) return normalizeConfig(null);
	try {
		return normalizeConfig(JSON.parse(text));
	} catch {
		return normalizeConfig(null);
	}
}

/** A digest file on disk. */
export interface DigestInfo {
	kind: DigestKind;
	/** Store-relative path, forward slashes. */
	file: string;
	/** Window (15m) or block (6h) start / end, ms. */
	startMs: number;
	endMs: number;
}

/**
 * Digest files whose window overlaps `range`, ascending by start (a block's
 * roll-up sorts after the 15-minute digests that start with it). Reads only
 * directory listings; bodies are read on demand with `readDigest`.
 */
export async function listDigests(
	storeDir: string,
	options: TimeRange & { kind?: DigestKind } = {}
): Promise<DigestInfo[]> {
	const days = (await listDir(resolveStorePath(storeDir, DIGESTS_DIR)))
		.filter((n) => DAY_DIR_RE.test(n))
		.sort();
	const out: DigestInfo[] = [];
	for (const day of days) {
		// A day folder can hold digests for blocks that end the next day; skip
		// only folders that start after the range ends.
		const dayStart = Date.parse(`${day}T00:00:00.000Z`);
		if (options.untilMs !== undefined && dayStart > options.untilMs) continue;
		if (options.sinceMs !== undefined && dayStart + 86_400_000 + ROLLUP_MS <= options.sinceMs)
			continue;
		for (const name of await listDir(resolveStorePath(storeDir, `${DIGESTS_DIR}/${day}`))) {
			const file = `${DIGESTS_DIR}/${day}/${name}`;
			const parsed = parseDigestRelativePath(file);
			if (!parsed) continue;
			if (options.kind && parsed.kind !== options.kind) continue;
			const endMs = parsed.startMs + (parsed.kind === '6h' ? ROLLUP_MS : SEGMENT_MS);
			if (options.sinceMs !== undefined && endMs <= options.sinceMs) continue;
			if (options.untilMs !== undefined && parsed.startMs > options.untilMs) continue;
			out.push({ kind: parsed.kind, file, startMs: parsed.startMs, endMs });
		}
	}
	return out.sort(
		(a, b) => a.startMs - b.startMs || (a.kind === '6h' ? 1 : 0) - (b.kind === '6h' ? 1 : 0)
	);
}

/** A digest body, or null when the file is gone. */
export async function readDigest(storeDir: string, rel: string): Promise<string | null> {
	return readTextIfExists(resolveStorePath(storeDir, rel));
}

/** One 15-minute window's activity. */
export interface ActivityBucket {
	startMs: number;
	events: number;
	/** Event count per `app.id`. */
	apps: Record<string, number>;
	/** Foreground ms per `app.id` (0 for index lines written before it was tracked). */
	activeMs: Record<string, number>;
}

/** One app's totals over a range. */
export interface AppActivity {
	id: string;
	/** Display name, or the id when no recorded line carried one. */
	name: string;
	events: number;
	activeMs: number;
	/** Start of the newest window the app appears in. */
	lastWindowMs: number;
}

export interface ActivitySummary {
	/** Windows with activity, ascending. */
	buckets: ActivityBucket[];
	/** Apps by foreground time, then event count. */
	apps: AppActivity[];
	totalEvents: number;
}

/**
 * Per-window and per-app activity over `range`, from the index (closed
 * windows) plus the open segment, read and folded the same way the writer
 * folds it. Granularity is the 15-minute window: a window the range only
 * partly covers counts whole. Cheap at any range, since closed windows cost
 * one index line each.
 */
export async function readActivity(
	storeDir: string,
	range: TimeRange = {}
): Promise<ActivitySummary> {
	const buckets: ActivityBucket[] = [];
	const byId = new Map<string, AppActivity>();
	let totalEvents = 0;
	for (const seg of await listSegments(storeDir, range)) {
		let apps = seg.apps;
		let names = seg.names;
		let activeMs = seg.activeMs;
		if (!seg.indexed) {
			const stats = createAppStats();
			for (const e of (await readSegment(storeDir, seg.file)).sort(compareEvents)) {
				addEventToAppStats(stats, e);
			}
			({ apps, names, activeMs } = stats);
		}
		const counts = apps ?? {};
		const events = Object.values(counts).reduce((sum, n) => sum + n, 0);
		if (events === 0) continue;
		totalEvents += events;
		const active: Record<string, number> = {};
		for (const [id, n] of Object.entries(counts)) {
			const ms = activeMs?.[id] ?? 0;
			active[id] = ms;
			let usage = byId.get(id);
			if (!usage) {
				usage = { id, name: id, events: 0, activeMs: 0, lastWindowMs: seg.startMs };
				byId.set(id, usage);
			}
			usage.events += n;
			usage.activeMs += ms;
			usage.lastWindowMs = Math.max(usage.lastWindowMs, seg.startMs);
			const name = names?.[id];
			if (name) usage.name = name;
		}
		buckets.push({ startMs: seg.startMs, events, apps: { ...counts }, activeMs: active });
	}
	const appsOut = [...byId.values()].sort(
		(a, b) => b.activeMs - a.activeMs || b.events - a.events || a.name.localeCompare(b.name)
	);
	return { buckets, apps: appsOut, totalEvents };
}

/** A digest with its body (agent-written, untrusted). */
export interface DigestWithBody extends DigestInfo {
	body: string;
}

/**
 * The newest `limit` digests overlapping `range` with their bodies, newest
 * first. Bodies are read only for the digests returned.
 */
export async function readRecentDigests(
	storeDir: string,
	options: TimeRange & { kind?: DigestKind; limit?: number } = {}
): Promise<DigestWithBody[]> {
	const limit = options.limit && options.limit > 0 ? options.limit : 50;
	const infos = (await listDigests(storeDir, options)).reverse().slice(0, limit);
	const out: DigestWithBody[] = [];
	for (const info of infos) {
		const body = await readDigest(storeDir, info.file);
		if (body !== null) out.push({ ...info, body });
	}
	return out;
}
