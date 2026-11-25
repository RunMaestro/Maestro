/**
 * What a column's type affinity does to a value written into it, as the rules
 * a cell edit keeps (src/main/sqlite/sqlite-row-edit.ts, and the table view's
 * editor in src/renderer/components/SqliteViewer/sqliteCellEdit.ts).
 *
 * SQLite converts a value to the column's affinity on the way in
 * (https://www.sqlite.org/datatype3.html#type_affinity): the text `'007'`
 * into an INTEGER column is stored as the integer 7, a number into a TEXT
 * column as text (`7.0` as `'7.0'`), `'3.0e+5'` into NUMERIC as 300000. In
 * an ordinary table it never refuses: text that is not a number stays text in
 * an INTEGER column. A cell edit must store what the person entered, so a
 * change SQLite would make is reported and nothing is written, never stored
 * converted. The affinity itself comes from `sqliteColumnAffinity()`.
 */

import { truncateAtWordBoundary } from '../formatters';
import type { SqliteBindValue } from './filter';
import type { SqliteAffinity, SqliteParameterValue } from './types';

/** INTEGER, REAL, and NUMERIC: the affinities that turn numeric text into a number. */
export function isNumericSqliteAffinity(affinity: SqliteAffinity): boolean {
	return affinity === 'INTEGER' || affinity === 'REAL' || affinity === 'NUMERIC';
}

/** A text value as a message quotes it: in single quotes, a long one cut. */
function quotedText(text: string): string {
	return `'${truncateAtWordBoundary(text, 40)}'`;
}

/**
 * Why this value cannot go into the `INTEGER PRIMARY KEY` that is the row's
 * rowid, or null when it can. SQLite answers anything but a whole number
 * there with a bare "datatype mismatch"; this names the column and the value.
 */
export function sqliteRowidValueProblem(
	column: string,
	value: SqliteParameterValue
): string | null {
	const lead = `${column} is the table's INTEGER PRIMARY KEY, which is each row's rowid, so it holds only whole numbers`;
	if (value.type === 'null') return `${lead}, never NULL.`;
	if (value.type === 'number') {
		const text = value.text.trim();
		const number = Number(text);
		if (/^[+-]?\d+$/.test(text) || (Number.isFinite(number) && Number.isInteger(number))) {
			return null;
		}
		return `${lead}; ${text} is not one.`;
	}
	return `${lead}; the text ${quotedText(value.text)} is not one.`;
}

/** The stored value as a message names it: `the integer 7`, `the text '7.0'`. */
function describeStored(storedType: unknown, stored: unknown): string {
	if (storedType === 'integer') return `the integer ${String(stored)}`;
	if (storedType === 'real') return `the real number ${String(stored)}`;
	if (storedType === 'text' && typeof stored === 'string') return `the text ${quotedText(stored)}`;
	return `a ${String(storedType).toUpperCase()} value`;
}

/** Whether a stored INTEGER or REAL is exactly the number that was bound. */
function sameNumber(given: number | bigint, stored: unknown): boolean {
	const whole = (value: number | bigint): bigint | null =>
		typeof value === 'bigint' ? value : Number.isInteger(value) ? BigInt(value) : null;
	if (typeof stored === 'bigint' || typeof stored === 'number') {
		if (typeof given === 'number' && typeof stored === 'number') return given === stored;
		const left = whole(given);
		const right = whole(stored);
		return left !== null && left === right;
	}
	return false;
}

/**
 * Why the value SQLite stored is not the value it was given, or null when it
 * is. `given` is what the `UPDATE` bound; `storedType` and `stored` are
 * `typeof(column)` and the column as the statement's `RETURNING` reports
 * them, read with `safeIntegers(true)`. `RETURNING` shows the row as the
 * `UPDATE` wrote it, after affinity and before any `AFTER` trigger, so a
 * difference here is the column's affinity converting the value, never the
 * database's own triggers. A whole number stored as a REAL (or the reverse)
 * is the same number, not a change.
 */
export function sqliteStoredValueProblem(
	column: string,
	affinity: SqliteAffinity,
	given: SqliteBindValue,
	storedType: unknown,
	stored: unknown
): string | null {
	if (given === null) return null;
	if (typeof given === 'string') {
		if (storedType === 'text' && stored === given) return null;
		return `${column} has ${affinity} affinity, so SQLite would store the text ${quotedText(given)} as ${describeStored(storedType, stored)}. Nothing was changed; to store a number, give it as a number.`;
	}
	if ((storedType === 'integer' || storedType === 'real') && sameNumber(given, stored)) return null;
	const hint =
		storedType === 'text' ? '; to store text, give it as text' : '; give a number it can hold';
	return `${column} has ${affinity} affinity, so SQLite would store the number ${String(given)} as ${describeStored(storedType, stored)}. Nothing was changed${hint}.`;
}
