/**
 * SqliteViewer - the file preview surface for SQLite databases.
 *
 * Like the Parquet viewer, this is a thin client: the database is open
 * read-only in the main process (src/main/sqlite/), the tab's content is only
 * a handoff marker, and the viewer asks for what it shows over the `sqlite:*`
 * IPC surface. No database bytes cross IPC.
 *
 * Opening is two steps with very different costs, and the viewer keeps them
 * apart so the rail is never blank while numbers are computed:
 *
 *  - The object list reads `sqlite_master` only, so the rail's names appear at
 *    once whatever the database's size.
 *  - Row counts and sizes are measured afterwards in budgeted batches (the main
 *    process is synchronous while SQLite runs), and the rail fills in as each
 *    batch lands. Visible objects are measured before internal ones. A table
 *    whose rail count stopped at the cap (`100,000+`) gets its exact count
 *    once the table view's converging count settles.
 *
 * The strip above both shows the database as a whole: object counts, file
 * size, and the header facts and integrity flag (SqliteDatabaseFacts).
 *
 * The content pane shows the selected object: its counts, then either its
 * rows (SqliteTableView, for a table or view) or its schema
 * (SqliteSchemaPanel), chosen by a Data / Schema switch the viewer remembers.
 * An index or trigger has no rows of its own, so it always shows its schema.
 *
 * Each table's or view's filter text is kept here, keyed by object, so going
 * back to a table finds its filter as it was left. Cmd+F in the file preview
 * lands in the filter box (`focusFilter()`), switching to the Data view first.
 *
 * A Browse / Query switch in the summary strip (remembered) trades the content
 * pane for the SQL editor (SqliteQueryPanel), with completion from this
 * database's tables and columns. The rail stays as a reference; picking an
 * object in it goes back to Browse to show that object. The query text, its
 * parameter values, the Plan toggle, and the last run's result are kept
 * here, so all survive the switch; opening another file clears them. The
 * Query panel's History rail and Export are its own (the history is kept
 * per file by the main process).
 *
 * The strip also holds the tab's "Enable editing" switch (SqliteEditingSwitch).
 * Read-only is the default; turning editing on asks the main process for a
 * grant (src/main/sqlite/sqlite-editing.ts), a token this tab alone holds and
 * every write must send back. The grant is never persisted: it is released
 * when the tab locks again, opens another file, or unmounts, so a reload
 * starts read-only. The table view gets the token, and with it the cell edit;
 * so does the Query panel, which lifts its read-only assertion only while the
 * token is live (a statement that changes the database then runs once, behind
 * the same gate and backup; the table on screen reads again after it).
 *
 * Beside the switch, Undo takes back the tab's last write
 * (SqliteUndoControl): each write the table view makes reports its result's
 * `undo` step here, and Undo (or Cmd+Z outside a text field) sends it to
 * `sqlite:undoEdit`, one single-row write through the same gate, backup, and
 * version check (src/main/sqlite/sqlite-row-edit.ts). One level, kept per
 * editing session, not per table, so switching tables keeps it; Lock, another
 * file, or unmount drops it with the grant. A write whose triggers or
 * foreign-key actions changed other rows says it cannot be undone, as does a
 * statement run from Query mode.
 */

import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from 'react';
import { AlertTriangle, Database } from 'lucide-react';

import type {
	SqliteDatabaseInfo,
	SqliteEditingGrant,
	SqliteObjectList,
	SqliteObjectStats,
	SqliteObjectSummary,
	SqliteParameterValues,
	SqliteQueryWrite,
} from '../../../shared/sqlite/types';
import {
	SQLITE_OBJECT_KINDS,
	SQLITE_OBJECT_KIND_LABELS,
	formatSqliteRowCount,
	groupSqliteObjects,
	sqliteMeasurementOrder,
	sqliteObjectTags,
} from '../../../shared/sqlite/objects';
import { formatCount, formatSize } from '../../../shared/formatters';
import { SQLITE_QUERY_WRITE_UNDO_MESSAGE, sqliteUndoOutcome } from '../../../shared/sqlite/undo';
import type { Theme } from '../../types';
import { isTextEntryTarget } from '../../utils/messageScrollNavigation';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { MiniBadge } from '../ui/MiniBadge';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Spinner } from '../ui/Spinner';
import { SqliteDatabaseFacts } from './SqliteDatabaseFacts';
import { SqliteEditingSwitch } from './SqliteEditingSwitch';
import { SqliteObjectRail } from './SqliteObjectRail';
import { SqliteQueryPanel, type SqliteQueryRunState } from './SqliteQueryPanel';
import { SqliteSchemaPanel } from './SqliteSchemaPanel';
import { SqliteTableView } from './SqliteTableView';
import { SqliteUndoControl, type SqliteUndoStatus } from './SqliteUndoControl';
import { isSqliteUndoChord, type SqliteLastWrite } from './sqliteUndo';

/** What the content pane shows for a table or view. */
type ObjectView = 'data' | 'schema';
const OBJECT_VIEWS: readonly ObjectView[] = ['data', 'schema'];
const OBJECT_VIEW_OPTIONS = [
	{ value: 'data' as const, label: 'Data', title: 'Browse the rows' },
	{ value: 'schema' as const, label: 'Schema', title: 'Columns, keys, and the CREATE statement' },
];

interface SqliteViewerProps {
	filePath: string;
	fileName: string;
	theme: Theme;
}

/** Imperative handle so the file preview can route Cmd+F to the filter box. */
export interface SqliteViewerHandle {
	focusFilter: () => void;
}

/** What the viewer shows beside the rail: one object, or the SQL editor. */
type ViewerMode = 'browse' | 'query';
const VIEWER_MODES: readonly ViewerMode[] = ['browse', 'query'];
const VIEWER_MODE_OPTIONS = [
	{
		value: 'browse' as const,
		label: 'Browse',
		title: 'Look at one table, view, index, or trigger',
	},
	{ value: 'query' as const, label: 'Query', title: 'Write SQL against this database' },
];

/** Key for an object's remembered filter text: a trigger may share a table's name. */
function filterKey(object: Pick<SqliteObjectSummary, 'kind' | 'name'>): string {
	return `${object.kind}:${object.name}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The object selected when a database opens: its first user table, if any. */
function defaultSelection(objects: readonly SqliteObjectSummary[]): string | null {
	const visible = groupSqliteObjects(objects, false).flatMap((group) => group.objects);
	return visible[0]?.name ?? objects[0]?.name ?? null;
}

export const SqliteViewer = forwardRef<SqliteViewerHandle, SqliteViewerProps>(function SqliteViewer(
	{ filePath, fileName, theme },
	ref
) {
	const [info, setInfo] = useState<SqliteDatabaseInfo | null>(null);
	const [list, setList] = useState<SqliteObjectList | null>(null);
	const [stats, setStats] = useState<ReadonlyMap<string, SqliteObjectStats>>(() => new Map());
	const [openError, setOpenError] = useState<string | null>(null);
	const [statsError, setStatsError] = useState<string | null>(null);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const showInternal = usePersistedToggle('sqlite-show-internal', false);
	const objectView = usePersistedChoice<ObjectView>('sqlite-object-view', OBJECT_VIEWS, 'data');
	const viewerMode = usePersistedChoice<ViewerMode>('sqlite-viewer-mode', VIEWER_MODES, 'browse');
	const [query, setQuery] = useState('');
	const [queryParams, setQueryParams] = useState<SqliteParameterValues>({});
	const [queryRun, setQueryRun] = useState<SqliteQueryRunState | null>(null);
	/** Query mode's Plan toggle: Run shows the statement's query plan instead of its rows. */
	const [queryPlan, setQueryPlan] = useState(false);
	const [filters, setFilters] = useState<ReadonlyMap<string, string>>(() => new Map());
	const [focusFilterRequested, setFocusFilterRequested] = useState(false);
	/** This tab's write grant, while "Enable editing" is on. Null is read-only. */
	const [editGrant, setEditGrant] = useState<SqliteEditingGrant | null>(null);
	const [editingBusy, setEditingBusy] = useState(false);
	const [editingError, setEditingError] = useState<string | null>(null);
	/** The tab's last write while editing is on, with the step that takes it back. */
	const [lastWrite, setLastWrite] = useState<SqliteLastWrite | null>(null);
	const [undoing, setUndoing] = useState(false);
	const [undoStatus, setUndoStatus] = useState<SqliteUndoStatus | null>(null);
	/** Bumped when an undo changed the table on screen, so it reads its rows again. */
	const [tableReload, setTableReload] = useState(0);
	/**
	 * Bumped whenever an enable request in flight stops being wanted (another
	 * file, Lock, unmount), so its grant is released instead of applied.
	 */
	const editRequest = useRef(0);
	/**
	 * Exact row counts the table view settled. A stats batch that lands later
	 * carries the capped count, so it must not overwrite these.
	 */
	const settledCounts = useRef(new Map<string, number>());

	// -- Open the database and read its object list -------------------------

	useEffect(() => {
		let cancelled = false;
		setInfo(null);
		setList(null);
		setStats(new Map());
		settledCounts.current = new Map();
		setOpenError(null);
		setStatsError(null);
		setSelectedName(null);
		setFilters(new Map());
		setQuery('');
		setQueryParams({});
		setQueryRun(null);
		setQueryPlan(false);
		editRequest.current += 1;
		setEditGrant(null);
		setEditingBusy(false);
		setEditingError(null);

		window.maestro.sqlite
			.open(filePath)
			.then(async (opened) => {
				if (cancelled) return;
				setInfo(opened);
				const objects = await window.maestro.sqlite.listObjects(opened.handle);
				if (cancelled) return;
				setList(objects);
				setSelectedName(defaultSelection(objects.objects));
			})
			.catch((error: unknown) => {
				if (!cancelled) setOpenError(errorText(error));
			});

		return () => {
			cancelled = true;
		};
	}, [filePath]);

	// Release the main-process connection when the tab goes away. The idle
	// reaper would also get it, but an open tab should not pin a read lock.
	const handle = info?.handle;
	useEffect(() => {
		if (!handle) return;
		return () => {
			void window.maestro.sqlite.close(handle);
		};
	}, [handle]);

	// -- Editing unlock ----------------------------------------------------

	// Release the grant whenever it stops being this tab's: Lock clears it,
	// another file replaces it, unmount drops it. One place, so no path forgets.
	// The last write's undo belongs to the grant: it goes with it.
	useEffect(() => {
		setLastWrite(null);
		setUndoStatus(null);
		if (!editGrant) return;
		return () => {
			void window.maestro.sqlite.disableEditing(editGrant.handle, editGrant.editToken);
		};
	}, [editGrant]);

	// An enable request still in flight at unmount must not leave a grant behind.
	useEffect(
		() => () => {
			editRequest.current += 1;
		},
		[]
	);

	const enableEditing = useCallback(() => {
		if (!handle) return;
		const request = ++editRequest.current;
		setEditingBusy(true);
		setEditingError(null);
		window.maestro.sqlite
			.enableEditing(handle)
			.then((grant) => {
				if (request !== editRequest.current) {
					void window.maestro.sqlite.disableEditing(grant.handle, grant.editToken);
					return;
				}
				setEditGrant(grant);
				setEditingBusy(false);
			})
			.catch((error: unknown) => {
				if (request !== editRequest.current) return;
				setEditingError(ipcErrorMessage(error));
				setEditingBusy(false);
			});
	}, [handle]);

	const disableEditing = useCallback(() => {
		editRequest.current += 1;
		setEditGrant(null);
		setEditingBusy(false);
	}, []);

	// -- Undo the last write ------------------------------------------------

	const handleWrite = useCallback((write: SqliteLastWrite) => {
		setLastWrite(write);
		setUndoStatus(null);
	}, []);

	// A statement run from Query mode with editing on. It has no undo step,
	// and it may have changed any table, so the one on screen reads again.
	const handleQueryWrite = useCallback((write: SqliteQueryWrite) => {
		setLastWrite({
			undo: null,
			otherChanges: write.otherChanges,
			unavailable: SQLITE_QUERY_WRITE_UNDO_MESSAGE,
		});
		setUndoStatus(null);
		setTableReload((count) => count + 1);
	}, []);

	const undoLastWrite = useCallback(() => {
		const step = lastWrite?.undo;
		if (!editGrant || !step || undoing) return;
		setUndoing(true);
		window.maestro.sqlite
			.undoEdit({ handle: editGrant.handle, editToken: editGrant.editToken, step })
			.then((result) => {
				// One level: the undo itself is not undone.
				setLastWrite(null);
				setUndoStatus({ text: sqliteUndoOutcome(step, result), error: false });
				// The table view on screen shows that table: its rows changed.
				if (selectedName === result.name) setTableReload((count) => count + 1);
			})
			.catch((error: unknown) => {
				// The step stays, so a busy database can be tried again.
				setUndoStatus({ text: `Could not undo: ${ipcErrorMessage(error)}`, error: true });
			})
			.finally(() => setUndoing(false));
	}, [editGrant, lastWrite, undoing, selectedName]);

	const handleViewerKeyDown = useCallback(
		(event: KeyboardEvent) => {
			// Inside a text field (the cell editor, the filter, the SQL editor)
			// Cmd+Z undoes typing, never a write.
			if (!isSqliteUndoChord(event) || isTextEntryTarget(event.target)) return;
			if (!editGrant || !lastWrite?.undo) return;
			event.preventDefault();
			event.stopPropagation();
			undoLastWrite();
		},
		[editGrant, lastWrite, undoLastWrite]
	);

	// -- Measure row counts and sizes, batch by batch -----------------------

	useEffect(() => {
		if (!handle || !list) return;
		let cancelled = false;
		let remaining = sqliteMeasurementOrder(list.objects);

		const measure = async () => {
			while (remaining.length > 0 && !cancelled) {
				const batch = await window.maestro.sqlite.readObjectStats(handle, remaining);
				if (cancelled) return;
				// The main process always answers for at least one name; an empty
				// reply would loop forever, so treat it as the end.
				if (batch.length === 0) return;
				remaining = remaining.slice(batch.length);
				setStats((previous) => {
					const next = new Map(previous);
					for (const entry of batch) {
						const settled = settledCounts.current.get(entry.name);
						next.set(
							entry.name,
							settled === undefined ? entry : { ...entry, rowCount: settled, rowCountCapped: false }
						);
					}
					return next;
				});
			}
		};
		measure().catch((error: unknown) => {
			if (!cancelled) setStatsError(errorText(error));
		});

		return () => {
			cancelled = true;
		};
	}, [handle, list]);

	const selected = useMemo(
		() => list?.objects.find((object) => object.name === selectedName) ?? null,
		[list, selectedName]
	);

	const kindCounts = useMemo(() => {
		const counts = SQLITE_OBJECT_KINDS.map((kind) => ({
			kind,
			count: list?.objects.filter((object) => object.kind === kind && !object.internal).length ?? 0,
		}));
		return counts.filter((entry) => entry.count > 0);
	}, [list]);

	const setViewerMode = viewerMode.setValue;
	const handleSelect = useCallback(
		(name: string) => {
			setSelectedName(name);
			// Picking an object is asking to see it.
			setViewerMode('browse');
		},
		[setViewerMode]
	);

	const selectedFilterKey = selected ? filterKey(selected) : null;
	const handleFilterChange = useCallback(
		(value: string) => {
			if (!selectedFilterKey) return;
			setFilters((previous) => new Map(previous).set(selectedFilterKey, value));
		},
		[selectedFilterKey]
	);
	const handleFilterFocused = useCallback(() => setFocusFilterRequested(false), []);

	const handleRowCountSettled = useCallback((name: string, rowCount: number) => {
		settledCounts.current.set(name, rowCount);
		setStats((previous) => {
			const entry = previous.get(name);
			// Not measured yet: the batch that measures it applies the count.
			if (!entry || entry.rowCount === null) return previous;
			if (entry.rowCount === rowCount && !entry.rowCountCapped) return previous;
			return new Map(previous).set(name, { ...entry, rowCount, rowCountCapped: false });
		});
	}, []);

	const setObjectView = objectView.setValue;
	useImperativeHandle(
		ref,
		() => ({
			focusFilter: () => {
				// In the SQL editor Cmd+F has nothing to find (the editor has no
				// find bar), and jumping to Browse would hide what is being typed.
				if (viewerMode.value === 'query') return;
				// Only a table or view has rows to filter; an index or trigger
				// shows its schema, and there is nothing for Cmd+F to find.
				if (selected?.kind !== 'table' && selected?.kind !== 'view') return;
				setObjectView('data');
				setFocusFilterRequested(true);
			},
		}),
		[selected?.kind, setObjectView, viewerMode.value]
	);

	if (openError) {
		return (
			<div
				className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center"
				data-testid="sqlite-open-error"
			>
				<AlertTriangle className="w-10 h-10" style={{ color: theme.colors.warning }} />
				<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Could not open {fileName}
				</div>
				<div className="text-xs select-text" style={{ color: theme.colors.textDim }}>
					{openError}
				</div>
			</div>
		);
	}

	if (!info || !list) {
		return (
			<div
				className="flex items-center justify-center h-full gap-2 text-sm"
				style={{ color: theme.colors.textDim }}
				data-testid="sqlite-loading"
			>
				<Spinner size={16} decorative />
				Reading database schema...
			</div>
		);
	}

	const selectedStats = selected ? stats.get(selected.name) : undefined;
	const selectedRows = formatSqliteRowCount(selectedStats);
	const hasRows = selected?.kind === 'table' || selected?.kind === 'view';
	const showData = hasRows && objectView.value === 'data';

	return (
		<div
			className="flex flex-col h-full min-h-0"
			onKeyDown={handleViewerKeyDown}
			data-testid="sqlite-viewer"
		>
			{/* Database summary */}
			<div
				className="shrink-0 flex items-center gap-3 px-3 py-2 flex-wrap"
				style={{ borderBottom: `1px solid ${theme.colors.border}` }}
			>
				<Database className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
				<span className="text-xs" style={{ color: theme.colors.textMain }}>
					{kindCounts.length > 0
						? kindCounts
								.map(
									({ kind, count }) =>
										`${formatCount(count)} ${SQLITE_OBJECT_KIND_LABELS[kind].toLowerCase()}`
								)
								.join(', ')
						: 'Empty database'}
				</span>
				<span className="text-xs-plus" style={{ color: theme.colors.textDim }}>
					{formatSize(info.fileBytes)}
				</span>
				<SqliteEditingSwitch
					enabled={editGrant !== null}
					busy={editingBusy}
					error={editingError}
					onEnable={enableEditing}
					onDisable={disableEditing}
					theme={theme}
				/>
				{editGrant && (
					<SqliteUndoControl
						lastWrite={lastWrite}
						undoing={undoing}
						status={undoStatus}
						onUndo={undoLastWrite}
						theme={theme}
					/>
				)}
				<SqliteDatabaseFacts
					// One mount per open database, so the auto-check rule and the
					// verdict never carry over from another file.
					key={info.handle}
					handle={info.handle}
					fileBytes={info.fileBytes}
					theme={theme}
				/>
				{statsError && (
					<span
						className="text-xs-plus"
						style={{ color: theme.colors.warning }}
						data-testid="sqlite-stats-error"
					>
						Counting stopped: {statsError}
					</span>
				)}
				<div className="ml-auto select-none">
					<SegmentedControl
						value={viewerMode.value}
						onChange={viewerMode.setValue}
						options={VIEWER_MODE_OPTIONS}
						theme={theme}
						ariaLabel="Browse objects or write a query"
						testId="sqlite-viewer-mode"
					/>
				</div>
			</div>

			<div className="flex flex-1 min-h-0">
				<SqliteObjectRail
					list={list}
					stats={stats}
					selectedName={selectedName}
					onSelect={handleSelect}
					showInternal={showInternal.value}
					onToggleInternal={showInternal.toggle}
					theme={theme}
				/>

				{viewerMode.value === 'query' ? (
					<div className="flex-1 min-w-0 flex flex-col min-h-0">
						<SqliteQueryPanel
							// One mount per open database, so a catalog never carries over.
							key={info.handle}
							handle={info.handle}
							fileName={fileName}
							value={query}
							onChange={setQuery}
							params={queryParams}
							onParamsChange={setQueryParams}
							run={queryRun}
							onRunChange={setQueryRun}
							plan={queryPlan}
							onPlanChange={setQueryPlan}
							editToken={editGrant?.editToken ?? null}
							onWrite={handleQueryWrite}
							theme={theme}
						/>
					</div>
				) : (
					<div className="flex-1 min-w-0 flex flex-col min-h-0" data-testid="sqlite-object-pane">
						{selected ? (
							<>
								<div className="shrink-0 flex flex-col gap-2 px-4 pt-4 pb-3 select-text">
									<div className="flex items-center gap-2 flex-wrap">
										<span
											className="text-sm font-mono font-semibold"
											style={{ color: theme.colors.textMain }}
										>
											{selected.name}
										</span>
										<MiniBadge label={selected.kind} theme={theme} />
										{sqliteObjectTags(selected).map((tag) => (
											<MiniBadge key={tag} label={tag} theme={theme} />
										))}
										{selected.internal && (
											<MiniBadge label="internal" theme={theme} color={theme.colors.textDim} />
										)}
										{hasRows && (
											<div className="ml-auto select-none">
												<SegmentedControl
													value={objectView.value}
													onChange={objectView.setValue}
													options={OBJECT_VIEW_OPTIONS}
													theme={theme}
													ariaLabel="Show the rows or the schema"
													testId="sqlite-object-view"
												/>
											</div>
										)}
									</div>
									<div
										className="text-xs flex gap-4 flex-wrap"
										style={{ color: theme.colors.textDim }}
									>
										{selected.kind !== 'table' && selected.kind !== 'view' && (
											<span>on {selected.tableName}</span>
										)}
										{selectedRows !== null && <span>{selectedRows} rows</span>}
										{selectedStats?.sizeBytes !== null &&
											selectedStats?.sizeBytes !== undefined && (
												<span>{formatSize(selectedStats.sizeBytes)} on disk</span>
											)}
									</div>
									{selectedStats?.error && (
										<div className="text-xs" style={{ color: theme.colors.warning }}>
											{selectedStats.error}
										</div>
									)}
								</div>
								{showData ? (
									<div
										className="flex-1 min-h-0"
										style={{ borderTop: `1px solid ${theme.colors.border}` }}
									>
										<SqliteTableView
											// One mount per object, so a selection change never
											// shows the previous object's rows or sort.
											key={`${selected.kind}:${selected.name}`}
											handle={info.handle}
											object={selected}
											filter={filters.get(filterKey(selected)) ?? ''}
											onFilterChange={handleFilterChange}
											focusFilterRequested={focusFilterRequested}
											onFilterFocused={handleFilterFocused}
											onRowCountSettled={handleRowCountSettled}
											editToken={editGrant?.editToken ?? null}
											onWrite={handleWrite}
											reloadSignal={tableReload}
											theme={theme}
										/>
									</div>
								) : (
									<div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 select-text">
										<SqliteSchemaPanel handle={info.handle} object={selected} theme={theme} />
									</div>
								)}
							</>
						) : (
							<div className="p-4 text-sm" style={{ color: theme.colors.textDim }}>
								This database has no tables, views, indexes, or triggers.
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
});
