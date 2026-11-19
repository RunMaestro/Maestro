/**
 * SqliteTableView - the rows of the selected table or view, in the shared
 * `<DataGrid>`.
 *
 * Rows are paged from the main process with `LIMIT`/`OFFSET` (see
 * src/main/sqlite/sqlite-rows.ts): the first window on selection, the next
 * when the grid scrolls near the end of what is loaded. A header click sorts
 * in SQLite (`ORDER BY`), so it orders the whole table, and starts again from
 * the first window. Nothing is sorted or filtered over the loaded rows.
 *
 * The parent remounts this per object (`key`), so a selection change never
 * shows the previous object's rows. Within one object, a generation token
 * drops the reply to a window asked for under an older sort.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatCount } from '../../../shared/formatters';
import { formatSqliteCell } from '../../../shared/sqlite/cells';
import { sqliteColumnAffinity } from '../../../shared/sqlite/schema';
import type {
	SqliteAffinity,
	SqliteCellValue,
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
import { Spinner } from '../ui/Spinner';

/** Rows asked for per window. Large enough to fill a tall pane in one call. */
const PAGE_SIZE = 300;

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
	theme: Theme;
}

export function SqliteTableView({ handle, object, theme }: SqliteTableViewProps) {
	const [sort, setSort] = useState<SqliteSortSpec | null>(null);
	const [columns, setColumns] = useState<SqliteResultColumn[] | null>(null);
	const [rows, setRows] = useState<SqliteCellValue[][]>([]);
	const [lastPage, setLastPage] = useState<SqliteRowsPage | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	/** Bumped on every sort change; a reply for an older one is dropped. */
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
				});
				if (token !== generation.current) return;
				setLastPage(page);
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
		[handle, name, sort]
	);

	// A new sort means a new order: start again from the first window. The
	// columns stay up meanwhile, so the header the user just clicked does not
	// vanish under the pointer.
	useEffect(() => {
		generation.current++;
		setRows([]);
		setLastPage(null);
		setError(null);
		void fetchWindow(0);
	}, [fetchWindow]);

	const handleReachEnd = useCallback(() => {
		if (!lastPage?.hasMore || inFlight.current !== null || error) return;
		void fetchWindow(rows.length);
	}, [lastPage, rows.length, error, fetchWindow]);

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

	const orderText =
		lastPage === null
			? null
			: lastPage.orderedBy.length > 0
				? `ordered by ${lastPage.orderedBy.join(', ')}`
				: 'in scan order';

	return (
		<div className="flex flex-col h-full min-h-0" data-testid="sqlite-table-view">
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
				<span>
					{rows.length > 0
						? `${formatCount(rows.length)} loaded${lastPage?.hasMore ? ', more below' : ''}`
						: busy
							? 'Reading rows...'
							: 'No rows'}
				</span>
				{orderText && <span>{orderText}</span>}
				{lastPage && <span>{lastPage.elapsedMs} ms</span>}
				{error && (
					<span style={{ color: theme.colors.warning }} data-testid="sqlite-rows-error">
						{error}
					</span>
				)}
			</div>
		</div>
	);
}
