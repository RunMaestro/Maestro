/**
 * Read-only access to an agent's history (`<userData>/history/<agentId>.jsonl`).
 *
 * The desktop's `HistoryManager` owns these files: it appends, rotates, and
 * migrates a legacy `<agentId>.json` to JSONL on first touch. A second process
 * doing any of that would race those writes, so this reader only reads - the
 * same rule `maestro-cli` follows (`src/cli/services/storage.ts`). When only
 * the legacy file exists it is read in place and left for the desktop to
 * migrate.
 *
 * Parsing is the desktop's own (`src/shared/history.ts`), so the two cannot
 * disagree about what a file holds:
 *
 *   - JSONL skips an unparseable line rather than failing the read. A torn
 *     LAST line is the expected cost of an append interrupted by a crash, and
 *     it costs exactly that one entry. `malformedLines` reports the count.
 *   - Legacy cross-agent consults written as AUTO come back as AGENT, the same
 *     normalization `HistoryManager.getEntries` applies.
 *
 * Like the store readers, nothing here throws: a missing, unreadable, or
 * corrupt file is a result the caller can show.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

import {
	HISTORY_JSONL_EXT,
	HISTORY_LEGACY_JSON_EXT,
	normalizeHistoryEntries,
	parseHistoryFileData,
	parseHistoryJsonl,
	sanitizeSessionId,
} from '../../history';
import { stripJsonBom } from '../../jsonUtils';
import type { HistoryEntry } from '../../types';
import type { MaestroPaths } from '../paths/resolve';

export type { HistoryEntry, HistoryEntryType } from '../../types';

/** Which on-disk format a history read came from. */
export type HistoryFileFormat = 'jsonl' | 'legacy-json';

/** One page of an agent's history, newest first. */
export interface HistoryPage {
	/** Entries on this page, newest first. */
	entries: HistoryEntry[];
	/** Every entry the file holds, before paging. */
	total: number;
	/** True when entries older than this page remain. */
	hasMore: boolean;
	/**
	 * Pass as `before` to read the next (older) page. Undefined on an empty
	 * page.
	 */
	nextBefore?: number;
	/** Non-empty lines that did not parse as an entry (JSONL only). */
	malformedLines: number;
}

/**
 * The outcome of reading one agent's history.
 *
 * - `ok`: read. An agent that has never had a turn has no file, and comes back
 *   as `missing`, not as an empty `ok`.
 * - `corrupt`: a legacy `.json` file that is not JSON. JSONL is never corrupt
 *   as a whole: a bad line costs one entry and is counted in `malformedLines`.
 * - `unreadable`: the read itself failed.
 */
export type HistoryReadResult =
	| ({ status: 'ok'; file: string; format: HistoryFileFormat } & HistoryPage)
	| { status: 'missing'; file: string }
	| { status: 'corrupt'; file: string; reason: string }
	| { status: 'unreadable'; file: string; reason: string; code?: string };

export interface ReadHistoryOptions {
	/** Maximum entries per page. Default 200. A page can run longer; see `before`. */
	limit?: number;
	/**
	 * Only entries strictly older than this timestamp (ms). Pass the previous
	 * page's `nextBefore` to page backward.
	 *
	 * A page never ends partway through a run of entries that share a
	 * timestamp: it grows to include the whole run. Without that, a cursor of
	 * "older than the last timestamp shown" would silently skip the rest of the
	 * run, and Cue fan-outs routinely write several entries in one millisecond.
	 */
	before?: number;
}

/** The page size a history view reads by default. */
export const DEFAULT_HISTORY_PAGE_SIZE = 200;

/** Path to an agent's JSONL history file. */
export function historyFilePath(historyDir: string, agentId: string): string {
	return path.join(historyDir, `${sanitizeSessionId(agentId)}${HISTORY_JSONL_EXT}`);
}

/** Path to an agent's legacy single-object history file. */
export function legacyHistoryFilePath(historyDir: string, agentId: string): string {
	return path.join(historyDir, `${sanitizeSessionId(agentId)}${HISTORY_LEGACY_JSON_EXT}`);
}

type FileRead =
	| { ok: true; content: string }
	| { ok: false; missing: boolean; error: NodeJS.ErrnoException };

function readText(file: string): FileRead {
	try {
		return { ok: true, content: fs.readFileSync(file, 'utf-8') };
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		return { ok: false, missing: err.code === 'ENOENT', error: err };
	}
}

/**
 * Newest first by timestamp. Sorted rather than reversed because the file is
 * in APPEND order, and a turn is appended when it finishes, not when it
 * started; a `before` cursor is only coherent over a timestamp order. The sort
 * is stable, so entries sharing a timestamp keep newest-appended first.
 */
function newestFirst(fileOrder: HistoryEntry[]): HistoryEntry[] {
	return fileOrder
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => b.entry.timestamp - a.entry.timestamp || b.index - a.index)
		.map(({ entry }) => entry);
}

/**
 * Slice one page out of a newest-first list. Exported for callers that hold
 * entries already (a fixture, a merged view across hosts).
 */
export function pageHistoryEntries(
	sorted: HistoryEntry[],
	options: ReadHistoryOptions = {},
	malformedLines = 0
): HistoryPage {
	const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_HISTORY_PAGE_SIZE));
	const { before } = options;
	const start = before === undefined ? 0 : sorted.findIndex((entry) => entry.timestamp < before);
	if (start === -1) {
		return { entries: [], total: sorted.length, hasMore: false, malformedLines };
	}

	let end = Math.min(start + limit, sorted.length);
	while (end < sorted.length && sorted[end].timestamp === sorted[end - 1].timestamp) end++;

	const entries = sorted.slice(start, end);
	return {
		entries,
		total: sorted.length,
		hasMore: end < sorted.length,
		nextBefore: entries.length > 0 ? entries[entries.length - 1].timestamp : undefined,
		malformedLines,
	};
}

/**
 * Read one page of an agent's history, newest first.
 *
 * `agentId` is the Maestro agent id (the `Session.id`), which is what the
 * desktop names the file after - not a provider session id.
 */
export function readHistory(
	paths: Pick<MaestroPaths, 'historyDir'>,
	agentId: string,
	options: ReadHistoryOptions = {}
): HistoryReadResult {
	const jsonlFile = historyFilePath(paths.historyDir, agentId);
	const jsonl = readText(jsonlFile);
	if (jsonl.ok) {
		const { entries, malformedLines } = parseHistoryJsonl(stripJsonBom(jsonl.content));
		const sorted = newestFirst(normalizeHistoryEntries(entries));
		return {
			status: 'ok',
			file: jsonlFile,
			format: 'jsonl',
			...pageHistoryEntries(sorted, options, malformedLines),
		};
	}
	if (!jsonl.missing) {
		return {
			status: 'unreadable',
			file: jsonlFile,
			reason: jsonl.error.message,
			code: jsonl.error.code,
		};
	}

	// No JSONL yet: the agent is new, or still on the legacy format the desktop
	// migrates on its next write. Read the legacy file where it lies.
	const legacyFile = legacyHistoryFilePath(paths.historyDir, agentId);
	const legacy = readText(legacyFile);
	if (!legacy.ok) {
		if (legacy.missing) return { status: 'missing', file: jsonlFile };
		return {
			status: 'unreadable',
			file: legacyFile,
			reason: legacy.error.message,
			code: legacy.error.code,
		};
	}

	let document: unknown;
	try {
		document = parseHistoryFileData(legacy.content).data;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return { status: 'corrupt', file: legacyFile, reason: error.message };
	}
	if (typeof document !== 'object' || document === null || Array.isArray(document)) {
		return { status: 'corrupt', file: legacyFile, reason: 'the document is not a JSON object' };
	}
	const legacyEntries = (document as { entries?: unknown }).entries;
	if (legacyEntries !== undefined && !Array.isArray(legacyEntries)) {
		return { status: 'corrupt', file: legacyFile, reason: '"entries" is not an array' };
	}
	const entries = (legacyEntries ?? []).filter(
		(entry): entry is HistoryEntry =>
			typeof entry === 'object' && entry !== null && typeof (entry as HistoryEntry).id === 'string'
	);
	// Legacy files are newest-first; `newestFirst` wants append order.
	const sorted = newestFirst(normalizeHistoryEntries([...entries].reverse()));
	return {
		status: 'ok',
		file: legacyFile,
		format: 'legacy-json',
		...pageHistoryEntries(sorted, options, 0),
	};
}

/** Bytes read per step when `readRecentHistory` walks a file back from its end. */
const RECENT_CHUNK_BYTES = 256 * 1024;

/** Most bytes `readRecentHistory` reads; a window that reaches further keeps what it found. */
const RECENT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * How far file order may trail timestamp order. An entry is appended when its
 * turn finishes, so an entry older than the window can sit after one inside
 * it; the walk reads this far past the window before it stops.
 */
const RECENT_ORDER_SLACK_MS = 60 * 60 * 1000;

export interface RecentHistoryOptions {
	/** Only entries at or after this time (epoch ms). */
	sinceMs: number;
	/** Only entries at or before this time (epoch ms). */
	untilMs?: number;
	/** Only the newest N entries in the window. */
	limit?: number;
}

/**
 * An agent's entries inside a time window, OLDEST first, read from the end of
 * the JSONL file backward so a recent window costs a few chunks rather than
 * the whole file (busy agents carry several MB of history). A legacy
 * single-object file is read whole. Never throws: an unreadable file reads as
 * no entries.
 */
export async function readRecentHistory(
	paths: Pick<MaestroPaths, 'historyDir'>,
	agentId: string,
	options: RecentHistoryOptions
): Promise<HistoryEntry[]> {
	const { sinceMs, untilMs, limit } = options;
	const inWindow = (entry: HistoryEntry) =>
		entry.timestamp >= sinceMs && (untilMs === undefined || entry.timestamp <= untilMs);
	const finish = (entries: HistoryEntry[]) => {
		const sorted = entries.filter(inWindow).sort((a, b) => a.timestamp - b.timestamp);
		return limit !== undefined ? sorted.slice(-Math.max(0, limit)) : sorted;
	};

	let handle: fsp.FileHandle;
	try {
		handle = await fsp.open(historyFilePath(paths.historyDir, agentId), 'r');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return [];
		const legacy = readHistory(paths, agentId, { limit: Number.MAX_SAFE_INTEGER });
		return legacy.status === 'ok' ? finish(legacy.entries) : [];
	}

	try {
		const { size } = await handle.stat();
		const entries: HistoryEntry[] = [];
		let start = size;
		// Bytes before the first complete line read so far: a partial line.
		let carry: Buffer = Buffer.alloc(0);
		while (start > 0 && size - start < RECENT_MAX_BYTES) {
			const next = Math.max(0, start - RECENT_CHUNK_BYTES);
			const chunk = Buffer.alloc(start - next);
			await handle.read(chunk, 0, chunk.length, next);
			start = next;
			const buffer = Buffer.concat([chunk, carry]);
			const firstBreak = start > 0 ? buffer.indexOf(0x0a) : -1;
			if (start > 0 && firstBreak === -1) {
				carry = buffer;
				continue;
			}
			const lines = buffer.subarray(firstBreak + 1).toString('utf-8');
			carry = buffer.subarray(0, firstBreak + 1);
			const parsed = normalizeHistoryEntries(
				parseHistoryJsonl(start === 0 ? stripJsonBom(lines) : lines).entries
			);
			entries.unshift(...parsed);

			// Stop once the chunk reaches past the window (or past the newest
			// `limit` entries in it) by more than the order slack.
			const matched = entries.filter(inWindow).map((e) => e.timestamp);
			let floor = sinceMs;
			if (limit !== undefined && matched.length >= limit) {
				floor = Math.max(floor, matched.sort((a, b) => b - a)[Math.max(0, limit - 1)]);
			}
			const oldestInChunk = Math.min(...parsed.map((e) => e.timestamp));
			if (parsed.length > 0 && oldestInChunk < floor - RECENT_ORDER_SLACK_MS) break;
		}
		return finish(entries);
	} catch {
		return [];
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** A history entry found by id, with the agent whose file holds it. */
export interface FoundHistoryEntry {
	agentId: string;
	entry: HistoryEntry;
}

/**
 * The entries whose id starts with `idPrefix`, across `agentIds`. A JSONL file
 * is parsed only when its raw text contains the prefix, and then only the
 * lines that do, so looking up one entry across every agent costs a read, not
 * a parse, per file. A legacy single-object file is read whole. Never throws:
 * an unreadable file holds no matches.
 */
export async function findHistoryEntries(
	paths: Pick<MaestroPaths, 'historyDir'>,
	agentIds: readonly string[],
	idPrefix: string
): Promise<FoundHistoryEntry[]> {
	const found: FoundHistoryEntry[] = [];
	if (!idPrefix) return found;
	for (const agentId of agentIds) {
		let raw: string;
		try {
			raw = await fsp.readFile(historyFilePath(paths.historyDir, agentId), 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
			const legacy = readHistory(paths, agentId, { limit: Number.MAX_SAFE_INTEGER });
			if (legacy.status !== 'ok') continue;
			for (const entry of legacy.entries) {
				if (entry.id.startsWith(idPrefix)) found.push({ agentId, entry });
			}
			continue;
		}
		if (!raw.includes(idPrefix)) continue;
		const lines = raw
			.split('\n')
			.filter((line) => line.includes(idPrefix))
			.join('\n');
		for (const entry of normalizeHistoryEntries(parseHistoryJsonl(stripJsonBom(lines)).entries)) {
			if (entry.id.startsWith(idPrefix)) found.push({ agentId, entry });
		}
	}
	return found;
}
