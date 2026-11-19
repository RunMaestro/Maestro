/**
 * Query history: the rules for what a SQLite database's history keeps.
 *
 * The history is kept in the main process, per database file
 * (src/main/sqlite/sqlite-query-history.ts), and recorded by the run itself
 * (`runSqliteQuery()`), so a statement run in the viewer's Query mode and one
 * run through `maestro-cli sqlite query` land in the same list. These are
 * the pure rules both the store and its readers share:
 *
 *   - A statement is one entry per text and mode: running it again moves it
 *     to the top with its latest parameter values and outcome, and counts
 *     the run. The text is kept exactly as it ran (only surrounding
 *     whitespace is trimmed), so two spellings of a query are two entries.
 *   - Only a run of the first window is a run: scrolling for the next
 *     window re-runs the statement but is not recorded.
 *   - A statement refused as not read-only never ran and is not recorded.
 *     A SQLite error, a timeout, and a Stop are recorded as failed, so a
 *     statement being fixed is still there to fix.
 *   - Each database keeps its newest `SQLITE_QUERY_HISTORY_MAX_ENTRIES`
 *     statements; the store keeps the `SQLITE_QUERY_HISTORY_MAX_FILES`
 *     databases used most recently.
 */

import { formatCount } from '../formatters';
import { sqliteQueryParameters } from './query';
import type {
	SqliteParameterValues,
	SqliteQueryHistoryEntry,
	SqliteQueryHistoryOutcome,
} from './types';

/** Statements one database's history keeps. */
export const SQLITE_QUERY_HISTORY_MAX_ENTRIES = 100;

/** Databases the store keeps a history for, the most recently used. */
export const SQLITE_QUERY_HISTORY_MAX_FILES = 200;

/** A statement longer than this is not recorded: a history row cannot show it, and it would bloat the store. */
export const SQLITE_QUERY_HISTORY_MAX_SQL_CHARS = 20_000;

/** A recorded error is cut to this many characters. */
export const SQLITE_QUERY_HISTORY_ERROR_CHARS = 500;

/** One run, as the store records it. */
export interface SqliteQueryHistoryRun {
	sql: string;
	plan: boolean;
	params: SqliteParameterValues;
	ranAt: number;
	outcome: SqliteQueryHistoryOutcome;
}

/** The store file's shape. */
export interface SqliteQueryHistoryStore {
	version: 1;
	/** Each database's history, keyed by its path. */
	files: Record<string, { usedAt: number; entries: SqliteQueryHistoryEntry[] }>;
}

/** An empty store. */
export function emptySqliteQueryHistoryStore(): SqliteQueryHistoryStore {
	return { version: 1, files: {} };
}

/** Whether a run is worth a history entry: some text, and not too long to keep. */
export function isRecordableSqliteQuery(sql: string): boolean {
	const text = sql.trim();
	return text.length > 0 && text.length <= SQLITE_QUERY_HISTORY_MAX_SQL_CHARS;
}

/** The values of the parameters `sql` holds, and no others. */
function paramsForStatement(sql: string, params: SqliteParameterValues): SqliteParameterValues {
	const kept: SqliteParameterValues = {};
	for (const { label } of sqliteQueryParameters(sql).parameters) {
		const value = Object.prototype.hasOwnProperty.call(params, label) ? params[label] : undefined;
		if (value) kept[label] = { type: value.type, text: value.text };
	}
	return kept;
}

/** An outcome as kept: an error cut to `SQLITE_QUERY_HISTORY_ERROR_CHARS`. */
function keptOutcome(outcome: SqliteQueryHistoryOutcome): SqliteQueryHistoryOutcome {
	if (outcome.ok || outcome.error.length <= SQLITE_QUERY_HISTORY_ERROR_CHARS) return outcome;
	return { ok: false, error: `${outcome.error.slice(0, SQLITE_QUERY_HISTORY_ERROR_CHARS - 3)}...` };
}

/**
 * The history after `run`: its entry (the same text and mode as an earlier
 * one, or a new one named by `newId()`) at the top, the rest after it in
 * their order, cut to `SQLITE_QUERY_HISTORY_MAX_ENTRIES`.
 */
export function addSqliteQueryHistoryRun(
	entries: readonly SqliteQueryHistoryEntry[],
	run: SqliteQueryHistoryRun,
	newId: () => string
): SqliteQueryHistoryEntry[] {
	const sql = run.sql.trim();
	const earlier = entries.find((entry) => entry.sql === sql && entry.plan === run.plan);
	const entry: SqliteQueryHistoryEntry = {
		id: earlier?.id ?? newId(),
		sql,
		plan: run.plan,
		params: paramsForStatement(sql, run.params),
		ranAt: run.ranAt,
		runs: (earlier?.runs ?? 0) + 1,
		outcome: keptOutcome(run.outcome),
	};
	return [entry, ...entries.filter((other) => other !== earlier)].slice(
		0,
		SQLITE_QUERY_HISTORY_MAX_ENTRIES
	);
}

/** The store with only its `SQLITE_QUERY_HISTORY_MAX_FILES` most recently used databases. */
export function pruneSqliteQueryHistoryStore(
	store: SqliteQueryHistoryStore
): SqliteQueryHistoryStore {
	const paths = Object.keys(store.files);
	if (paths.length <= SQLITE_QUERY_HISTORY_MAX_FILES) return store;
	const kept = paths
		.sort((a, b) => store.files[b].usedAt - store.files[a].usedAt)
		.slice(0, SQLITE_QUERY_HISTORY_MAX_FILES);
	return { version: 1, files: Object.fromEntries(kept.map((path) => [path, store.files[path]])) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseParams(value: unknown): SqliteParameterValues | null {
	if (!isRecord(value)) return null;
	const params: SqliteParameterValues = {};
	for (const [label, raw] of Object.entries(value)) {
		// Every label starts with its sigil, so `__proto__` is never one.
		if (!/^[?:@$#]/.test(label)) return null;
		if (!isRecord(raw) || typeof raw.text !== 'string') return null;
		if (raw.type !== 'text' && raw.type !== 'number' && raw.type !== 'null') return null;
		params[label] = { type: raw.type, text: raw.text };
	}
	return params;
}

function parseOutcome(value: unknown): SqliteQueryHistoryOutcome | null {
	if (!isRecord(value)) return null;
	if (value.ok === false) {
		return typeof value.error === 'string' ? { ok: false, error: value.error } : null;
	}
	if (
		value.ok !== true ||
		typeof value.rows !== 'number' ||
		typeof value.hasMore !== 'boolean' ||
		typeof value.returnsRows !== 'boolean' ||
		typeof value.elapsedMs !== 'number'
	) {
		return null;
	}
	return {
		ok: true,
		rows: value.rows,
		hasMore: value.hasMore,
		returnsRows: value.returnsRows,
		elapsedMs: value.elapsedMs,
		...(typeof value.changes === 'number' ? { changes: value.changes } : {}),
	};
}

function parseEntry(value: unknown): SqliteQueryHistoryEntry | null {
	if (!isRecord(value)) return null;
	const params = parseParams(value.params);
	const outcome = parseOutcome(value.outcome);
	if (
		typeof value.id !== 'string' ||
		typeof value.sql !== 'string' ||
		typeof value.plan !== 'boolean' ||
		typeof value.ranAt !== 'number' ||
		typeof value.runs !== 'number' ||
		!params ||
		!outcome
	) {
		return null;
	}
	return {
		id: value.id,
		sql: value.sql,
		plan: value.plan,
		params,
		ranAt: value.ranAt,
		runs: value.runs,
		outcome,
	};
}

/**
 * A parsed store file as a store. An entry that does not have the shape is
 * dropped and the rest kept, so one bad record (a hand edit, an older
 * build's shape) never costs a database its whole history. Anything that is
 * not a store at all reads as an empty one.
 */
export function parseSqliteQueryHistoryStore(value: unknown): SqliteQueryHistoryStore {
	const store = emptySqliteQueryHistoryStore();
	if (!isRecord(value) || !isRecord(value.files)) return store;
	for (const [path, file] of Object.entries(value.files)) {
		if (!isRecord(file) || !Array.isArray(file.entries)) continue;
		const entries = file.entries
			.map(parseEntry)
			.filter((entry): entry is SqliteQueryHistoryEntry => entry !== null)
			.slice(0, SQLITE_QUERY_HISTORY_MAX_ENTRIES);
		if (entries.length === 0) continue;
		const usedAt = typeof file.usedAt === 'number' ? file.usedAt : entries[0].ranAt;
		store.files[path] = { usedAt, entries };
	}
	return store;
}

/** How an entry last ended, in a few words: `12 rows`, `500+ rows`, `no rows`, `changed 3 rows`, `failed`. */
export function formatSqliteQueryHistoryOutcome(outcome: SqliteQueryHistoryOutcome): string {
	if (!outcome.ok) return 'failed';
	if (outcome.changes !== undefined) {
		// A schema change (CREATE, DROP, ALTER) changes no rows.
		if (outcome.changes === 0) return 'changed no rows';
		return `changed ${formatCount(outcome.changes)} ${outcome.changes === 1 ? 'row' : 'rows'}`;
	}
	if (!outcome.returnsRows) return 'returns no rows';
	if (outcome.rows === 0) return 'no rows';
	const count = `${formatCount(outcome.rows)}${outcome.hasMore ? '+' : ''}`;
	return `${count} ${outcome.rows === 1 && !outcome.hasMore ? 'row' : 'rows'}`;
}

/** A statement on one line, for a list row: whitespace and line breaks collapsed to single spaces. */
export function sqliteQueryHistoryLine(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}
