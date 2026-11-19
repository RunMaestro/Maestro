/**
 * The table view's cell edit, as pure rules: whether a cell may be edited,
 * the text its editor starts with, what the edited text writes, and the key
 * that names the row. The write itself, and every check that matters for
 * safety, happen again in main (src/main/sqlite/sqlite-row-edit.ts); these
 * rules only keep the editor from offering what main would refuse, and from
 * writing what nobody changed.
 */

import { formatCount } from '../../../shared/formatters';
import { sqliteNumberBindValue } from '../../../shared/sqlite/filter';
import type {
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

/** The text an editor opens with: the value as typed, NULL as empty. */
export function sqliteCellEditText(value: SqliteCellValue): string {
	if (value === null) return '';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'string') return value;
	if (value.kind === 'integer') return value.text;
	if (value.kind === 'text') return value.head;
	return '';
}

/**
 * What an edit writes, or null when the text is what the editor opened with
 * (Enter on an untouched cell writes nothing, so a NULL never turns into an
 * empty string by accident). A number stays a number while the text is still
 * one, so a column with no affinity does not silently start storing TEXT;
 * anything else binds as TEXT, for the column's affinity to convert.
 */
export function sqliteCellEditValue(
	original: SqliteCellValue,
	draft: string
): SqliteParameterValue | null {
	if (draft === sqliteCellEditText(original)) return null;
	const numeric =
		typeof original === 'number' ||
		(original !== null && typeof original === 'object' && original.kind === 'integer');
	if (numeric && sqliteNumberBindValue(draft.trim()) !== null) {
		return { type: 'number', text: draft.trim() };
	}
	return { type: 'text', text: draft };
}
