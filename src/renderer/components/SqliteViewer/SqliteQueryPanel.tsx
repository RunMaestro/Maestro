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
 * A failure or refusal is shown under the grid, never as a toast.
 *
 * A statement with parameters (`?`, `:id`) gets one value box per parameter
 * between the toolbar and the grid (SqliteQueryParameters), read from the
 * text as it changes. The values ride with the run and are bound by the
 * driver; a parameter that cannot bind (a Number box that holds no number)
 * is refused here, before any process starts, with the same words the run
 * would use.
 *
 * The query text and the run are owned by the viewer (`value` / `run`), so
 * switching to Browse and back keeps both. Every call carries a fresh id; a
 * reply under any other id than the run's current one is stale and dropped,
 * which holds across a remount too.
 */

import { useCallback, useEffect, useMemo, useState, type SetStateAction } from 'react';
import { Play, Square } from 'lucide-react';
import type { Extension } from '@codemirror/state';

import { formatCount } from '../../../shared/formatters';
import {
	SQLITE_QUERY_PAGE_ROWS,
	SQLITE_READ_ONLY_KEYWORDS,
	sqliteQueryBinding,
	sqliteQueryParameters,
	sqliteReadOnlyRefusal,
} from '../../../shared/sqlite/query';
import type {
	SqliteParameterValue,
	SqliteParameterValues,
	SqliteQueryResult,
} from '../../../shared/sqlite/types';
import type { Theme } from '../../types';
import { useStableCallback } from '../../hooks/utils/useStableCallback';
import { generateId } from '../../utils/ids';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { MarkdownEditor } from '../FilePreview/markdownEditor';
import { DataGrid } from '../ui/DataGrid';
import { Spinner } from '../ui/Spinner';
import { sqliteGridCell, sqliteGridColumn } from './sqliteGrid';
import { SqliteQueryParameters, sqliteParameterValuesFor } from './SqliteQueryParameters';

/** The last statement run in Query mode and what it returned so far. */
export interface SqliteQueryRunState {
	/** Id of the call in flight or last made. A reply under another id is stale. */
	runId: string;
	/** The text that ran; the editor may have moved on since. */
	sql: string;
	/** The parameter values it ran with, so a later window binds the same ones. */
	params: SqliteParameterValues;
	/** Columns and every row loaded so far; null until the first window lands. */
	result: SqliteQueryResult | null;
	/** A call (the first window or a later one) is in flight. */
	running: boolean;
	/** Why the last call failed or was refused, verbatim. */
	error: string | null;
}

interface SqliteQueryPanelProps {
	handle: string;
	value: string;
	onChange: (value: string) => void;
	/** Values typed for the statement's parameters, keyed by label. */
	params: SqliteParameterValues;
	onParamsChange: (update: SetStateAction<SqliteParameterValues>) => void;
	run: SqliteQueryRunState | null;
	onRunChange: (update: SetStateAction<SqliteQueryRunState | null>) => void;
	theme: Theme;
}

const BLOB_HINT = 'Open the table in Browse to save a BLOB to a file';

export function SqliteQueryPanel({
	handle,
	value,
	onChange,
	params,
	onParamsChange,
	run,
	onRunChange,
	theme,
}: SqliteQueryPanelProps) {
	const [language, setLanguage] = useState<Extension | undefined>(undefined);
	const [catalogError, setCatalogError] = useState<string | null>(null);

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
	 * still in flight); a later offset re-runs the statement already shown, for
	 * the next window, and appends it.
	 */
	const runQuery = useStableCallback(async (offset: number) => {
		const sql = offset === 0 ? value : (run?.sql ?? '');
		const values =
			offset === 0 ? sqliteParameterValuesFor(scan.parameters, params) : (run?.params ?? {});
		const refusal =
			offset === 0 ? (sqliteReadOnlyRefusal(sql) ?? sqliteQueryBinding(sql, values).problem) : null;
		if (offset === 0 && run?.running) void window.maestro.sqlite.cancelQuery(run.runId);
		const runId = generateId();
		if (refusal) {
			// The text and the values alone settle it: no process is started.
			onRunChange({ runId, sql, params: values, result: null, running: false, error: refusal });
			return;
		}
		onRunChange((previous) =>
			offset === 0 || !previous
				? { runId, sql, params: values, result: null, running: true, error: null }
				: { ...previous, runId, running: true, error: null }
		);
		try {
			const page = await window.maestro.sqlite.runQuery({
				handle,
				sql,
				params: values,
				offset,
				limit: SQLITE_QUERY_PAGE_ROWS,
				queryId: runId,
			});
			onRunChange((previous) => {
				if (previous?.runId !== runId) return previous;
				const result =
					offset > 0 && previous.result
						? { ...page, offset: 0, rows: [...previous.result.rows, ...page.rows] }
						: page;
				return { ...previous, result, running: false };
			});
		} catch (failure) {
			onRunChange((previous) =>
				previous?.runId === runId
					? { ...previous, running: false, error: ipcErrorMessage(failure) }
					: previous
			);
		}
	});

	const handleRun = useCallback(() => void runQuery(0), [runQuery]);
	const handleParamChange = useCallback(
		(label: string, next: SqliteParameterValue) =>
			onParamsChange((previous) => ({ ...previous, [label]: next })),
		[onParamsChange]
	);
	const handleStop = useCallback(() => {
		if (run?.running) void window.maestro.sqlite.cancelQuery(run.runId);
	}, [run]);

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
		if (!result?.hasMore || run?.running || run?.error) return;
		void runQuery(result.rows.length);
	}, [result, run?.running, run?.error, runQuery]);
	const ignoreSort = useCallback(() => undefined, []);

	const runKeys = formatShortcutKeys(['Meta', 'Enter']);
	const running = run?.running === true;

	return (
		<div className="flex flex-col h-full min-h-0" data-testid="sqlite-query-panel">
			<div className="shrink-0 h-[38%] min-h-[120px]">
				<MarkdownEditor
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
					className="flex items-center gap-1.5 px-2.5 py-1 rounded font-medium"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					title={`Run the statement (${runKeys}). Read-only: ${SQLITE_READ_ONLY_KEYWORDS.join(', ')}.`}
					data-testid="sqlite-query-run"
				>
					<Play className="w-3 h-3" />
					Run
					<span className="opacity-70" data-shortcut-hint>
						{runKeys}
					</span>
				</button>
				{running && (
					<button
						type="button"
						onClick={handleStop}
						className="flex items-center gap-1.5 px-2.5 py-1 rounded"
						style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
						title="Stop the statement"
						data-testid="sqlite-query-stop"
					>
						<Square className="w-3 h-3" />
						Stop
					</button>
				)}
				<span>Read-only: anything that would change the database is refused.</span>
			</div>
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
				{result && result.returnsRows ? (
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
						) : result ? (
							`${result.statement} ran and returns no rows.`
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
						{run.error}
					</span>
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
	);
}
