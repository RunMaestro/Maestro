/**
 * SQLite Row Versions
 *
 * The optimistic-concurrency check behind every edit the viewer makes. A
 * rows page carries one short version per row (`SqliteRowsPage.rowVersions`):
 * a hash of the row's every value, whole, as SQLite stores them. A write that
 * names the row sends the version back, and its statement's `WHERE` asks for
 * it next to the key:
 *
 *   UPDATE "t" SET "c" = ? WHERE "rowid" = ? AND maestro_row_version("a", "b", "c") = ?
 *
 * So the check and the write are one statement: a row another tab, another
 * program, or a trigger changed since the page was read matches nothing, and
 * the write changes nothing instead of clobbering what is there now. A cut
 * cell cannot hide a change, because the hash reads the value whole, and a
 * column added since the read changes every version, which is right: the
 * row is not what was shown.
 *
 * The hash is a SQL function, `maestro_row_version()`, registered on the
 * handle's read-only connection (sqlite-database.ts) and on the writable one
 * (sqlite-connection.ts), so the page and the write compute it with the same
 * code over the same `SELECT *` columns. It
 * is deterministic and direct-only: a view, trigger, or CHECK in the file
 * can never call it. Values are tagged by type before hashing, so the text
 * `'7'` and the integer 7 differ, and an INTEGER past 2^53 hashes exactly
 * (integers arrive as BigInt). A table wider than one call's argument limit
 * hashes in chunks, the outer call over the inner ones.
 *
 * Nothing here may import `electron`: the SQLite child process loads the
 * connection module that imports it.
 */

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import { quoteSqliteIdentifier } from '../../shared/sqlite/sql';

/** The SQL function's name, as statements call it. */
export const SQLITE_ROW_VERSION_FUNCTION = 'maestro_row_version';

/**
 * Columns hashed per call. SQLite caps a function's arguments (127 before
 * 3.48, 1000 after), and a table may have 2,000 columns.
 */
const SQLITE_ROW_VERSION_CHUNK = 100;

/** A version as the function writes it: 22 base64url characters (128 bits). */
const SQLITE_ROW_VERSION_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * The version of one row's values, in column order. Each value is tagged by
 * its storage class, so equal-looking values of different types differ.
 */
export function sqliteRowVersion(values: readonly unknown[]): string {
	const hash = createHash('sha256');
	for (const value of values) {
		if (value === null || value === undefined) {
			hash.update('n');
		} else if (typeof value === 'bigint') {
			hash.update(`i${value};`);
		} else if (typeof value === 'number') {
			// The double's own bits: no text form can merge two values.
			const bits = Buffer.alloc(8);
			bits.writeDoubleBE(value);
			hash.update('r');
			hash.update(bits);
		} else if (typeof value === 'string') {
			const bytes = Buffer.from(value, 'utf8');
			hash.update(`t${bytes.length}:`);
			hash.update(bytes);
		} else if (value instanceof Uint8Array) {
			hash.update(`b${value.length}:`);
			hash.update(value);
		} else {
			throw new Error(`${SQLITE_ROW_VERSION_FUNCTION} cannot hash a ${typeof value}.`);
		}
	}
	return hash.digest('base64url').slice(0, 22);
}

/**
 * Make `maestro_row_version()` callable on this connection. Integers reach
 * it as BigInt whatever the statement's own setting, so the same row always
 * hashes the same.
 */
export function registerSqliteRowVersion(db: Database.Database): void {
	db.function(
		SQLITE_ROW_VERSION_FUNCTION,
		{ varargs: true, deterministic: true, directOnly: true, safeIntegers: true },
		(...values: unknown[]) => sqliteRowVersion(values)
	);
}

/**
 * The SQL expression that computes a row's version from these columns, in
 * order: the columns `SELECT *` reports, so a page and a write agree.
 */
export function sqliteRowVersionExpression(columns: readonly string[]): string {
	const call = (args: readonly string[]) => `${SQLITE_ROW_VERSION_FUNCTION}(${args.join(', ')})`;
	const quoted = columns.map(quoteSqliteIdentifier);
	if (quoted.length <= SQLITE_ROW_VERSION_CHUNK) return call(quoted);
	const chunks: string[] = [];
	for (let start = 0; start < quoted.length; start += SQLITE_ROW_VERSION_CHUNK) {
		chunks.push(call(quoted.slice(start, start + SQLITE_ROW_VERSION_CHUNK)));
	}
	return call(chunks);
}

/**
 * The version a write was given, checked: absent (null or undefined) means
 * the caller names the row by key alone, as `maestro-cli sqlite set` does
 * without `--if-version`. Throws on anything else that is not a version.
 */
export function sqliteRowVersionParam(version: unknown): string | null {
	if (version === undefined || version === null) return null;
	if (typeof version !== 'string' || !SQLITE_ROW_VERSION_PATTERN.test(version)) {
		throw new Error(
			`"${String(version)}" is not a row version. Read the row again (sqlite rows --json lists each row's version).`
		);
	}
	return version;
}
