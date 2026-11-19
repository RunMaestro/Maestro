/**
 * The table view's cell edit, as pure rules: whether a cell may be edited,
 * the text its editor starts with, what the edited text writes, and the key
 * that names the row. The write itself, and every check that matters for
 * safety, happen again in main (src/main/sqlite/sqlite-row-edit.ts); these
 * rules only keep the editor from offering what main would refuse, and from
 * writing what nobody changed.
 */

import { formatCount, truncateAtWordBoundary } from '../../../shared/formatters';
import { isNumericSqliteAffinity, sqliteRowidValueProblem } from '../../../shared/sqlite/affinity';
import { sqliteNumberBindValue, sqliteNumberTextProblem } from '../../../shared/sqlite/filter';
import type {
	SqliteAffinity,
	SqliteCellValue,
	SqliteEditability,
	SqliteKeyValue,
	SqliteParameterValue,
	SqliteRowKey,
} from '../../../shared/sqlite/types';

/**
 * The key that names one loaded row for an edit, from its page: the rowid,
 * or the whole primary key. Null when the page carried none for that row.
 */
export function sqliteRowKeyAt(
	editability: SqliteEditability | null,
	rowids: readonly string[] | null,
	rowKeys: readonly SqliteKeyValue[][] | null,
	rowPosition: number
): SqliteRowKey | null {
	if (!editability?.editable) return null;
	const { identity } = editability;
	if (identity.kind === 'rowid') {
		const rowid = rowids?.[rowPosition];
		return rowid ? { kind: 'rowid', rowid } : null;
	}
	const key = rowKeys?.[rowPosition];
	if (!key || key.length !== identity.columns.length) return null;
	return {
		kind: 'primary-key',
		values: Object.fromEntries(identity.columns.map((column, index) => [column, key[index]])),
	};
}

/**
 * Why this cell cannot be edited in the grid, or null when it can. A BLOB is
 * not text, and a TEXT value the page cut would be saved cut, so both are
 * refused rather than offered with part of the value.
 */
export function sqliteCellEditRefusal(
	editability: SqliteEditability | null,
	column: string,
	value: SqliteCellValue,
	key: SqliteRowKey | null
): string | null {
	if (!editability) return 'The table is still loading.';
	if (!editability.editable) return editability.reason;
	const generated = editability.readOnlyColumns.find((entry) => entry.name === column);
	if (generated) return generated.reason;
	if (value !== null && typeof value === 'object' && value.kind === 'blob') {
		return `${column} holds a BLOB, which cannot be edited as text. Double-click the row number to save it to a file.`;
	}
	if (value !== null && typeof value === 'object' && value.kind === 'text') {
		return `${column} holds ${formatCount(value.length)} characters, more than the grid shows, so editing it here would cut it.`;
	}
	if (!key)
		return 'This row came back without its key, so an edit cannot name it. Reload the table.';
	if (key.kind === 'primary-key' && Object.values(key.values).some((entry) => entry === null)) {
		return "This row's primary key holds NULL, and NULL never equals anything, so the row cannot be named for a change.";
	}
	return null;
}

/**
 * What a cell editor holds. NULL is its own state, not an empty box: a text
 * input cannot tell NULL from '' (the classic data-grid data-loss bug), so
 * the editor says which one it holds and only an explicit act moves between
 * them. While `isNull` is set, `text` keeps what was typed, so turning NULL
 * back off restores it.
 */
export interface SqliteCellDraft {
	text: string;
	isNull: boolean;
}

/**
 * The chord that sets the open cell to NULL, inside the cell editor only.
 * Clearing the text leaves an empty string; this is the one keyboard way to
 * NULL. Not Cmd+Shift+Backspace, which is Remove Agent everywhere else.
 */
export const SQLITE_CELL_NULL_KEYS = ['Alt', 'Meta', 'Backspace'];

/** Whether a keydown in the cell editor is SQLITE_CELL_NULL_KEYS (Ctrl for Cmd off macOS). */
export function isSqliteCellNullChord(event: {
	key: string;
	altKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
}): boolean {
	return (
		event.key === 'Backspace' && event.altKey && (event.metaKey || event.ctrlKey) && !event.shiftKey
	);
}

/** The text an editor opens with: the value as typed, NULL as empty. */
export function sqliteCellEditText(value: SqliteCellValue): string {
	if (value === null) return '';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'string') return value;
	if (value.kind === 'integer') return value.text;
	if (value.kind === 'text') return value.head;
	return '';
}

/** The draft an editor opens with: a NULL opens as NULL, never as ''. */
export function sqliteCellEditDraft(value: SqliteCellValue): SqliteCellDraft {
	return { text: sqliteCellEditText(value), isNull: value === null };
}

/**
 * What an edit writes, or null when the draft is what the editor opened with
 * (Enter on an untouched cell writes nothing, so a NULL never turns into an
 * empty string by accident). A NULL draft binds NULL. An empty text draft is
 * an empty string, even on a cell that held NULL: getting there took typing
 * or turning NULL off, both deliberate.
 *
 * Otherwise the column's affinity picks the type, so the value is stored the
 * way it was entered rather than converted by SQLite:
 *
 *   - TEXT: always text, so `007` stays `'007'`.
 *   - INTEGER, REAL, NUMERIC: a number while the text is one (trimmed), else
 *     text, which `sqliteCellEditValueProblem()` then judges.
 *   - BLOB (no affinity, which converts nothing): a number stays a number
 *     while the text is still one, so the column does not silently start
 *     storing TEXT; anything else is text, verbatim.
 */
export function sqliteCellEditValue(
	original: SqliteCellValue,
	draft: SqliteCellDraft,
	affinity: SqliteAffinity
): SqliteParameterValue | null {
	if (draft.isNull) return original === null ? null : { type: 'null', text: '' };
	if (original !== null && draft.text === sqliteCellEditText(original)) return null;
	const trimmed = draft.text.trim();
	const isNumber = sqliteNumberBindValue(trimmed) !== null;
	if (affinity === 'TEXT') return { type: 'text', text: draft.text };
	if (affinity === 'BLOB') {
		const numeric =
			typeof original === 'number' ||
			(original !== null && typeof original === 'object' && original.kind === 'integer');
		if (!numeric || !isNumber) return { type: 'text', text: draft.text };
	}
	return isNumber ? { type: 'number', text: trimmed } : { type: 'text', text: draft.text };
}

/** Whether the cell holds TEXT now, so the column demonstrably takes text here. */
function holdsText(value: SqliteCellValue): boolean {
	return (
		typeof value === 'string' ||
		(value !== null && typeof value === 'object' && value.kind === 'text')
	);
}

/** The column an edit writes, as the value checks need it. */
export interface SqliteCellEditColumn {
	name: string;
	affinity: SqliteAffinity;
	/** The `INTEGER PRIMARY KEY` that is the row's rowid. */
	isRowid: boolean;
}

/**
 * Why the editor will not save this value, or null when it will. Reported
 * under the grid with the editor left open, so the value can be fixed:
 *
 *   - A number SQLite could not hold as typed (past the 64-bit range, too
 *     large, more digits than a REAL keeps): it would be stored rounded.
 *   - Anything but a whole number in the rowid column (SQLite would say only
 *     "datatype mismatch").
 *   - Text that is not a number, an empty box included, in an INTEGER, REAL,
 *     or NUMERIC column, unless the cell already holds text: SQLite would keep
 *     it as TEXT in a numeric column, which is almost always a typo or a
 *     cleared box meant as NULL.
 *
 * Main checks the stored value again (`sqliteStoredValueProblem()`), so a
 * conversion this misses is still refused there, never written.
 */
export function sqliteCellEditValueProblem(
	column: SqliteCellEditColumn,
	original: SqliteCellValue,
	value: SqliteParameterValue
): string | null {
	if (value.type === 'number') {
		const inexact = sqliteNumberTextProblem(value.text);
		if (inexact) return `${column.name}: ${inexact}`;
	}
	if (column.isRowid) return sqliteRowidValueProblem(column.name, value);
	if (value.type !== 'text' || !isNumericSqliteAffinity(column.affinity)) return null;
	if (holdsText(original)) return null;
	const shown =
		value.text === '' ? 'an empty string' : `'${truncateAtWordBoundary(value.text, 40)}'`;
	return `${column.name} has ${column.affinity} affinity, and ${shown} is not a number, so SQLite would keep it as TEXT. Enter a number, or set NULL.`;
}

/** What the editor's box says about the column it writes, as its tooltip. */
export function sqliteCellEditTypeHint(
	column: string,
	declaredType: string | null,
	affinity: SqliteAffinity
): string {
	const declared = declaredType ? `${declaredType}, ` : '';
	const rule = isNumericSqliteAffinity(affinity)
		? 'a number is stored as a number; text that is not one is refused'
		: affinity === 'TEXT'
			? 'everything is stored as text, numbers included'
			: 'no conversion, so a value keeps the type it is entered as';
	return `${column} (${declared}${affinity} affinity): ${rule}.`;
}
