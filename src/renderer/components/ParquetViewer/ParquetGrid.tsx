/**
 * ParquetGrid - the virtualized cell surface of the parquet viewer.
 *
 * Rows are windowed with `@tanstack/react-virtual` rather than capped, because
 * the row count here is a property of the file, not of what the UI can afford
 * to draw. The CSV renderer's 500-row ceiling is fine for a spreadsheet export
 * and meaningless for a file whose whole reason to exist is having a hundred
 * million rows.
 *
 * The layout is divs, not a `<table>`. A table's own layout algorithm needs
 * every row present to size its columns, which is exactly what virtualization
 * removes - so column widths are explicit state here, seeded from the column's
 * type and adjustable by dragging a header edge.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Filter } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type {
	ParquetCellValue,
	ParquetColumnInfo,
	ParquetSortSpec,
} from '../../../shared/parquet/types';
import type { Theme } from '../../types';
import { columnAlignment, columnTypeBadge, formatCell, quoteColumnName } from './parquetFormat';

/** Height of one data row, in pixels. Fixed so the virtualizer never measures. */
const ROW_HEIGHT = 26;

/** Height of the sticky header row. */
const HEADER_HEIGHT = 38;

/** Width of the gutter showing each row's index within the file. */
const GUTTER_WIDTH = 76;

/** Extra rows rendered above and below the viewport. */
const OVERSCAN = 12;

const MIN_COLUMN_WIDTH = 64;
const MAX_INITIAL_COLUMN_WIDTH = 320;

/**
 * Starting width for a column, guessed from its type.
 *
 * A guess beats measuring here: measuring needs cells, cells arrive one page
 * at a time, and a width that jumps when page two lands is worse than one that
 * is merely approximate. Dragging overrides it permanently.
 */
function initialColumnWidth(column: ParquetColumnInfo): number {
	const headerWidth = column.name.length * 7.5 + 56;
	const byKind =
		column.kind === 'boolean'
			? 80
			: column.kind === 'timestamp'
				? 172
				: column.kind === 'date'
					? 110
					: column.kind === 'integer' || column.kind === 'float' || column.kind === 'decimal'
						? 120
						: column.nested || column.kind === 'json'
							? 260
							: 180;
	return Math.min(MAX_INITIAL_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, headerWidth, byKind));
}

interface ParquetGridProps {
	columns: ParquetColumnInfo[];
	rows: ParquetCellValue[][];
	/** File row index for each loaded row, shown in the gutter. */
	rowIndexes: number[];
	theme: Theme;
	sort: ParquetSortSpec | null;
	onSortChange: (sort: ParquetSortSpec | null) => void;
	/** Open the record view for a loaded row. */
	onOpenRow: (rowPosition: number) => void;
	/** Append a clause to the filter, from a header or cell affordance. */
	onAddFilterClause: (clause: string) => void;
	/** Called when the viewport nears the end of the loaded rows. */
	onReachEnd: () => void;
	/** True while more rows are on the way, for the trailing spinner row. */
	loadingMore: boolean;
}

export function ParquetGrid({
	columns,
	rows,
	rowIndexes,
	theme,
	sort,
	onSortChange,
	onOpenRow,
	onAddFilterClause,
	onReachEnd,
	loadingMore,
}: ParquetGridProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [widths, setWidths] = useState<Record<string, number>>({});
	const dragState = useRef<{ column: string; startX: number; startWidth: number } | null>(null);

	// Seed widths for columns that have not been seen yet, preserving any the
	// user has already dragged.
	useLayoutEffect(() => {
		setWidths((previous) => {
			let changed = false;
			const next = { ...previous };
			for (const column of columns) {
				if (next[column.name] === undefined) {
					next[column.name] = initialColumnWidth(column);
					changed = true;
				}
			}
			return changed ? next : previous;
		});
	}, [columns]);

	const totalWidth = useMemo(
		() =>
			GUTTER_WIDTH +
			columns.reduce((sum, column) => sum + (widths[column.name] ?? initialColumnWidth(column)), 0),
		[columns, widths]
	);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN,
	});

	const virtualRows = virtualizer.getVirtualItems();
	// -1, not 0, when nothing is rendered. A grid that has not been measured
	// yet (no layout, a zero-height container) must read as "the bottom is not
	// in view" - treating it as row 0 makes every unmeasured grid look like it
	// has been scrolled to the end, which requests page after page until the
	// entire match set is in memory without the user ever scrolling.
	const lastVisible = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;

	// Ask for the next page once the final loaded row is inside the rendered
	// window. Overscan means that happens a screenful early, so the next page
	// is usually there before the user reaches it - and when the loaded rows do
	// not yet fill the viewport, this is also what keeps pulling until they do.
	useEffect(() => {
		// A grid with no laid-out height is not on screen, and prefetching rows
		// nobody can see only competes with the scan that is filling the page
		// the user IS looking at.
		if (!scrollRef.current?.clientHeight) return;
		if (lastVisible >= 0 && lastVisible >= rows.length - 1) onReachEnd();
	}, [lastVisible, rows.length, onReachEnd]);

	const handleHeaderClick = (column: ParquetColumnInfo) => {
		if (column.nested) return;
		onSortChange(
			sort?.column !== column.name
				? { column: column.name, direction: 'asc' }
				: sort.direction === 'asc'
					? { column: column.name, direction: 'desc' }
					: null
		);
	};

	const beginResize = useCallback(
		(event: React.PointerEvent, column: ParquetColumnInfo) => {
			event.preventDefault();
			event.stopPropagation();
			dragState.current = {
				column: column.name,
				startX: event.clientX,
				startWidth: widths[column.name] ?? initialColumnWidth(column),
			};
			const move = (moveEvent: PointerEvent) => {
				const drag = dragState.current;
				if (!drag) return;
				const width = Math.max(
					MIN_COLUMN_WIDTH,
					drag.startWidth + (moveEvent.clientX - drag.startX)
				);
				setWidths((previous) => ({ ...previous, [drag.column]: width }));
			};
			const up = () => {
				dragState.current = null;
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', up);
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
		},
		[widths]
	);

	if (columns.length === 0) {
		return (
			<div
				className="flex items-center justify-center h-full text-sm"
				style={{ color: theme.colors.textDim }}
			>
				No columns selected.
			</div>
		);
	}

	return (
		<div
			ref={scrollRef}
			className="h-full w-full overflow-auto select-none"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="parquet-grid"
		>
			<div style={{ width: totalWidth, minWidth: '100%', position: 'relative' }}>
				{/* Header. Sticky vertically, scrolls horizontally with the body. */}
				<div
					className="flex sticky top-0 z-10"
					style={{
						height: HEADER_HEIGHT,
						backgroundColor: theme.colors.bgActivity,
						borderBottom: `2px solid ${theme.colors.border}`,
					}}
				>
					<div
						className="shrink-0 flex items-center justify-end px-2 text-[11px]"
						style={{
							width: GUTTER_WIDTH,
							color: theme.colors.textDim,
							borderRight: `1px solid ${theme.colors.border}`,
						}}
						title="Row index within the file"
					>
						#
					</div>
					{columns.map((column) => {
						const active = sort?.column === column.name;
						return (
							<div
								key={column.name}
								className="shrink-0 relative flex items-center gap-1 px-2 group"
								style={{
									width: widths[column.name] ?? initialColumnWidth(column),
									borderRight: `1px solid ${theme.colors.border}`,
									backgroundColor: active ? `${theme.colors.accent}20` : 'transparent',
								}}
							>
								<button
									type="button"
									onClick={() => handleHeaderClick(column)}
									className="flex-1 min-w-0 flex flex-col items-start text-left outline-none"
									style={{ cursor: column.nested ? 'default' : 'pointer' }}
									title={
										column.nested
											? `${column.name} - nested column, cannot be sorted`
											: `${column.name} (${column.logicalType ?? column.physicalType ?? ''}) - click to sort`
									}
									data-testid={`parquet-header-${column.name}`}
								>
									<span
										className="text-xs font-semibold truncate w-full flex items-center gap-1"
										style={{ color: theme.colors.textMain }}
									>
										{column.name}
										{active &&
											(sort.direction === 'asc' ? (
												<ArrowUp
													className="w-3 h-3 shrink-0"
													style={{ color: theme.colors.accent }}
												/>
											) : (
												<ArrowDown
													className="w-3 h-3 shrink-0"
													style={{ color: theme.colors.accent }}
												/>
											))}
									</span>
									<span
										className="text-[10px] truncate w-full"
										style={{ color: theme.colors.textDim }}
									>
										{columnTypeBadge(column)}
										{column.optional ? '' : ' · required'}
									</span>
								</button>
								<button
									type="button"
									onClick={() => onAddFilterClause(quoteColumnName(column.name))}
									className="opacity-0 group-hover:opacity-100 shrink-0 transition-opacity"
									title={`Filter on ${column.name}`}
									aria-label={`Filter on ${column.name}`}
								>
									<Filter className="w-3 h-3" style={{ color: theme.colors.textDim }} />
								</button>
								{/* Resize grip. A wide hit area over a hairline rule. */}
								<div
									onPointerDown={(event) => beginResize(event, column)}
									className="absolute top-0 right-0 h-full"
									style={{ width: 7, cursor: 'col-resize', transform: 'translateX(3px)' }}
									role="separator"
									aria-orientation="vertical"
									aria-label={`Resize ${column.name}`}
								/>
							</div>
						);
					})}
				</div>

				{/* Body */}
				<div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
					{virtualRows.map((virtualRow) => {
						const row = rows[virtualRow.index];
						return (
							<div
								key={virtualRow.key}
								className="flex absolute left-0 hover:brightness-125 transition-[filter] duration-75"
								style={{
									top: virtualRow.start,
									height: ROW_HEIGHT,
									width: totalWidth,
									backgroundColor:
										virtualRow.index % 2 === 0 ? 'transparent' : `${theme.colors.bgActivity}55`,
								}}
								// Suppress the browser's double-click word selection so the
								// row flips to the record view without flashing selected text.
								onMouseDown={(event) => {
									if (event.detail > 1) event.preventDefault();
								}}
								onDoubleClick={() => onOpenRow(virtualRow.index)}
								data-testid={`parquet-row-${virtualRow.index}`}
							>
								<div
									className="shrink-0 flex items-center justify-end px-2 text-[11px] tabular-nums"
									style={{
										width: GUTTER_WIDTH,
										color: theme.colors.textDim,
										borderRight: `1px solid ${theme.colors.border}`,
									}}
								>
									{(rowIndexes[virtualRow.index] ?? virtualRow.index).toLocaleString()}
								</div>
								{columns.map((column, columnIndex) => {
									const value = row?.[columnIndex] ?? null;
									const text = formatCell(value, column.kind);
									return (
										<div
											key={column.name}
											className="shrink-0 flex items-center px-2 text-xs truncate"
											style={{
												width: widths[column.name] ?? initialColumnWidth(column),
												justifyContent:
													columnAlignment(column.kind) === 'right' ? 'flex-end' : 'flex-start',
												borderRight: `1px solid ${theme.colors.border}40`,
												color: value === null ? theme.colors.textDim : theme.colors.textMain,
												fontFamily:
													'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
												fontStyle: value === null ? 'italic' : 'normal',
												opacity: value === null ? 0.55 : 1,
											}}
											title={value === null ? 'null' : text}
										>
											{value === null ? 'null' : text}
										</div>
									);
								})}
							</div>
						);
					})}
				</div>

				{loadingMore && (
					<div className="px-3 py-2 text-xs sticky left-0" style={{ color: theme.colors.textDim }}>
						Loading more rows…
					</div>
				)}
			</div>
		</div>
	);
}
