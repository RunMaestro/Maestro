/**
 * SQLite Converging Row Count
 *
 * How many rows a table or view has, or how many a filter matches, for the
 * table view's footer. The answer converges: `1,204+` while counting, then
 * `1,204,331` once every row has been walked. It is the Parquet viewer's
 * converging count, for the same reason: an exact count of a huge table costs
 * time proportional to the table, and better-sqlite3 is synchronous, so one
 * `SELECT COUNT(*)` would hold the main process (and every window in the app)
 * until SQLite finished.
 *
 * So a count is a walk in bounded chunks:
 *
 *   - **One chunk is one statement over at most `SQLITE_COUNT_CHUNK_ROWS`
 *     rows.** The chunk bounds rows WALKED, not rows matched: the filter is
 *     evaluated per row inside the chunk (`CASE WHEN <where> THEN 1`), so a
 *     filter that matches nothing still advances a chunk at a time instead of
 *     scanning the whole table for its first match.
 *   - **One call runs chunks until its time budget is spent** and returns a
 *     cursor. The caller asks again with it, so the event loop runs between
 *     calls and row reads interleave with the count. Main keeps no state.
 *   - **A table with a rowid is walked by rowid** (`WHERE rowid > ? ORDER BY
 *     rowid LIMIT ?`), so each chunk costs its own size wherever it starts,
 *     and a row another process inserts or deletes mid-walk moves the count
 *     by one rather than shifting every later chunk. A view, a virtual table,
 *     or a `WITHOUT ROWID` table has no rowid and is walked by `OFFSET`, which
 *     re-steps the skipped rows on every chunk: correct, slower on a large
 *     one.
 *
 * The filter compiles through the same `resolveSqliteRowSource()` the row
 * reader uses, so a count and a window over the same text mean the same rows.
 */

import type Database from 'better-sqlite3';

import type {
	SqliteCountCursor,
	SqliteCountRequest,
	SqliteRowCount,
} from '../../shared/sqlite/types';
import { quoteSqliteIdentifier } from '../../shared/sqlite/sql';
import { yieldToEventLoop } from '../utils/concurrency';
import { getSqliteDatabase } from './sqlite-database';
import { reachableRowidAlias, resolveSqliteRowSource } from './sqlite-rows';

/** Rows walked by one counting statement. */
export const SQLITE_COUNT_CHUNK_ROWS = 20_000;

/** Default time budget for one `countSqliteRows()` call. */
export const SQLITE_COUNT_BUDGET_MS = 50;

/** Result column aliases, unlikely enough that no filter column shadows them. */
const KEY = 'maestro_count_key';
const MATCH = 'maestro_count_match';

interface ChunkRow {
	scanned: unknown;
	matched: unknown;
	last?: unknown;
}

function toCount(value: unknown): number {
	return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A cursor handed back by a caller; anything malformed is a caller bug. */
function validCursor(cursor: SqliteCountCursor | null | undefined): SqliteCountCursor {
	if (cursor === null || cursor === undefined) return { matched: 0, scanned: 0, afterRowid: null };
	if (
		!isCount(cursor.matched) ||
		!isCount(cursor.scanned) ||
		(cursor.afterRowid !== null &&
			(typeof cursor.afterRowid !== 'string' || !/^-?\d+$/.test(cursor.afterRowid)))
	) {
		throw new Error('SQLite count cursor is malformed.');
	}
	return { matched: cursor.matched, scanned: cursor.scanned, afterRowid: cursor.afterRowid };
}

/**
 * Count the rows of a table or view that a filter matches, for as long as the
 * time budget allows, and say where it stopped. Always runs at least one
 * chunk, so repeated calls with the returned cursor always make progress.
 * Throws when no table or view has the name, or when SQLite cannot read it.
 */
export function countSqliteRows(
	request: SqliteCountRequest,
	budgetMs: number = SQLITE_COUNT_BUDGET_MS
): SqliteRowCount {
	const { db } = getSqliteDatabase(request.handle);
	let cursor = validCursor(request.cursor);
	const { object, source, columns, filter } = resolveSqliteRowSource(
		db,
		request.name,
		request.filter
	);

	if (filter.problem) {
		return {
			name: object.name,
			matched: 0,
			complete: false,
			cursor: null,
			filtered: false,
			elapsedMs: 0,
			filterProblem: filter.problem,
		};
	}
	const where = filter.compiled;
	const matchExpression = where ? `CASE WHEN (${where.where}) THEN 1 ELSE 0 END` : '1';
	const params = where?.params ?? [];
	const alias = reachableRowidAlias(object, columns);

	const started = performance.now();
	let complete = false;
	do {
		const chunk = alias
			? walkByRowid(db, source, alias, matchExpression, params, cursor.afterRowid)
			: walkByOffset(db, source, matchExpression, params, cursor.scanned);
		cursor = {
			matched: cursor.matched + chunk.matched,
			scanned: cursor.scanned + chunk.scanned,
			afterRowid: chunk.last ?? cursor.afterRowid,
		};
		complete = chunk.scanned < SQLITE_COUNT_CHUNK_ROWS;
	} while (!complete && performance.now() - started < budgetMs);

	return {
		name: object.name,
		matched: cursor.matched,
		complete,
		cursor: complete ? null : cursor,
		filtered: where !== null,
		elapsedMs: Math.round(performance.now() - started),
	};
}

interface Chunk {
	scanned: number;
	matched: number;
	/** The last rowid walked, as decimal text; absent for an offset walk. */
	last?: string;
}

/** One chunk of a table walked in rowid order, after `afterRowid`. */
function walkByRowid(
	db: Database.Database,
	source: string,
	alias: string,
	matchExpression: string,
	params: readonly unknown[],
	afterRowid: string | null
): Chunk {
	const rowid = quoteSqliteIdentifier(alias);
	const sql =
		`SELECT count(*) AS scanned, coalesce(sum(${MATCH}), 0) AS matched, max(${KEY}) AS last ` +
		`FROM (SELECT ${rowid} AS ${KEY}, ${matchExpression} AS ${MATCH} FROM ${source}` +
		(afterRowid !== null ? ` WHERE ${rowid} > ?` : '') +
		` ORDER BY ${rowid} LIMIT ?)`;
	const bound: unknown[] = [...params];
	if (afterRowid !== null) bound.push(BigInt(afterRowid));
	bound.push(SQLITE_COUNT_CHUNK_ROWS);
	const row = db
		.prepare(sql)
		.safeIntegers(true)
		.get(...bound) as ChunkRow;
	const last = row.last === null || row.last === undefined ? undefined : String(row.last);
	return { scanned: toCount(row.scanned), matched: toCount(row.matched), last };
}

/** One chunk of a source with no rowid, walked in scan order from `offset`. */
function walkByOffset(
	db: Database.Database,
	source: string,
	matchExpression: string,
	params: readonly unknown[],
	offset: number
): Chunk {
	const sql =
		`SELECT count(*) AS scanned, coalesce(sum(${MATCH}), 0) AS matched ` +
		`FROM (SELECT ${matchExpression} AS ${MATCH} FROM ${source} LIMIT ? OFFSET ?)`;
	const row = db
		.prepare(sql)
		.safeIntegers(true)
		.get(...params, SQLITE_COUNT_CHUNK_ROWS, offset) as ChunkRow;
	return { scanned: toCount(row.scanned), matched: toCount(row.matched) };
}

/**
 * Count to the end, call after call, yielding between them. For callers that
 * want the settled number in one reply (`maestro-cli sqlite count`); the
 * viewer calls `countSqliteRows()` itself so it can show the count converge.
 */
export async function countAllSqliteRows(request: SqliteCountRequest): Promise<SqliteRowCount> {
	let elapsedMs = 0;
	let cursor = request.cursor ?? null;
	for (;;) {
		const count = countSqliteRows({ ...request, cursor });
		elapsedMs += count.elapsedMs;
		if (count.complete || count.filterProblem || !count.cursor) return { ...count, elapsedMs };
		cursor = count.cursor;
		await yieldToEventLoop();
	}
}
