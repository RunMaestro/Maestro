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
 *    batch lands. Visible objects are measured before internal ones.
 *
 * The content pane shows the selected object: its counts, then either its
 * rows (SqliteTableView, for a table or view) or its schema
 * (SqliteSchemaPanel), chosen by a Data / Schema switch the viewer remembers.
 * An index or trigger has no rows of its own, so it always shows its schema.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Database } from 'lucide-react';

import type {
	SqliteDatabaseInfo,
	SqliteObjectList,
	SqliteObjectStats,
	SqliteObjectSummary,
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
import type { Theme } from '../../types';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { MiniBadge } from '../ui/MiniBadge';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Spinner } from '../ui/Spinner';
import { SqliteObjectRail } from './SqliteObjectRail';
import { SqliteSchemaPanel } from './SqliteSchemaPanel';
import { SqliteTableView } from './SqliteTableView';

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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The object selected when a database opens: its first user table, if any. */
function defaultSelection(objects: readonly SqliteObjectSummary[]): string | null {
	const visible = groupSqliteObjects(objects, false).flatMap((group) => group.objects);
	return visible[0]?.name ?? objects[0]?.name ?? null;
}

export function SqliteViewer({ filePath, fileName, theme }: SqliteViewerProps) {
	const [info, setInfo] = useState<SqliteDatabaseInfo | null>(null);
	const [list, setList] = useState<SqliteObjectList | null>(null);
	const [stats, setStats] = useState<ReadonlyMap<string, SqliteObjectStats>>(() => new Map());
	const [openError, setOpenError] = useState<string | null>(null);
	const [statsError, setStatsError] = useState<string | null>(null);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const showInternal = usePersistedToggle('sqlite-show-internal', false);
	const objectView = usePersistedChoice<ObjectView>('sqlite-object-view', OBJECT_VIEWS, 'data');

	// -- Open the database and read its object list -------------------------

	useEffect(() => {
		let cancelled = false;
		setInfo(null);
		setList(null);
		setStats(new Map());
		setOpenError(null);
		setStatsError(null);
		setSelectedName(null);

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
					for (const entry of batch) next.set(entry.name, entry);
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

	const handleSelect = useCallback((name: string) => setSelectedName(name), []);

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
		<div className="flex flex-col h-full min-h-0" data-testid="sqlite-viewer">
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
					{formatSize(info.fileBytes)} - read-only
				</span>
				{statsError && (
					<span
						className="text-xs-plus"
						style={{ color: theme.colors.warning }}
						data-testid="sqlite-stats-error"
					>
						Counting stopped: {statsError}
					</span>
				)}
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
									{selectedStats?.sizeBytes !== null && selectedStats?.sizeBytes !== undefined && (
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
			</div>
		</div>
	);
}
