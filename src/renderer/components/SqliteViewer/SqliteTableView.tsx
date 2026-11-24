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
 *
 * A double-click on a row opens it in the shared `<RecordDetailModal>`, one
 * field per line (`formatSqliteRecordValue()`). Left/Right there step through
 * the loaded rows in the grid's order, and stepping near the last loaded row
 * reads the next window, so the record view walks the whole table the way
 * scrolling does. A new sort or filter closes it: the position it showed
 * now holds a different row.
 *
 * A BLOB cell shows its size and first bytes in hex; the record view shows
 * its 32-byte head and a Save to file button, which writes the value whole
 * from the main process (src/main/sqlite/sqlite-blob.ts). The row is named by
 * the rowid its page carried, or for a view or `WITHOUT ROWID` table by its
 * position under the sort and filter the rows were read with; either way the
 * save is refused if the stored value no longer matches the cell.
 *
 * While the tab has editing enabled, the footer says how an edit would name a
 * row (rowid, else the primary key) or why this object is read-only, from the
 * `editability` each page carries (src/main/sqlite/sqlite-identity.ts).
 *
 * With editing enabled on an editable table, a double-click on a cell opens an
 * editor over it (SqliteCellEditor) and a double-click on the row number opens
 * the record view. Saving sends the tab's edit token, the row's key from its
 * page (`rowids`, or `rowKeys` read whole for a primary key), the row's
 * version from its page (`rowVersions`), and the new value to
 * `sqlite:updateCell`, one single-row UPDATE in main
 * (src/main/sqlite/sqlite-row-edit.ts), which changes nothing when the row
 * no longer has that version: another tab, another program, or a trigger
 * changed it since the page was read. That refusal (and the record view's,
 * for a delete) offers Reload instead of overwriting the change. The saved row replaces its line in
 * place, with its new key when the edit changed one; the order and filter are
 * not re-applied until the next read. A cell main would refuse anyway (a
 * BLOB, a cut TEXT value, a generated column, a key holding NULL) says why in
 * the footer instead of opening, and so does a refused save, with SQLite's
 * own words. NULL is a state of the editor, set by its NULL button or
 * Alt+Cmd+Backspace and never by clearing the text, so an emptied box saves an
 * empty string and a NULL cell saved untouched stays NULL. The column's type
 * affinity picks how the text binds (a number in a numeric column, text in a
 * TEXT one), and a value SQLite would convert or keep as the wrong type is
 * reported in the footer with the editor still open, never written converted
 * (`sqliteCellEditValueProblem()` here, `sqliteStoredValueProblem()` in main).
 * The first save of a session announces where the file's backup went.
 *
 * On an editable table the footer offers Insert row: a form with one field
 * per column, each left to its DEFAULT, given a value (bound by the same
 * affinity rule), or NULL (SqliteInsertRowModal), sent as one INSERT
 * (`sqlite:insertRow`). A refusal, the form's or SQLite's own words for a
 * failed constraint, shows in the form with the values kept. After an insert
 * the first window is read again, since where the row lands depends on the
 * sort and filter. The record view offers Delete row, which asks once more
 * and sends the row's key to `sqlite:deleteRow`; its outcome shows in the
 * record view. A delete that changed only its own row drops that line in
 * place (the record view steps to the next row); one whose triggers or
 * foreign-key actions changed other rows reads the first window again. Either
 * write counts the rows again from the start.
 *
 * Every write reports its result's `undo` step upward (`onWrite`): the
 * viewer keeps the tab's last write and offers Undo in its summary strip
 * (SqliteUndoControl), since an undo may come after switching tables. When an
 * undo changed this table, the viewer bumps `reloadSignal` and the first
 * window is read again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';

import { formatCount, formatSize } from '../../../shared/formatters';
import { useStableCallback } from '../../hooks/utils/useStableCallback';
import { useDebouncedValue } from '../../hooks/utils/useThrottle';
import { formatSqliteRecordValue, sqliteBlobFileName } from '../../../shared/sqlite/cells';
import { formatSqliteRowCount, sqliteConvergingRowTotal } from '../../../shared/sqlite/objects';
import {
	formatSqliteEditability,
	isSqliteStaleRowMessage,
	sqliteColumnAffinity,
	sqliteEditabilityLabel,
} from '../../../shared/sqlite/schema';
import type {
	SqliteCellValue,
	SqliteCountCursor,
	SqliteEditability,
	SqliteFilterProblem,
	SqliteKeyValue,
	SqliteObjectSummary,
	SqliteResultColumn,
	SqliteRowsPage,
	SqliteSortSpec,
} from '../../../shared/sqlite/types';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { notifyToast } from '../../stores/notificationStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { DataGrid, type DataGridCellPosition } from '../ui/DataGrid';
import {
	FilterExpressionBar,
	type FilterExpressionBarHandle,
	type FilterExpressionExample,
} from '../ui/FilterExpressionBar';
import { RecordDetailModal, type RecordDetailField } from '../ui/RecordDetailModal';
import { Spinner } from '../ui/Spinner';
import { SqliteCellEditor } from './SqliteCellEditor';
import { SqliteInsertRowModal } from './SqliteInsertRowModal';
import {
	sqliteCellEditDraft,
	sqliteCellEditRefusal,
	sqliteCellEditTypeHint,
	sqliteCellEditValue,
	sqliteCellEditValueProblem,
	sqliteRowKeyAt,
	sqliteRowKeyRefusal,
	type SqliteCellDraft,
} from './sqliteCellEdit';
import { sqliteGridCell, sqliteGridColumn } from './sqliteGrid';
import { sqliteInsertColumns, sqliteInsertValues, type SqliteInsertDraft } from './sqliteRowInsert';
import type { SqliteLastWrite } from './sqliteUndo';
import { announceSqliteBackup, sqliteOtherChangesText } from './sqliteWriteNotice';

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

/**
 * How close to the last loaded row the record view gets before it reads the
 * next window, so Right never stops at a window boundary.
 */
const RECORD_PREFETCH_ROWS = 5;

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

const BLOB_HINT = 'Double-click the row to save it to a file';

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A write's outcome or refusal; `stale` when the row changed since it was read. */
interface WriteStatus {
	text: string;
	error: boolean;
	stale?: boolean;
}

/** A refused write as its status line shows it, in main's (or SQLite's) words. */
function writeFailureStatus(failure: unknown): WriteStatus {
	const text = ipcErrorMessage(failure);
	return { text, error: true, stale: isSqliteStaleRowMessage(text) };
}

/** The Reload a stale-row refusal offers: the rows on screen are not the rows stored. */
function StaleRowReload({
	onReload,
	theme,
	testId,
}: {
	onReload: () => void;
	theme: Theme;
	testId: string;
}) {
	return (
		<button
			type="button"
			className="ml-2 underline"
			onClick={onReload}
			style={{ color: theme.colors.accentText }}
			title="Read the rows again as they are stored now"
			data-testid={testId}
		>
			Reload
		</button>
	);
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
	/**
	 * The tab's edit token while it holds the editing unlock: the footer says
	 * whether this object's rows can be edited, and its cells can be.
	 */
	editToken?: string | null;
	/** Each write that landed, with the step that takes it back, for the viewer's Undo. */
	onWrite?: (write: SqliteLastWrite) => void;
	/** Bumped when something outside (an undo) changed this table: read the first window again. */
	reloadSignal?: number;
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
	editToken = null,
	onWrite,
	reloadSignal = 0,
	theme,
}: SqliteTableViewProps) {
	const editingEnabled = editToken !== null;
	const [sort, setSort] = useState<SqliteSortSpec | null>(null);
	const appliedFilter = useDebouncedValue(filter.trim(), FILTER_DEBOUNCE_MS);
	const [filterProblem, setFilterProblem] = useState<SqliteFilterProblem | undefined>(undefined);
	const filterBarRef = useRef<FilterExpressionBarHandle>(null);
	const [columns, setColumns] = useState<SqliteResultColumn[] | null>(null);
	const [rows, setRows] = useState<SqliteCellValue[][]>([]);
	const [lastPage, setLastPage] = useState<SqliteRowsPage | null>(null);
	/** Whether this object's rows can be edited; every reply carries it, even a filter problem. */
	const [editability, setEditability] = useState<SqliteEditability | null>(null);
	/** The applied filter the rows on screen were read with. */
	const [rowsFilter, setRowsFilter] = useState<string | null>(null);
	/** The sort the rows on screen were read with: a row's position means it. */
	const [rowsSort, setRowsSort] = useState<SqliteSortSpec | null>(null);
	/** Each loaded row's rowid, parallel to `rows`; null when the object has none. */
	const [rowids, setRowids] = useState<string[] | null>(null);
	/** Each loaded row's primary key, whole, parallel to `rows`; null unless edits key on it. */
	const [rowKeys, setRowKeys] = useState<SqliteKeyValue[][] | null>(null);
	/** The cell an editor is open on, and its draft. */
	const [editingCell, setEditingCell] = useState<DataGridCellPosition | null>(null);
	const [editDraft, setEditDraft] = useState<SqliteCellDraft>({ text: '', isNull: false });
	/** A cell save is in flight. */
	const [savingCell, setSavingCell] = useState(false);
	/** Each loaded row's version, parallel to `rows`; an edit sends it so main refuses a stale one. */
	const [rowVersions, setRowVersions] = useState<string[] | null>(null);
	/** The last edit's outcome or refusal, for the footer. */
	const [editStatus, setEditStatus] = useState<WriteStatus | null>(null);
	/** A BLOB save is in flight; its button waits. */
	const [savingBlob, setSavingBlob] = useState(false);
	const [count, setCount] = useState<CountProgress | null>(null);
	const [counting, setCounting] = useState(false);
	const [countError, setCountError] = useState<string | null>(null);
	/** The filter "Count all" was clicked for; the auto pass limit is lifted for it. */
	const [countAllFor, setCountAllFor] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/** Position of the row open in the record view, or null when it is closed. */
	const [detailRow, setDetailRow] = useState<number | null>(null);
	/** The Insert row form is open, what it holds, and its last refusal. */
	const [insertOpen, setInsertOpen] = useState(false);
	const [insertDraft, setInsertDraft] = useState<SqliteInsertDraft>({});
	const [inserting, setInserting] = useState(false);
	const [insertProblem, setInsertProblem] = useState<string | null>(null);
	/** Position of the row whose Delete was clicked once and waits for the second click. */
	const [deleteArmed, setDeleteArmed] = useState<number | null>(null);
	const [deleting, setDeleting] = useState(false);
	/** The last delete's outcome, shown in the record view where it was clicked. */
	const [deleteStatus, setDeleteStatus] = useState<WriteStatus | null>(null);
	/** Bumped when a write changed the row set, so the count starts over. */
	const [countEpoch, setCountEpoch] = useState(0);

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
				setEditability(page.editability);
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
				setRowsSort(sort);
				if (offset === 0) {
					setColumns(page.columns);
					setRows(page.rows);
					setRowids(page.rowids);
					setRowKeys(page.rowKeys);
					setRowVersions(page.rowVersions);
				} else {
					setRows((previous) => [...previous, ...page.rows]);
					setRowids((previous) => (previous && page.rowids ? [...previous, ...page.rowids] : null));
					setRowKeys((previous) =>
						previous && page.rowKeys ? [...previous, ...page.rowKeys] : null
					);
					setRowVersions((previous) =>
						previous && page.rowVersions ? [...previous, ...page.rowVersions] : null
					);
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
		setDetailRow(null);
		// A position now holds a different row: an open editor would write to it.
		setEditingCell(null);
		setEditStatus(null);
		void fetchWindow(0);
	}, [fetchWindow]);

	// Locking the tab ends any edit in progress; a save in flight is refused in main.
	useEffect(() => {
		if (editToken !== null) return;
		setEditingCell(null);
		setEditStatus(null);
		setInsertOpen(false);
		setDeleteArmed(null);
	}, [editToken]);

	const handleReachEnd = useCallback(() => {
		if (!lastPage?.hasMore || inFlight.current !== null || error || filterProblem) return;
		void fetchWindow(rows.length);
	}, [lastPage, rows.length, error, filterProblem, fetchWindow]);

	// -- Converging count ---------------------------------------------------

	const countRef = useRef<CountProgress | null>(null);

	/** Count the rows again from the first one: a write added or removed some. */
	const restartCount = useCallback(() => {
		countRef.current = null;
		setCountEpoch((epoch) => epoch + 1);
	}, []);

	/**
	 * Read the first window again under the same sort and filter, keeping the
	 * footer's edit status: an insert, or a delete that changed other rows,
	 * leaves the loaded rows stale.
	 */
	const reloadRows = useStableCallback(() => {
		generation.current++;
		setError(null);
		setDetailRow(null);
		setEditingCell(null);
		restartCount();
		void fetchWindow(0);
	});
	/** The Reload a stale-row refusal offers: the refusal goes with the stale rows. */
	const reloadStaleRows = useCallback(() => {
		setEditStatus(null);
		setDeleteStatus(null);
		reloadRows();
	}, [reloadRows]);
	// An undo changed this table: what is on screen may no longer be stored.
	const seenReloadSignal = useRef(reloadSignal);
	useEffect(() => {
		if (seenReloadSignal.current === reloadSignal) return;
		seenReloadSignal.current = reloadSignal;
		setDeleteStatus(null);
		reloadRows();
	}, [reloadSignal, reloadRows]);
	const reportWrite = useStableCallback((write: SqliteLastWrite) => onWrite?.(write));
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
		// countEpoch: a write changed how many rows there are, so count again.
	}, [handle, name, appliedFilter, countAll, reportSettled, countEpoch]);

	// The filter bar is drawn only once the columns arrive, so a request made
	// while they load (Cmd+F from the Schema view) waits for the bar instead of
	// being cleared with nothing focused.
	const filterBarShown = columns !== null;
	useEffect(() => {
		if (!focusFilterRequested || !filterBarShown) return;
		filterBarRef.current?.focus();
		onFilterFocused();
	}, [focusFilterRequested, filterBarShown, onFilterFocused]);

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
		() => (columns ?? []).map((column) => sqliteGridColumn(column, { strict })),
		[columns, strict]
	);

	const getCell = useCallback(
		(rowPosition: number, columnPosition: number) =>
			sqliteGridCell(rows[rowPosition]?.[columnPosition] ?? null, BLOB_HINT),
		[rows]
	);

	const getRowLabel = useCallback((rowPosition: number) => formatCount(rowPosition + 1), []);

	// -- Cell edit ----------------------------------------------------------

	const canEditCells = editingEnabled && editability?.editable === true;

	const handleEditCell = useStableCallback((rowPosition: number, columnPosition: number) => {
		if (savingCell) return;
		const column = columns?.[columnPosition];
		if (!column) return;
		const value = rows[rowPosition]?.[columnPosition] ?? null;
		const key = sqliteRowKeyAt(editability, rowids, rowKeys, rowPosition);
		const refusal = sqliteCellEditRefusal(editability, column.name, value, key);
		if (refusal) {
			setEditingCell(null);
			setEditStatus({ text: refusal, error: true });
			return;
		}
		setEditStatus(null);
		setEditDraft(sqliteCellEditDraft(value));
		setEditingCell({ row: rowPosition, column: columnPosition });
	});

	const cancelEdit = useCallback(() => {
		setEditingCell(null);
		setEditStatus(null);
	}, []);

	const commitEdit = useStableCallback(async () => {
		const cell = editingCell;
		// A blur can follow the save that closed the editor.
		if (!cell || savingCell || !editToken) return;
		const column = columns?.[cell.column];
		const original = rows[cell.row]?.[cell.column] ?? null;
		const key = sqliteRowKeyAt(editability, rowids, rowKeys, cell.row);
		if (!column || !key) return;
		const affinity = sqliteColumnAffinity(column.declaredType ?? '', strict);
		const value = sqliteCellEditValue(original, editDraft, affinity);
		if (!value) {
			// Nothing changed, so nothing is written.
			setEditingCell(null);
			return;
		}
		const identity = editability?.editable ? editability.identity : null;
		const problem = sqliteCellEditValueProblem(
			{
				name: column.name,
				affinity,
				isRowid: identity?.kind === 'rowid' && identity.rowidColumn === column.name,
			},
			original,
			value
		);
		if (problem) {
			// The editor stays open with the draft, so the value can be fixed.
			setEditStatus({ text: problem, error: true });
			return;
		}
		const token = generation.current;
		setSavingCell(true);
		try {
			const result = await window.maestro.sqlite.updateCell({
				handle,
				editToken,
				name,
				column: column.name,
				row: key,
				// Main refuses the save if the row changed since this page read it.
				version: rowVersions?.[cell.row] ?? null,
				value,
			});
			announceSqliteBackup(result.backup);
			reportWrite({ undo: result.undo, otherChanges: result.otherChanges });
			// A new sort or filter since the save started moved the rows; the
			// next window shows the change.
			if (token !== generation.current) return;
			setRows((previous) =>
				previous.map((row, position) => (position === cell.row ? result.row : row))
			);
			setRowVersions((previous) =>
				previous
					? previous.map((entry, position) => (position === cell.row ? result.version : entry))
					: null
			);
			if (result.key.kind === 'rowid') {
				const rowid = result.key.rowid;
				setRowids((previous) =>
					previous
						? previous.map((entry, position) => (position === cell.row ? rowid : entry))
						: null
				);
			} else if (editability?.editable && editability.identity.kind === 'primary-key') {
				const values = result.key.values;
				const keyRow = editability.identity.columns.map((keyColumn) => values[keyColumn] ?? null);
				setRowKeys((previous) =>
					previous
						? previous.map((entry, position) => (position === cell.row ? keyRow : entry))
						: null
				);
			}
			setEditingCell(null);
			setEditStatus({
				text: `Saved ${column.name} in row ${formatCount(cell.row + 1)} (${result.elapsedMs} ms)${sqliteOtherChangesText(result.otherChanges)}`,
				error: false,
			});
		} catch (failure) {
			// The editor stays open with the draft, so the value can be fixed.
			if (token === generation.current) setEditStatus(writeFailureStatus(failure));
		} finally {
			setSavingCell(false);
		}
	});

	const renderCellEditor = useCallback(
		(_rowPosition: number, columnPosition: number) => {
			const column = columns?.[columnPosition];
			return (
				<SqliteCellEditor
					column={column?.name ?? ''}
					typeHint={
						column
							? sqliteCellEditTypeHint(
									column.name,
									column.declaredType,
									sqliteColumnAffinity(column.declaredType ?? '', strict)
								)
							: undefined
					}
					draft={editDraft}
					onDraftChange={setEditDraft}
					onCommit={() => void commitEdit()}
					onCancel={cancelEdit}
					saving={savingCell}
					theme={theme}
				/>
			);
		},
		[columns, strict, editDraft, commitEdit, cancelEdit, savingCell, theme]
	);

	// -- Insert row ---------------------------------------------------------

	const insertColumns = useMemo(
		() => sqliteInsertColumns(columns ?? [], editability),
		[columns, editability]
	);

	const openInsert = useCallback(() => {
		setEditingCell(null);
		setInsertDraft({});
		setInsertProblem(null);
		setInsertOpen(true);
	}, []);

	const closeInsert = useCallback(() => {
		if (!inserting) setInsertOpen(false);
	}, [inserting]);

	const submitInsert = useStableCallback(async () => {
		if (inserting || !editToken) return;
		const planned = sqliteInsertValues(insertColumns, insertDraft, strict);
		if ('problem' in planned) {
			// The form stays open and filled, so the value can be fixed.
			setInsertProblem(planned.problem);
			return;
		}
		setInserting(true);
		setInsertProblem(null);
		try {
			const result = await window.maestro.sqlite.insertRow({
				handle,
				editToken,
				name,
				values: planned.values,
			});
			announceSqliteBackup(result.backup);
			reportWrite({ undo: result.undo, otherChanges: result.otherChanges });
			setInsertOpen(false);
			const key =
				result.key.kind === 'rowid'
					? `rowid ${result.key.rowid}`
					: `primary key (${Object.entries(result.key.values)
							.map(([column, value]) => `${column} = ${value === null ? 'NULL' : value.text}`)
							.join(', ')})`;
			// Where the new row lands depends on the sort and filter: read again.
			reloadRows();
			setEditStatus({
				text: `Inserted a row with ${key} (${result.elapsedMs} ms)${sqliteOtherChangesText(result.otherChanges)}`,
				error: false,
			});
		} catch (failure) {
			// SQLite's own words (a constraint), with the form still filled.
			setInsertProblem(ipcErrorMessage(failure));
		} finally {
			setInserting(false);
		}
	});

	// -- Delete row ---------------------------------------------------------

	const deleteRow = useStableCallback(async (rowPosition: number) => {
		if (deleting || !editToken) return;
		const key = sqliteRowKeyAt(editability, rowids, rowKeys, rowPosition);
		const refusal = sqliteRowKeyRefusal(key);
		if (refusal || !key) {
			setDeleteArmed(null);
			setDeleteStatus({ text: refusal ?? 'This row cannot be named.', error: true });
			return;
		}
		const token = generation.current;
		setDeleting(true);
		try {
			const result = await window.maestro.sqlite.deleteRow({
				handle,
				editToken,
				name,
				row: key,
				// Main deletes nothing if the row changed since this page read it.
				version: rowVersions?.[rowPosition] ?? null,
			});
			announceSqliteBackup(result.backup);
			reportWrite({ undo: result.undo, otherChanges: result.otherChanges });
			setDeleteArmed(null);
			const outcome = {
				text: `Deleted row ${formatCount(rowPosition + 1)} (${result.elapsedMs} ms)${sqliteOtherChangesText(result.otherChanges)}`,
				error: false,
			};
			setEditStatus(outcome);
			setDeleteStatus(outcome);
			if (token !== generation.current) return;
			setEditingCell(null);
			if (result.otherChanges > 0) {
				// A cascade or a trigger may have changed rows on screen: read again.
				reloadRows();
				return;
			}
			// Only this row went: drop it in place, so the record view steps to the
			// next one and the next window still starts where the loaded rows end.
			const drop = <T,>(list: T[] | null) =>
				list ? list.filter((_entry, position) => position !== rowPosition) : null;
			setRows((previous) => drop(previous) ?? []);
			setRowids(drop);
			setRowKeys(drop);
			setRowVersions(drop);
			if (rows.length <= 1) setDetailRow(null);
			restartCount();
		} catch (failure) {
			// SQLite's own words, such as a FOREIGN KEY a child row still holds.
			setDeleteArmed(null);
			if (token === generation.current) setDeleteStatus(writeFailureStatus(failure));
		} finally {
			setDeleting(false);
		}
	});

	// -- Record view --------------------------------------------------------

	const saveBlob = useStableCallback(async (rowPosition: number, columnPosition: number) => {
		const value = rows[rowPosition]?.[columnPosition];
		const column = columns?.[columnPosition];
		if (!column || value === null || typeof value !== 'object' || value.kind !== 'blob') return;
		const rowid = rowids?.[rowPosition] ?? null;
		const destPath = await window.maestro.dialog.saveFile({
			title: 'Save BLOB to file',
			defaultPath: sqliteBlobFileName(name, column.name, rowid ?? String(rowPosition + 1)),
		});
		if (!destPath) return;
		setSavingBlob(true);
		try {
			const saved = await window.maestro.sqlite.saveBlob({
				handle,
				name,
				column: column.name,
				rowid,
				// Without a rowid the row is its position under the order and
				// filter it was read with; the expected head guards a moved row.
				offset: rowid === null ? rowPosition : null,
				sort: rowsSort,
				filter: rowsFilter || null,
				expected: { bytes: value.bytes, head: value.head },
				destPath,
			});
			notifyToast({
				color: 'green',
				title: 'BLOB saved',
				message: `${formatSize(saved.bytes)} written to ${saved.path}`,
			});
		} catch (failure) {
			notifyToast({
				color: 'red',
				title: 'Could not save the BLOB',
				message: ipcErrorMessage(failure),
			});
		} finally {
			setSavingBlob(false);
		}
	});

	const detailIndex = detailRow === null ? -1 : Math.min(detailRow, rows.length - 1);
	const detailFields = useMemo<RecordDetailField[]>(() => {
		const row = detailIndex >= 0 ? rows[detailIndex] : undefined;
		if (!row || !columns) return [];
		return columns.map((column, position) => {
			const value = row[position] ?? null;
			const { text, placeholder } = formatSqliteRecordValue(value);
			const field: RecordDetailField = {
				key: column.name || `(column ${position + 1})`,
				value: text,
				placeholder,
			};
			if (value !== null && typeof value === 'object' && value.kind === 'blob') {
				field.action = {
					icon: <Download className="w-3 h-3" />,
					label: 'Save BLOB to file',
					onClick: () => void saveBlob(detailIndex, position),
					disabled: savingBlob,
				};
			}
			return field;
		});
	}, [detailIndex, rows, columns, saveBlob, savingBlob]);

	const handleRecordNavigate = useCallback(
		(next: number) => {
			const clamped = Math.max(0, Math.min(next, rows.length - 1));
			setDetailRow(clamped);
			setDeleteArmed(null);
			setDeleteStatus(null);
			if (clamped >= rows.length - RECORD_PREFETCH_ROWS) handleReachEnd();
		},
		[rows.length, handleReachEnd]
	);
	const openRecord = useCallback((rowPosition: number) => {
		setDetailRow(rowPosition);
		setDeleteArmed(null);
		setDeleteStatus(null);
	}, []);
	const closeRecord = useCallback(() => {
		setDetailRow(null);
		setDeleteArmed(null);
	}, []);

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
					gutterTitle={
						canEditCells
							? 'Row number in the current order. Double-click it to open the row (Delete row is there); double-click a cell to edit it.'
							: 'Row number in the current order'
					}
					theme={theme}
					sort={sort}
					onSortChange={handleSortChange}
					onReachEnd={handleReachEnd}
					onOpenRow={openRecord}
					onEditCell={canEditCells ? handleEditCell : undefined}
					editingCell={canEditCells ? editingCell : null}
					renderCellEditor={canEditCells ? renderCellEditor : undefined}
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
				{canEditCells && (
					<button
						type="button"
						className="flex items-center gap-1 underline disabled:opacity-50"
						onClick={openInsert}
						disabled={inserting}
						style={{ color: theme.colors.accentText }}
						title={`Add a row to ${name}: each column takes its default unless you give a value`}
						data-testid="sqlite-insert-row"
					>
						<Plus className="w-3 h-3" />
						Insert row
					</button>
				)}
				{editingEnabled && editability && (
					<span
						style={{
							color: editability.editable ? theme.colors.textDim : theme.colors.warning,
						}}
						title={formatSqliteEditability(editability)}
						data-testid="sqlite-rows-editability"
					>
						{sqliteEditabilityLabel(editability)}
					</span>
				)}
				{lastPage && <span>{lastPage.elapsedMs} ms</span>}
				{savingCell && (
					<span className="flex items-center gap-1" data-testid="sqlite-edit-saving">
						<Spinner size={10} decorative />
						saving
					</span>
				)}
				{editingEnabled && editStatus && (
					<span
						className="select-text"
						style={{ color: editStatus.error ? theme.colors.warning : theme.colors.textDim }}
						data-testid="sqlite-edit-status"
					>
						{editStatus.text}
						{editStatus.stale && (
							<StaleRowReload
								onReload={reloadStaleRows}
								theme={theme}
								testId="sqlite-edit-reload"
							/>
						)}
					</span>
				)}
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
			{detailFields.length > 0 && (
				<RecordDetailModal
					fields={detailFields}
					index={detailIndex}
					total={rows.length}
					onNavigate={handleRecordNavigate}
					onClose={closeRecord}
					theme={theme}
					priority={MODAL_PRIORITIES.TABLE_ROW_DETAIL}
					resizeKey="sqlite-row-detail"
					testIdPrefix="sqlite-row-detail"
					headerActions={
						canEditCells ? (
							<button
								type="button"
								className="flex items-center gap-1.5 px-2.5 py-1 mr-1 rounded-lg text-xs font-medium transition-colors hover:bg-white/10 disabled:opacity-50"
								onClick={() =>
									deleteArmed === detailIndex
										? void deleteRow(detailIndex)
										: setDeleteArmed(detailIndex)
								}
								onBlur={() => {
									if (!deleting) setDeleteArmed(null);
								}}
								disabled={deleting}
								style={{
									color:
										deleteArmed === detailIndex
											? theme.colors.accentForeground
											: theme.colors.error,
									backgroundColor: deleteArmed === detailIndex ? theme.colors.error : undefined,
								}}
								title={
									deleteArmed === detailIndex
										? 'Click again to delete this row from the database'
										: `Delete this row from ${name} (asks once more)`
								}
								data-testid="sqlite-delete-row"
							>
								{deleting ? <Spinner size={12} decorative /> : <Trash2 className="w-3 h-3" />}
								{deleting
									? 'Deleting...'
									: deleteArmed === detailIndex
										? 'Confirm delete'
										: 'Delete row'}
							</button>
						) : undefined
					}
					notice={
						deleteStatus ? (
							<span
								style={{ color: deleteStatus.error ? theme.colors.error : theme.colors.textDim }}
								data-testid="sqlite-delete-status"
							>
								{deleteStatus.text}
								{deleteStatus.stale && (
									<StaleRowReload
										onReload={reloadStaleRows}
										theme={theme}
										testId="sqlite-delete-reload"
									/>
								)}
							</span>
						) : undefined
					}
				/>
			)}
			{insertOpen && canEditCells && (
				<SqliteInsertRowModal
					table={name}
					columns={insertColumns}
					strict={strict}
					draft={insertDraft}
					onDraftChange={setInsertDraft}
					onInsert={() => void submitInsert()}
					onClose={closeInsert}
					saving={inserting}
					problem={insertProblem}
					theme={theme}
				/>
			)}
		</div>
	);
}
