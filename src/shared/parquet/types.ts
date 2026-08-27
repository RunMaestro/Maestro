/**
 * Parquet Preview Types
 *
 * The wire contract between the main-process parquet query engine
 * (src/main/parquet/) and the renderer's ParquetViewer.
 *
 * Two rules shape this file:
 *
 *  1. **Bytes never cross IPC.** A parquet file can be gigabytes; the renderer
 *     only ever receives metadata and the window of rows it is displaying. The
 *     file itself stays behind an open file handle in the main process, read
 *     positionally a row group at a time. This mirrors how audio/video avoid
 *     the base64 path (see src/shared/mediaTypes.ts).
 *
 *  2. **Types live on the column, values are plain scalars.** Parquet is
 *     strongly typed, so the renderer learns a column is a timestamp / decimal
 *     / int64 exactly once, from {@link ParquetColumnInfo}, and every cell in
 *     that column arrives as a bare `string | number | boolean | null`. The
 *     alternative - tagging every cell with its type - multiplies a 500x60
 *     window by an object per cell for information that is constant down the
 *     column.
 */

/** Physical storage type as written in the parquet schema. */
export type ParquetPhysicalType =
	| 'BOOLEAN'
	| 'INT32'
	| 'INT64'
	| 'INT96'
	| 'FLOAT'
	| 'DOUBLE'
	| 'BYTE_ARRAY'
	| 'FIXED_LEN_BYTE_ARRAY';

/**
 * How a column behaves for filtering, sorting, alignment, and formatting.
 *
 * This is deliberately coarser than the parquet logical-type zoo: the viewer
 * only needs to know how to compare a value, how to right-align it, and how to
 * turn a filter literal into something comparable.
 */
export type ParquetValueKind =
	| 'string'
	| 'integer'
	| 'decimal'
	| 'float'
	| 'boolean'
	| 'timestamp'
	| 'date'
	| 'time'
	| 'binary'
	| 'json';

/** Aggregate statistics for one column, folded across every row group. */
export interface ParquetColumnStats {
	/** Rows whose value is null, summed across row groups. */
	nullCount: number | null;
	/** Smallest value seen, already converted to the wire representation. */
	min: string | number | boolean | null;
	/** Largest value seen, already converted to the wire representation. */
	max: string | number | boolean | null;
	/** True when at least one row group withheld statistics, so min/max are partial. */
	partial: boolean;
}

/** One top-level column of the parquet schema. */
export interface ParquetColumnInfo {
	/** Column name as it appears in the schema (the filter language's identifier). */
	name: string;
	physicalType: ParquetPhysicalType | null;
	/** Parquet logical/converted type name, e.g. `STRING`, `TIMESTAMP`, `DECIMAL`. */
	logicalType: string | null;
	kind: ParquetValueKind;
	/**
	 * Resolution of a `timestamp` / `time` column, which decides how a filter
	 * literal in epoch milliseconds converts back to the physical integer the
	 * row-group statistics are recorded in. Absent for every other kind.
	 */
	timeUnit?: 'MILLIS' | 'MICROS' | 'NANOS';
	/** REQUIRED columns can never be null, which the schema panel calls out. */
	optional: boolean;
	/** True for LIST / MAP / STRUCT columns, which render as JSON and cannot be pushed down. */
	nested: boolean;
	/** Compression codec of this column's chunks (`SNAPPY`, `ZSTD`, ...). */
	compression: string | null;
	/** Compressed bytes across all row groups. */
	compressedBytes: number;
	/** Uncompressed bytes across all row groups. */
	uncompressedBytes: number;
	stats: ParquetColumnStats;
}

/** Per-row-group summary, used by the pruning readout. */
export interface ParquetRowGroupInfo {
	rows: number;
	compressedBytes: number;
}

/** Everything the viewer knows about a file before it reads a single row. */
export interface ParquetFileInfo {
	handle: string;
	/** Path of the file as the user sees it (the remote path when over SSH). */
	displayPath: string;
	fileBytes: number;
	totalRows: number;
	columns: ParquetColumnInfo[];
	rowGroups: ParquetRowGroupInfo[];
	/** `created_by` from the footer, e.g. `parquet-cpp-arrow version 14.0.1`. */
	createdBy: string | null;
	/** Parquet format version from the footer. */
	formatVersion: number;
	/** Key/value footer metadata, minus the giant `ARROW:schema` blob. */
	keyValueMetadata: { key: string; value: string }[];
	/** Present when the file was pulled off an SSH remote into a local cache. */
	fetchedFromRemote?: boolean;
}

/** A single cell, already normalized to something structured-clone-safe. */
export type ParquetCellValue = string | number | boolean | null;

/** Which direction a sort runs, and on what. */
export interface ParquetSortSpec {
	column: string;
	direction: 'asc' | 'desc';
}

export interface ParquetQueryRequest {
	handle: string;
	/** Raw filter expression as typed by the user. Empty means "no filter". */
	filter: string;
	/** Columns to materialize, in display order. Empty means every column. */
	columns?: string[];
	sort?: ParquetSortSpec | null;
	offset: number;
	limit: number;
	/**
	 * Drive the scan toward completion rather than stopping as soon as the
	 * window is filled.
	 *
	 * Row delivery is deliberately lazy - the grid wants its first page before
	 * the file has been read - which means `matchedRows` is a lower bound until
	 * the scan finishes. The viewer sets this on a follow-up call so the exact
	 * total converges in the background without delaying the first paint. The
	 * per-call time budget still applies, so this may need several calls.
	 */
	countAll?: boolean;
}

/** What the engine did to answer a query - the material for the stats readout. */
export interface ParquetScanStats {
	rowGroupsTotal: number;
	/** Row groups the engine actually decoded. */
	rowGroupsScanned: number;
	/**
	 * Row groups eliminated by statistics, bloom filters, or page indexes
	 * before any of their data pages were read. This is the number that makes
	 * a filtered scan of a multi-GB file feel instant.
	 */
	rowGroupsPruned: number;
	/** Bytes actually pulled off disk for this scan. */
	bytesRead: number;
	/** Rows examined after pruning (i.e. rows the residual predicate ran on). */
	rowsExamined: number;
	/** Wall-clock time the engine spent, in milliseconds. */
	elapsedMs: number;
	/** True when the predicate was fully expressible as parquet-level pushdown. */
	fullyPushedDown: boolean;
	/** Columns the engine had to decode (filter columns plus projected columns). */
	columnsRead: string[];
}

export interface ParquetQueryResult {
	/** Row-major window of cells, one inner array per row, in `columns` order. */
	rows: ParquetCellValue[][];
	/** Column names in the order the cells appear. */
	columns: string[];
	/**
	 * Zero-based file row index for each returned row, so the grid can show a
	 * stable row number that survives filtering and sorting.
	 */
	rowIndexes: number[];
	/** Rows matched so far. Exact once `complete` is true, a lower bound before. */
	matchedRows: number;
	/** True when the engine finished scanning the file for this predicate. */
	complete: boolean;
	/** True when the match set hit the engine's materialization cap. */
	truncated: boolean;
	stats: ParquetScanStats;
	/** Non-fatal filter problems (unknown column, unparsable literal). */
	filterError?: ParquetFilterProblem;
}

/** A filter expression that failed to parse or bind. */
export interface ParquetFilterProblem {
	message: string;
	/** Character offset into the expression where the problem starts. */
	start: number;
	/** Character offset just past the problem. */
	end: number;
	/** Closest matching column name, when the problem was a typo'd identifier. */
	suggestion?: string;
}
