/**
 * DataGrid - the virtualized cell surface shared by the data previews
 * (Parquet and SQLite).
 *
 * Rows are windowed with `@tanstack/react-virtual` rather than capped, because
 * the row count is a property of the file, not of what the UI can afford to
 * draw. The grid never holds the data itself: the caller pages rows in from
 * its engine, tells the grid how many are loaded, and answers `getCell` for
 * the ones on screen. `onReachEnd` is how the grid asks for the next page.
 *
 * The layout is divs, not a `<table>`. A table's own layout algorithm needs
 * every row present to size its columns, which is exactly what virtualization
 * removes - so column widths are explicit state here, seeded from each
 * column's `initialWidth` and adjustable by dragging a header edge.
 *
 * Sorting is the caller's: a header click reports the next sort (ascending,
 * then descending, then none) through `onSortChange`, and the caller asks its
 * engine for rows in that order. Sorting the loaded page locally would only
 * ever order the first few hundred rows.
 */

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { Theme } from '../../types';
import { isCoarsePointer } from '../../utils/touch';

/** Height of one data row, in pixels. Fixed so the virtualizer never measures. */
const ROW_HEIGHT = 26;

/** Height of the sticky header row. */
const HEADER_HEIGHT = 38;

/** Width of the gutter showing each row's label. */
const GUTTER_WIDTH = 76;

/** Extra rows rendered above and below the viewport. */
const OVERSCAN = 12;

export const DATA_GRID_MIN_COLUMN_WIDTH = 64;
const MAX_INITIAL_COLUMN_WIDTH = 320;

/**
 * Starting width for a column: wide enough for its header, and for the width
 * its kind of content usually needs, clamped to a sane range.
 *
 * A guess beats measuring here: measuring needs cells, cells arrive one page
 * at a time, and a width that jumps when page two lands is worse than one that
 * is merely approximate. Dragging overrides it permanently.
 */
export function dataGridColumnWidth(label: string, contentWidth: number): number {
	const headerWidth = label.length * 7.5 + 56;
	return Math.min(
		MAX_INITIAL_COLUMN_WIDTH,
		Math.max(DATA_GRID_MIN_COLUMN_WIDTH, headerWidth, contentWidth)
	);
}

/** One column as the grid draws it. Callers map their engine's schema onto this. */
export interface DataGridColumn {
	/** Stable id, unique in the grid. Also the name reported in a sort. */
	key: string;
	/** Header text. */
	label: string;
	/** Second header line: the column's type, as the caller describes it. */
	subtitle?: string;
	/** Header tooltip. */
	title?: string;
	/** Starting width in pixels; see `dataGridColumnWidth()`. */
	initialWidth: number;
	align?: 'left' | 'right';
	/** Whether a header click sorts by this column. Default true. */
	sortable?: boolean;
}

/** A server-side sort: one column, one direction. */
export interface DataGridSort {
	column: string;
	direction: 'asc' | 'desc';
}

/** What one cell shows. */
export interface DataGridCell {
	text: string;
	/**
	 * The text stands for something other than a value (`null`, a BLOB
	 * summary), so it renders dimmed and italic rather than as data.
	 */
	placeholder?: boolean;
	/** Tooltip; defaults to `text`. */
	title?: string;
}

/** The sort a header click moves to: ascending, then descending, then none. */
export function nextDataGridSort(
	current: DataGridSort | null,
	column: string
): DataGridSort | null {
	if (current?.column !== column) return { column, direction: 'asc' };
	return current.direction === 'asc' ? { column, direction: 'desc' } : null;
}

interface DataGridProps {
	columns: DataGridColumn[];
	/** How many rows are loaded. The grid draws only the ones on screen. */
	rowCount: number;
	/** The cell at a loaded row position and a column position. */
	getCell: (rowPosition: number, columnPosition: number) => DataGridCell;
	/** Gutter text for a loaded row position (a file row index, a row number). */
	getRowLabel: (rowPosition: number) => string;
	/** Tooltip on the gutter header, saying what the gutter numbers mean. */
	gutterTitle: string;
	theme: Theme;
	sort: DataGridSort | null;
	onSortChange: (sort: DataGridSort | null) => void;
	/** Open the record view for a loaded row. Rows are inert without it. */
	onOpenRow?: (rowPosition: number) => void;
	/** Extra control in a header, shown on hover (the Parquet filter shortcut). */
	renderHeaderAction?: (column: DataGridColumn) => ReactNode;
	/** Called when the viewport nears the end of the loaded rows. */
	onReachEnd: () => void;
	/** True while more rows are on the way, for the trailing spinner row. */
	loadingMore: boolean;
	/** Shown when `columns` is empty. */
	emptyMessage?: string;
	/**
	 * Prefix for test ids: `${prefix}-grid`, `${prefix}-header-${key}`,
	 * `${prefix}-row-${position}`.
	 */
	testIdPrefix: string;
}

export function DataGrid({
	columns,
	rowCount,
	getCell,
	getRowLabel,
	gutterTitle,
	theme,
	sort,
	onSortChange,
	onOpenRow,
	renderHeaderAction,
	onReachEnd,
	loadingMore,
	emptyMessage = 'No columns to show.',
	testIdPrefix,
}: DataGridProps) {
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
				if (next[column.key] === undefined) {
					next[column.key] = column.initialWidth;
					changed = true;
				}
			}
			return changed ? next : previous;
		});
	}, [columns]);

	const widthOf = useCallback(
		(column: DataGridColumn) => widths[column.key] ?? column.initialWidth,
		[widths]
	);

	const totalWidth = useMemo(
		() => GUTTER_WIDTH + columns.reduce((sum, column) => sum + widthOf(column), 0),
		[columns, widthOf]
	);

	const virtualizer = useVirtualizer({
		count: rowCount,
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
		// nobody can see only competes with the query filling the page the user
		// IS looking at.
		if (!scrollRef.current?.clientHeight) return;
		if (lastVisible >= 0 && lastVisible >= rowCount - 1) onReachEnd();
	}, [lastVisible, rowCount, onReachEnd]);

	const beginResize = useCallback(
		(event: React.PointerEvent, column: DataGridColumn) => {
			event.preventDefault();
			event.stopPropagation();
			dragState.current = {
				column: column.key,
				startX: event.clientX,
				startWidth: widthOf(column),
			};
			const move = (moveEvent: PointerEvent) => {
				const drag = dragState.current;
				if (!drag) return;
				const width = Math.max(
					DATA_GRID_MIN_COLUMN_WIDTH,
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
		[widthOf]
	);

	if (columns.length === 0) {
		return (
			<div
				className="flex items-center justify-center h-full text-sm"
				style={{ color: theme.colors.textDim }}
			>
				{emptyMessage}
			</div>
		);
	}

	return (
		<div
			ref={scrollRef}
			className="h-full w-full overflow-auto select-none"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid={`${testIdPrefix}-grid`}
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
						className="shrink-0 flex items-center justify-end px-2 text-xs-plus"
						style={{
							width: GUTTER_WIDTH,
							color: theme.colors.textDim,
							borderRight: `1px solid ${theme.colors.border}`,
						}}
						title={gutterTitle}
					>
						#
					</div>
					{columns.map((column) => {
						const sortable = column.sortable !== false;
						const active = sort?.column === column.key;
						return (
							<div
								key={column.key}
								className="shrink-0 relative flex items-center gap-1 px-2 group"
								style={{
									width: widthOf(column),
									borderRight: `1px solid ${theme.colors.border}`,
									backgroundColor: active ? `${theme.colors.accent}20` : 'transparent',
								}}
							>
								<button
									type="button"
									onClick={() => {
										if (sortable) onSortChange(nextDataGridSort(sort, column.key));
									}}
									className="flex-1 min-w-0 flex flex-col items-start text-left outline-none"
									style={{ cursor: sortable ? 'pointer' : 'default' }}
									title={column.title ?? column.label}
									aria-sort={
										active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
									}
									data-testid={`${testIdPrefix}-header-${column.key}`}
								>
									<span
										className="text-xs font-semibold truncate w-full flex items-center gap-1"
										style={{ color: theme.colors.textMain }}
									>
										{column.label}
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
									{column.subtitle !== undefined && (
										<span
											className="text-2xs truncate w-full"
											style={{ color: theme.colors.textDim }}
										>
											{column.subtitle}
										</span>
									)}
								</button>
								{renderHeaderAction?.(column)}
								{/* Resize grip. A wide hit area over a hairline rule. */}
								<div
									onPointerDown={(event) => beginResize(event, column)}
									className="absolute top-0 right-0 h-full"
									style={{ width: 7, cursor: 'col-resize', transform: 'translateX(3px)' }}
									role="separator"
									aria-orientation="vertical"
									aria-label={`Resize ${column.label}`}
								/>
							</div>
						);
					})}
				</div>

				{/* Body */}
				<div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
					{virtualRows.map((virtualRow) => (
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
								if (onOpenRow && event.detail > 1) event.preventDefault();
							}}
							// A finger cannot double-tap (iOS reserves the gesture), so on a
							// coarse pointer one tap opens the record view. A mouse keeps
							// the double-click, since a single click on a grid row is how
							// the user selects text in it.
							onClick={() => {
								if (onOpenRow && isCoarsePointer()) onOpenRow(virtualRow.index);
							}}
							onDoubleClick={() => onOpenRow?.(virtualRow.index)}
							data-testid={`${testIdPrefix}-row-${virtualRow.index}`}
						>
							<div
								className="shrink-0 flex items-center justify-end px-2 text-xs-plus tabular-nums"
								style={{
									width: GUTTER_WIDTH,
									color: theme.colors.textDim,
									borderRight: `1px solid ${theme.colors.border}`,
								}}
							>
								{getRowLabel(virtualRow.index)}
							</div>
							{columns.map((column, columnIndex) => {
								const cell = getCell(virtualRow.index, columnIndex);
								return (
									<div
										key={column.key}
										className="shrink-0 flex items-center px-2 text-xs truncate"
										style={{
											width: widthOf(column),
											justifyContent: column.align === 'right' ? 'flex-end' : 'flex-start',
											borderRight: `1px solid ${theme.colors.border}40`,
											color: cell.placeholder ? theme.colors.textDim : theme.colors.textMain,
											// Inherits the File Preview font rather than pinning a
											// monospace stack, so the setting reaches a data file like
											// every other previewed document. `tabular-nums` is what
											// actually keeps the numeric columns aligned, and it does so
											// in ANY face - the mono stack was doing that job by side
											// effect while overriding the setting.
											fontVariantNumeric: 'tabular-nums',
											fontStyle: cell.placeholder ? 'italic' : 'normal',
											opacity: cell.placeholder ? 0.55 : 1,
										}}
										title={cell.title ?? cell.text}
									>
										{cell.text}
									</div>
								);
							})}
						</div>
					))}
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
