/**
 * Computer History - segment writer.
 *
 * Events land in 15-minute UTC segment files (`segments/<day>/<HHMM>Z.jsonl`),
 * append-only, each line an event plus a per-segment `seq`. When a window
 * ends (a later event arrives, the expiry timer fires, or the app shuts down)
 * the segment is CLOSED: one summary line is appended to `index.jsonl`, which
 * is what lets readers skip whole files by time range.
 *
 * Ordering: every append and close runs on one keyed queue key, so `seq`
 * order is file order and a rollover can never interleave with an append.
 * `index.jsonl` writes use the `index` key of the SAME queue the retention
 * pass uses to rewrite that file, so an append can never land between
 * retention's read and its atomic rename.
 *
 * Restart inside a window: the file already exists, so it is scanned and the
 * new events continue its `seq`. Re-closing it appends a second index line;
 * readers take the last line for a file.
 *
 * Crash recovery: `start()` indexes any segment file on disk that has no
 * index line and is not the current window (a crash skipped its close).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
	INDEX_FILE,
	SEGMENT_MS,
	resolveStorePath,
	segmentRelativePath,
	segmentStartMs,
	parseSegmentRelativePath,
} from '../../shared/computer-history/paths';
import {
	listDayFolders,
	listSegmentFilesIn,
	parseSegmentText,
	readIndex,
} from '../../shared/computer-history/reader';
import {
	addEventToAppStats,
	appStatsIndexFields,
	createAppStats,
	type AppStats,
} from '../../shared/computer-history/appStats';
import type { SegmentIndexEntry, StoredEvent } from '../../shared/computer-history/types';
import type { KeyedWriteQueue } from '../utils/atomic-json-store';

/** Queue keys shared with retention / clear. */
export const SEGMENT_QUEUE_KEY = 'computer-history:segment';
export const INDEX_QUEUE_KEY = 'computer-history:index';

/** A window is closed this long after it ends, so late events still land in it. */
const CLOSE_GRACE_MS = 2_000;

/**
 * The store holds the user's screen and typing history: owner-only. Modes
 * apply when a directory or file is CREATED (and are ignored on Windows,
 * where the per-user profile ACL is what protects it).
 */
export const STORE_DIR_MODE = 0o700;
export const STORE_FILE_MODE = 0o600;

/**
 * Defense against a runaway helper: past this many bytes in one 15-minute
 * segment, `content.snapshot` events are dropped; past twice this, every
 * event is. Drops are counted in the segment's index line (`dropped`).
 */
export const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

interface OpenSegment {
	startMs: number;
	rel: string;
	abs: string;
	nextSeq: number;
	events: number;
	bytes: number;
	/** Per-app counts, names, and foreground time for the index line. */
	stats: AppStats;
	firstTs: string | null;
	lastTs: string | null;
	/** The file ends in a torn line (a crash mid-append): start the next one on a new line. */
	needsNewline: boolean;
	/** Events refused by the per-segment byte guard. */
	dropped: number;
}

export type StoredEventInput = Omit<StoredEvent, 'seq'>;

export interface SegmentWriterOptions {
	storeDir: string;
	queue: KeyedWriteQueue;
	now?: () => number;
	/** Fires after a non-empty segment's index line is written. */
	onSegmentClosed?: (entry: SegmentIndexEntry, startMs: number) => void;
	maxSegmentBytes?: number;
}

function summarize(seg: OpenSegment): SegmentIndexEntry {
	return {
		file: seg.rel,
		start: seg.firstTs ?? new Date(seg.startMs).toISOString(),
		end: seg.lastTs ?? new Date(seg.startMs).toISOString(),
		events: seg.events,
		bytes: seg.bytes,
		...appStatsIndexFields(seg.stats),
		...(seg.dropped > 0 ? { dropped: seg.dropped } : {}),
	};
}

/** Whether a non-empty file's last byte is not a newline (a torn final line). */
async function endsTorn(abs: string): Promise<boolean> {
	let handle: fs.FileHandle | null = null;
	try {
		handle = await fs.open(abs, 'r');
		const { size } = await handle.stat();
		if (size === 0) return false;
		const buf = Buffer.alloc(1);
		await handle.read(buf, 0, 1, size - 1);
		return buf[0] !== 0x0a;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw err;
	} finally {
		await handle?.close();
	}
}

/** Count what an existing segment file already holds. */
async function scanExisting(abs: string): Promise<{
	nextSeq: number;
	events: number;
	bytes: number;
	stats: AppStats;
	firstTs: string | null;
	lastTs: string | null;
	needsNewline: boolean;
} | null> {
	let text: string;
	try {
		text = await fs.readFile(abs, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	const events = parseSegmentText(text);
	const stats = createAppStats();
	let maxSeq = -1;
	for (const e of events) {
		addEventToAppStats(stats, e);
		if (typeof e.seq === 'number' && e.seq > maxSeq) maxSeq = e.seq;
	}
	return {
		nextSeq: maxSeq + 1,
		events: events.length,
		bytes: Buffer.byteLength(text, 'utf-8'),
		stats,
		firstTs: events[0]?.ts ?? null,
		lastTs: events[events.length - 1]?.ts ?? null,
		needsNewline: text.length > 0 && !text.endsWith('\n'),
	};
}

export class SegmentWriter {
	private readonly storeDir: string;
	private readonly queue: KeyedWriteQueue;
	private readonly now: () => number;
	private readonly onSegmentClosed?: SegmentWriterOptions['onSegmentClosed'];
	private readonly maxSegmentBytes: number;
	private current: OpenSegment | null = null;

	constructor(options: SegmentWriterOptions) {
		this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
		this.storeDir = options.storeDir;
		this.queue = options.queue;
		this.now = options.now ?? Date.now;
		this.onSegmentClosed = options.onSegmentClosed;
	}

	/** Index segment files a crash left without an index line. */
	async start(): Promise<number> {
		return this.queue.enqueue(SEGMENT_QUEUE_KEY, async () => {
			const indexed = new Set((await readIndex(this.storeDir)).map((e) => e.file));
			const openWindow = segmentStartMs(this.now());
			const days = await listDayFolders(this.storeDir);
			const recovered: SegmentIndexEntry[] = [];
			for (const rel of await listSegmentFilesIn(this.storeDir, days)) {
				if (indexed.has(rel)) continue;
				const startMs = parseSegmentRelativePath(rel);
				if (startMs === null || startMs >= openWindow) continue;
				const scan = await scanExisting(resolveStorePath(this.storeDir, rel));
				if (!scan || scan.events === 0) continue;
				recovered.push({
					file: rel,
					start: scan.firstTs ?? new Date(startMs).toISOString(),
					end: scan.lastTs ?? new Date(startMs).toISOString(),
					events: scan.events,
					bytes: scan.bytes,
					...appStatsIndexFields(scan.stats),
				});
			}
			if (recovered.length > 0) await this.appendIndexLines(recovered);
			return recovered.length;
		});
	}

	/**
	 * Append one event; assigns `seq` and rolls the segment over by window.
	 * Resolves null when the per-segment byte guard refused it.
	 */
	append(event: StoredEventInput): Promise<StoredEvent | null> {
		return this.queue.enqueue(SEGMENT_QUEUE_KEY, async () => {
			const parsed = Date.parse(event.ts);
			const window = segmentStartMs(Number.isNaN(parsed) ? this.now() : parsed);
			if (this.current && window > this.current.startMs) {
				await this.closeCurrent();
			}
			// An event older than the open window (clock skew, a slow helper) is
			// written to the open segment rather than reopening a closed one.
			if (!this.current) this.current = await this.open(window);
			const seg = this.current;
			const stored = { ...event, seq: seg.nextSeq } as StoredEvent;
			const body = `${JSON.stringify(stored)}\n`;
			const size = Buffer.byteLength(body, 'utf-8');
			const overSoft = seg.bytes + size > this.maxSegmentBytes;
			const overHard = seg.bytes + size > this.maxSegmentBytes * 2;
			if (overHard || (overSoft && stored.kind === 'content.snapshot')) {
				seg.dropped += 1;
				return null;
			}
			// A torn last line from a crash would swallow this event into one
			// unparseable line; terminate it first.
			const line = seg.needsNewline ? `\n${body}` : body;
			await fs.appendFile(seg.abs, line, { encoding: 'utf-8', mode: STORE_FILE_MODE });
			seg.needsNewline = false;
			seg.nextSeq += 1;
			seg.events += 1;
			seg.bytes += Buffer.byteLength(line, 'utf-8');
			addEventToAppStats(seg.stats, stored);
			if (!seg.firstTs) seg.firstTs = stored.ts;
			seg.lastTs = stored.ts;
			return stored;
		});
	}

	/** Close the open segment if its window has ended. Called on a timer. */
	closeIfExpired(): Promise<boolean> {
		return this.queue.enqueue(SEGMENT_QUEUE_KEY, async () => {
			if (!this.current) return false;
			if (this.now() < this.current.startMs + SEGMENT_MS + CLOSE_GRACE_MS) return false;
			await this.closeCurrent();
			return true;
		});
	}

	/** Close the open segment now (shutdown). */
	close(): Promise<void> {
		return this.queue.enqueue(SEGMENT_QUEUE_KEY, () => this.closeCurrent());
	}

	/** Run `fn` while no append or rollover can run (used by clear). */
	exclusive<T>(fn: () => Promise<T>): Promise<T> {
		return this.queue.enqueue(SEGMENT_QUEUE_KEY, fn);
	}

	/**
	 * Forget the open segment WITHOUT indexing it and return its path. Only
	 * call inside `exclusive()` (clear deletes the file right after).
	 */
	dropCurrentUnsafe(): string | null {
		const rel = this.current?.rel ?? null;
		this.current = null;
		return rel;
	}

	currentInfo(): { file: string; events: number } | null {
		return this.current ? { file: this.current.rel, events: this.current.events } : null;
	}

	private async open(startMs: number): Promise<OpenSegment> {
		const rel = segmentRelativePath(startMs);
		const abs = resolveStorePath(this.storeDir, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true, mode: STORE_DIR_MODE });
		const scan = await scanExisting(abs);
		return {
			startMs,
			rel,
			abs,
			nextSeq: scan?.nextSeq ?? 0,
			events: scan?.events ?? 0,
			bytes: scan?.bytes ?? 0,
			stats: scan?.stats ?? createAppStats(),
			firstTs: scan?.firstTs ?? null,
			lastTs: scan?.lastTs ?? null,
			needsNewline: scan?.needsNewline ?? false,
			dropped: 0,
		};
	}

	private async closeCurrent(): Promise<void> {
		const seg = this.current;
		this.current = null;
		if (!seg || (seg.events === 0 && seg.dropped === 0)) return;
		const entry = summarize(seg);
		await this.appendIndexLines([entry]);
		this.onSegmentClosed?.(entry, seg.startMs);
	}

	private appendIndexLines(entries: SegmentIndexEntry[]): Promise<void> {
		return this.queue.enqueue(INDEX_QUEUE_KEY, async () => {
			await fs.mkdir(this.storeDir, { recursive: true, mode: STORE_DIR_MODE });
			const indexAbs = resolveStorePath(this.storeDir, INDEX_FILE);
			const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
			// Same torn-tail rule as segments: never glue a line onto a partial one.
			const prefix = (await endsTorn(indexAbs)) ? '\n' : '';
			await fs.appendFile(indexAbs, prefix + text, { encoding: 'utf-8', mode: STORE_FILE_MODE });
		});
	}
}
