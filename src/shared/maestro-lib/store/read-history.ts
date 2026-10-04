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
