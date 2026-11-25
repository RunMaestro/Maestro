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
 *     their rowid (`rowids`), so a later call (saving a BLOB, an edit) reads
 *     exactly that row whatever the order or filter. A view, a virtual table,
 *     or a `WITHOUT ROWID` table has none to offer. The page also says
 *     whether the rows can be edited and by what identity
 *     (sqlite-identity.ts); a table edited by its primary key gets each row's
 *     key read whole (`rowKeys`), since a key cell may be cut, and an
 *     editable table's rows carry their versions (`rowVersions`), a hash of
 *     every value whole, so an edit is refused when its row changed since the
 *     page was read (sqlite-row-version.ts).
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
	SqliteKeyValue,
	SqliteObjectSummary,
	SqliteResultColumn,
	SqliteRowsPage,
	SqliteRowsRequest,
	SqliteSortSpec,
} from '../../shared/sqlite/types';
import { sqliteCellFromHead, sqliteKeyValue } from './sqlite-cell';
import { reportSqliteBusy } from './sqlite-connection';
import { getSqliteDatabase } from './sqlite-database';
import {
	reachableRowidAlias,
	resolveSqliteEditability,
	sqliteRowKeyColumns,
} from './sqlite-identity';
import { findSqliteObject, readSqliteObjectSummaries } from './sqlite-objects';
import { sqliteRowVersionExpression } from './sqlite-row-version';

/** Most rows one window may hold, whatever the caller asks for. */
export const SQLITE_ROWS_MAX_LIMIT = 1000;

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

/**
 * What a row statement selects: the rowid alias (when named) first, then each
 * column's value/length pair, then the key columns (when named) bare and
 * whole, then (when asked) the row's version over every column
 * (sqlite-row-version.ts). Shared by the window reader and the edits'
 * read-back (sqlite-row-edit.ts), so an edited row comes back exactly as a
 * window shows it. Nothing has an `AS` alias.
 */
export function sqliteRowSelectList(
	columns: readonly SqliteResultColumn[],
	rowidAlias: string | null,
	keyColumns: readonly string[],
	withVersion = false
): string {
	const parts: string[] = [];
	if (rowidAlias) parts.push(quoteSqliteIdentifier(rowidAlias));
	parts.push(
		columns.length > 0 ? columns.map((column) => columnExpressions(column.name)).join(', ') : '1'
	);
	for (const key of keyColumns) parts.push(quoteSqliteIdentifier(key));
	if (withVersion) parts.push(sqliteRowVersionExpression(columns.map((column) => column.name)));
	return parts.join(', ');
}

/** One raw row read with `sqliteRowSelectList()`, as wire values. */
export interface SqliteSelectedRow {
	cells: SqliteCellValue[];
	/** The rowid as decimal text, when the list selected one. */
	rowid: string | null;
	/** The key values whole, when the list selected key columns. */
	key: SqliteKeyValue[] | null;
	/** The row's version, when the list selected it. */
	version: string | null;
}

/** Split one raw row read with `sqliteRowSelectList()` (raw, safe integers). */
export function sqliteSelectedRow(
	raw: readonly unknown[],
	columnCount: number,
	rowidAlias: string | null,
	keyColumns: readonly string[],
	withVersion = false
): SqliteSelectedRow {
	const first = rowidAlias ? 1 : 0;
	const cells: SqliteCellValue[] = [];
	for (let index = 0; index < columnCount; index++) {
		cells.push(sqliteCellFromHead(raw[first + index * 2], raw[first + index * 2 + 1]));
	}
	// With no columns the list selects a lone `1` in their place.
	const keyStart = first + Math.max(columnCount * 2, 1);
	return {
		cells,
		rowid: rowidAlias ? String(raw[0]) : null,
		key:
			keyColumns.length > 0
				? keyColumns.map((_, index) => sqliteKeyValue(raw[keyStart + index]))
				: null,
		version: withVersion ? String(raw[keyStart + keyColumns.length]) : null,
	};
}

/**
 * Read one window of a table's or view's rows. Throws when no table or view
 * has the name, when the sort names a column the object does not have, or
 * when SQLite cannot read the object (a view over a dropped table, a virtual
 * table whose module this build lacks), with SQLite's own message.
 */
export function readSqliteRows(request: SqliteRowsRequest): SqliteRowsPage {
	return reportSqliteBusy('read', () => readRows(request));
}

/** `readSqliteRows()`'s work; a busy database is restated by the caller. */
function readRows(request: SqliteRowsRequest): SqliteRowsPage {
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
	const editability = resolveSqliteEditability(db, object);
	// A table edited by its primary key gets each row's key whole: a key cell
	// may be cut, and an edit must name its row exactly.
	const keyColumns =
		editability.editable && editability.identity.kind === 'primary-key'
			? sqliteRowKeyColumns(editability.identity)
			: [];
	// An editable table's rows carry their versions, which an edit sends back
	// so main can refuse it when the row changed since this read.
	const withVersion = editability.editable;

	const selectList = sqliteRowSelectList(columns, rowidAlias, keyColumns, withVersion);
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
			editability,
			rowKeys: keyColumns.length > 0 ? [] : null,
			rowVersions: withVersion ? [] : null,
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

	const kept = raw
		.slice(0, limit)
		.map((row) => sqliteSelectedRow(row, columns.length, rowidAlias, keyColumns, withVersion));
	const rows = kept.map((row) => row.cells);
	const rowids = rowidAlias ? kept.map((row) => row.rowid ?? '') : null;
	const rowKeys = keyColumns.length > 0 ? kept.map((row) => row.key ?? []) : null;
	const rowVersions = withVersion ? kept.map((row) => row.version ?? '') : null;

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
		editability,
		rowKeys,
		rowVersions,
	};
}
