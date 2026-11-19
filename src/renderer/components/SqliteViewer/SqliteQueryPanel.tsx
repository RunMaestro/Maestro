/**
 * SqliteQueryPanel - the SQLite viewer's Query mode: a SQL editor over the
 * result of the last statement run.
 *
 * The editor is the shared CodeMirror editor (`MarkdownEditor` in
 * code-editor mode, the same one the file editor uses) with the SQLite
 * dialect and completion built from the open database: keywords, table and
 * view names, `table.` and `alias.` columns, and the bare columns of the
 * tables a statement names (see `sqliteSqlLanguage.ts`). The column catalog
 * is read once per open database over `sqlite:readColumns`; the grammar
 * module is loaded with `import()` so lang-sql stays out of the main bundle.
 * Until both arrive the editor runs on the plain SQL grammar, so typing never
 * waits on them; a catalog that fails to load leaves keyword completion and
 * says so.
 *
 * Run (or Cmd+Enter in the editor) sends the statement to main
 * (`sqlite:runQuery`), which runs it read-only by construction in a child
 * process with a connection of its own (src/main/sqlite/sqlite-query.ts):
 * anything that would write is refused there, and a runaway statement is
 * stopped at a timeout or by Stop. The result fills the shared `<DataGrid>`
 * with the same cells the table view draws (sqliteGrid.ts), a window at a
 * time: scrolling near the end re-runs the statement for the next window.
 * A failure or refusal is shown under the grid, never as a toast, against
 * the statement: the token it points at is underlined in the editor (the one
 * SQLite stopped at for a syntax error, found in the child process; a missing
 * table, column, or function by its name; the keyword a refusal names), and
 * its line and column, shown before the message, put the cursor there.
 *
 * With the tab's "Enable editing" on (`editToken`), and only then, the
 * read-only assertion is lifted: the token rides with the run, and main
 * sends a statement that changes the database through the write gate and the
 * session's backup, running it once in a transaction of its own (ATTACH,
 * DETACH, VACUUM INTO, and transaction control stay refused). Its result
 * says how many rows it changed, shows any `RETURNING` rows, and is never
 * paged or exported, since either would run it again. The viewer hears of
 * each write (`onWrite`) to re-read the table on screen; the toolbar note
 * turns to a warning while editing is on.
 *
 * Dry run (editing on, Rows mode) asks first: main says what kind of
 * statement it is (`classifySqliteStatement()`) and, for a write, tries it
 * once in a transaction in the child and rolls it back, so the status line
 * reads what it would change (rows, rows its triggers and foreign-key actions
 * would change, schema objects it would create, drop, or alter) and the grid
 * shows any `RETURNING` rows, while the database stays as it was. A read is
 * not run; VACUUM and a writing PRAGMA are not tried. Never paged, exported,
 * or announced as a write; Run applies the statement.
 *
 * Begin transaction (editing on) opens an explicit transaction the viewer
 * keeps (`useSqliteTransaction()`, main's sqlite-transaction.ts): from then
 * on every Run goes into it, reads included, so a SELECT sees what the
 * UPDATE before it changed, and each result says what the statement changed
 * there. A strip under the toolbar says what the transaction holds so far
 * (`formatSqliteTransaction()`) beside Commit and Roll back; nothing is in
 * the file until Commit. Dry run is refused while it is open (it would wait
 * on the transaction's own write lock), Run waits for the statement in
 * flight instead of stopping it (Stop rolls the whole transaction back), and
 * Export is refused for a result read inside it (Export reads the file as
 * committed). When main ends it on its own (idle, SQLite rolling it back),
 * the strip says how.
 *
 * A statement with parameters (`?`, `:id`) gets one value box per parameter
 * between the toolbar and the grid (SqliteQueryParameters), read from the
 * text as it changes. The values ride with the run and are bound by the
 * driver; a parameter that cannot bind (a Number box that holds no number)
 * is refused here, before any process starts, with the same words the run
 * would use.
 *
 * The Rows / Plan switch in the toolbar runs the statement's
 * `EXPLAIN QUERY PLAN` instead (the same run, `plan: true`), and the result
 * is drawn as the plan's tree (SqliteQueryPlanView): which tables are read
 * whole, which are reached through an index, where SQLite sorts in a
 * temporary b-tree. A plan reads none of the statement's rows, so switching
 * to Plan runs the editor's statement at once; switching back waits for Run.
 *
 * Export writes EVERY row of the statement shown (the one that ran, with the
 * values it ran with, not the editor's newer text) to a CSV or JSON Lines
 * file the person picks (`sqlite:exportQuery`): the statement runs again in
 * a child process, which writes the rows whole, so none of them cross IPC.
 * Its progress, Stop, and outcome sit in the status line; a finished export
 * also raises a toast, since it may end long after the person moved on.
 *
 * History (a toolbar toggle, remembered) opens a rail of the statements run
 * against this database, newest first (SqliteQueryHistoryRail). The main
 * process records every run, so the rail is re-read whenever a run settles;
 * picking an entry puts its statement, values, and mode back in the editor.
 *
 * The query text and the run are owned by the viewer (`value` / `run`), so
 * switching to Browse and back keeps both. Every call carries a fresh id; a
 * reply under any other id than the run's current one is stale and dropped,
 * which holds across a remount too.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { Check, Download, FlaskConical, History, Layers, Play, Square, Undo2 } from 'lucide-react';
import type { Extension } from '@codemirror/state';

import { formatCount } from '../../../shared/formatters';
import {
	SQLITE_QUERY_MAX_LIMIT,
	SQLITE_QUERY_PAGE_ROWS,
	SQLITE_READ_ONLY_KEYWORDS,
	sqliteQueryBinding,
	sqliteQueryParameters,
	sqliteQueryRefusal,
} from '../../../shared/sqlite/query';
import { sqliteQueryPlanSteps } from '../../../shared/sqlite/plan';
import { formatSqliteDryRun, sqliteDryRunRefusal } from '../../../shared/sqlite/dryRun';
import {
	SQLITE_TRANSACTION_IDLE_MS,
	formatSqliteTransaction,
} from '../../../shared/sqlite/transaction';
import {
	formatSqliteQueryErrorPlace,
	splitSqliteErrorOffset,
	sqliteQueryErrorLocation,
	type SqliteQueryErrorLocation,
} from '../../../shared/sqlite/queryError';
import type {
	SqliteParameterValue,
	SqliteParameterValues,
	SqliteQueryExported,
	SqliteQueryHistoryEntry,
	SqliteQueryResult,
	SqliteQueryWrite,
} from '../../../shared/sqlite/types';
import {
	TABULAR_EXPORT_FILE_FILTERS,
	tabularExportFormatForPath,
} from '../../../shared/tabularExport';
import type { Theme } from '../../types';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { useStableCallback } from '../../hooks/utils/useStableCallback';
import { notifyToast } from '../../stores/notificationStore';
import { generateId } from '../../utils/ids';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { MarkdownEditor, type MarkdownEditorHandle } from '../FilePreview/markdownEditor';
import { DataGrid } from '../ui/DataGrid';
import { Spinner } from '../ui/Spinner';
import { sqliteGridCell, sqliteGridColumn } from './sqliteGrid';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SqliteQueryHistoryRail } from './SqliteQueryHistoryRail';
import { SqliteQueryParameters, sqliteParameterValuesFor } from './SqliteQueryParameters';
import { SqliteQueryPlanView } from './SqliteQueryPlanView';
import { announceSqliteBackup, sqliteOtherChangesText } from './sqliteWriteNotice';
import type { SqliteTransactionControl } from './useSqliteTransaction';

/** The last statement run in Query mode and what it returned so far. */
export interface SqliteQueryRunState {
	/** Id of the call in flight or last made. A reply under another id is stale. */
	runId: string;
	/** The text that ran; the editor may have moved on since. */
	sql: string;
	/** The parameter values it ran with, so a later window binds the same ones. */
	params: SqliteParameterValues;
	/** It ran as `EXPLAIN QUERY PLAN`: the rows are its plan, shown whole. */
	plan: boolean;
	/** It was a dry run: tried and rolled back, or only classified. Never paged. */
	dryRun: boolean;
	/** The open transaction it ran in, so a later window reads in the same one; else null. */
	transactionId: string | null;
	/** Columns and every row loaded so far; null until the first window lands. */
	result: SqliteQueryResult | null;
	/** A call (the first window or a later one) is in flight. */
	running: boolean;
	/** Why the last call failed or was refused, verbatim. */
	error: string | null;
	/** The span of `sql` the error points at, when it names one. */
	errorLocation: SqliteQueryErrorLocation | null;
}

/** An export of the shown result: in flight, written, or failed. */
interface SqliteQueryExportState {
	/** Id of the export call, which Stop cancels. */
	exportId: string;
	/** The run whose result it exports; a finished export is shown only beside that run. */
	runId: string;
	running: boolean;
	exported: SqliteQueryExported | null;
	error: string | null;
}

interface SqliteQueryPanelProps {
	handle: string;
	/** The database's file name, for the export's suggested name. */
	fileName: string;
	value: string;
	onChange: (value: string) => void;
	/** Values typed for the statement's parameters, keyed by label. */
	params: SqliteParameterValues;
	onParamsChange: (update: SetStateAction<SqliteParameterValues>) => void;
	run: SqliteQueryRunState | null;
	onRunChange: (update: SetStateAction<SqliteQueryRunState | null>) => void;
	/** The Plan toggle: Run shows the statement's query plan instead of its rows. */
	plan: boolean;
	onPlanChange: (plan: boolean) => void;
	/**
	 * The tab's editing grant token while "Enable editing" is on, else null.
	 * Only with it does a run lift the read-only assertion; main checks it.
	 */
	editToken: string | null;
	/** A statement changed the database (its result's `write`). */
	onWrite: (write: SqliteQueryWrite) => void;
	/** The tab's explicit transaction (kept by the viewer): Begin, its state, Commit, Roll back. */
	transaction: SqliteTransactionControl;
	theme: Theme;
}

type ResultMode = 'rows' | 'plan';
const RESULT_MODES = [
	{ value: 'rows' as const, label: 'Rows', title: "Run shows the statement's rows" },
	{
		value: 'plan' as const,
		label: 'Plan',
		title:
			"Run shows the statement's EXPLAIN QUERY PLAN: full scans, index searches, temporary sorts. Reads none of its rows.",
	},
];

const BLOB_HINT = 'Open the table in Browse to save a BLOB to a file';

/** "DELETE changed 3 rows; the database's triggers ... changed 2 other rows". */
function sqliteWriteSummary(
	statement: string,
	write: Pick<SqliteQueryWrite, 'changes' | 'otherChanges'>
): string {
	const rows = `${formatCount(write.changes)} ${write.changes === 1 ? 'row' : 'rows'}`;
	return `${statement} changed ${rows}${sqliteOtherChangesText(write.otherChanges)}`;
}

/** "It would return 3 rows." / "...at least 501 rows.": a dry run's RETURNING rows, first window only. */
function sqliteDryRunReturnedText(result: SqliteQueryResult): string {
	const count = result.rows.length;
	if (result.hasMore) return `It would return more than ${formatCount(count)} rows.`;
	return `It would return ${formatCount(count)} ${count === 1 ? 'row' : 'rows'}.`;
}

export function SqliteQueryPanel({
	handle,
	fileName,
	value,
	onChange,
	params,
	onParamsChange,
	run,
	onRunChange,
	plan,
	onPlanChange,
	editToken,
	onWrite,
	transaction,
	theme,
}: SqliteQueryPanelProps) {
	const editing = editToken !== null;
	const openTransaction = editing ? transaction.state : null;
	const [language, setLanguage] = useState<Extension | undefined>(undefined);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const showHistory = usePersistedToggle('sqlite-query-history', false);
	/** Bumped when a run settles, so the History rail reads the history again. */
	const [historyStamp, setHistoryStamp] = useState(0);
	const [exportState, setExportState] = useState<SqliteQueryExportState | null>(null);
	const editorRef = useRef<MarkdownEditorHandle | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLanguage(undefined);
		setCatalogError(null);
		Promise.all([window.maestro.sqlite.readColumns(handle), import('./sqliteSqlLanguage')])
			.then(([catalog, grammar]) => {
				if (!cancelled) setLanguage(grammar.buildSqliteSqlLanguage(catalog));
			})
			.catch((error: unknown) => {
				if (!cancelled) setCatalogError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			cancelled = true;
		};
	}, [handle]);

	// Re-read on every edit: one linear pass, cheaper than the editor's own parse.
	const scan = useMemo(() => sqliteQueryParameters(value), [value]);

	/**
	 * Run a statement. Offset 0 runs the editor's text afresh (stopping a run
	 * still in flight), as a plan when `asPlan`; a later offset re-runs the
	 * statement already shown, for the next window, and appends it. A plan is
	 * read whole in one call. `asDryRun` asks main for a dry run instead
	 * (editing only): tried and rolled back, its first window only.
	 */
	const runQuery = useStableCallback(
		async (offset: number, asPlan: boolean = plan, asDryRun: boolean = false) => {
			const sql = offset === 0 ? value : (run?.sql ?? '');
			const values =
				offset === 0 ? sqliteParameterValuesFor(scan.parameters, params) : (run?.params ?? {});
			const runPlan = offset === 0 ? asPlan : run?.plan === true;
			const dryRun = offset === 0 && asDryRun;
			const transactionId =
				offset === 0 ? (openTransaction?.transactionId ?? null) : (run?.transactionId ?? null);
			// Stopping a statement in a transaction would roll the whole transaction back.
			if (offset === 0 && transactionId && run?.running) return;
			const refusal =
				offset === 0
					? ((dryRun
							? sqliteDryRunRefusal({ editing, plan: runPlan, transaction: transactionId !== null })
							: null) ??
						sqliteQueryRefusal(sql, { plan: runPlan, editing }) ??
						sqliteQueryBinding(sql, values).problem)
					: null;
			if (offset === 0 && run?.running) void window.maestro.sqlite.cancelQuery(run.runId);
			const runId = generateId();
			const fresh = {
				runId,
				sql,
				params: values,
				plan: runPlan,
				dryRun,
				transactionId,
				result: null,
			};
			if (refusal) {
				// The text and the values alone settle it: no process is started.
				onRunChange({
					...fresh,
					running: false,
					error: refusal,
					errorLocation: sqliteQueryErrorLocation(sql, refusal),
				});
				return;
			}
			onRunChange((previous) =>
				offset === 0 || !previous
					? { ...fresh, running: true, error: null, errorLocation: null }
					: { ...previous, runId, running: true, error: null, errorLocation: null }
			);
			try {
				const page = await window.maestro.sqlite.runQuery({
					handle,
					sql,
					params: values,
					plan: runPlan,
					...(dryRun ? { dryRun: true } : {}),
					offset,
					limit: runPlan ? SQLITE_QUERY_MAX_LIMIT : SQLITE_QUERY_PAGE_ROWS,
					queryId: runId,
					// Main lifts the read-only assertion only for a live grant.
					editToken,
					...(transactionId ? { transactionId } : {}),
				});
				if (page.inTransaction) transaction.noteStep(page.inTransaction);
				if (page.write) {
					// It changed the database whether or not this run is still shown.
					announceSqliteBackup(page.write.backup);
					onWrite(page.write);
				}
				onRunChange((previous) => {
					if (previous?.runId !== runId) return previous;
					const result =
						offset > 0 && previous.result
							? { ...page, offset: 0, rows: [...previous.result.rows, ...page.rows] }
							: page;
					return { ...previous, result, running: false };
				});
			} catch (failure) {
				// SQLite may have rolled the transaction back with the failure.
				if (transactionId) transaction.resync();
				// A syntax error carries where SQLite stopped; see `withSqliteErrorOffset()`.
				const { message, offset: errorOffset } = splitSqliteErrorOffset(ipcErrorMessage(failure));
				onRunChange((previous) =>
					previous?.runId === runId
						? {
								...previous,
								running: false,
								error: message,
								errorLocation: sqliteQueryErrorLocation(sql, message, errorOffset),
							}
						: previous
				);
			} finally {
				// Main records a first window's run before it answers.
				if (offset === 0) setHistoryStamp((stamp) => stamp + 1);
			}
		}
	);

	/** Write every row of the statement shown to a file the person picks. */
	const handleExport = useStableCallback(async () => {
		if (!run?.result?.returnsRows || run.plan || exportState?.running) return;
		const shown = run;
		const destination = await window.maestro.dialog.saveFile({
			title: 'Export the query result',
			defaultPath: `${fileName.replace(/\.[^.]+$/, '') || 'query'}-query.csv`,
			filters: [...TABULAR_EXPORT_FILE_FILTERS],
		});
		if (!destination) return;
		const exportId = generateId();
		setExportState({ exportId, runId: shown.runId, running: true, exported: null, error: null });
		try {
			const exported = await window.maestro.sqlite.exportQuery({
				handle,
				sql: shown.sql,
				params: shown.params,
				destPath: destination,
				format: tabularExportFormatForPath(destination),
				queryId: exportId,
			});
			setExportState((previous) =>
				previous?.exportId === exportId ? { ...previous, running: false, exported } : previous
			);
			notifyToast({
				color: 'green',
				title: 'Export complete',
				message: `${formatCount(exported.rows)} ${exported.rows === 1 ? 'row' : 'rows'} written to ${exported.path}`,
			});
		} catch (failure) {
			setExportState((previous) =>
				previous?.exportId === exportId
					? { ...previous, running: false, error: ipcErrorMessage(failure) }
					: previous
			);
		}
	});
	const handleStopExport = useCallback(() => {
		if (exportState?.running) void window.maestro.sqlite.cancelQuery(exportState.exportId);
	}, [exportState]);

	/** Put a history entry back in the editor, with its values and mode, without running it. */
	const handlePickHistory = useCallback(
		(entry: SqliteQueryHistoryEntry) => {
			onChange(entry.sql);
			onParamsChange((previous) => ({ ...previous, ...entry.params }));
			onPlanChange(entry.plan);
		},
		[onChange, onParamsChange, onPlanChange]
	);

	const handleRun = useCallback(() => void runQuery(0), [runQuery]);
	const handleDryRun = useCallback(() => void runQuery(0, false, true), [runQuery]);
	const handleResultModeChange = useCallback(
		(mode: ResultMode) => {
			const next = mode === 'plan';
			if (next === plan) return;
			onPlanChange(next);
			// A plan reads no rows, so it is safe to show at once; rows wait for Run.
			if (next && value.trim()) void runQuery(0, true);
		},
		[plan, onPlanChange, value, runQuery]
	);
	const handleParamChange = useCallback(
		(label: string, next: SqliteParameterValue) =>
			onParamsChange((previous) => ({ ...previous, [label]: next })),
		[onParamsChange]
	);
	const handleStop = useCallback(() => {
		if (run?.running) void window.maestro.sqlite.cancelQuery(run.runId);
	}, [run]);

	// The error's span is drawn only over the text that ran; an edit since may
	// have moved or fixed it, and the next run says which.
	const errorLocation = run?.error && run.sql === value ? run.errorLocation : null;
	const problemRange = useMemo(
		() =>
			errorLocation && run?.error
				? { from: errorLocation.from, to: errorLocation.to, message: run.error }
				: null,
		[errorLocation, run?.error]
	);
	/** Put the cursor on the span the error points at. */
	const handleJumpToError = useCallback(() => {
		if (!errorLocation) return;
		editorRef.current?.setSelection(errorLocation.from, errorLocation.to, true);
		editorRef.current?.focus();
	}, [errorLocation]);

	/**
	 * The editor's host keydown hook. Cmd+Enter runs; every other key stays
	 * the editor's. Passing a hook at all is what lets an open completion
	 * popup keep Escape, Enter, and the arrows from the file preview (see
	 * `editorClaimsKey`).
	 */
	const handleEditorKey = useCallback(
		(event: KeyboardEvent): boolean => {
			if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.shiftKey) {
				return false;
			}
			event.preventDefault();
			handleRun();
			return true;
		},
		[handleRun]
	);

	const result = run?.result ?? null;
	const rows = result?.rows;
	const gridColumns = useMemo(
		() =>
			(result?.columns ?? []).map((column, position) =>
				sqliteGridColumn(column, { key: String(position), sortable: false })
			),
		[result?.columns]
	);
	const getCell = useCallback(
		(rowPosition: number, columnPosition: number) =>
			sqliteGridCell(rows?.[rowPosition]?.[columnPosition] ?? null, BLOB_HINT),
		[rows]
	);
	const getRowLabel = useCallback((rowPosition: number) => formatCount(rowPosition + 1), []);
	const handleReachEnd = useCallback(() => {
		// A statement that changed the database runs once: a later window would re-run it.
		// Nor is a dry run, whose trial is rolled back each time.
		if (!result?.hasMore || result.write || result.dryRun || result.inTransaction?.writes) return;
		if (run?.plan || run?.running || run?.error) return;
		void runQuery(result.rows.length);
	}, [result, run?.plan, run?.running, run?.error, runQuery]);
	const ignoreSort = useCallback(() => undefined, []);

	const runKeys = formatShortcutKeys(['Meta', 'Enter']);
	const running = run?.running === true;
	const showsPlan = run?.plan === true && result?.returnsRows === true;
	const planSteps = useMemo(
		() => (showsPlan && result ? sqliteQueryPlanSteps(result.rows) : []),
		[showsPlan, result]
	);
	const exporting = exportState?.running === true;
	// An export runs the statement again, so a write's result is never exported;
	// it reads the file as committed, so neither is a result read inside a transaction.
	const canExport =
		result?.returnsRows === true &&
		!result.write &&
		!result.dryRun &&
		!result.inTransaction &&
		run?.plan !== true &&
		!running &&
		!exporting;
	// A finished export is news only beside the result it exported.
	const shownExport = exporting || exportState?.runId === run?.runId ? exportState : null;

	return (
		<div className="flex h-full min-h-0" data-testid="sqlite-query-panel">
			<div className="flex flex-col flex-1 min-w-0 min-h-0">
				<div className="shrink-0 h-[38%] min-h-[120px]">
					<MarkdownEditor
						ref={editorRef}
						value={value}
						onChange={onChange}
						language="sql"
						languageExtension={language}
						theme={theme}
						codeEditing
						completion="typing"
						showLineNumbers
						wrap
						placeholder="SELECT * FROM ... WHERE id = :id"
						onKeyDown={handleEditorKey}
						problemRange={problemRange}
					/>
				</div>
				<div
					className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs-plus select-none"
					style={{
						borderTop: `1px solid ${theme.colors.border}`,
						borderBottom: `1px solid ${theme.colors.border}`,
						color: theme.colors.textDim,
					}}
				>
					<button
						type="button"
						onClick={handleRun}
						disabled={openTransaction !== null && running}
						className="flex items-center gap-1.5 px-2.5 py-1 rounded font-medium disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						title={
							plan
								? `Show the statement's query plan (${runKeys}). Reads none of its rows.`
								: openTransaction
									? `Run the statement in the open transaction (${runKeys}). Reads see its changes; nothing is in the file until Commit.`
									: editing
										? `Run the statement (${runKeys}). Editing is on: a statement that changes the database runs once, in its own transaction.`
										: `Run the statement (${runKeys}). Read-only: ${SQLITE_READ_ONLY_KEYWORDS.join(', ')}.`
						}
						data-testid="sqlite-query-run"
					>
						<Play className="w-3 h-3" />
						Run
						<span className="opacity-70" data-shortcut-hint>
							{runKeys}
						</span>
					</button>
					{editing && !plan && !openTransaction && (
						<button
							type="button"
							onClick={handleDryRun}
							className="flex items-center gap-1.5 px-2.5 py-1 rounded"
							style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
							title="Dry run: say what kind of statement this is and what it would change, then change nothing. A write is tried once in a transaction and rolled back; a read is not run."
							data-testid="sqlite-query-dry-run"
						>
							<FlaskConical className="w-3 h-3" />
							Dry run
						</button>
					)}
					{editing && !openTransaction && (
						<button
							type="button"
							onClick={transaction.begin}
							disabled={transaction.pending !== null}
							className="flex items-center gap-1.5 px-2.5 py-1 rounded disabled:opacity-50"
							style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
							title="Begin a transaction: every Run then goes into it, reads included, and nothing reaches the file until Commit. Roll back discards it all. It holds the file's write lock while open."
							data-testid="sqlite-transaction-begin"
						>
							{transaction.pending === 'begin' ? (
								<Spinner size={10} decorative />
							) : (
								<Layers className="w-3 h-3" />
							)}
							Begin transaction
						</button>
					)}
					{running && (
						<button
							type="button"
							onClick={handleStop}
							className="flex items-center gap-1.5 px-2.5 py-1 rounded"
							style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
							title={
								run?.transactionId
									? 'Stop the statement. This rolls back the whole transaction: a statement can only be stopped by ending the process that holds it.'
									: 'Stop the statement'
							}
							data-testid="sqlite-query-stop"
						>
							<Square className="w-3 h-3" />
							Stop
						</button>
					)}
					<SegmentedControl<ResultMode>
						value={plan ? 'plan' : 'rows'}
						onChange={handleResultModeChange}
						options={RESULT_MODES}
						theme={theme}
						ariaLabel="Show the statement's rows or its query plan"
						testId="sqlite-query-result-mode"
					/>
					{openTransaction ? (
						<span
							className="truncate"
							style={{ color: theme.colors.warning }}
							title="Commit or Roll back in the strip below ends it. Lock, closing the file, and a stopped statement roll it back."
							data-testid="sqlite-query-editing-note"
						>
							In a transaction: every statement runs inside it, reads included.
						</span>
					) : editing ? (
						<span
							className="truncate"
							style={{ color: theme.colors.warning }}
							title="Lock in the summary strip makes Query mode read-only again. ATTACH, DETACH, VACUUM INTO, and typed BEGIN/COMMIT stay refused: Begin transaction holds several statements in one."
							data-testid="sqlite-query-editing-note"
						>
							Editing enabled: a statement that changes the database runs, once, in its own
							transaction.
						</span>
					) : (
						<span className="truncate" data-testid="sqlite-query-read-only-note">
							Read-only: anything that would change the database is refused. Enable editing to
							change it.
						</span>
					)}
					<div className="ml-auto flex items-center gap-1 shrink-0">
						<button
							type="button"
							onClick={() => void handleExport()}
							disabled={!canExport}
							className="flex items-center gap-1 px-2 py-1 rounded disabled:opacity-40"
							style={{ color: theme.colors.textDim }}
							title={
								run?.plan
									? 'A query plan has no rows to export; switch to Rows and run the statement'
									: result?.write
										? 'This statement changed the database; exporting would run it again'
										: result?.inTransaction
											? 'Export reads the file as committed, not this transaction; Commit, then run it again to export'
											: result?.dryRun
												? 'A dry run changes nothing and exports nothing; Run the statement to export its rows'
												: 'Write every row of the result to a CSV or JSON Lines file, whole'
							}
							data-testid="sqlite-query-export"
						>
							<Download className="w-3.5 h-3.5" />
							Export
						</button>
						<button
							type="button"
							onClick={showHistory.toggle}
							className="flex items-center gap-1 px-2 py-1 rounded"
							style={{
								color: showHistory.value ? theme.colors.accentText : theme.colors.textDim,
								backgroundColor: showHistory.value ? `${theme.colors.accent}22` : 'transparent',
							}}
							title="Show the statements run against this database"
							aria-pressed={showHistory.value}
							data-testid="sqlite-query-toggle-history"
						>
							<History className="w-3.5 h-3.5" />
							History
						</button>
					</div>
				</div>
				{editing && (openTransaction || transaction.lastEnd || transaction.error) && (
					<div
						className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs-plus select-none"
						style={{
							borderBottom: `1px solid ${theme.colors.border}`,
							color: theme.colors.textDim,
						}}
						data-testid="sqlite-transaction-strip"
					>
						{openTransaction ? (
							<>
								<span
									className="select-text truncate"
									style={{ color: theme.colors.warning }}
									title={`It holds the file's write lock, so other writers wait. Rolled back by itself after ${Math.round(SQLITE_TRANSACTION_IDLE_MS / 60_000)} minutes with nothing run in it.`}
									data-testid="sqlite-transaction-summary"
								>
									{formatSqliteTransaction(openTransaction)}
								</span>
								<div className="ml-auto flex items-center gap-1 shrink-0">
									<button
										type="button"
										onClick={transaction.commit}
										disabled={transaction.pending !== null || running}
										className="flex items-center gap-1 px-2 py-0.5 rounded font-medium disabled:opacity-50"
										style={{
											backgroundColor: theme.colors.accent,
											color: theme.colors.accentForeground,
										}}
										title="Commit: write everything the transaction holds to the file, as one change"
										data-testid="sqlite-transaction-commit"
									>
										{transaction.pending === 'commit' ? (
											<Spinner size={10} decorative />
										) : (
											<Check className="w-3 h-3" />
										)}
										Commit
									</button>
									<button
										type="button"
										onClick={transaction.rollBack}
										disabled={transaction.pending !== null || running}
										className="flex items-center gap-1 px-2 py-0.5 rounded disabled:opacity-50"
										style={{
											border: `1px solid ${theme.colors.border}`,
											color: theme.colors.textMain,
										}}
										title="Roll back: discard everything the transaction holds; the file stays as it was"
										data-testid="sqlite-transaction-rollback"
									>
										{transaction.pending === 'rollback' ? (
											<Spinner size={10} decorative />
										) : (
											<Undo2 className="w-3 h-3" />
										)}
										Roll back
									</button>
								</div>
							</>
						) : transaction.lastEnd ? (
							<span
								className="select-text"
								style={{
									color:
										transaction.lastEnd.outcome === 'committed'
											? theme.colors.success
											: theme.colors.textDim,
								}}
								data-testid="sqlite-transaction-end"
							>
								{transaction.lastEnd.reason}
							</span>
						) : null}
						{transaction.error && (
							<span
								className="select-text"
								style={{ color: theme.colors.error }}
								data-testid="sqlite-transaction-error"
							>
								{transaction.error}
							</span>
						)}
					</div>
				)}
				{(scan.parameters.length > 0 || scan.problem) && (
					<SqliteQueryParameters
						parameters={scan.parameters}
						values={params}
						onChange={handleParamChange}
						problem={scan.problem}
						onRun={handleRun}
						theme={theme}
					/>
				)}
				<div className="flex-1 min-h-0" data-testid="sqlite-query-results">
					{showsPlan ? (
						<SqliteQueryPlanView steps={planSteps} theme={theme} />
					) : result && result.returnsRows ? (
						<DataGrid
							columns={gridColumns}
							rowCount={result.rows.length}
							getCell={getCell}
							getRowLabel={getRowLabel}
							gutterTitle="Row number in the result"
							theme={theme}
							sort={null}
							onSortChange={ignoreSort}
							onReachEnd={handleReachEnd}
							loadingMore={running && result.rows.length > 0}
							emptyMessage="The statement returns no columns."
							testIdPrefix="sqlite-query"
						/>
					) : (
						<div
							className="flex items-center justify-center h-full gap-2 text-sm select-none"
							style={{ color: theme.colors.textDim }}
							data-testid="sqlite-query-empty"
						>
							{running ? (
								<>
									<Spinner size={16} decorative />
									Running...
								</>
							) : result?.dryRun ? (
								`Dry run of ${result.statement}: the database was not changed.`
							) : result?.write ? (
								`${result.statement} ran and changed the database.`
							) : result?.inTransaction?.writes ? (
								`${result.statement} ran in the open transaction. Nothing is in the file until Commit.`
							) : result ? (
								`${result.statement} ran and returns no rows.`
							) : plan ? (
								`Write a statement and press Run (${runKeys}) to see its query plan.`
							) : (
								`Write a statement and press Run (${runKeys}).`
							)}
						</div>
					)}
				</div>
				<div
					className="shrink-0 px-3 py-1.5 text-xs-plus flex gap-3 flex-wrap select-none"
					style={{ borderTop: `1px solid ${theme.colors.border}`, color: theme.colors.textDim }}
					data-testid="sqlite-query-status"
				>
					{run?.error ? (
						<span
							className="select-text whitespace-pre-wrap"
							style={{ color: theme.colors.error }}
							data-testid="sqlite-query-error"
						>
							{errorLocation && (
								<button
									type="button"
									onClick={handleJumpToError}
									className="underline underline-offset-2 select-none"
									style={{ color: theme.colors.error }}
									title="Put the cursor on the part of the statement this error points at"
									data-testid="sqlite-query-error-place"
								>
									{formatSqliteQueryErrorPlace(errorLocation)}:
								</button>
							)}
							{errorLocation && ' '}
							{run.error}
						</span>
					) : result?.dryRun ? (
						<>
							<span
								className="select-text"
								style={{ color: theme.colors.textMain }}
								data-testid="sqlite-query-dry-run-summary"
							>
								Dry run: {formatSqliteDryRun(result.dryRun)}
								{result.returnsRows && ` ${sqliteDryRunReturnedText(result)}`}
							</span>
							{result.dryRun.tried && <span>{result.elapsedMs} ms</span>}
						</>
					) : result?.inTransaction?.writes ? (
						<>
							<span data-testid="sqlite-query-transaction-step">
								{sqliteWriteSummary(result.statement, result.inTransaction)} in the transaction (not
								committed)
								{result.returnsRows &&
									`; returned ${formatCount(result.rows.length)} ${result.rows.length === 1 ? 'row' : 'rows'}${result.hasMore ? ' (more not shown)' : ''}`}
							</span>
							<span>{result.elapsedMs} ms</span>
						</>
					) : result?.write ? (
						<>
							<span data-testid="sqlite-query-write">
								{sqliteWriteSummary(result.statement, result.write)}
								{result.returnsRows &&
									`; returned ${formatCount(result.rows.length)} ${result.rows.length === 1 ? 'row' : 'rows'}${result.hasMore ? ' (more not shown)' : ''}`}
							</span>
							<span>{result.elapsedMs} ms</span>
						</>
					) : showsPlan && result ? (
						<>
							<span data-testid="sqlite-query-total">
								Query plan of {result.statement}: {formatCount(planSteps.length)}{' '}
								{planSteps.length === 1 ? 'step' : 'steps'}
								{result.hasMore ? ' (the first ones only)' : ''}
							</span>
							<span>{result.elapsedMs} ms</span>
						</>
					) : result?.returnsRows ? (
						<>
							<span data-testid="sqlite-query-total">
								{result.rows.length === 0
									? 'No rows'
									: `${formatCount(result.rows.length)} ${result.rows.length === 1 ? 'row' : 'rows'}${result.hasMore ? ' loaded, more below' : ''}`}
							</span>
							<span>{result.elapsedMs} ms</span>
						</>
					) : null}
					{running && result && (
						<span className="flex items-center gap-1">
							<Spinner size={10} decorative />
							running
						</span>
					)}
					{shownExport && (
						<span
							className="flex items-center gap-1.5 select-text"
							data-testid="sqlite-query-export-status"
						>
							{shownExport.running ? (
								<>
									<Spinner size={10} decorative />
									Exporting...
									<button
										type="button"
										onClick={handleStopExport}
										className="flex items-center gap-1 px-1.5 rounded select-none"
										style={{
											border: `1px solid ${theme.colors.border}`,
											color: theme.colors.textMain,
										}}
										title="Stop the export; no file is left behind"
										data-testid="sqlite-query-export-stop"
									>
										<Square className="w-2.5 h-2.5" />
										Stop
									</button>
								</>
							) : shownExport.error ? (
								<span style={{ color: theme.colors.error }}>
									Export failed: {shownExport.error}
								</span>
							) : shownExport.exported ? (
								`Exported ${formatCount(shownExport.exported.rows)} ${shownExport.exported.rows === 1 ? 'row' : 'rows'} to ${shownExport.exported.path}`
							) : null}
						</span>
					)}
					{catalogError ? (
						<span style={{ color: theme.colors.warning }} data-testid="sqlite-query-catalog-error">
							Completing keywords only. The table and column names could not be read: {catalogError}
						</span>
					) : (
						!run && (
							<span>
								Completes keywords, table names, and the columns of the tables a statement names.
								Ctrl+Space asks for suggestions.
							</span>
						)
					)}
				</div>
			</div>
			{showHistory.value && (
				<SqliteQueryHistoryRail
					handle={handle}
					refreshKey={historyStamp}
					onPick={handlePickHistory}
					theme={theme}
				/>
			)}
		</div>
	);
}
