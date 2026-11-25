/**
 * SQLite BLOB Save
 *
 * A row window carries a BLOB as its size plus a 32-byte head
 * (src/main/sqlite/sqlite-rows.ts), so a page of images stays a page of
 * kilobytes. Saving one to a file reads that one value whole, here, and writes
 * it straight to disk: the bytes never cross IPC or the WebSocket.
 *
 * The row is named one of two ways, and the reader prefers the exact one:
 *
 *   - **By rowid**, when its page carried one (`SqliteRowsPage.rowids`). The
 *     same row whatever has been sorted, filtered, inserted, or deleted since.
 *   - **By position** in the window it was read in (same filter, same sort,
 *     same `OFFSET`), for a view, a virtual table, or a `WITHOUT ROWID` table.
 *     The order is rebuilt by `sqliteRowOrder()`, so it is the window's own;
 *     but a write to the database since the read can move another row there.
 *
 * Either way, `expected` (the size and head the cell showed) is checked before
 * a byte is written, so a row that changed underneath is refused rather than
 * saved as the wrong file. A size-and-head match is strong evidence, not proof:
 * two same-size BLOBs can share a 32-byte header, which is why the rowid wins.
 *
 * better-sqlite3 is synchronous and SQLite reads a value whole, so a very large
 * BLOB holds the main process while it loads. SQLite's own default limit is
 * 1,000,000,000 bytes per value.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { quoteSqliteIdentifier } from '../../shared/sqlite/sql';
import type { SqliteBlobRequest, SqliteBlobSaved } from '../../shared/sqlite/types';
import { reportSqliteBusy } from './sqlite-connection';
import { getSqliteDatabase } from './sqlite-database';
import { SQLITE_ROWID_TEXT, reachableRowidAlias } from './sqlite-identity';
import { resolveSqliteRowSource, sqliteRowOrder, windowBound } from './sqlite-rows';

/** One BLOB, read whole, and the row it came from. */
export interface SqliteBlobValue {
	bytes: Buffer;
	rowid: string | null;
}

/**
 * Read one BLOB value whole. Throws when no table or view has the name, the
 * column does not exist, the row cannot be found, the value is not a BLOB, or
 * it no longer matches `expected`.
 */
export function readSqliteBlob(request: Omit<SqliteBlobRequest, 'destPath'>): SqliteBlobValue {
	return reportSqliteBusy('read', () => readBlob(request));
}

/** `readSqliteBlob()`'s work; a busy database is restated by the caller. */
function readBlob(request: Omit<SqliteBlobRequest, 'destPath'>): SqliteBlobValue {
	const { db } = getSqliteDatabase(request.handle);
	const hasRowid = request.rowid !== undefined && request.rowid !== null;
	// A rowid names the row on its own, so its filter is not compiled: text
	// that no longer parses must not block saving a row it already found.
	const { object, source, columns, filter } = resolveSqliteRowSource(
		db,
		request.name,
		hasRowid ? null : request.filter
	);
	if (!columns.some((column) => column.name === request.column)) {
		throw new Error(`${object.name} has no column named ${request.column}.`);
	}

	const column = quoteSqliteIdentifier(request.column);
	const alias = reachableRowidAlias(object, columns);
	const selectList = `typeof(${column}), ${column}${alias ? `, ${quoteSqliteIdentifier(alias)}` : ''}`;

	let row: unknown[] | undefined;
	let rowLabel: string;
	if (hasRowid) {
		const rowid = String(request.rowid);
		if (!alias) throw new Error(`${object.name} has no rowid; name the row by its position.`);
		if (!SQLITE_ROWID_TEXT.test(rowid)) throw new Error(`Not a rowid: ${rowid}`);
		rowLabel = `rowid ${rowid}`;
		row = db
			.prepare(`SELECT ${selectList} FROM ${source} WHERE ${quoteSqliteIdentifier(alias)} = ?`)
			.raw(true)
			.safeIntegers(true)
			.get(BigInt(rowid)) as unknown[] | undefined;
	} else {
		if (request.offset === undefined || request.offset === null) {
			throw new Error('Name the row by its rowid or its position (offset).');
		}
		const offset = windowBound(request.offset, 'offset');
		if (filter.problem) throw new Error(`Filter problem: ${filter.problem.message}`);
		const { orderTerms } = sqliteRowOrder(db, { object, columns }, request.sort);
		const compiled = filter.compiled;
		rowLabel = `row ${offset + 1}${compiled ? ' of the matching rows' : ''}`;
		row = db
			.prepare(
				`SELECT ${selectList} FROM ${source}` +
					(compiled ? ` WHERE ${compiled.where}` : '') +
					(orderTerms.length > 0 ? ` ORDER BY ${orderTerms.join(', ')}` : '') +
					' LIMIT 1 OFFSET ?'
			)
			.raw(true)
			.safeIntegers(true)
			.get(...(compiled?.params ?? []), offset) as unknown[] | undefined;
	}

	if (!row)
		throw new Error(`${object.name} has no ${rowLabel}; it may have changed since it was read.`);
	const [type, value, rowid] = row;
	if (type !== 'blob' || !Buffer.isBuffer(value)) {
		const held = type === 'null' ? 'NULL' : `a ${String(type).toUpperCase()} value`;
		throw new Error(`${request.column} holds ${held} in ${rowLabel}, not a BLOB.`);
	}

	const expected = request.expected;
	if (expected) {
		const head = value.subarray(0, Math.floor(expected.head.length / 2)).toString('hex');
		if (value.length !== expected.bytes || head !== expected.head.toLowerCase()) {
			throw new Error(
				`${request.column} in ${rowLabel} changed since it was read. Reload the table and try again.`
			);
		}
	}
	return { bytes: value, rowid: alias && rowid !== undefined ? String(rowid) : null };
}

/**
 * Read one BLOB whole and write it to `destPath`, replacing any file there.
 * The viewer's record view and `maestro-cli sqlite blob` both call this.
 */
export async function saveSqliteBlob(request: SqliteBlobRequest): Promise<SqliteBlobSaved> {
	if (typeof request.destPath !== 'string' || !path.isAbsolute(request.destPath)) {
		throw new Error(`destPath must be an absolute path, got: ${request.destPath || '(none)'}`);
	}
	const { bytes, rowid } = readSqliteBlob(request);
	await fs.mkdir(path.dirname(request.destPath), { recursive: true });
	await fs.writeFile(request.destPath, bytes);
	return { path: request.destPath, bytes: bytes.length, rowid };
}
