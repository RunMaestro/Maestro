/**
 * SQLite cell limits and display text.
 *
 * The main-process row reader (src/main/sqlite/sqlite-rows.ts) cuts large
 * values down to these limits before they cross IPC; the viewer's grid and
 * `maestro-cli sqlite rows` both turn a cell into text through
 * `formatSqliteCell()`, so the two never disagree about what a cell says.
 * The record view's longer form is `formatSqliteRecordValue()`.
 */

import { formatCount, formatSize } from '../formatters';
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

/**
 * Text for one value in the record view, where a value has a whole line or
 * more to itself. It says more than the grid's one-line cell: a cut TEXT value
 * names its full length and how much of it arrived, and a BLOB shows the bytes
 * that arrived as spaced hex under its size. Anything the grid shows whole is
 * the same text here.
 */
export function formatSqliteRecordValue(value: SqliteCellValue): string {
	if (value === null || typeof value !== 'object') return formatSqliteCell(value).text;
	switch (value.kind) {
		case 'integer':
			return value.text;
		case 'text':
			return `${value.head}…\n\n(${formatCount(value.length)} characters; the first ${formatCount(value.head.length)} are shown)`;
		case 'blob': {
			const shownBytes = Math.floor(value.head.length / 2);
			const hex = value.head.match(/../g)?.join(' ') ?? '';
			const summary = `BLOB ${formatSize(value.bytes)}`;
			if (!hex) return summary;
			return `${summary}\n${hex}${value.bytes > shownBytes ? ' …' : ''}`;
		}
	}
}
