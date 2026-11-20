/**
 * The table view's Insert row form, as pure rules: what each column's field
 * starts as, and what the filled form writes. The INSERT itself, and every
 * check that matters for safety, happen again in main
 * (`insertSqliteRow()` in src/main/sqlite/sqlite-row-edit.ts); these rules
 * keep the form from sending what main would refuse, with the same words the
 * cell editor uses, since a new value obeys the same affinity rules.
 */

import { sqliteColumnAffinity } from '../../../shared/sqlite/schema';
import type {
	SqliteEditability,
	SqliteParameterValue,
	SqliteResultColumn,
} from '../../../shared/sqlite/types';
import { sqliteCellEditValue, sqliteCellEditValueProblem } from './sqliteCellEdit';

/**
 * How one column of a new row is filled: left to its DEFAULT (the column is
 * not named in the INSERT, so SQLite applies the default, or the next rowid
 * for the rowid column), set to the typed value, or set to NULL.
 */
export type SqliteInsertFieldMode = 'default' | 'value' | 'null';

/** One column's field in the form. `text` survives a switch to Default or NULL and back. */
export interface SqliteInsertField {
	mode: SqliteInsertFieldMode;
	text: string;
}

/** The form's fields, keyed by column name. */
export type SqliteInsertDraft = Record<string, SqliteInsertField>;

/** A column the form offers, with what the field needs to know about it. */
export interface SqliteInsertColumn {
	name: string;
	declaredType: string | null;
	/** Why no value can be given (a generated column), or null. */
	readOnlyReason: string | null;
	/** The `INTEGER PRIMARY KEY` that is the rowid: Default takes the next one. */
	isRowid: boolean;
}

/** The columns an Insert row form lists, in table order. */
export function sqliteInsertColumns(
	columns: readonly SqliteResultColumn[],
	editability: SqliteEditability | null
): SqliteInsertColumn[] {
	const editable = editability?.editable ? editability : null;
	return columns.map((column) => ({
		name: column.name,
		declaredType: column.declaredType,
		readOnlyReason:
			editable?.readOnlyColumns.find((entry) => entry.name === column.name)?.reason ?? null,
		isRowid: editable?.identity.kind === 'rowid' && editable.identity.rowidColumn === column.name,
	}));
}

/** A field as the form opens it: every column left to its DEFAULT. */
export const EMPTY_SQLITE_INSERT_FIELD: SqliteInsertField = { mode: 'default', text: '' };

/** The field for `column`: the one the form holds, or one left to its DEFAULT. */
export function sqliteInsertField(draft: SqliteInsertDraft, column: string): SqliteInsertField {
	return Object.prototype.hasOwnProperty.call(draft, column)
		? draft[column]
		: EMPTY_SQLITE_INSERT_FIELD;
}

/**
 * What the form writes: each column not left to its DEFAULT, keyed by name,
 * or the first problem, named by column, when a value would be refused. A
 * value binds the way a cell edit binds it into an empty cell
 * (`sqliteCellEditValue()`): the column's affinity picks text or a number, so
 * `007` in a TEXT column stays `'007'`, and text that is not a number in a
 * numeric column is refused rather than kept as TEXT. NULL in the rowid
 * column is allowed: SQLite takes it as "assign the next rowid".
 */
export function sqliteInsertValues(
	columns: readonly SqliteInsertColumn[],
	draft: SqliteInsertDraft,
	strict: boolean
): { values: Record<string, SqliteParameterValue> } | { problem: string } {
	const values: Record<string, SqliteParameterValue> = {};
	for (const column of columns) {
		const field = sqliteInsertField(draft, column.name);
		if (field.mode === 'default') continue;
		if (column.readOnlyReason) return { problem: column.readOnlyReason };
		if (field.mode === 'null') {
			values[column.name] = { type: 'null', text: '' };
			continue;
		}
		const affinity = sqliteColumnAffinity(column.declaredType ?? '', strict);
		// Never null: an empty cell (the original here) differs from any text.
		const value = sqliteCellEditValue(null, { text: field.text, isNull: false }, affinity) ?? {
			type: 'text',
			text: field.text,
		};
		const problem = sqliteCellEditValueProblem(
			{ name: column.name, affinity, isRowid: column.isRowid },
			null,
			value
		);
		if (problem) return { problem };
		values[column.name] = value;
	}
	return { values };
}
