/**
 * Parquet display formatting.
 *
 * Cells arrive from the main process as bare scalars; the column's
 * {@link ParquetValueKind} is what says whether `1704067200000` is a row count
 * or an instant. Everything that turns a value into pixels lives here so the
 * grid, the record modal, and the clipboard all agree.
 */

import type {
	ParquetCellValue,
	ParquetColumnInfo,
	ParquetValueKind,
} from '../../../shared/parquet/types';

/** Numbers get digit grouping; this is a data grid, and 1,204,993 reads faster. */
const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 });

/** Pad to two digits without pulling in a date library. */
function pad(value: number, width = 2): string {
	return String(value).padStart(width, '0');
}

/**
 * Render a timestamp in local time, seconds precision, with milliseconds only
 * when they are non-zero.
 *
 * ISO-ordered rather than locale-ordered on purpose: a column of timestamps is
 * read as a sequence, and `2024-02-01 09:30:00` sorts and scans visually while
 * `2/1/2024, 9:30:00 AM` does neither.
 */
export function formatTimestamp(ms: number): string {
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return String(ms);
	const base =
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	const millis = date.getMilliseconds();
	return millis ? `${base}.${pad(millis, 3)}` : base;
}

/**
 * Render a DATE column value.
 *
 * A parquet DATE is a day count with no timezone, decoded as UTC midnight, so
 * it is formatted in UTC. Using local time would show the previous day for
 * every user west of Greenwich.
 */
export function formatDateOnly(ms: number): string {
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return String(ms);
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Display text for one cell. Null renders as empty; callers style the gap. */
export function formatCell(value: ParquetCellValue, kind: ParquetValueKind): string {
	if (value === null) return '';
	switch (kind) {
		case 'timestamp':
			return typeof value === 'number' ? formatTimestamp(value) : String(value);
		case 'date':
			return typeof value === 'number' ? formatDateOnly(value) : String(value);
		case 'integer':
		case 'float':
		case 'decimal':
			return typeof value === 'number' ? NUMBER_FORMAT.format(value) : String(value);
		case 'boolean':
			return value ? 'true' : 'false';
		default:
			return String(value);
	}
}

/**
 * Full-fidelity text for a cell: what the record view shows and what a copy
 * puts on the clipboard.
 *
 * Differs from {@link formatCell} in refusing to group digits, so a copied
 * value pastes back into a query as a number rather than as `1,204,993`.
 */
export function formatCellExact(value: ParquetCellValue, kind: ParquetValueKind): string {
	if (value === null) return '';
	if (kind === 'timestamp' && typeof value === 'number') {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
	}
	if (kind === 'date' && typeof value === 'number') return formatDateOnly(value);
	return String(value);
}

/** Numerics and instants right-align so their magnitudes line up. */
export function columnAlignment(kind: ParquetValueKind): 'left' | 'right' {
	return kind === 'integer' ||
		kind === 'float' ||
		kind === 'decimal' ||
		kind === 'timestamp' ||
		kind === 'date'
		? 'right'
		: 'left';
}

/** Compact type badge, e.g. `int64`, `string`, `ts(us)`, `dec(10,2)`. */
export function columnTypeBadge(column: ParquetColumnInfo): string {
	if (column.nested) return column.logicalType?.toLowerCase() ?? 'nested';
	if (column.kind === 'timestamp')
		return `ts${column.timeUnit ? `(${column.timeUnit.slice(0, 2).toLowerCase()}s)` : ''}`;
	if (column.kind === 'date') return 'date';
	if (column.kind === 'decimal')
		return column.logicalType?.toLowerCase().replace('decimal', 'dec') ?? 'decimal';
	if (column.kind === 'boolean') return 'bool';
	if (column.kind === 'string') return 'string';
	if (column.physicalType === 'INT32') return 'int32';
	if (column.physicalType === 'INT64') return 'int64';
	if (column.physicalType === 'FLOAT') return 'float';
	if (column.physicalType === 'DOUBLE') return 'double';
	return column.physicalType?.toLowerCase() ?? column.kind;
}

/**
 * Quote a column name for the filter language when it needs it.
 *
 * Bare identifiers stop at any operator or delimiter character, so a column
 * named `order id` or `total($)` has to be bracketed to survive the tokenizer.
 */
export function quoteColumnName(name: string): string {
	return /^[^\s()=,!<>~^$&|'"`[\]]+$/.test(name) ? name : `[${name}]`;
}

/**
 * Build the filter clause the user gets when they click a cell's "filter to
 * this value" affordance.
 *
 * Values are quoted whenever they contain anything the tokenizer would treat
 * as structure, and timestamps become the ISO instant the filter language
 * parses back to the same moment.
 */
export function buildEqualityClause(column: ParquetColumnInfo, value: ParquetCellValue): string {
	const name = quoteColumnName(column.name);
	if (value === null) return `${name} is null`;
	if (column.kind === 'timestamp' && typeof value === 'number') {
		return `${name} = "${new Date(value).toISOString()}"`;
	}
	if (column.kind === 'date' && typeof value === 'number')
		return `${name} = ${formatDateOnly(value)}`;
	if (typeof value === 'boolean') return `${name} = ${value}`;
	const text = String(value);
	return /^[^\s()=,!<>~^$&|'"`[\]]+$/.test(text)
		? `${name} = ${text}`
		: `${name} = "${text.replace(/"/g, '\\"')}"`;
}
