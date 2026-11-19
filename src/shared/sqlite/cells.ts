/**
 * SQLite cell limits and display text.
 *
 * The main-process row reader (src/main/sqlite/sqlite-rows.ts) cuts large
 * values down to these limits before they cross IPC; the viewer's grid and
 * `maestro-cli sqlite rows` both turn a cell into text through
 * `formatSqliteCell()`, so the two never disagree about what a cell says.
 */

import { formatSize } from '../formatters';
import type { SqliteCellValue } from './types';

/** TEXT values longer than this many characters arrive cut to it. */
export const SQLITE_CELL_TEXT_LIMIT = 4096;

/** BLOB values arrive as this many leading bytes, in hex, plus their size. */
export const SQLITE_CELL_BLOB_HEAD_BYTES = 32;

/** What one cell reads as, and whether that text stands in for a value. */
export interface SqliteCellText {
	text: string;
	/** `NULL` or a BLOB summary: drawn dimmed so it never reads as data. */
	placeholder: boolean;
}

/**
 * Display text for one cell. `NULL` is spelled out, never an empty string,
 * because an empty TEXT value is a different value. A cut TEXT value ends in
 * an ellipsis; a BLOB shows its size, since its bytes are not text.
 */
export function formatSqliteCell(value: SqliteCellValue): SqliteCellText {
	if (value === null) return { text: 'NULL', placeholder: true };
	if (typeof value === 'number') return { text: String(value), placeholder: false };
	if (typeof value === 'string') return { text: value, placeholder: false };
	switch (value.kind) {
		case 'integer':
			return { text: value.text, placeholder: false };
		case 'text':
			return { text: `${value.head}…`, placeholder: false };
		case 'blob':
			return { text: `BLOB ${formatSize(value.bytes)}`, placeholder: true };
	}
}
