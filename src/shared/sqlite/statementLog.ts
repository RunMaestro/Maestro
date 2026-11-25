/**
 * Statement log: the rules for what a SQLite database's write log keeps.
 *
 * The query history (history.ts) answers "what have I run here", one entry
 * per statement, reads included, re-runs merged. The statement log answers
 * "what did I just do to this database": every write that reached the file,
 * in the order it ran, never merged, whichever path made it.
 *
 *   - The table view's cell edit, insert, delete, and Undo, and their CLI
 *     verbs (`sqlite set` / `insert` / `delete` / `undo`), log the
 *     single-row statement they ran, spelled as a person would type it with
 *     the values written in (`sqliteRowWriteStatement()`); the statement
 *     main actually prepares binds its values and checks the row's version,
 *     which says nothing to a reader.
 *   - A Query-mode write (`sqlite query --enable-editing`) logs its text and
 *     parameter values as it ran.
 *   - An explicit transaction logs its `BEGIN IMMEDIATE`, each write run in
 *     it under its `transactionId`, and how it ended (`COMMIT`, or `ROLLBACK`
 *     with the reason: Roll back, Lock, idle, a stopped statement...). A
 *     write inside a transaction that was rolled back is in the log and NOT
 *     in the file; `sqliteStatementLogStanding()` says which.
 *   - A write SQLite refused, that found its row changed since it was read,
 *     or that was stopped once it reached the file is logged as failed:
 *     nothing changed, but it was tried. A write refused before it reached
 *     the file (no grant, a table that cannot be edited, the backup, another
 *     tab's transaction holding the lock) never ran and is not.
 *   - A dry run is not a write and is never logged.
 *
 * The log is kept by the main process, per database file
 * (src/main/sqlite/sqlite-statement-log.ts), recorded by each write path
 * itself, so the viewer and the CLI read the same list. These are the pure
 * rules the store and its readers share.
 */

import { formatCount } from '../formatters';
import { sqliteWriteChangesText } from './dryRun';
import { parseSqliteParameterValues } from './history';
import { sqliteIdentifierForSql } from './sql';
import type {
	SqliteKeyValue,
	SqliteParameterValue,
	SqliteRowKey,
	SqliteSchemaChange,
	SqliteStatementLogEntry,
	SqliteStatementLogKind,
	SqliteStatementLogOutcome,
} from './types';

/**
 * Pushed from main to every window when a database's statement log changes (a
 * write recorded, the log cleared), with the database's path, so an open Log
 * reads again whoever made the write: another tab, another window, the CLI.
 */
export const SQLITE_STATEMENT_LOGGED_CHANNEL = 'sqlite:statementLogged';

/** Writes one database's log keeps, the newest. */
export const SQLITE_STATEMENT_LOG_MAX_ENTRIES = 500;

/** Databases the store keeps a log for, the most recently written. */
export const SQLITE_STATEMENT_LOG_MAX_FILES = 200;

/**
 * A statement longer than this is kept cut, with a note saying so. Unlike
 * the history, the log never skips a write for its length: a missing write
 * would make the log lie about what was done.
 */
export const SQLITE_STATEMENT_LOG_MAX_SQL_CHARS = 20_000;

/** A recorded error is cut to this many characters. */
export const SQLITE_STATEMENT_LOG_ERROR_CHARS = 500;

/** A value written into a row write's statement is cut past this many characters. */
export const SQLITE_STATEMENT_LOG_VALUE_CHARS = 200;

/** Every kind of entry, in the order a reader meets them. */
export const SQLITE_STATEMENT_LOG_KINDS: readonly SqliteStatementLogKind[] = [
	'cell',
	'insert',
	'delete',
	'undo',
	'query',
	'begin',
	'commit',
	'rollback',
];

/** A short name for each kind, for a badge or a CLI column. */
export const SQLITE_STATEMENT_LOG_KIND_LABELS: Record<SqliteStatementLogKind, string> = {
	cell: 'cell edit',
	insert: 'insert',
	delete: 'delete',
	undo: 'undo',
	query: 'query',
	begin: 'begin',
	commit: 'commit',
	rollback: 'rollback',
};

/** One entry, as a write path hands it to the store: the store names it. */
export type SqliteStatementLogRecord = Omit<SqliteStatementLogEntry, 'id'>;

/** The store file's shape. */
export interface SqliteStatementLogStore {
	version: 1;
	/** Each database's log, keyed by its path. */
	files: Record<string, { usedAt: number; entries: SqliteStatementLogEntry[] }>;
}

/** An empty store. */
export function emptySqliteStatementLogStore(): SqliteStatementLogStore {
	return { version: 1, files: {} };
}

/**
 * A parameter's value as one line of a listing: `NULL`, `"text"`, or
 * `"42" (number)`. Shared by the Log's detail and `maestro-cli sqlite log` /
 * `sqlite history`.
 */
export function formatSqliteParameterValue(value: SqliteParameterValue): string {
	if (value.type === 'null') return 'NULL';
	return `${JSON.stringify(value.text)}${value.type === 'number' ? ' (number)' : ''}`;
}

/** A value a row write's statement holds: a person's typed value, or one stored whole. */
export type SqliteLogValue = SqliteKeyValue | SqliteParameterValue;

function cutText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/**
 * A value as SQL text: `NULL`, a number as written, `'text'` with its quotes
 * doubled, `X'hex'` for a BLOB. A value past
 * `SQLITE_STATEMENT_LOG_VALUE_CHARS` is cut, and a comment says how long it
 * was, so the line stays readable and the store stays small.
 */
export function sqliteLogLiteral(value: SqliteLogValue): string {
	if (value === null || value.type === 'null') return 'NULL';
	if (value.type === 'integer' || value.type === 'real' || value.type === 'number') {
		return value.text.trim();
	}
	const max = SQLITE_STATEMENT_LOG_VALUE_CHARS;
	if (value.type === 'blob') {
		const bytes = value.text.length / 2;
		if (value.text.length <= max) return `X'${value.text}'`;
		return `X'${value.text.slice(0, max)}...' /* ${formatCount(bytes)} bytes, cut */`;
	}
	if (value.text.length <= max) return `'${value.text.replace(/'/g, "''")}'`;
	return `'${value.text.slice(0, max).replace(/'/g, "''")}...' /* ${formatCount(value.text.length)} characters, cut */`;
}

/** The `WHERE` that names one row, as a person would write it: `rowid = 7`, `a = 1 AND b = 'x'`. */
export function sqliteRowKeyText(row: SqliteRowKey): string {
	if (row.kind === 'rowid') return `rowid = ${row.rowid}`;
	const terms = Object.entries(row.values).map(([column, value]) =>
		value === null
			? `${sqliteIdentifierForSql(column)} IS NULL`
			: `${sqliteIdentifierForSql(column)} = ${sqliteLogLiteral(value)}`
	);
	return terms.length > 0 ? terms.join(' AND ') : 'false';
}

/** One single-row write, as the table view (or its CLI verb) makes it. */
export type SqliteRowWrite =
	| { kind: 'cell'; table: string; column: string; row: SqliteRowKey; value: SqliteLogValue }
	| {
			kind: 'insert';
			table: string;
			values: Record<string, SqliteLogValue>;
			/** The rowid an undo puts a deleted row back under, when the table has no INTEGER PRIMARY KEY. */
			rowid?: string | null;
	  }
	| { kind: 'delete'; table: string; row: SqliteRowKey };

/**
 * A single-row write as a statement a person could read and type:
 *
 *   UPDATE users SET name = 'Bob' WHERE id = 3
 *   INSERT INTO users (name, age) VALUES ('Bob', 30)
 *   DELETE FROM users WHERE rowid = 7
 *
 * What main prepares binds each value and checks the row's version in the
 * same `WHERE`; this is what the write did, not how it was guarded.
 */
export function sqliteRowWriteStatement(write: SqliteRowWrite): string {
	const table = sqliteIdentifierForSql(write.table);
	switch (write.kind) {
		case 'cell':
			return `UPDATE ${table} SET ${sqliteIdentifierForSql(write.column)} = ${sqliteLogLiteral(write.value)} WHERE ${sqliteRowKeyText(write.row)}`;
		case 'insert': {
			const columns = [
				...(write.rowid != null ? [['rowid', write.rowid] as const] : []),
				...Object.entries(write.values).map(
					([column, value]) => [sqliteIdentifierForSql(column), sqliteLogLiteral(value)] as const
				),
			];
			if (columns.length === 0) return `INSERT INTO ${table} DEFAULT VALUES`;
			return `INSERT INTO ${table} (${columns.map(([name]) => name).join(', ')}) VALUES (${columns.map(([, value]) => value).join(', ')})`;
		}
		case 'delete':
			return `DELETE FROM ${table} WHERE ${sqliteRowKeyText(write.row)}`;
	}
}

/** An entry as the store keeps it: its statement and error cut to their limits. */
function keptEntry(entry: SqliteStatementLogEntry): SqliteStatementLogEntry {
	const sql = entry.sql.trim();
	const kept: SqliteStatementLogEntry = {
		...entry,
		sql:
			sql.length <= SQLITE_STATEMENT_LOG_MAX_SQL_CHARS
				? sql
				: `${sql.slice(0, SQLITE_STATEMENT_LOG_MAX_SQL_CHARS)}\n/* cut: the statement was ${formatCount(sql.length)} characters */`,
	};
	if (!entry.outcome.ok) {
		kept.outcome = {
			ok: false,
			error: cutText(entry.outcome.error, SQLITE_STATEMENT_LOG_ERROR_CHARS),
		};
	}
	return kept;
}

/** The log after `entry`: it on top, the rest after it, cut to `SQLITE_STATEMENT_LOG_MAX_ENTRIES`. */
export function addSqliteStatementLogEntry(
	entries: readonly SqliteStatementLogEntry[],
	entry: SqliteStatementLogEntry
): SqliteStatementLogEntry[] {
	return [keptEntry(entry), ...entries].slice(0, SQLITE_STATEMENT_LOG_MAX_ENTRIES);
}

/** The store with only its `SQLITE_STATEMENT_LOG_MAX_FILES` most recently written databases. */
export function pruneSqliteStatementLogStore(
	store: SqliteStatementLogStore
): SqliteStatementLogStore {
	const paths = Object.keys(store.files);
	if (paths.length <= SQLITE_STATEMENT_LOG_MAX_FILES) return store;
	const kept = paths
		.sort((a, b) => store.files[b].usedAt - store.files[a].usedAt)
		.slice(0, SQLITE_STATEMENT_LOG_MAX_FILES);
	return { version: 1, files: Object.fromEntries(kept.map((path) => [path, store.files[path]])) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSchemaChanges(value: unknown): SqliteSchemaChange[] | null {
	if (!Array.isArray(value)) return null;
	const changes: SqliteSchemaChange[] = [];
	for (const raw of value) {
		if (!isRecord(raw) || typeof raw.type !== 'string' || typeof raw.name !== 'string') return null;
		if (raw.change !== 'created' && raw.change !== 'dropped' && raw.change !== 'altered')
			return null;
		changes.push({ change: raw.change, type: raw.type, name: raw.name });
	}
	return changes;
}

function parseOutcome(value: unknown): SqliteStatementLogOutcome | null {
	if (!isRecord(value)) return null;
	if (value.ok === false) {
		return typeof value.error === 'string' ? { ok: false, error: value.error } : null;
	}
	const schemaChanges = parseSchemaChanges(value.schemaChanges);
	if (
		value.ok !== true ||
		typeof value.changes !== 'number' ||
		typeof value.otherChanges !== 'number' ||
		!schemaChanges
	) {
		return null;
	}
	return { ok: true, changes: value.changes, otherChanges: value.otherChanges, schemaChanges };
}

function parseEntry(value: unknown): SqliteStatementLogEntry | null {
	if (!isRecord(value)) return null;
	const params = parseSqliteParameterValues(value.params);
	const outcome = parseOutcome(value.outcome);
	if (
		typeof value.id !== 'string' ||
		!SQLITE_STATEMENT_LOG_KINDS.includes(value.kind as SqliteStatementLogKind) ||
		typeof value.sql !== 'string' ||
		(value.table !== null && typeof value.table !== 'string') ||
		(value.transactionId !== null && typeof value.transactionId !== 'string') ||
		typeof value.at !== 'number' ||
		!params ||
		!outcome
	) {
		return null;
	}
	return {
		id: value.id,
		kind: value.kind as SqliteStatementLogKind,
		sql: value.sql,
		params,
		table: value.table as string | null,
		transactionId: value.transactionId as string | null,
		at: value.at,
		outcome,
		...(typeof value.note === 'string' ? { note: value.note } : {}),
		...(typeof value.backupPath === 'string' ? { backupPath: value.backupPath } : {}),
	};
}

/**
 * A parsed store file as a store. An entry that does not have the shape is
 * dropped and the rest kept, so one bad record never costs a database its
 * whole log. Anything that is not a store at all reads as an empty one.
 */
export function parseSqliteStatementLogStore(value: unknown): SqliteStatementLogStore {
	const store = emptySqliteStatementLogStore();
	if (!isRecord(value) || !isRecord(value.files)) return store;
	for (const [path, file] of Object.entries(value.files)) {
		if (!isRecord(file) || !Array.isArray(file.entries)) continue;
		const entries = file.entries
			.map(parseEntry)
			.filter((entry): entry is SqliteStatementLogEntry => entry !== null)
			.slice(0, SQLITE_STATEMENT_LOG_MAX_ENTRIES);
		if (entries.length === 0) continue;
		const usedAt = typeof file.usedAt === 'number' ? file.usedAt : entries[0].at;
		store.files[path] = { usedAt, entries };
	}
	return store;
}

/**
 * Where a logged write stands in the file now:
 *
 *   - `in-file`: it changed the file (or, for a transaction's end, ended it).
 *   - `rolled-back`: it ran inside a transaction that was rolled back, so
 *     nothing it did is in the file.
 *   - `uncommitted`: it ran inside a transaction the log has no end for yet
 *     (still open, or the app stopped before it ended, which rolls it back).
 *   - `failed`: SQLite refused it, or it was stopped; nothing changed.
 */
export type SqliteStatementLogStanding = 'in-file' | 'rolled-back' | 'uncommitted' | 'failed';

/** Each logged transaction's end, by id: `commit` once committed, `rollback` once rolled back. */
export function sqliteStatementLogTransactionEnds(
	entries: readonly SqliteStatementLogEntry[]
): Map<string, 'commit' | 'rollback'> {
	const ends = new Map<string, 'commit' | 'rollback'>();
	for (const entry of entries) {
		if (!entry.transactionId || !entry.outcome.ok) continue;
		if (entry.kind === 'commit' || entry.kind === 'rollback')
			ends.set(entry.transactionId, entry.kind);
	}
	return ends;
}

/** Where `entry` stands, given its log's transaction ends (`sqliteStatementLogTransactionEnds()`). */
export function sqliteStatementLogStanding(
	entry: SqliteStatementLogEntry,
	ends: ReadonlyMap<string, 'commit' | 'rollback'>
): SqliteStatementLogStanding {
	if (!entry.outcome.ok) return 'failed';
	if (entry.kind === 'begin' || entry.kind === 'commit' || entry.kind === 'rollback') {
		return 'in-file';
	}
	if (!entry.transactionId) return 'in-file';
	const end = ends.get(entry.transactionId);
	if (end === 'commit') return 'in-file';
	return end === 'rollback' ? 'rolled-back' : 'uncommitted';
}

/**
 * What a logged write did, in a few words: "changed 1 row", "changed 3 rows
 * (+2 by triggers)", "created table logs", "began a transaction", "committed
 * 2 statements' changes", "rolled back", "failed". Shared by the viewer's Log
 * and `maestro-cli sqlite log`.
 */
export function formatSqliteStatementLogOutcome(entry: SqliteStatementLogEntry): string {
	const { outcome } = entry;
	if (!outcome.ok) return 'failed';
	switch (entry.kind) {
		case 'begin':
			return 'began a transaction';
		case 'rollback':
			return 'rolled back';
		case 'commit':
			return `committed: ${sqliteWriteChangesText(outcome)}`;
		default: {
			const others =
				outcome.otherChanges > 0 ? ` (+${formatCount(outcome.otherChanges)} by triggers)` : '';
			return `${sqliteWriteChangesText(outcome)}${others}`;
		}
	}
}

/** A standing as words a reader needs: empty for an ordinary write that is in the file. */
export function sqliteStatementLogStandingText(standing: SqliteStatementLogStanding): string {
	switch (standing) {
		case 'rolled-back':
			return 'rolled back, not in the file';
		case 'uncommitted':
			return 'in a transaction, not committed';
		default:
			return '';
	}
}
