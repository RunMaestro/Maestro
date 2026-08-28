/**
 * Parquet Query Engine
 *
 * Answers "give me rows N..N+M matching this filter" against an open parquet
 * file without ever materializing the file, and reports honestly how much work
 * that took.
 *
 * The engine is built around three ideas, in descending order of how much they
 * matter:
 *
 *  1. **Pushdown.** The filter is compiled (see shared/parquet/pushdown.ts)
 *     into a conservative parquet-level predicate and handed to hyparquet as a
 *     `pruningFilter`. Row groups whose footer statistics, bloom filters, or
 *     page indexes prove they cannot match are eliminated before a single data
 *     page is fetched. `pruningFilter` is used rather than the plain `filter`
 *     option specifically because it prunes physical ranges *without* dropping
 *     individual rows, leaving row-level truth entirely to the residual pass
 *     below - so a bound that is merely conservative can never lose a row.
 *
 *  2. **Two-phase projection.** Within a surviving range, only the columns the
 *     predicate mentions are decoded first. Ranges where nothing matches never
 *     touch the wide columns at all, which is the common case for a selective
 *     filter over a wide table.
 *
 *  3. **A resumable match set.** Scanning stops as soon as the requested page
 *     is satisfied (or a time budget expires) and picks up from the same range
 *     next call. Paging through a filtered 100M-row file therefore costs one
 *     forward pass in total, not one pass per page.
 *
 * Match sets are cached per filter, not per (filter, columns), so showing or
 * hiding a column re-materializes a page instead of re-running the scan.
 */

import { promises as fs } from 'fs';
import path from 'path';

import type { ParquetQueryFilter, ParquetScan } from 'hyparquet';

import {
	bindFilterExpression,
	evaluateFilterNode,
	toComparable,
	type FilterNode,
} from '../../shared/parquet/filterExpression';
import { compileFilterPushdown } from '../../shared/parquet/pushdown';
import type {
	ParquetCellValue,
	ParquetColumnInfo,
	ParquetFilterProblem,
	ParquetQueryRequest,
	ParquetQueryResult,
	ParquetScanStats,
	ParquetSortSpec,
	ParquetValueKind,
} from '../../shared/parquet/types';
import { getParquetFile, loadParquetReader, type OpenParquetFile } from './parquet-file';

/**
 * Most matching row indexes the engine will retain.
 *
 * Row indexes are plain numbers, so this is a few megabytes - the cap exists
 * to bound the *scan*, not the memory. Past this the answer stops being
 * something a person reads and starts being something they should narrow.
 */
const MAX_MATCHED_ROWS = 500_000;

/**
 * Wall-clock budget for one query call.
 *
 * Exceeding it returns a partial, honestly-labelled result rather than pinning
 * the main process. The renderer sees `complete: false` and asks again, so a
 * long scan streams its progress instead of freezing the window.
 */
const MAX_QUERY_MS = 2_500;

/** Rows the engine will sort. Sorting needs the whole match set materialized. */
const MAX_SORT_ROWS = 200_000;

/** Bytes of a binary cell rendered as hex before it is elided. */
const MAX_BINARY_PREVIEW_BYTES = 24;

/** Characters of a JSON-rendered nested cell kept for the grid. */
const MAX_JSON_CELL_CHARS = 500;

/** A physical, half-open row range in the file. */
interface ScanRange {
	rowStart: number;
	rowEnd: number;
}

/**
 * Cached progress for one filter against one file.
 *
 * `identity` is the no-filter case: every row matches, so the match set is the
 * row numbers themselves and is never materialized. Without this a 100M-row
 * unfiltered preview would allocate a 100M-entry array to say "all of them".
 */
interface ScanSession {
	filterSource: string;
	node: FilterNode | null;
	problem?: ParquetFilterProblem;
	identity: boolean;
	/**
	 * The expression did not parse or bind, so the session matches nothing.
	 * Distinct from `identity` (no filter at all): showing every row under a
	 * red error message reads as "filtering is broken", not as "your
	 * expression is broken".
	 */
	blocked: boolean;
	scan: ParquetScan;
	ranges: ScanRange[];
	/** Next range to decode when the match set needs extending. */
	nextRange: number;
	matched: number[];
	complete: boolean;
	truncated: boolean;
	rowGroupsPruned: number;
	rowGroupsScanned: number;
	rowsExamined: number;
	fullyPushedDown: boolean;
	filterColumns: string[];
	/** Sorted view of the match set, keyed by `column:direction`. */
	sorted: Map<string, number[]>;
}

/** Serializes queries per file so two scans cannot interleave on one session. */
const queryQueues = new Map<string, Promise<unknown>>();

function runExclusive<T>(handle: string, task: () => Promise<T>): Promise<T> {
	const previous = queryQueues.get(handle) ?? Promise.resolve();
	const next = previous.then(task, task);
	queryQueues.set(
		handle,
		next.catch(() => undefined)
	);
	return next;
}

/** Yield to the event loop so a long scan cannot starve IPC. */
function breathe(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// ─── Value normalization ──────────────────────────────────────────────────────

/**
 * Reduce a decoded parquet value to a structured-clone-safe scalar.
 *
 * The column's kind travels separately (see ParquetColumnInfo), so a timestamp
 * arrives as epoch milliseconds and the renderer formats it - rather than
 * every cell carrying a type tag for information that is constant down the
 * column.
 */
export function normalizeCell(value: unknown, kind: ParquetValueKind): ParquetCellValue {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'bigint') {
		const asNumber = Number(value);
		// Past 2^53 a number would round, and an INT64 id that renders as a
		// neighbouring value is worse than one that renders as text.
		return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
	}
	if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
		return value;
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		let hex = '';
		for (const byte of bytes.subarray(0, MAX_BINARY_PREVIEW_BYTES))
			hex += byte.toString(16).padStart(2, '0');
		return bytes.length > MAX_BINARY_PREVIEW_BYTES ? `${hex}… (${bytes.length} bytes)` : hex;
	}
	if (kind === 'json' || typeof value === 'object') {
		try {
			const text = JSON.stringify(value, (_key, inner) =>
				typeof inner === 'bigint' ? inner.toString() : inner
			);
			if (text === undefined) return String(value);
			return text.length > MAX_JSON_CELL_CHARS ? `${text.slice(0, MAX_JSON_CELL_CHARS)}…` : text;
		} catch {
			return String(value);
		}
	}
	return String(value);
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

/** Which row groups a set of ranges touches, for the pruning readout. */
function countGroupsTouched(file: OpenParquetFile, ranges: ScanRange[]): number {
	const boundaries: { start: number; end: number }[] = [];
	let cursor = 0;
	for (const group of file.metadata.row_groups) {
		const rows = Number(group.num_rows);
		boundaries.push({ start: cursor, end: cursor + rows });
		cursor += rows;
	}
	let touched = 0;
	for (const bound of boundaries) {
		if (ranges.some((range) => range.rowStart < bound.end && range.rowEnd > bound.start)) touched++;
	}
	return touched;
}

/**
 * Build (or reuse) the scan session for a filter.
 *
 * The pruning filter is applied here, when the scan is prepared, because that
 * is when hyparquet consults statistics, bloom filters, and page indexes to
 * decide which physical ranges are worth reading at all.
 */
async function getSession(file: OpenParquetFile, filterSource: string): Promise<ScanSession> {
	const cached = file.scans.get(filterSource) as ScanSession | undefined;
	if (cached) return cached;

	const { hyparquet } = await loadParquetReader();
	const bound = bindFilterExpression(filterSource, file.info.columns);
	// A filter that does not parse must not silently behave as "no filter":
	// showing every row under a broken expression reads as the filter being
	// ignored. The problem travels with the session and the caller surfaces it.
	const node = bound.problem ? null : bound.node;
	const pushdown = compileFilterPushdown(node, file.info.columns);

	const readableColumns = file.info.columns.map((column) => column.name);
	const scan = await hyparquet.parquetScan({
		file: file.buffer,
		metadata: file.metadata,
		columns: readableColumns,
		compressors: file.compressors,
		// Structurally identical to hyparquet's filter union; the cast just
		// picks the branch TypeScript cannot infer from an index signature.
		...(pushdown.filter ? { pruningFilter: pushdown.filter as ParquetQueryFilter } : {}),
		useBloomFilters: true,
		usePageIndex: true,
	});

	const ranges: ScanRange[] = scan.ranges.map((range) => ({
		rowStart: range.rowStart,
		rowEnd: range.rowEnd,
	}));
	const blocked = Boolean(bound.problem);
	const session: ScanSession = {
		filterSource,
		node,
		...(bound.problem ? { problem: bound.problem } : {}),
		identity: node === null && !blocked,
		blocked,
		scan,
		ranges,
		nextRange: 0,
		matched: [],
		complete: node === null || blocked,
		truncated: false,
		rowGroupsPruned: blocked
			? 0
			: file.metadata.row_groups.length - countGroupsTouched(file, ranges),
		rowGroupsScanned: 0,
		rowsExamined: 0,
		fullyPushedDown: node !== null && pushdown.complete,
		filterColumns: bound.scansAllColumns ? readableColumns : bound.columns,
		sorted: new Map(),
	};

	// Only one session is kept per file. Filters are typed character by
	// character, so an unbounded cache would pin a scan (and its decoded
	// column cache) for every prefix the user passed through.
	file.scans.clear();
	file.scans.set(filterSource, session);
	return session;
}

/** Row count in the match set so far, without materializing the identity case. */
function matchCount(file: OpenParquetFile, session: ScanSession): number {
	return session.identity ? file.info.totalRows : session.matched.length;
}

/**
 * Extend the match set until it holds `needed` rows, the file is exhausted, or
 * the time budget runs out.
 */
async function extendMatches(
	file: OpenParquetFile,
	session: ScanSession,
	needed: number,
	deadline: number
): Promise<void> {
	if (session.identity || session.complete || !session.node) return;

	const allColumns = file.info.columns.map((column) => column.name);
	const filterColumns = session.filterColumns.length > 0 ? session.filterColumns : allColumns;

	while (session.nextRange < session.ranges.length) {
		if (session.matched.length >= needed) return;
		if (Date.now() > deadline) return;
		if (session.matched.length >= MAX_MATCHED_ROWS) {
			session.truncated = true;
			session.complete = true;
			return;
		}

		const range = session.ranges[session.nextRange++];
		session.rowGroupsScanned++;
		session.rowsExamined += range.rowEnd - range.rowStart;

		// Phase one: decode only the columns the predicate mentions. A range
		// where nothing matches never reaches phase two, so the wide columns
		// are never touched for it.
		const decoded = new Map<string, ArrayLike<unknown>>();
		for (const column of filterColumns) {
			decoded.set(
				column,
				(await session.scan.readColumn({ column, ...range })) as ArrayLike<unknown>
			);
		}

		const rows = range.rowEnd - range.rowStart;
		for (let i = 0; i < rows; i++) {
			const accessor = (column: string) => decoded.get(column)?.[i];
			if (evaluateFilterNode(session.node, accessor, allColumns)) {
				session.matched.push(range.rowStart + i);
				if (session.matched.length >= MAX_MATCHED_ROWS) {
					session.truncated = true;
					session.complete = true;
					break;
				}
			}
		}

		await breathe();
	}

	if (session.nextRange >= session.ranges.length) session.complete = true;
}

/** Finish the scan outright. Required before sorting, which needs every match. */
async function completeMatches(
	file: OpenParquetFile,
	session: ScanSession,
	deadline: number
): Promise<void> {
	await extendMatches(file, session, MAX_MATCHED_ROWS, deadline);
}

// ─── Sorting ──────────────────────────────────────────────────────────────────

/** Ordering that puts nulls last in both directions, as every grid expects. */
function compareForSort(a: unknown, b: unknown, direction: 'asc' | 'desc'): number {
	const left = toComparable(a);
	const right = toComparable(b);
	if (left === null && right === null) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	let order: number;
	if (typeof left === 'string' && typeof right === 'string') {
		order = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
	} else if (typeof left === 'string' || typeof right === 'string') {
		order = String(left).localeCompare(String(right), undefined, {
			numeric: true,
			sensitivity: 'base',
		});
	} else {
		order = left < right ? -1 : left > right ? 1 : 0;
	}
	return direction === 'asc' ? order : -order;
}

/**
 * Order the match set by one column.
 *
 * Sorting is the one operation that cannot be answered from a window: the
 * first row of a sorted result can live anywhere in the file, so the whole
 * match set has to exist first. The sorted permutation is cached per column
 * and direction, so flipping the arrow is free.
 */
async function sortedMatches(
	file: OpenParquetFile,
	session: ScanSession,
	sort: ParquetSortSpec,
	deadline: number
): Promise<{ order: number[]; sortTruncated: boolean }> {
	const key = `${sort.column}:${sort.direction}`;
	const cached = session.sorted.get(key);
	if (cached) return { order: cached, sortTruncated: cached.length >= MAX_SORT_ROWS };

	await completeMatches(file, session, deadline);
	const indexes = session.identity
		? Array.from({ length: Math.min(file.info.totalRows, MAX_SORT_ROWS) }, (_, i) => i)
		: session.matched.slice(0, MAX_SORT_ROWS);

	const values = await readColumnForRows(session, sort.column, indexes);
	const order = indexes
		.map((rowIndex, position) => ({ rowIndex, value: values[position] }))
		.sort((a, b) => compareForSort(a.value, b.value, sort.direction))
		.map((entry) => entry.rowIndex);

	session.sorted.set(key, order);
	return { order, sortTruncated: indexes.length >= MAX_SORT_ROWS };
}

// ─── Materialization ──────────────────────────────────────────────────────────

/** Locate the scan range containing a row, or -1 when the row was pruned away. */
function findRange(ranges: ScanRange[], rowIndex: number): number {
	let low = 0;
	let high = ranges.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (rowIndex < ranges[mid].rowStart) high = mid - 1;
		else if (rowIndex >= ranges[mid].rowEnd) low = mid + 1;
		else return mid;
	}
	return -1;
}

/**
 * Read one column's values for an arbitrary set of row indexes.
 *
 * Rows are grouped by the range that contains them so each range is decoded
 * once, which matters because the rows arrive in file order for an unsorted
 * page and in scattered order for a sorted one.
 */
async function readColumnForRows(
	session: ScanSession,
	column: string,
	rowIndexes: number[]
): Promise<unknown[]> {
	const out = new Array<unknown>(rowIndexes.length);
	const byRange = new Map<number, number[]>();
	for (let i = 0; i < rowIndexes.length; i++) {
		const rangeIndex = findRange(session.ranges, rowIndexes[i]);
		if (rangeIndex < 0) {
			out[i] = null;
			continue;
		}
		const bucket = byRange.get(rangeIndex);
		if (bucket) bucket.push(i);
		else byRange.set(rangeIndex, [i]);
	}

	for (const [rangeIndex, positions] of byRange) {
		const range = session.ranges[rangeIndex];
		const data = (await session.scan.readColumn({ column, ...range })) as ArrayLike<unknown>;
		for (const position of positions) {
			out[position] = data[rowIndexes[position] - range.rowStart];
		}
	}
	return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Run one windowed query against an open parquet file. */
export function queryParquet(request: ParquetQueryRequest): Promise<ParquetQueryResult> {
	return runExclusive(request.handle, async () => {
		const started = Date.now();
		const deadline = started + MAX_QUERY_MS;
		const file = getParquetFile(request.handle);
		const bytesBefore = file.buffer.bytesRead;

		const session = await getSession(file, request.filter ?? '');
		const columnByName = new Map(file.info.columns.map((column) => [column.name, column]));
		const projection = (
			request.columns?.length ? request.columns : file.info.columns.map((c) => c.name)
		).filter((name) => columnByName.has(name));

		const offset = Math.max(0, request.offset);
		const limit = Math.max(0, Math.min(request.limit, 5_000));

		let rowIndexes: number[];
		let sortTruncated = false;
		if (request.sort && columnByName.has(request.sort.column)) {
			const { order, sortTruncated: truncatedSort } = await sortedMatches(
				file,
				session,
				request.sort,
				deadline
			);
			sortTruncated = truncatedSort;
			rowIndexes = order.slice(offset, offset + limit);
		} else if (request.countAll) {
			// Counting mode: push the scan forward rather than stopping at the
			// window, so `matchedRows` converges on the true total.
			await completeMatches(file, session, deadline);
			rowIndexes = session.identity
				? Array.from(
						{ length: Math.max(0, Math.min(limit, file.info.totalRows - offset)) },
						(_, i) => offset + i
					)
				: session.matched.slice(offset, offset + limit);
		} else {
			await extendMatches(file, session, offset + limit, deadline);
			rowIndexes = session.identity
				? Array.from(
						{ length: Math.max(0, Math.min(limit, file.info.totalRows - offset)) },
						(_, i) => offset + i
					)
				: session.matched.slice(offset, offset + limit);
		}

		// Serialized rather than parallel: each column read decodes a whole
		// range, so N concurrent reads means N decoded column buffers alive at
		// once, and a wide table would spike memory for no I/O win (the reads
		// hit the same already-open file handle).
		const columnValues: unknown[][] = [];
		for (const column of projection) {
			columnValues.push(await readColumnForRows(session, column, rowIndexes));
		}

		const rows: ParquetCellValue[][] = rowIndexes.map((_, rowPosition) =>
			projection.map((column, columnPosition) =>
				normalizeCell(
					columnValues[columnPosition][rowPosition],
					columnByName.get(column)?.kind ?? 'string'
				)
			)
		);

		const stats: ParquetScanStats = {
			rowGroupsTotal: file.metadata.row_groups.length,
			rowGroupsScanned: session.identity
				? countGroupsTouched(file, session.ranges)
				: session.rowGroupsScanned,
			rowGroupsPruned: session.rowGroupsPruned,
			bytesRead: file.buffer.bytesRead - bytesBefore,
			rowsExamined: session.identity ? file.info.totalRows : session.rowsExamined,
			elapsedMs: Date.now() - started,
			fullyPushedDown: session.fullyPushedDown,
			columnsRead: [...new Set([...session.filterColumns, ...projection])],
		};

		return {
			rows,
			columns: projection,
			rowIndexes,
			matchedRows: matchCount(file, session),
			complete: session.complete,
			truncated: session.truncated || sortTruncated,
			stats,
			...(session.problem ? { filterError: session.problem } : {}),
		};
	});
}

/** Escape one CSV field, quoting only when the content forces it. */
function toCsvField(value: ParquetCellValue): string {
	if (value === null) return '';
	const text = String(value);
	return /[",\n\r]/.test(text) ? `"${text.split('"').join('""')}"` : text;
}

/**
 * Write the current match set to disk as CSV or JSON Lines.
 *
 * Streams in pages so an export larger than memory still completes, and stops
 * at the engine's match cap with the same honesty the grid shows.
 */
export async function exportParquetMatches(options: {
	handle: string;
	filter: string;
	columns?: string[];
	sort?: ParquetSortSpec | null;
	destPath: string;
	format: 'csv' | 'jsonl';
	maxRows?: number;
}): Promise<{ path: string; rows: number; truncated: boolean }> {
	const pageSize = 2_000;
	const maxRows = Math.min(options.maxRows ?? MAX_MATCHED_ROWS, MAX_MATCHED_ROWS);
	await fs.mkdir(path.dirname(options.destPath), { recursive: true });
	const output = await fs.open(options.destPath, 'w');

	try {
		let written = 0;
		let header: string[] | null = null;
		let truncated = false;
		let emptyPages = 0;

		for (;;) {
			const page = await queryParquet({
				handle: options.handle,
				filter: options.filter,
				...(options.columns ? { columns: options.columns } : {}),
				sort: options.sort ?? null,
				offset: written,
				limit: Math.min(pageSize, maxRows - written),
			});

			if (!header) {
				header = page.columns;
				if (options.format === 'csv') await output.write(`${header.map(toCsvField).join(',')}\n`);
			}

			for (const row of page.rows) {
				if (options.format === 'csv') {
					await output.write(`${row.map(toCsvField).join(',')}\n`);
				} else {
					const record: Record<string, ParquetCellValue> = {};
					page.columns.forEach((column, index) => {
						record[column] = row[index];
					});
					await output.write(`${JSON.stringify(record)}\n`);
				}
			}

			written += page.rows.length;
			truncated = page.truncated;
			if (written >= maxRows) break;
			if (page.rows.length === 0) {
				// An empty page can mean "no more matches" or "this call ran
				// out of its time budget mid-scan". Only the first ends the
				// export; the second gets another turn, since each call
				// advances the scan by a bounded amount.
				if (page.complete) break;
				if (++emptyPages > 10_000) break;
				continue;
			}
			emptyPages = 0;
		}

		return { path: options.destPath, rows: written, truncated: truncated || written >= maxRows };
	} finally {
		await output.close();
	}
}

/** Test seam: the column-kind lookup used when normalizing a page of cells. */
export type { ParquetColumnInfo };
