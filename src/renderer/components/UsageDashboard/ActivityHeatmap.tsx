/**
 * ActivityHeatmap
 *
 * When in the day (and week) the work happened, over the selected window.
 *
 * Three layouts, chosen by the window's length (see `heatmapLayoutFor`):
 * - up to a week: one column per day, one row per hour;
 * - up to ~a quarter: one column per day, one row per 4-hour block;
 * - longer: GitHub-style, one column per week, one row per weekday.
 *
 * Every cell is real data. The hour layouts read `byDayHour` (queries per local
 * day and hour), the day layout reads the gap-filled `byDay`. All Time spans the
 * whole recorded history (`data.window`), not a silent last-365-days cut.
 *
 * Tokens are known per day only, so the Tokens metric is offered in the day
 * layout alone; the hour layouts show queries and time.
 *
 * Keyboard: the grid is ONE tab stop. Arrow keys move the active cell
 * (Left/Right across columns, Up/Down within one), Home/End jump to the first
 * or last column, and the active cell's tooltip shows while the grid has focus.
 */

import { memo, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../../shared/stats-types';
import { formatDurationHuman, formatNumber, formatTokensCompact } from '../../../shared/formatters';
import {
	buildHeatmapGrid,
	calculateIntensity,
	cellValue,
	getIntensityColor,
	headerIndices,
	layoutSupportsMetric,
	type HeatmapCell,
	type MetricMode,
} from './activityHeatmapUtils';
import { MetricModeToggle, metricModeNoun } from './MetricModeToggle';
import { useTokenSeries } from './TokenSeriesContext';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { ChartTooltip } from '../widgets';

const METRIC_MODES: readonly MetricMode[] = ['count', 'duration', 'tokens'];
const HOUR_LAYOUT_MODES: MetricMode[] = ['count', 'duration'];
export const HEATMAP_METRIC_KEY = 'usageDashboard.activity.heatmapMetric';

/** Row height (px) per layout; the day layout uses square cells instead. */
const ROW_HEIGHT: Record<'hours' | 'blocks', number> = { hours: 14, blocks: 17 };

/** Most column headers to print before thinning them. */
const MAX_HEADERS = 16;
const MAX_HEADERS_PHONE = 7;

interface ActivityHeatmapProps {
	/** Aggregated stats for the selected range (uses `window`, `byDay`, `byDayHour`). */
	data: StatsAggregation;
	theme: Theme;
	colorBlindMode?: boolean;
}

function describeValue(cell: HeatmapCell, metric: MetricMode): string {
	if (metric === 'tokens') return `${formatTokensCompact(cell.tokens ?? 0)} tokens`;
	if (metric === 'duration') return formatDurationHuman(cell.duration);
	return `${formatNumber(cell.count)} ${cell.count === 1 ? 'query' : 'queries'}`;
}

/** The cell's accessible text: when, then the active metric, then the rest. */
function describeCell(cell: HeatmapCell, metric: MetricMode): string {
	const others = (['count', 'duration', 'tokens'] as const)
		.filter((m) => m !== metric && (m !== 'tokens' || cell.tokens !== null))
		.map((m) => describeValue(cell, m));
	return `${cell.label}: ${describeValue(cell, metric)} (${others.join(', ')})`;
}

export const ActivityHeatmap = memo(function ActivityHeatmap({
	data,
	theme,
	colorBlindMode = false,
}: ActivityHeatmapProps) {
	const { value: chosenMetric, setValue: setMetric } = usePersistedChoice<MetricMode>(
		HEATMAP_METRIC_KEY,
		METRIC_MODES,
		'count'
	);
	const phone = usePhoneLayout();
	const gridId = useId();

	// The layout depends only on the window, so it is known before tokens are.
	const layoutProbe = useMemo(() => buildHeatmapGrid(data, null), [data]);
	const layout = layoutProbe.layout;
	// A Tokens choice remembered from a long range falls back to queries in an
	// hour layout, without overwriting the remembered choice.
	const metric: MetricMode = layoutSupportsMetric(layout, chosenMetric) ? chosenMetric : 'count';
	const { series: tokenSeries, loading: tokensLoading } = useTokenSeries(metric === 'tokens');

	const grid = useMemo(
		() =>
			layout === 'days' && tokenSeries ? buildHeatmapGrid(data, tokenSeries.byDay) : layoutProbe,
		[layout, tokenSeries, data, layoutProbe]
	);

	const maxValue = useMemo(() => {
		let max = 0;
		for (const column of grid.columns) {
			for (const cell of column.cells) {
				if (!cell.placeholder) max = Math.max(max, cellValue(cell, metric));
			}
		}
		return max;
	}, [grid, metric]);

	const shownHeaders = useMemo(
		() => headerIndices(grid.columns, phone ? MAX_HEADERS_PHONE : MAX_HEADERS),
		[grid.columns, phone]
	);

	// Roving position: [column, row]. Starts on the last column (today).
	const [active, setActive] = useState<{ col: number; row: number } | null>(null);
	const [focused, setFocused] = useState(false);
	const [hover, setHover] = useState<{ cell: HeatmapCell; x: number; y: number } | null>(null);

	const lastCol = grid.columns.length - 1;
	const rowCount = grid.rowLabels.length;
	const position = active && active.col <= lastCol && active.row < rowCount ? active : null;
	// Default: today. In the day layout that is the last real cell of the last
	// week (which may end in placeholders); in an hour layout, today's first row.
	const fallbackPosition = useMemo(() => {
		for (let col = lastCol; col >= 0; col--) {
			const cells = grid.columns[col].cells;
			const order = grid.layout === 'days' ? [...cells.keys()].reverse() : [...cells.keys()];
			const row = order.find((index) => !cells[index].placeholder);
			if (row !== undefined) return { col, row };
		}
		return { col: 0, row: 0 };
	}, [grid, lastCol]);
	const current = position ?? fallbackPosition;
	const activeCell = grid.columns[current.col]?.cells[current.row];
	const cellDomId = (cell: HeatmapCell) => `${gridId}-${cell.key}`;

	const isRealCell = (col: number, row: number) => {
		const cell = grid.columns[col]?.cells[row];
		return !!cell && !cell.placeholder;
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const { col, row } = current;
		let target: { col: number; row: number } | null = null;
		// Horizontal moves walk past placeholder days (the day layout pads its
		// first and last weeks); a vertical move onto one stays put.
		const scan = (from: number, step: number, inRow: number) => {
			for (let c = from; c >= 0 && c <= lastCol; c += step) {
				if (isRealCell(c, inRow)) return { col: c, row: inRow };
			}
			return null;
		};
		switch (event.key) {
			case 'ArrowLeft':
				target = scan(col - 1, -1, row);
				break;
			case 'ArrowRight':
				target = scan(col + 1, 1, row);
				break;
			case 'ArrowUp':
				target = isRealCell(col, row - 1) ? { col, row: row - 1 } : null;
				break;
			case 'ArrowDown':
				target = isRealCell(col, row + 1) ? { col, row: row + 1 } : null;
				break;
			case 'Home':
				target = scan(0, 1, row);
				break;
			case 'End':
				target = scan(lastCol, -1, row);
				break;
			default:
				return;
		}
		// The section's own arrow keys must not fire while the grid owns them.
		event.preventDefault();
		event.stopPropagation();
		if (target) setActive(target);
	};

	// Tooltip: the hovered cell, else the keyboard-active cell while focused.
	const tooltipCell = hover?.cell ?? (focused && activeCell ? activeCell : null);
	let tooltipAnchor: { x: number; y: number } | null = null;
	if (hover) {
		tooltipAnchor = { x: hover.x, y: hover.y };
	} else if (focused && activeCell) {
		const rect = document.getElementById(cellDomId(activeCell))?.getBoundingClientRect();
		if (rect) tooltipAnchor = { x: rect.left + rect.width / 2, y: rect.top };
	}

	const modes = layout === 'days' ? (METRIC_MODES as MetricMode[]) : HOUR_LAYOUT_MODES;
	const isDayLayout = layout === 'days';
	const labelEvery = layout === 'hours' ? 3 : 1;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Activity heatmap showing ${metricModeNoun(metric)} over ${grid.dayCount} ${grid.dayCount === 1 ? 'day' : 'days'}.`}
			data-testid="activity-heatmap"
			data-layout={layout}
		>
			<div className="flex flex-wrap items-center justify-between gap-2 mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Activity Heatmap
				</h3>
				<MetricModeToggle
					mode={metric}
					onChange={setMetric}
					theme={theme}
					modes={modes}
					variant="subtle"
					tokensLoading={tokensLoading}
				/>
			</div>

			<div className="flex gap-2">
				{/* Row labels */}
				<div
					className="flex flex-col flex-shrink-0 gap-[2px]"
					style={{ width: layout === 'blocks' ? 84 : 40, paddingTop: 20 }}
					aria-hidden="true"
				>
					{grid.rowLabels.map((label, idx) => (
						<div
							key={label}
							className="text-xs text-right flex items-center justify-end pr-1 whitespace-nowrap"
							style={{
								color: theme.colors.textDim,
								height: isDayLayout ? undefined : ROW_HEIGHT[layout as 'hours' | 'blocks'],
								flex: isDayLayout ? '1 1 0' : undefined,
								fontSize: 10,
							}}
						>
							{isDayLayout ? (idx % 2 === 1 ? label : '') : idx % labelEvery === 0 ? label : ''}
						</div>
					))}
				</div>

				{/* The grid: one tab stop; arrow keys move the active cell. */}
				<div
					className="flex-1 min-w-0 flex gap-[2px] outline-none rounded-sm"
					role="group"
					aria-roledescription="heatmap"
					aria-label="Activity heatmap cells. Use arrow keys to move between cells."
					aria-activedescendant={activeCell ? cellDomId(activeCell) : undefined}
					tabIndex={0}
					onKeyDown={handleKeyDown}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					style={{
						boxShadow: focused ? `0 0 0 1px ${theme.colors.accent}` : undefined,
					}}
					data-testid="activity-heatmap-grid"
				>
					{grid.columns.map((column, colIdx) => (
						<div
							key={column.key}
							className="flex flex-col gap-[2px] min-w-0"
							style={{ flex: '1 1 0' }}
						>
							<div
								className="text-center h-[18px] flex items-center justify-center overflow-visible whitespace-nowrap"
								style={{
									color: column.monthStart ? theme.colors.accent : theme.colors.textDim,
									fontSize: 10,
									fontWeight: column.monthStart ? 600 : 400,
								}}
								title={column.title}
								aria-hidden="true"
							>
								{shownHeaders.has(colIdx) ? column.header : ''}
							</div>
							{column.cells.map((cell, rowIdx) => {
								const isActive = focused && colIdx === current.col && rowIdx === current.row;
								const isHovered = hover?.cell.key === cell.key;
								return (
									<div
										key={cell.key}
										id={cell.placeholder ? undefined : cellDomId(cell)}
										className="rounded-sm w-full"
										role={cell.placeholder ? 'presentation' : 'img'}
										aria-label={cell.placeholder ? undefined : describeCell(cell, metric)}
										data-testid={cell.placeholder ? undefined : 'activity-heatmap-cell'}
										data-active={isActive || undefined}
										style={{
											...(isDayLayout
												? { aspectRatio: '1 / 1' }
												: { height: ROW_HEIGHT[layout as 'hours' | 'blocks'] }),
											backgroundColor: cell.placeholder
												? 'transparent'
												: getIntensityColor(
														calculateIntensity(cellValue(cell, metric), maxValue),
														theme,
														colorBlindMode
													),
											outline: isActive || isHovered ? `2px solid ${theme.colors.accent}` : 'none',
											outlineOffset: -1,
											transition: 'background-color 0.3s ease, outline 0.15s ease',
										}}
										onMouseEnter={
											cell.placeholder
												? undefined
												: (e) => setHover({ cell, x: e.clientX, y: e.clientY })
										}
										onMouseMove={
											cell.placeholder
												? undefined
												: (e) => setHover({ cell, x: e.clientX, y: e.clientY })
										}
										onMouseLeave={() => setHover(null)}
										onClick={
											cell.placeholder ? undefined : () => setActive({ col: colIdx, row: rowIdx })
										}
									/>
								);
							})}
						</div>
					))}
				</div>
			</div>

			{/* Announces the keyboard-active cell (the visual tooltip is not read). */}
			<div className="sr-only" aria-live="polite">
				{focused && activeCell && !activeCell.placeholder ? describeCell(activeCell, metric) : ''}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2 mt-3">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{isDayLayout
						? ''
						: 'Tokens have no hourly breakdown, so this view shows queries and time.'}
				</span>
				<div
					className="flex items-center gap-2"
					role="list"
					aria-label="Activity intensity scale from less to more"
				>
					<span className="text-xs" style={{ color: theme.colors.textDim }} aria-hidden="true">
						Less
					</span>
					{[0, 1, 2, 3, 4].map((level) => (
						<div
							key={level}
							className="rounded-sm"
							style={{
								width: 12,
								height: 12,
								backgroundColor: getIntensityColor(level, theme, colorBlindMode),
							}}
							role="listitem"
							aria-label={`Intensity level ${level}: ${level === 0 ? 'No activity' : level === 1 ? 'Low' : level === 2 ? 'Medium-low' : level === 3 ? 'Medium-high' : 'High'} activity`}
						/>
					))}
					<span className="text-xs" style={{ color: theme.colors.textDim }} aria-hidden="true">
						More
					</span>
				</div>
			</div>

			{tooltipCell && !tooltipCell.placeholder && (
				<ChartTooltip anchor={tooltipAnchor} theme={theme} testId="activity-heatmap-tooltip">
					<div className="font-medium mb-0.5">{tooltipCell.label}</div>
					<div style={{ color: theme.colors.textMain }}>{describeValue(tooltipCell, metric)}</div>
					<div style={{ color: theme.colors.textDim }}>
						{(['count', 'duration', 'tokens'] as const)
							.filter((m) => m !== metric && (m !== 'tokens' || tooltipCell.tokens !== null))
							.map((m) => describeValue(tooltipCell, m))
							.join(' - ')}
					</div>
				</ChartTooltip>
			)}
		</div>
	);
});

export default ActivityHeatmap;
