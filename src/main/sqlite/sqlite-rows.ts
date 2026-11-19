/**
 * SQLite Row Windows
 *
 * What the viewer's table view shows: one window of a table's or view's rows,
 * `LIMIT`/`OFFSET` paged, optionally narrowed by a filter (`WHERE`) and
 * ordered by one column (`ORDER BY`). Both run in SQLite, never over the
 * loaded page, so they cover the whole table.
 *
 * Three rules keep a window honest and cheap:
 *
 *   - **Identifiers are quoted, values are bound.** The table and column names
 *     go through `quoteSqliteIdentifier()`; the sort column must be one the
 *     statement itself reports, `LIMIT`/`OFFSET` are bound parameters, and the
 *     filter compiles to a `WHERE` whose every value is a bound parameter
 *     (`buildSqliteFilter()` in src/shared/sqlite/filter.ts).
 *   - **Pages do not drift.** Paging with `OFFSET` is only stable when the
 *     order is total, so a sort is followed by `rowid` (or, for a `WITHOUT
 *     ROWID` table, its primary key) as a tie-break. A view has neither, so
 *     its order is SQLite's scan order and `orderedBy` says so.
 *   - **Large values are cut in SQL.** A TEXT value past `SQLITE_CELL_TEXT_LIMIT`
 *     characters and every BLOB arrive as a head plus their full length, so a
 *     page of megabyte payloads stays a page of kilobytes on the wire.
 *     Integers are read as BigInt and only narrowed when that loses nothing.
 *   - **A row can be named again.** An ordinary table's rows come back with
 *     their rowid (`rowids`), so a later call (saving a BLOB) reads exactly
 *     that row whatever the order or filter. A view, a virtual table, or a
 *     `WITHOUT ROWID` table has none to offer.
 *
 * better-sqlite3 is synchronous, so a sort on an unindexed column of a very
 * large table holds the main process while SQLite sorts, and a filter that
 * matches few rows holds it while SQLite scans for them. The window is
 * bounded (`SQLITE_ROWS_MAX_LIMIT`), the sort and the scan are not.
 */

import type Database from 'better-sqlite3';

import { SQLITE_CELL_BLOB_HEAD_BYTES, SQLITE_CELL_TEXT_LIMIT } from '../../shared/sqlite/cells';
import { buildSqliteFilter, type SqliteFilterBuild } from '../../shared/sqlite/filter';
import { sqliteColumnAffinity } from '../../shared/sqlite/schema';
import { quoteSqliteIdentifier } from '../../shared/sqlite/sql';
import type {
	SqliteCellValue,
	SqliteObjectSummary,
	SqliteResultColumn,
	SqliteRowsPage,
	SqliteRowsRequest,
	SqliteSortSpec,
} from '../../shared/sqlite/types';
import { getSqliteDatabase } from './sqlite-database';
import { findSqliteObject, readSqliteObjectSummaries } from './sqlite-objects';

/** Most rows one window may hold, whatever the caller asks for. */
export const SQLITE_ROWS_MAX_LIMIT = 1000;

/** The names SQLite answers to for a rowid, in the order we prefer them. */
const ROWID_ALIASES = ['rowid', '_rowid_', 'oid'] as const;

function toCount(value: unknown): number {
	return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/**
 * A window bound as a non-negative integer; anything else is a caller bug.
 * Shared with the BLOB reader (sqlite-blob.ts), whose row position is one.
 */
export function windowBound(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(`SQLite rows ${label} must be a non-negative number.`);
	}
	return Math.floor(value);
}

/**
 * The rowid alias a statement over this object can use, or null when it has
 * none: views, virtual tables, and `WITHOUT ROWID` tables have no rowid, and a
 * real column named `rowid` hides that alias, so the first name still free
 * wins. A table whose columns take all three names has no reachable rowid.
 * Shared with the row counter (sqlite-count.ts), which walks a table by it.
 */
export function reachableRowidAlias(
	object: SqliteObjectSummary,
	columns: readonly SqliteResultColumn[]
): string | null {
	if (object.kind !== 'table' || object.tableType === 'virtual' || object.withoutRowid) {
		return null;
	}
	const taken = new Set(columns.map((column) => column.name.toLowerCase()));
	return ROWID_ALIASES.find((candidate) => !taken.has(candidate)) ?? null;
}

/**
 * The columns that make the order total after the sort column: a usable rowid
 * alias for an ordinary table, the primary key for a `WITHOUT ROWID` one, and
 * nothing for a view or a virtual table, which promise neither.
 */
function tieBreakColumns(
	db: Database.Database,
	object: SqliteObjectSummary,
	columns: readonly SqliteResultColumn[]
): string[] {
	if (object.kind !== 'table' || object.tableType === 'virtual') return [];
	if (object.withoutRowid) {
		return (
			db
				.prepare("SELECT name FROM pragma_table_info(?, 'main') WHERE pk > 0 ORDER BY pk")
				.all(object.name) as Array<{ name: string }>
		).map((row) => row.name);
	}
	const alias = reachableRowidAlias(object, columns);
	return alias ? [alias] : [];
}

/** What a row statement reads from: the object, its columns, and the compiled filter. */
export interface SqliteRowSource {
	object: SqliteObjectSummary;
	/** The object's name, quoted for SQL text. */
	source: string;
	/** `SELECT *`'s columns, in order. */
	columns: SqliteResultColumn[];
	/** The filter text compiled against those columns, or its problem. */
	filter: SqliteFilterBuild;
}

/**
 * Resolve the table or view a row statement reads and compile its filter.
 * Shared by the row reader and the row counter (sqlite-count.ts), so a window
 * and a count over the same filter text always mean the same rows. Throws
 * when no table or view has the name.
 */
export function resolveSqliteRowSource(
	db: Database.Database,
	name: string,
	filterText: string | null | undefined
): SqliteRowSource {
	const objects = readSqliteObjectSummaries(db);
	const object =
		findSqliteObject(objects, name, 'table') ?? findSqliteObject(objects, name, 'view');
	if (!object) throw new Error(`No table or view is named ${name}.`);

	const source = quoteSqliteIdentifier(object.name);
	// `SELECT *` is what the user means by "the table": it leaves out a virtual
	// table's hidden columns and keeps generated ones. Preparing it runs
	// nothing; it only reports the columns.
	const columns: SqliteResultColumn[] = db
		.prepare(`SELECT * FROM ${source}`)
		.columns()
		.map((column) => ({ name: column.name, declaredType: column.type }));

	const filter = buildSqliteFilter(
		filterText?.trim() ?? '',
		columns.map((column) => ({
			name: column.name,
			affinity: sqliteColumnAffinity(column.declaredType ?? '', object.strict === true),
		}))
	);
	return { object, source, columns, filter };
}

/** The `ORDER BY` a row statement uses, and the columns that make it up. */
export interface SqliteRowOrder {
	/** The sort column (if any), then the tie-break; see `SqliteRowsPage.orderedBy`. */
	orderedBy: string[];
	/** Quoted `ORDER BY` terms, in `orderedBy` order; empty for no order. */
	orderTerms: string[];
}

/**
 * The order a window is read in: the requested sort column first, then the
 * tie-break that makes it total. Shared with the BLOB reader
 * (sqlite-blob.ts), which re-finds a row by its position in a window and so
 * must order exactly as the window did. Throws when the sort names a column
 * `SELECT *` does not report, or a direction other than asc / desc.
 */
export function sqliteRowOrder(
	db: Database.Database,
	{ object, columns }: Pick<SqliteRowSource, 'object' | 'columns'>,
	sort: SqliteSortSpec | null | undefined
): SqliteRowOrder {
	if (sort) {
		if (!columns.some((column) => column.name === sort.column)) {
			throw new Error(`${object.name} has no column named ${sort.column}.`);
		}
		if (sort.direction !== 'asc' && sort.direction !== 'desc') {
			throw new Error(`Sort direction must be asc or desc.`);
		}
	}

	const orderedBy = sort ? [sort.column] : [];
	for (const column of tieBreakColumns(db, object, columns)) {
		if (!orderedBy.includes(column)) orderedBy.push(column);
	}
	const orderTerms = orderedBy.map((column, position) => {
		const direction = sort && position === 0 && sort.direction === 'desc' ? ' DESC' : '';
		return `${quoteSqliteIdentifier(column)}${direction}`;
	});
	return { orderedBy, orderTerms };
}

/**
 * One column's two result expressions: the value (cut when it is long TEXT or
 * a BLOB) and its full length (null unless it is TEXT or a BLOB). Neither has
 * an `AS` alias, so an `ORDER BY` name always resolves to the source column.
 */
function columnExpressions(name: string): string {
	const q = quoteSqliteIdentifier(name);
	return (
		`CASE typeof(${q}) WHEN 'blob' THEN substr(${q}, 1, ${SQLITE_CELL_BLOB_HEAD_BYTES}) ` +
		`WHEN 'text' THEN substr(${q}, 1, ${SQLITE_CELL_TEXT_LIMIT}) ELSE ${q} END, ` +
		`CASE typeof(${q}) WHEN 'blob' THEN length(${q}) WHEN 'text' THEN length(${q}) END`
	);
}

/** Turn one value/length pair from the statement into a wire cell. */
function toCell(value: unknown, length: unknown): SqliteCellValue {
	if (value === null || value === undefined) return null;
	if (typeof value === 'bigint') {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: { kind: 'integer', text: value.toString() };
	}
	if (typeof value === 'number') return value;
	if (typeof value === 'string') {
		const full = toCount(length);
		return full > value.length ? { kind: 'text', head: value, length: full } : value;
	}
	if (Buffer.isBuffer(value)) {
		return { kind: 'blob', head: value.toString('hex'), bytes: toCount(length) };
	}
	return String(value);
}

/**
 * Read one window of a table's or view's rows. Throws when no table or view
 * has the name, when the sort names a column the object does not have, or
 * when SQLite cannot read the object (a view over a dropped table, a virtual
 * table whose module this build lacks), with SQLite's own message.
 */
export function readSqliteRows(request: SqliteRowsRequest): SqliteRowsPage {
	const { db } = getSqliteDatabase(request.handle);
	const offset = windowBound(request.offset, 'offset');
	const limit = Math.min(windowBound(request.limit, 'limit'), SQLITE_ROWS_MAX_LIMIT);

	const { object, source, columns, filter } = resolveSqliteRowSource(
		db,
		request.name,
		request.filter
	);

	const { orderedBy, orderTerms } = sqliteRowOrder(db, { object, columns }, request.sort);
	// The rowid rides ahead of the cells, so a caller can name a row exactly
	// (saving a BLOB, later an edit). Bare, with no `AS`, like the cells.
	const rowidAlias = reachableRowidAlias(object, columns);

	const cellList =
		columns.length > 0 ? columns.map((column) => columnExpressions(column.name)).join(', ') : '1';
	const selectList = rowidAlias ? `${quoteSqliteIdentifier(rowidAlias)}, ${cellList}` : cellList;
	if (filter.problem) {
		// Text that does not parse reads nothing: the caller keeps what it shows
		// and underlines the span.
		return {
			name: object.name,
			columns,
			rows: [],
			rowids: rowidAlias ? [] : null,
			offset,
			hasMore: false,
			orderedBy,
			elapsedMs: 0,
			filtered: false,
			filterProblem: filter.problem,
		};
	}
	const where = filter.compiled;

	const sql =
		`SELECT ${selectList} FROM ${source}` +
		(where ? ` WHERE ${where.where}` : '') +
		(orderTerms.length > 0 ? ` ORDER BY ${orderTerms.join(', ')}` : '') +
		' LIMIT ? OFFSET ?';

	const started = performance.now();
	// One row past the window says whether another page exists, without a count.
	const raw = db
		.prepare(sql)
		.raw(true)
		.safeIntegers(true)
		.all(...(where?.params ?? []), limit + 1, offset) as unknown[][];
	const elapsedMs = Math.round(performance.now() - started);

	const first = rowidAlias ? 1 : 0;
	const kept = raw.slice(0, limit);
	const rows = kept.map((row) =>
		columns.map((_, index) => toCell(row[first + index * 2], row[first + index * 2 + 1]))
	);
	const rowids = rowidAlias ? kept.map((row) => String(row[0])) : null;

	return {
		name: object.name,
		columns,
		rows,
		rowids,
		offset,
		hasMore: raw.length > limit,
		orderedBy,
		elapsedMs,
		filtered: where !== null,
	};
}
