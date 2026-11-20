/**
 * SQLite results in the shared `<DataGrid>`: one column and one cell shape
 * for both grids the viewer draws, the table view's rows (SqliteTableView)
 * and a statement's result in Query mode (SqliteQueryPanel), so a NULL, a
 * cut TEXT value, and a BLOB read the same in either.
 */

import { formatCount, formatSize } from '../../../shared/formatters';
import { formatSqliteBlobHex, formatSqliteCell } from '../../../shared/sqlite/cells';
import { sqliteColumnAffinity } from '../../../shared/sqlite/schema';
import type {
	SqliteAffinity,
	SqliteCellValue,
	SqliteResultColumn,
} from '../../../shared/sqlite/types';
import { dataGridColumnWidth, type DataGridCell, type DataGridColumn } from '../ui/DataGrid';

/** Typical content width for a column of each affinity. */
const CONTENT_WIDTH: Record<SqliteAffinity, number> = {
	INTEGER: 110,
	REAL: 120,
	NUMERIC: 120,
	TEXT: 200,
	BLOB: 160,
};

export interface SqliteGridColumnOptions {
	/** The table is `STRICT`, so declared types are enforced. */
	strict?: boolean;
	/**
	 * The grid key. Defaults to the column's name, which is unique in a table;
	 * a statement's result may repeat a name (`SELECT a, a`), so it passes one.
	 */
	key?: string;
	/** A header click sorts. Default true; a statement's result is in its own order. */
	sortable?: boolean;
}

/** A SQLite result column as a grid column: its name, declared type, affinity, alignment. */
export function sqliteGridColumn(
	column: SqliteResultColumn,
	{ strict = false, key = column.name, sortable = true }: SqliteGridColumnOptions = {}
): DataGridColumn {
	const declared = column.declaredType ?? '';
	const affinity = sqliteColumnAffinity(declared, strict);
	const typeText =
		column.declaredType === null
			? 'an expression'
			: declared
				? `${declared}, ${affinity} affinity`
				: 'no declared type';
	return {
		key,
		label: column.name,
		subtitle: declared || undefined,
		title: `${column.name} (${typeText})${sortable ? ' - click to sort' : ''}`,
		initialWidth: dataGridColumnWidth(column.name, CONTENT_WIDTH[affinity]),
		align: affinity === 'TEXT' || affinity === 'BLOB' ? 'left' : 'right',
		sortable,
	};
}

/**
 * One cell for the grid. A NULL and an empty string differ in the cell itself
 * (a dimmed `NULL` against a blank), and the tooltip names which one the user
 * is pointing at, since a blank can also be whitespace. `blobHint` is a last
 * tooltip line under a BLOB's size and hex, saying what the grid offers for it.
 */
export function sqliteGridCell(value: SqliteCellValue, blobHint?: string): DataGridCell {
	const cell = formatSqliteCell(value);
	if (value === null) return { ...cell, title: 'NULL (no value)' };
	if (value === '') return { ...cell, title: 'Empty string' };
	if (typeof value === 'object' && value.kind === 'blob') {
		const hex = formatSqliteBlobHex(value);
		const lines = [`BLOB, ${formatSize(value.bytes)} (${formatCount(value.bytes)} bytes)`];
		if (hex) lines.push(hex);
		if (blobHint) lines.push(blobHint);
		return { ...cell, title: lines.join('\n') };
	}
	if (typeof value === 'object' && value.kind === 'text') {
		return {
			...cell,
			title: `${cell.text}\n(${formatCount(value.length)} characters; the grid shows the first ${formatCount(value.head.length)})`,
		};
	}
	return cell;
}
