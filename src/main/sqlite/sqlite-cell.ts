/**
 * Driver values to wire cells (`SqliteCellValue`).
 *
 * Two readers produce cells, and both go through here so a value reads the
 * same in the table view and in a query result:
 *
 *   - The table view's window (sqlite-rows.ts) cuts long TEXT and BLOBs IN
 *     SQL, so it hands over a head and the full length: `sqliteCellFromHead()`.
 *   - A query result (sqlite-query-task.ts) runs SQL a person wrote, whose
 *     columns cannot be rewritten, so the whole value arrives in the child
 *     process and is cut there: `sqliteCellFromValue()`. Only the cut cell
 *     leaves it.
 *
 * An export (Query mode's Export) is the one reader that keeps values whole:
 * `sqliteExportValue()` hands the shared CSV / JSON Lines encoder each value
 * uncut, a BLOB as its bytes in hex.
 *
 * Both expect a statement read with `safeIntegers(true)`, so an INTEGER past
 * 2^53 arrives as a BigInt and keeps every digit.
 *
 * Nothing here, or reachable from here, may import `electron`: the SQLite
 * child process loads this module.
 */

import { SQLITE_CELL_BLOB_HEAD_BYTES, SQLITE_CELL_TEXT_LIMIT } from '../../shared/sqlite/cells';
import type { SqliteCellValue } from '../../shared/sqlite/types';
import type { TabularExportValue } from '../../shared/tabularExport';

function toCount(value: unknown): number {
	return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/** An INTEGER as a number when that loses nothing, else as its decimal text. */
function integerCell(value: bigint): SqliteCellValue {
	return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
		? Number(value)
		: { kind: 'integer', text: value.toString() };
}

/**
 * One value/length pair from a statement that cut the value in SQL: `value`
 * is at most `SQLITE_CELL_TEXT_LIMIT` characters or `SQLITE_CELL_BLOB_HEAD_BYTES`
 * bytes, and `length` is SQLite's `length()` of the whole value (null unless
 * it is TEXT or a BLOB).
 */
export function sqliteCellFromHead(value: unknown, length: unknown): SqliteCellValue {
	if (value === null || value === undefined) return null;
	if (typeof value === 'bigint') return integerCell(value);
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
 * TEXT past the limit, cut the way SQLite's `substr()` cuts it: by
 * characters (code points), so a surrogate pair is never split, with the
 * full length counted the way `length()` counts it.
 */
function textCell(value: string): SqliteCellValue {
	// UTF-16 units never undercount code points, so a short string is whole.
	if (value.length <= SQLITE_CELL_TEXT_LIMIT) return value;
	let characters = 0;
	let cutAt = value.length;
	for (let index = 0; index < value.length; ) {
		if (characters === SQLITE_CELL_TEXT_LIMIT) cutAt = index;
		const code = value.codePointAt(index) ?? 0;
		index += code > 0xffff ? 2 : 1;
		characters++;
	}
	if (characters <= SQLITE_CELL_TEXT_LIMIT) return value;
	return { kind: 'text', head: value.slice(0, cutAt), length: characters };
}

/** One whole value from a statement whose columns could not be cut in SQL. */
export function sqliteCellFromValue(value: unknown): SqliteCellValue {
	if (typeof value === 'string') return textCell(value);
	if (Buffer.isBuffer(value)) {
		return {
			kind: 'blob',
			head: value.subarray(0, SQLITE_CELL_BLOB_HEAD_BYTES).toString('hex'),
			bytes: value.length,
		};
	}
	return sqliteCellFromHead(value, null);
}

/**
 * One whole value as an export writes it: TEXT and REAL as they are, an
 * INTEGER as a `bigint` (every digit kept), a BLOB as lowercase hex, NULL as
 * null. Nothing is cut.
 */
export function sqliteExportValue(value: unknown): TabularExportValue {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
		return value;
	}
	if (Buffer.isBuffer(value)) return value.toString('hex');
	return String(value);
}
