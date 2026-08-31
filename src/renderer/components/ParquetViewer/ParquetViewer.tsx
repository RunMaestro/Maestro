/**
 * ParquetViewer - the file preview surface for `.parquet` files.
 *
 * Parquet is the first previewable format Maestro handles that is genuinely
 * too big to read, so this viewer is a thin client over a query engine rather
 * than a renderer over file content. The main process holds the open file (see
 * src/main/parquet/), and this component asks it for a schema once and then
 * for the window of rows the grid is showing. No parquet bytes ever cross IPC.
 *
 * Three behaviours follow from that split and are worth knowing before editing:
 *
 *  - **Rows arrive lazily and the total converges.** A filtered scan stops as
 *    soon as it has filled the requested window, so `matchedRows` is a lower
 *    bound (rendered as `1,204+`) until the scan reaches the end of the file.
 *    A background pass drives it to the exact number, which is also what warms
 *    the scan for the next page - the count and the prefetch are the same work.
 *
 *  - **Hiding a column is a real optimization, not a CSS trick.** Hidden
 *    columns are dropped from the projection, so the engine never decodes
 *    them. That is the entire point of a columnar format.
 *
 *  - **The filter round-trips to the engine.** Filtering locally over loaded
 *    rows would only ever search the first page, which on a 100M-row file is
 *    a search box that lies.
 */

import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react';
import { Columns3, Database, Download, RefreshCw, AlertTriangle } from 'lucide-react';

import type {
	ParquetCellValue,
	ParquetFetchProgress,
	ParquetFileInfo,
	ParquetQueryResult,
	ParquetSortSpec,
} from '../../../shared/parquet/types';
import type { Theme } from '../../types';
import { formatCount, formatSize } from '../../../shared/formatters';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useDebouncedValue } from '../../hooks/utils/useThrottle';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { notifyToast } from '../../stores/notificationStore';
import { ProgressBar } from '../ui/ProgressBar';
import { RecordDetailModal, type RecordDetailField } from '../ui/RecordDetailModal';
import { ParquetFilterBar, type ParquetFilterBarHandle } from './ParquetFilterBar';
import { ParquetGrid } from './ParquetGrid';
import { ParquetSchemaPanel } from './ParquetSchemaPanel';
import { formatCellExact } from './parquetFormat';

/** Rows fetched per request. Large enough to fill a tall window in one call. */
const PAGE_SIZE = 300;

/**
 * Files under this row count get their exact match total counted
 * automatically. Above it the count is opt-in, because driving a scan to
 * completion over a billion rows is a decision the user should make rather
 * than something a preview does on open.
 */
const AUTO_COUNT_ROW_LIMIT = 5_000_000;

/** Safety valve on the background counting loop. */
const MAX_COUNT_PASSES = 40;

/**
 * Imperative handle for the file preview around this viewer.
 *
 * Cmd+F in a data grid means "find rows", and the filter box is what does
 * that - so the preview routes the shortcut here instead of opening its own
 * find bar, which could only ever search the handoff marker.
 */
export interface ParquetViewerHandle {
	focusFilter: () => void;
}

interface ParquetViewerProps {
	filePath: string;
	fileName: string;
	sshRemoteId?: string;
	theme: Theme;
}

interface ViewerData {
	rows: ParquetCellValue[][];
	rowIndexes: number[];
	columns: string[];
}

const EMPTY_DATA: ViewerData = { rows: [], rowIndexes: [], columns: [] };

export const ParquetViewer = forwardRef<ParquetViewerHandle, ParquetViewerProps>(
	function ParquetViewer({ filePath, fileName, sshRemoteId, theme }, ref) {
		const filterBarRef = useRef<ParquetFilterBarHandle>(null);
		useImperativeHandle(ref, () => ({ focusFilter: () => filterBarRef.current?.focus() }));

		const [info, setInfo] = useState<ParquetFileInfo | null>(null);
		const [openError, setOpenError] = useState<string | null>(null);
		const [filterText, setFilterText] = useState('');
		const [sort, setSort] = useState<ParquetSortSpec | null>(null);
		const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
		const [data, setData] = useState<ViewerData>(EMPTY_DATA);
		const [result, setResult] = useState<ParquetQueryResult | null>(null);
		const [busy, setBusy] = useState(false);
		const [detailRow, setDetailRow] = useState<number | null>(null);
		const [countingRequested, setCountingRequested] = useState(false);
		/**
		 * Remote-copy progress, set only while an SSH-backed file is being
		 * pulled across. Null for a local file, which is opened in place.
		 */
		const [fetchProgress, setFetchProgress] = useState<ParquetFetchProgress | null>(null);
		const schemaPanel = usePersistedToggle('parquet-schema-panel', true);

		// Typing a filter must not fire a scan per keystroke. 250ms is long enough
		// to swallow a burst and short enough that the grid feels reactive.
		const appliedFilter = useDebouncedValue(filterText, 250);

		/**
		 * Bumped whenever the query identity changes (file, filter, sort, or
		 * projection). Every async response checks it before writing state, so a
		 * slow scan for an abandoned filter cannot overwrite a newer result.
		 */
		const generation = useRef(0);
		const loadingRef = useRef(false);

		const visibleColumns = useMemo(
			() => (info ? info.columns.filter((column) => !hiddenColumns.has(column.name)) : []),
			[info, hiddenColumns]
		);
		const projection = useMemo(() => visibleColumns.map((column) => column.name), [visibleColumns]);
		const projectionKey = projection.join(' ');

		// -- Open the file --------------------------------------------------------

		// Armed before the open effect below so the first chunk's progress is
		// not missed. Effects run in declaration order, and a listener attached
		// after `open()` starts would drop however many chunks landed first.
		useEffect(() => {
			return window.maestro.parquet.onFetchProgress((progress) => {
				// Ignore other tabs' copies: every viewer in this window hears
				// every event, and a second open would otherwise drive this
				// tab's bar with someone else's byte counts.
				if (progress.remotePath !== filePath) return;
				setFetchProgress(progress.done ? null : progress);
			});
		}, [filePath]);

		useEffect(() => {
			let cancelled = false;
			setInfo(null);
			setOpenError(null);
			setData(EMPTY_DATA);
			setResult(null);
			setFetchProgress(null);

			window.maestro.parquet
				.open(filePath, sshRemoteId)
				.then((opened) => {
					if (!cancelled) setInfo(opened);
				})
				.catch((error: unknown) => {
					if (!cancelled) setOpenError(error instanceof Error ? error.message : String(error));
				})
				.finally(() => {
					// The copy is over either way; a bar left on screen under an
					// error message reads as still-working.
					if (!cancelled) setFetchProgress(null);
				});

			return () => {
				cancelled = true;
			};
		}, [filePath, sshRemoteId]);

		// Release the main-process handle when the tab goes away. The idle reaper
		// would also get it, but a preview tab left open for an hour should not
		// hold a file descriptor for one.
		const handle = info?.handle;
		useEffect(() => {
			if (!handle) return;
			return () => {
				void window.maestro.parquet.close(handle);
			};
		}, [handle]);

		// -- Fetch pages ----------------------------------------------------------

		const fetchPage = useCallback(
			async (offset: number, mode: 'replace' | 'append') => {
				if (!handle || loadingRef.current) return;
				const token = generation.current;
				loadingRef.current = true;
				setBusy(true);
				try {
					const page = await window.maestro.parquet.query({
						handle,
						filter: appliedFilter,
						columns: projection,
						sort,
						offset,
						limit: PAGE_SIZE,
					});
					if (token !== generation.current) return;
					setResult(page);
					setData((previous) =>
						mode === 'replace'
							? { rows: page.rows, rowIndexes: page.rowIndexes, columns: page.columns }
							: {
									rows: [...previous.rows, ...page.rows],
									rowIndexes: [...previous.rowIndexes, ...page.rowIndexes],
									columns: page.columns,
								}
					);
				} catch (error) {
					if (token === generation.current) {
						notifyToast({
							color: 'red',
							title: 'Parquet query failed',
							message: error instanceof Error ? error.message : String(error),
						});
					}
				} finally {
					loadingRef.current = false;
					setBusy(false);
				}
			},
			[handle, appliedFilter, projection, sort]
		);

		// Any change to what is being asked invalidates the loaded window.
		useEffect(() => {
			if (!handle) return;
			generation.current++;
			setData(EMPTY_DATA);
			setDetailRow(null);
			setCountingRequested(false);
			void fetchPage(0, 'replace');
			// `fetchPage` closes over exactly these, so listing them keeps the reset
			// and the fetch on the same trigger.
		}, [handle, appliedFilter, sort, projectionKey, fetchPage]);

		const handleReachEnd = useCallback(() => {
			if (!result || loadingRef.current) return;
			const loaded = data.rows.length;
			// More rows exist when the scan is unfinished, or when it finished with
			// more matches than have been paged in.
			if (!result.complete || loaded < result.matchedRows) void fetchPage(loaded, 'append');
		}, [result, data.rows.length, fetchPage]);

		// -- Background exact count -----------------------------------------------

		const shouldAutoCount = Boolean(info && info.totalRows <= AUTO_COUNT_ROW_LIMIT);
		const countingActive =
			(shouldAutoCount || countingRequested) && result !== null && !result.complete;

		useEffect(() => {
			if (!handle || !countingActive) return;
			const token = generation.current;
			let cancelled = false;
			let passes = 0;

			const step = async () => {
				while (!cancelled && token === generation.current && passes++ < MAX_COUNT_PASSES) {
					// Never race a page fetch: both drive the same scan session, and
					// the engine serializes them anyway, so waiting keeps the grid
					// responsive instead of queueing behind a counting pass.
					if (loadingRef.current) {
						await new Promise((resolve) => window.setTimeout(resolve, 120));
						continue;
					}
					const counted = await window.maestro.parquet.query({
						handle,
						filter: appliedFilter,
						columns: [],
						sort: null,
						offset: 0,
						limit: 0,
						countAll: true,
					});
					if (cancelled || token !== generation.current) return;
					setResult((previous) =>
						previous
							? {
									...previous,
									matchedRows: counted.matchedRows,
									complete: counted.complete,
									truncated: counted.truncated,
								}
							: previous
					);
					if (counted.complete) return;
				}
			};

			void step();
			return () => {
				cancelled = true;
			};
		}, [handle, countingActive, appliedFilter]);

		// -- Actions --------------------------------------------------------------

		const appendFilterClause = useCallback((clause: string) => {
			setFilterText((previous) => {
				const trimmed = previous.trim();
				return trimmed ? `${trimmed} and ${clause}` : clause;
			});
		}, []);

		const toggleColumn = useCallback((name: string) => {
			setHiddenColumns((previous) => {
				const next = new Set(previous);
				if (next.has(name)) next.delete(name);
				else next.add(name);
				return next;
			});
		}, []);

		const handleExport = useCallback(async () => {
			if (!handle || !info) return;
			const base = fileName.replace(/\.(parquet|parq|pq)$/i, '');
			const destination = await window.maestro.dialog.saveFile({
				title: 'Export matching rows',
				defaultPath: `${base}${appliedFilter ? '-filtered' : ''}.csv`,
				filters: [
					{ name: 'CSV', extensions: ['csv'] },
					{ name: 'JSON Lines', extensions: ['jsonl'] },
				],
			});
			if (!destination) return;
			try {
				const exported = await window.maestro.parquet.export({
					handle,
					filter: appliedFilter,
					columns: projection,
					sort,
					destPath: destination,
					format: destination.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'csv',
				});
				notifyToast({
					color: exported.truncated ? 'yellow' : 'green',
					title: 'Export complete',
					message: `${formatCount(exported.rows)} rows written to ${exported.path}${
						exported.truncated
							? ' (stopped at the engine row cap - narrow the filter for the rest)'
							: ''
					}`,
				});
			} catch (error) {
				notifyToast({
					color: 'red',
					title: 'Export failed',
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}, [handle, info, fileName, appliedFilter, projection, sort]);

		// -- Record view ----------------------------------------------------------

		const detailFields = useMemo<RecordDetailField[]>(() => {
			if (detailRow === null || !info) return [];
			const row = data.rows[detailRow];
			if (!row) return [];
			return data.columns.map((name, index) => {
				const column = info.columns.find((candidate) => candidate.name === name);
				return {
					key: name,
					value: formatCellExact(row[index] ?? null, column?.kind ?? 'string'),
				};
			});
		}, [detailRow, data, info]);

		// -- Render ---------------------------------------------------------------

		if (openError) {
			return (
				<div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
					<AlertTriangle className="w-10 h-10" style={{ color: theme.colors.error }} />
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Could not open this parquet file
					</div>
					<div className="text-xs max-w-lg" style={{ color: theme.colors.textDim }}>
						{openError}
					</div>
				</div>
			);
		}

		if (!info) {
			// Two different waits, and conflating them would be a lie in both
			// directions. Reading a footer is a few kilobytes and effectively
			// instant, so it gets a spinner. Copying a remote file across SSH
			// is megabytes over a network with a known total, so it gets a real
			// bar - the whole reason remote opens felt broken before was that
			// this multi-second transfer rendered as an idle spinner.
			if (fetchProgress) {
				return (
					<div
						className="flex flex-col items-center justify-center h-full gap-3 px-8"
						data-testid="parquet-fetch-progress"
					>
						<div className="text-sm" style={{ color: theme.colors.textMain }}>
							Copying {fileName} from the remote host
						</div>
						<div className="w-full" style={{ maxWidth: 380 }}>
							<ProgressBar
								value={fetchProgress.receivedBytes}
								total={fetchProgress.totalBytes}
								theme={theme}
								label={`Copying ${fileName} from the remote host`}
								testId="parquet-fetch-progress-bar"
							/>
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							{formatSize(fetchProgress.receivedBytes)} of {formatSize(fetchProgress.totalBytes)}
						</div>
						<div className="text-[11px] text-center" style={{ color: theme.colors.textDim }}>
							There is no byte-range channel over SSH, so the whole file has to come across before
							any of it can be read.
						</div>
					</div>
				);
			}

			return (
				<div
					className="flex items-center justify-center h-full gap-2 text-sm"
					style={{ color: theme.colors.textDim }}
				>
					<RefreshCw className="w-4 h-4 animate-spin" />
					Reading parquet footer...
				</div>
			);
		}

		const totalLabel = result
			? result.complete
				? formatCount(result.matchedRows)
				: `${formatCount(result.matchedRows)}+`
			: '...';

		return (
			<div className="flex flex-col h-full min-h-0" data-testid="parquet-viewer">
				{/* File summary */}
				<div
					className="shrink-0 flex items-center gap-3 px-3 py-2 flex-wrap"
					style={{ borderBottom: `1px solid ${theme.colors.border}` }}
				>
					<Database className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
					<span className="text-xs" style={{ color: theme.colors.textMain }}>
						{formatCount(info.totalRows)} rows, {info.columns.length} columns
					</span>
					<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
						{formatSize(info.fileBytes)} - {info.rowGroups.length} row group
						{info.rowGroups.length === 1 ? '' : 's'}
						{info.createdBy ? ` - ${info.createdBy}` : ''}
						{info.fetchedFromRemote ? ' - cached from remote' : ''}
					</span>
					<div className="flex-1" />
					<button
						type="button"
						onClick={schemaPanel.toggle}
						className="flex items-center gap-1 text-[11px] px-2 py-1 rounded"
						style={{
							color: schemaPanel.value ? theme.colors.accentText : theme.colors.textDim,
							backgroundColor: schemaPanel.value ? `${theme.colors.accent}22` : 'transparent',
						}}
						title="Toggle the schema rail"
						data-testid="parquet-toggle-schema"
					>
						<Columns3 className="w-3.5 h-3.5" />
						Schema
					</button>
					<button
						type="button"
						onClick={handleExport}
						className="flex items-center gap-1 text-[11px] px-2 py-1 rounded"
						style={{ color: theme.colors.textDim }}
						title="Export the matching rows as CSV or JSON Lines"
						data-testid="parquet-export"
					>
						<Download className="w-3.5 h-3.5" />
						Export
					</button>
				</div>

				<ParquetFilterBar
					ref={filterBarRef}
					value={filterText}
					onChange={setFilterText}
					columns={info.columns}
					problem={result?.filterError}
					stats={result?.stats}
					busy={busy || countingActive}
					theme={theme}
				/>

				<div className="flex flex-1 min-h-0">
					{schemaPanel.value && (
						<ParquetSchemaPanel
							info={info}
							hiddenColumns={hiddenColumns}
							onToggleColumn={toggleColumn}
							onFilterOnColumn={(clause) => appendFilterClause(clause.trimEnd())}
							theme={theme}
						/>
					)}
					<div className="flex-1 min-w-0">
						<ParquetGrid
							columns={visibleColumns}
							rows={data.rows}
							rowIndexes={data.rowIndexes}
							theme={theme}
							sort={sort}
							onSortChange={setSort}
							onOpenRow={setDetailRow}
							onAddFilterClause={(name) => appendFilterClause(`${name} = `)}
							onReachEnd={handleReachEnd}
							loadingMore={busy && data.rows.length > 0}
						/>
					</div>
				</div>

				{/* Footer: what the match set actually is right now. */}
				<div
					className="shrink-0 flex items-center gap-3 px-3 py-1.5 text-[11px] flex-wrap"
					style={{ borderTop: `1px solid ${theme.colors.border}`, color: theme.colors.textDim }}
					data-testid="parquet-footer"
				>
					<span>
						{appliedFilter.trim() && !result?.filterError
							? `${totalLabel} of ${formatCount(info.totalRows)} rows match`
							: `${formatCount(info.totalRows)} rows`}
					</span>
					<span>
						{data.rows.length > 0 ? `${formatCount(data.rows.length)} loaded` : 'no rows loaded'}
					</span>
					{hiddenColumns.size > 0 && (
						<span>{hiddenColumns.size} column(s) hidden from the scan</span>
					)}
					{result && !result.complete && !countingActive && (
						<button
							type="button"
							className="underline"
							onClick={() => setCountingRequested(true)}
							style={{ color: theme.colors.accentText }}
							data-testid="parquet-count-all"
						>
							Count all matches
						</button>
					)}
					{result?.truncated && (
						<span style={{ color: theme.colors.warning }}>
							match set capped - narrow the filter to see the rest
						</span>
					)}
					{result && <span>{result.stats.elapsedMs} ms</span>}
				</div>

				{detailRow !== null && detailFields.length > 0 && (
					<RecordDetailModal
						fields={detailFields}
						index={detailRow}
						total={data.rows.length}
						onNavigate={(next) => setDetailRow(Math.max(0, Math.min(next, data.rows.length - 1)))}
						onClose={() => setDetailRow(null)}
						theme={theme}
						priority={MODAL_PRIORITIES.TABLE_ROW_DETAIL}
						resizeKey="parquet-row-detail"
						testIdPrefix="parquet-row-detail"
					/>
				)}
			</div>
		);
	}
);
