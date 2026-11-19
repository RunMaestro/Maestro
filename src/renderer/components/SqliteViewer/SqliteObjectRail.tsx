/**
 * SqliteObjectRail - the table-list rail beside the SQLite viewer's content.
 *
 * Lists every table, view, index, and trigger in the database, grouped by kind
 * in that order. Each table carries its row count and each b-tree (table or
 * index) its on-disk size, with a bar relative to the largest one, so the rail
 * answers "which table is this database actually made of" before anything is
 * opened. Counts and sizes arrive after the names (see
 * src/main/sqlite/sqlite-objects.ts): a row still waiting shows a placeholder,
 * never a zero.
 *
 * Objects SQLite or a virtual-table module made for itself (sqlite_sequence,
 * autoindexes, FTS shadow tables) are hidden behind a toggle, because they are
 * noise to most readers and essential to the few debugging storage.
 *
 * The rail is a listbox: Up/Down (and Home/End) move the selection, and the
 * selection is what the content pane shows.
 */

import { useMemo, useRef, type KeyboardEvent } from 'react';
import { AlertTriangle, Eye, ListTree, Table2, Zap, type LucideIcon } from 'lucide-react';

import type {
	SqliteObjectKind,
	SqliteObjectList,
	SqliteObjectStats,
	SqliteObjectSummary,
} from '../../../shared/sqlite/types';
import {
	SQLITE_OBJECT_KIND_LABELS,
	formatSqliteRowCount,
	groupSqliteObjects,
	sqliteObjectTags,
} from '../../../shared/sqlite/objects';
import { formatCount, formatSize } from '../../../shared/formatters';
import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';
import { SkeletonBox } from '../ui/SkeletonBox';

const KIND_ICONS: Record<SqliteObjectKind, LucideIcon> = {
	table: Table2,
	view: Eye,
	index: ListTree,
	trigger: Zap,
};

interface SqliteObjectRailProps {
	list: SqliteObjectList;
	/** Measurements so far, by object name. Missing means still pending. */
	stats: ReadonlyMap<string, SqliteObjectStats>;
	selectedName: string | null;
	onSelect: (name: string) => void;
	showInternal: boolean;
	onToggleInternal: () => void;
	theme: Theme;
}

/** Whether an object will ever get a measurement worth waiting for. */
function isMeasured(object: SqliteObjectSummary): boolean {
	return object.countable || object.hasStorage;
}

export function SqliteObjectRail({
	list,
	stats,
	selectedName,
	onSelect,
	showInternal,
	onToggleInternal,
	theme,
}: SqliteObjectRailProps) {
	const rowRefs = useRef(new Map<string, HTMLButtonElement>());
	const groups = useMemo(
		() => groupSqliteObjects(list.objects, showInternal),
		[list.objects, showInternal]
	);
	const ordered = useMemo(() => groups.flatMap((group) => group.objects), [groups]);
	const internalCount = useMemo(
		() => list.objects.filter((object) => object.internal).length,
		[list.objects]
	);

	// Bars are relative to the largest b-tree on show, so the rail ranks
	// objects by what they cost rather than making the reader compare numbers.
	const largestBytes = useMemo(() => {
		let largest = 1;
		for (const object of ordered) {
			const bytes = stats.get(object.name)?.sizeBytes ?? 0;
			if (bytes > largest) largest = bytes;
		}
		return largest;
	}, [ordered, stats]);

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (ordered.length === 0) return;
		const current = ordered.findIndex((object) => object.name === selectedName);
		let next: number;
		switch (event.key) {
			case 'ArrowDown':
				next = current < 0 ? 0 : Math.min(ordered.length - 1, current + 1);
				break;
			case 'ArrowUp':
				next = current < 0 ? 0 : Math.max(0, current - 1);
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = ordered.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		const name = ordered[next].name;
		onSelect(name);
		rowRefs.current.get(name)?.focus();
	};

	return (
		<div
			className="h-full overflow-y-auto shrink-0 select-none"
			style={{
				width: 280,
				borderRight: `1px solid ${theme.colors.border}`,
				backgroundColor: theme.colors.bgSidebar,
			}}
			data-testid="sqlite-object-rail"
		>
			<div role="listbox" aria-label="Database objects" onKeyDown={handleKeyDown}>
				{groups.map((group) => {
					const Icon = KIND_ICONS[group.kind];
					return (
						<div key={group.kind} data-testid={`sqlite-rail-section-${group.kind}`}>
							<div
								className="px-3 py-1.5 sticky top-0 z-10 flex items-center gap-2"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									borderBottom: `1px solid ${theme.colors.border}`,
								}}
							>
								<Icon className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								<span className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
									{SQLITE_OBJECT_KIND_LABELS[group.kind]}
								</span>
								<span className="text-xs-plus" style={{ color: theme.colors.textDim }}>
									{group.objects.length}
								</span>
							</div>

							{group.objects.length === 0 && (
								<div className="px-3 py-1.5 text-xs-plus" style={{ color: theme.colors.textDim }}>
									None
								</div>
							)}

							{group.objects.map((object) => {
								const measured = stats.get(object.name);
								const pending = isMeasured(object) && !measured;
								const rowCount = formatSqliteRowCount(measured);
								const sizeBytes = measured?.sizeBytes ?? null;
								const selected = object.name === selectedName;
								const owner =
									object.kind === 'index' || object.kind === 'trigger'
										? `on ${object.tableName}`
										: null;
								return (
									<button
										key={object.name}
										ref={(element) => {
											if (element) rowRefs.current.set(object.name, element);
											else rowRefs.current.delete(object.name);
										}}
										type="button"
										role="option"
										aria-selected={selected}
										tabIndex={selected || (selectedName === null && object === ordered[0]) ? 0 : -1}
										onClick={() => onSelect(object.name)}
										className="w-full text-left px-3 py-1.5 block outline-none focus-visible:ring-1"
										style={{
											backgroundColor: selected ? `${theme.colors.accent}22` : 'transparent',
											borderBottom: `1px solid ${theme.colors.border}40`,
											opacity: object.internal ? 0.7 : 1,
										}}
										data-testid={`sqlite-rail-object-${object.name}`}
									>
										<div className="flex items-center gap-2 min-w-0">
											<span
												className="text-xs font-mono truncate flex-1 min-w-0"
												style={{
													color: selected ? theme.colors.accentText : theme.colors.textMain,
												}}
												title={object.name}
											>
												{object.name}
											</span>
											{measured?.error && (
												<span
													className="shrink-0"
													title={measured.error}
													data-testid={`sqlite-rail-error-${object.name}`}
												>
													<AlertTriangle
														className="w-3.5 h-3.5"
														style={{ color: theme.colors.warning }}
														aria-label={measured.error}
													/>
												</span>
											)}
											{object.countable &&
												(pending ? (
													<SkeletonBox theme={theme} className="h-2.5 w-8 shrink-0" />
												) : (
													rowCount !== null && (
														<span
															className="text-2xs shrink-0 tabular-nums"
															style={{ color: theme.colors.textDim }}
															title={
																measured?.rowCountCapped
																	? `At least ${formatCount(measured.rowCount ?? 0)} rows; counting stops there`
																	: `${rowCount} rows`
															}
															data-testid={`sqlite-rail-rows-${object.name}`}
														>
															{rowCount}
														</span>
													)
												))}
										</div>

										{(owner || sqliteObjectTags(object).length > 0 || object.internal) && (
											<div className="flex items-center gap-1.5 mt-0.5 min-w-0">
												{owner && (
													<span
														className="text-2xs truncate"
														style={{ color: theme.colors.textDim }}
													>
														{owner}
													</span>
												)}
												{sqliteObjectTags(object).map((tag) => (
													<MiniBadge key={tag} label={tag} theme={theme} />
												))}
												{object.internal && (
													<MiniBadge label="internal" theme={theme} color={theme.colors.textDim} />
												)}
											</div>
										)}

										{object.hasStorage && list.sizesAvailable && (
											<div className="mt-1 flex items-center gap-2">
												<div
													className="flex-1 h-1 rounded"
													style={{ backgroundColor: theme.colors.border }}
												>
													{sizeBytes !== null && (
														<div
															className="h-1 rounded"
															style={{
																width: `${Math.max(2, (sizeBytes / largestBytes) * 100)}%`,
																backgroundColor: theme.colors.accent,
															}}
														/>
													)}
												</div>
												{pending ? (
													<SkeletonBox theme={theme} className="h-2.5 w-10 shrink-0" />
												) : (
													<span
														className="text-2xs shrink-0 tabular-nums"
														style={{ color: theme.colors.textDim }}
														data-testid={`sqlite-rail-size-${object.name}`}
													>
														{sizeBytes !== null ? formatSize(sizeBytes) : '?'}
													</span>
												)}
											</div>
										)}
									</button>
								);
							})}
						</div>
					);
				})}
			</div>

			<div
				className="px-3 py-2 flex flex-col gap-1.5"
				style={{ borderTop: `1px solid ${theme.colors.border}` }}
			>
				{internalCount > 0 && (
					<button
						type="button"
						onClick={onToggleInternal}
						className="text-xs-plus underline text-left"
						style={{ color: theme.colors.accentText }}
						data-testid="sqlite-rail-toggle-internal"
					>
						{showInternal
							? 'Hide internal objects'
							: `Show ${internalCount} internal object${internalCount === 1 ? '' : 's'}`}
					</button>
				)}
				{list.sizeNote && (
					<span className="text-2xs" style={{ color: theme.colors.textDim }}>
						{list.sizeNote}
					</span>
				)}
			</div>
		</div>
	);
}
