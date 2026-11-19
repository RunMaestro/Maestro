/**
 * SqliteTableView - the rows of the selected table or view, in the shared
 * `<DataGrid>`, under the shared `<FilterExpressionBar>`.
 *
 * Rows are paged from the main process with `LIMIT`/`OFFSET` (see
 * src/main/sqlite/sqlite-rows.ts): the first window on selection, the next
 * when the grid scrolls near the end of what is loaded. A header click sorts
 * in SQLite (`ORDER BY`), and the filter box compiles to a parameterised
 * `WHERE` there (src/shared/sqlite/filter.ts), so both cover the whole table
 * and either change starts again from the first window. Nothing is sorted or
 * filtered over the loaded rows.
 *
 * The parent remounts this per object (`key`), so a selection change never
 * shows the previous object's rows; it keeps each object's filter text, so
 * coming back to a table restores its filter. Within one object, a generation
 * token drops the reply to a window asked for under an older sort or filter,
 * and the rows on screen stay until the new first window replaces them: a
 * filter that does not parse underlines itself and leaves the last good
 * result in place.
 *
 * The footer's total converges, the way the Parquet viewer's does: `300+`
 * from the first window, then `1,204,000+` as the background count walks the
 * table a time budget at a time (src/main/sqlite/sqlite-count.ts), then the
 * exact number. The count runs only between window reads, stops after
 * `AUTO_COUNT_PASSES` calls on a very large table (a "Count all" link
 * continues it from where it stopped), and starts over on a new filter, not
 * on a new sort, which leaves the row set the same.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatCount } from '../../../shared/formatters';
import { useStableCallback } from '../../hooks/utils/useStableCallback';
import { useDebouncedValue } from '../../hooks/utils/useThrottle';
import { formatSqliteCell } from '../../../shared/sqlite/cells';
import { formatSqliteRowCount, sqliteConvergingRowTotal } from '../../../shared/sqlite/objects';
import { sqliteColumnAffinity } from '../../../shared/sqlite/schema';
import type {
	SqliteAffinity,
	SqliteCellValue,
	SqliteCountCursor,
	SqliteFilterProblem,
	SqliteObjectSummary,
	SqliteResultColumn,
	SqliteRowsPage,
	SqliteSortSpec,
} from '../../../shared/sqlite/types';
import type { Theme } from '../../types';
import {
	DataGrid,
	dataGridColumnWidth,
	type DataGridCell,
	type DataGridColumn,
} from '../ui/DataGrid';
import {
	FilterExpressionBar,
	type FilterExpressionBarHandle,
	type FilterExpressionExample,
} from '../ui/FilterExpressionBar';
import { Spinner } from '../ui/Spinner';

/** Rows asked for per window. Large enough to fill a tall pane in one call. */
const PAGE_SIZE = 300;

/** Quiet time after the last keystroke before the filter runs. */
const FILTER_DEBOUNCE_MS = 250;

/**
 * Count calls made on their own before the count waits for "Count all". Each
 * holds the main process for about 50 ms, so this is roughly two seconds of
 * main-process time: every ordinary table settles well inside it.
 */
export const AUTO_COUNT_PASSES = 40;

/** How long the count waits for a window read in flight before trying again. */
const COUNT_WAIT_MS = 120;

/** How far the count has got for one filter. */
interface CountProgress {
	/** The applied filter text this count is for. */
	filter: string;
	matched: number;
	complete: boolean;
	/** Where to resume; null once complete. */
	cursor: SqliteCountCursor | null;
}

/** The syntax popover, in ascending order of sophistication. */
const SYNTAX_EXAMPLES: readonly FilterExpressionExample[] = [
	{ expression: 'acme', description: 'any column contains "acme"' },
	{ expression: 'status = active', description: 'exact match' },
	{ expression: 'price > 100 and qty <= 5', description: 'combine with and / or / not' },
	{ expression: 'region in (us, eu)', description: 'set membership' },
	{ expression: 'id between 100 and 200', description: 'inclusive range' },
	{ expression: 'created_at >= 2024-01-15', description: 'compared the way SQLite compares' },
	{ expression: 'name ~ smith', description: 'contains (ASCII case-insensitive)' },
	{ expression: 'name ~ /^acme-\\d+$/', description: 'regular expression' },
	{ expression: 'path ^= /var/log', description: 'starts with ( $= ends with )' },
	{ expression: 'notes is null', description: 'null tests' },
	{ expression: '[order id] = 42', description: 'bracket names with spaces' },
];

const FOOTNOTE = (
	<>
		Terms sitting next to each other are combined with <code>and</code>. Every value is a bound
		parameter, and SQLite compares it by the column&apos;s affinity: <code>price &gt; 100</code>{' '}
		compares numbers on an INTEGER or REAL column, and a date compares as text where dates are
		stored as text.
	</>
);

/** Typical content width for a column of each affinity. */
const CONTENT_WIDTH: Record<SqliteAffinity, number> = {
	INTEGER: 110,
	REAL: 120,
	NUMERIC: 120,
	TEXT: 200,
	BLOB: 160,
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toGridColumn(column: SqliteResultColumn, strict: boolean): DataGridColumn {
	const declared = column.declaredType ?? '';
	const affinity = sqliteColumnAffinity(declared, strict);
	const typeText =
		column.declaredType === null
			? 'an expression'
			: declared
				? `${declared}, ${affinity} affinity`
				: 'no declared type';
	return {
		key: column.name,
		label: column.name,
		subtitle: declared || undefined,
		title: `${column.name} (${typeText}) - click to sort`,
		initialWidth: dataGridColumnWidth(column.name, CONTENT_WIDTH[affinity]),
		align: affinity === 'TEXT' || affinity === 'BLOB' ? 'left' : 'right',
	};
}

interface SqliteTableViewProps {
	handle: string;
	/** A table or view. */
	object: SqliteObjectSummary;
	/** This object's filter text; the parent keeps it per object. */
	filter: string;
	onFilterChange: (value: string) => void;
	/** Focus the filter box once (Cmd+F), then report it done. */
	focusFilterRequested: boolean;
	onFilterFocused: () => void;
	/** The unfiltered count settled: the rail can replace its capped count. */
	onRowCountSettled?: (name: string, rowCount: number) => void;
	theme: Theme;
}

export function SqliteTableView({
	handle,
	object,
	filter,
	onFilterChange,
	focusFilterRequested,
	onFilterFocused,
	onRowCountSettled,
	theme,
}: SqliteTableViewProps) {
	const [sort, setSort] = useState<SqliteSortSpec | null>(null);
	const appliedFilter = useDebouncedValue(filter.trim(), FILTER_DEBOUNCE_MS);
	const [filterProblem, setFilterProblem] = useState<SqliteFilterProblem | undefined>(undefined);
	const filterBarRef = useRef<FilterExpressionBarHandle>(null);
	const [columns, setColumns] = useState<SqliteResultColumn[] | null>(null);
	const [rows, setRows] = useState<SqliteCellValue[][]>([]);
	const [lastPage, setLastPage] = useState<SqliteRowsPage | null>(null);
	/** The applied filter the rows on screen were read with. */
	const [rowsFilter, setRowsFilter] = useState<string | null>(null);
	const [count, setCount] = useState<CountProgress | null>(null);
	const [counting, setCounting] = useState(false);
	const [countError, setCountError] = useState<string | null>(null);
	/** The filter "Count all" was clicked for; the auto pass limit is lifted for it. */
	const [countAllFor, setCountAllFor] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	/** Bumped on every sort or filter change; a reply for an older one is dropped. */
	const generation = useRef(0);
	/** Generation of the window in flight, or null when none is. */
	const inFlight = useRef<number | null>(null);

	const name = object.name;
	const fetchWindow = useCallback(
		async (offset: number) => {
			const token = generation.current;
			inFlight.current = token;
			setBusy(true);
			try {
				const page = await window.maestro.sqlite.readRows({
					handle,
					name,
					offset,
					limit: PAGE_SIZE,
					sort,
					filter: appliedFilter || null,
				});
				if (token !== generation.current) return;
				if (page.filterProblem) {
					// Nothing was read: keep the last good rows and underline the text.
					// A filter restored on mount can fail before any rows arrived, so
					// the header still comes from this reply.
					setFilterProblem(page.filterProblem);
					setColumns((previous) => previous ?? page.columns);
					return;
				}
				setFilterProblem(undefined);
				setLastPage(page);
				setRowsFilter(appliedFilter);
				if (offset === 0) {
					setColumns(page.columns);
					setRows(page.rows);
				} else {
					setRows((previous) => [...previous, ...page.rows]);
				}
			} catch (failure) {
				if (token === generation.current) setError(errorText(failure));
			} finally {
				if (inFlight.current === token) {
					inFlight.current = null;
					setBusy(false);
				}
			}
		},
		[handle, name, sort, appliedFilter]
	);

	// A new sort or filter means a new row set: start again from the first
	// window. What is on screen stays until that window replaces it, so the
	// header the user just clicked does not vanish under the pointer and a
	// filter mid-edit does not blank the grid.
	useEffect(() => {
		generation.current++;
		setError(null);
		void fetchWindow(0);
	}, [fetchWindow]);

	const handleReachEnd = useCallback(() => {
		if (!lastPage?.hasMore || inFlight.current !== null || error || filterProblem) return;
		void fetchWindow(rows.length);
	}, [lastPage, rows.length, error, filterProblem, fetchWindow]);

	// -- Converging count ---------------------------------------------------

	const countRef = useRef<CountProgress | null>(null);
	const countAll = countAllFor === appliedFilter;
	const reportSettled = useStableCallback((rowCount: number) => {
		onRowCountSettled?.(name, rowCount);
	});

	useEffect(() => {
		let cancelled = false;
		// Resume a count for the same filter ("Count all" after a pause);
		// anything else starts over at the first row.
		const resume = countRef.current?.filter === appliedFilter ? countRef.current : null;
		if (resume?.complete) return;
		if (!resume) {
			countRef.current = null;
			setCount(null);
		}
		setCountError(null);
		let cursor = resume?.cursor ?? null;
		let passes = 0;

		const step = async () => {
			while (!cancelled) {
				if (!countAll && passes >= AUTO_COUNT_PASSES) return;
				// Never race a window read: both hold the main process, and the
				// rows the user is waiting for come first.
				if (inFlight.current !== null) {
					await new Promise((resolve) => window.setTimeout(resolve, COUNT_WAIT_MS));
					continue;
				}
				passes++;
				const result = await window.maestro.sqlite.countRows({
					handle,
					name,
					filter: appliedFilter || null,
					cursor,
				});
				if (cancelled) return;
				// The window read reports the problem and underlines it.
				if (result.filterProblem) return;
				const next: CountProgress = {
					filter: appliedFilter,
					matched: result.matched,
					complete: result.complete,
					cursor: result.cursor,
				};
				countRef.current = next;
				setCount(next);
				if (result.complete || !result.cursor) {
					if (result.complete && !result.filtered) reportSettled(result.matched);
					return;
				}
				cursor = result.cursor;
			}
		};

		setCounting(true);
		step()
			.catch((failure: unknown) => {
				if (!cancelled) setCountError(errorText(failure));
			})
			.finally(() => {
				if (!cancelled) setCounting(false);
			});
		return () => {
			cancelled = true;
		};
	}, [handle, name, appliedFilter, countAll, reportSettled]);

	useEffect(() => {
		if (!focusFilterRequested) return;
		filterBarRef.current?.focus();
		onFilterFocused();
	}, [focusFilterRequested, onFilterFocused]);

	const completions = useMemo(
		() =>
			(columns ?? []).map((column) => ({
				name: column.name,
				detail: column.declaredType || undefined,
			})),
		[columns]
	);

	const handleSortChange = useCallback((next: SqliteSortSpec | null) => setSort(next), []);

	const strict = object.strict === true;
	const gridColumns = useMemo(
		() => (columns ?? []).map((column) => toGridColumn(column, strict)),
		[columns, strict]
	);

	const getCell = useCallback(
		(rowPosition: number, columnPosition: number): DataGridCell => {
			const value = rows[rowPosition]?.[columnPosition] ?? null;
			const cell = formatSqliteCell(value);
			if (value !== null && typeof value === 'object' && value.kind === 'text') {
				return {
					...cell,
					title: `${cell.text}\n(${formatCount(value.length)} characters; the grid shows the first ${formatCount(value.head.length)})`,
				};
			}
			return cell;
		},
		[rows]
	);

	const getRowLabel = useCallback((rowPosition: number) => formatCount(rowPosition + 1), []);

	if (columns === null) {
		if (error) {
			return (
				<div
					className="p-4 text-xs select-text"
					style={{ color: theme.colors.warning }}
					data-testid="sqlite-rows-error"
				>
					Could not read the rows of {name}: {error}
				</div>
			);
		}
		return (
			<div
				className="flex items-center justify-center h-full gap-2 text-sm"
				style={{ color: theme.colors.textDim }}
				data-testid="sqlite-rows-loading"
			>
				<Spinner size={16} decorative />
				Reading rows...
			</div>
		);
	}

	const filtered = lastPage?.filtered === true;
	const total = sqliteConvergingRowTotal({
		loaded: rows.length,
		hasMore: lastPage ? lastPage.hasMore : null,
		// Only a count over the rows on screen; a newer filter's count waits
		// for its own first window.
		count: count && count.filter === rowsFilter ? count : null,
	});
	const totalText = formatSqliteRowCount(total);
	const countPaused =
		!counting && !countError && count !== null && !count.complete && total.rowCountCapped;
	const orderText =
		lastPage === null
			? null
			: lastPage.orderedBy.length > 0
				? `ordered by ${lastPage.orderedBy.join(', ')}`
				: 'in scan order';

	return (
		<div className="flex flex-col h-full min-h-0" data-testid="sqlite-table-view">
			<FilterExpressionBar
				ref={filterBarRef}
				value={filter}
				onChange={onFilterChange}
				columns={completions}
				problem={filterProblem}
				busy={busy && appliedFilter.length > 0}
				busyLabel="filtering…"
				placeholder="Filter rows: try  status = active and price > 100"
				examples={SYNTAX_EXAMPLES}
				footnote={FOOTNOTE}
				testIdPrefix="sqlite"
				theme={theme}
			/>
			<div className="flex-1 min-h-0">
				<DataGrid
					columns={gridColumns}
					rowCount={rows.length}
					getCell={getCell}
					getRowLabel={getRowLabel}
					gutterTitle="Row number in the current order"
					theme={theme}
					sort={sort}
					onSortChange={handleSortChange}
					onReachEnd={handleReachEnd}
					loadingMore={busy && rows.length > 0}
					emptyMessage={`${name} has no columns.`}
					testIdPrefix="sqlite"
				/>
			</div>
			<div
				className="shrink-0 flex items-center gap-3 px-3 py-1.5 text-xs-plus flex-wrap"
				style={{ borderTop: `1px solid ${theme.colors.border}`, color: theme.colors.textDim }}
				data-testid="sqlite-rows-footer"
			>
				<span data-testid="sqlite-rows-total">
					{rows.length > 0 && totalText
						? `${totalText} ${filtered ? 'matching ' : ''}${total.rowCount === 1 && !total.rowCountCapped ? 'row' : 'rows'}`
						: busy
							? 'Reading rows...'
							: filtered
								? 'No matching rows'
								: 'No rows'}
				</span>
				{counting && total.rowCountCapped && (
					<span className="flex items-center gap-1" data-testid="sqlite-rows-counting">
						<Spinner size={10} decorative />
						counting
					</span>
				)}
				{countPaused && (
					<button
						type="button"
						className="underline"
						onClick={() => setCountAllFor(appliedFilter)}
						style={{ color: theme.colors.accentText }}
						title="Keep counting to the last row. Each step briefly holds the app while SQLite counts."
						data-testid="sqlite-count-all"
					>
						Count all
					</button>
				)}
				{rows.length > 0 && (
					<span>
						{formatCount(rows.length)} loaded{lastPage?.hasMore ? ', more below' : ''}
					</span>
				)}
				{orderText && <span>{orderText}</span>}
				{lastPage && <span>{lastPage.elapsedMs} ms</span>}
				{error && (
					<span style={{ color: theme.colors.warning }} data-testid="sqlite-rows-error">
						{error}
					</span>
				)}
				{countError && (
					<span style={{ color: theme.colors.warning }} data-testid="sqlite-count-error">
						Counting stopped: {countError}
					</span>
				)}
			</div>
		</div>
	);
}
