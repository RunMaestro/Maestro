/**
 * Rows to CSV and JSON Lines, for a data viewer's Export.
 *
 * Shared by the Parquet viewer's export of its matches
 * (`exportParquetMatches()` in src/main/parquet/parquet-query.ts) and the
 * SQLite viewer's export of a query's result (the SQLite child process,
 * src/main/sqlite/sqlite-query-task.ts), so a file written by either reads
 * the same. Only the encoding lives here; each caller owns its own I/O.
 *
 * CSV: a header line of the column names, then one line per row. A field is
 * quoted only when it holds a quote, a comma, or a line break, with inner
 * quotes doubled (RFC 4180). NULL is an empty field.
 *
 * JSON Lines: one object per row, keyed by column name. A column name that
 * repeats (`SELECT a, a`) would collapse into one key, so later copies are
 * keyed `a_2`, `a_3` (`tabularRecordKeys()`). An integer arrives as a
 * `bigint` when it may be past 2^53, and is written as its exact digits,
 * which is valid JSON; a non-finite number, which JSON cannot hold, is
 * written as the string `"Infinity"`, `"-Infinity"`, or `"NaN"`.
 */

/** The two formats an Export writes. */
export type TabularExportFormat = 'csv' | 'jsonl';

/** One cell as an export receives it. */
export type TabularExportValue = string | number | boolean | bigint | null;

/** The choices a save dialog offers for an export, CSV first (the default). */
export const TABULAR_EXPORT_FILE_FILTERS: ReadonlyArray<{ name: string; extensions: string[] }> = [
	{ name: 'CSV', extensions: ['csv'] },
	{ name: 'JSON Lines', extensions: ['jsonl'] },
];

/** Whether a value names an export format. */
export function isTabularExportFormat(value: unknown): value is TabularExportFormat {
	return value === 'csv' || value === 'jsonl';
}

/** The format a destination's extension asks for: `.jsonl` / `.ndjson` is JSON Lines, else CSV. */
export function tabularExportFormatForPath(filePath: string): TabularExportFormat {
	return /\.(jsonl|ndjson)$/i.test(filePath) ? 'jsonl' : 'csv';
}

/** One CSV field, quoted only when its content forces it. */
export function csvField(value: TabularExportValue): string {
	if (value === null) return '';
	const text = String(value);
	return /[",\n\r]/.test(text) ? `"${text.split('"').join('""')}"` : text;
}

/** One value as JSON text, keeping every digit of a `bigint`. */
function jsonValue(value: TabularExportValue): string {
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
	return JSON.stringify(value);
}

/**
 * The keys a JSON Lines record uses for `columns`: each name as it is, and a
 * repeat of one suffixed `_2`, `_3`, ... (skipping any suffix another column
 * already uses), so no value is lost to a duplicate key.
 */
export function tabularRecordKeys(columns: readonly string[]): string[] {
	const taken = new Set(columns);
	const seen = new Set<string>();
	return columns.map((name) => {
		if (!seen.has(name)) {
			seen.add(name);
			return name;
		}
		let suffix = 2;
		while (taken.has(`${name}_${suffix}`)) suffix++;
		const key = `${name}_${suffix}`;
		taken.add(key);
		return key;
	});
}

/** Turns rows into lines of one format. */
export interface TabularRowEncoder {
	/** Text that goes before the first row: the CSV header line, or nothing for JSON Lines. */
	header: string;
	/** One row, in `columns` order, as one line with its newline. */
	row: (values: readonly TabularExportValue[]) => string;
}

/** An encoder for rows with these columns, in this format. */
export function createTabularRowEncoder(
	format: TabularExportFormat,
	columns: readonly string[]
): TabularRowEncoder {
	if (format === 'csv') {
		return {
			header: `${columns.map(csvField).join(',')}\n`,
			row: (values) => `${values.map(csvField).join(',')}\n`,
		};
	}
	const keys = tabularRecordKeys(columns).map((key) => JSON.stringify(key));
	return {
		header: '',
		row: (values) =>
			`{${keys.map((key, index) => `${key}:${jsonValue(values[index] ?? null)}`).join(',')}}\n`,
	};
}
