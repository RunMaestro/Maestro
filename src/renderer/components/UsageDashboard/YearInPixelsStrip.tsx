/**
 * YearInPixelsStrip
 *
 * Single-row "year in pixels" hero - one cell per day of the selected range,
 * colored by query count (the same 5-bucket scale as the Activity Heatmap so
 * the colors are consistent across the dashboard).
 *
 * The cells are the aggregation's gap-filled `byDay` series, so the strip
 * covers exactly the range's calendar window, idle days included.
 *
 * Keyboard: the strip is ONE tab stop (a roving tabindex). Arrow keys move
 * between days, Home/End jump to the ends, and the focused day shows its
 * tooltip. A per-cell tab stop would put 365 Tab presses before the next
 * section on the Last 365 Days range.
 */

import {
	memo,
	useMemo,
	useRef,
	useState,
	type MouseEvent,
	type KeyboardEvent,
	type FocusEvent,
} from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import type { StatsTimeRange } from '../../../shared/stats-types';
import { formatDurationHuman as formatDuration, formatNumber } from '../../../shared/formatters';
import { parseLocalYmd } from '../../../shared/localDay';
import { cssColorToHex, hexToRgb } from '../../../shared/colorContrast';
import { COLORBLIND_HEATMAP_SCALE } from '../../constants/colorblindPalettes';
import { ChartTooltip } from '../widgets';
import { getTimeRangeLabel } from './UsageDashboardModal/constants';

interface YearInPixelsStripProps {
	data: StatsAggregation;
	theme: Theme;
	colorBlindMode?: boolean;
	/** Active dashboard time window - names the strip; the cells come from `data.byDay`. */
	timeRange: StatsTimeRange;
}

interface DayCell {
	dateStr: string;
	displayDate: string;
	count: number;
	duration: number;
	intensity: number; // 0-4
}

const MONTH_ABBR = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
];

/**
 * Past this many cells the 1px gaps are dropped: 364 gaps alone are wider than
 * a phone, and a flex row whose gaps exceed its width squeezes every cell to
 * nothing and overflows. Without gaps the cells always share the full width.
 */
const GAPLESS_CELL_COUNT = 120;

/**
 * Cap the input value into the 5-bucket intensity scale used by the
 * Activity Heatmap. 0 = no activity; 1-4 = quartiles of `[1, max]`.
 */
function calcIntensity(value: number, max: number): number {
	if (value === 0 || max === 0) return 0;
	const ratio = value / max;
	if (ratio <= 0.25) return 1;
	if (ratio <= 0.5) return 2;
	if (ratio <= 0.75) return 3;
	return 4;
}

/**
 * Resolve an intensity bucket to a color string. In colorblind mode we use
 * the project's curated palette; otherwise the theme accent at rising alpha,
 * so the strip looks right against any theme.
 */
function intensityColor(level: number, theme: Theme, colorBlindMode: boolean): string {
	if (colorBlindMode) {
		const clamped = Math.max(0, Math.min(4, Math.round(level)));
		return COLORBLIND_HEATMAP_SCALE[clamped];
	}
	if (level === 0) return theme.colors.bgActivity;
	const rgb = hexToRgb(cssColorToHex(theme.colors.accent) ?? '');
	if (!rgb) return theme.colors.accent;
	const alphaByLevel = [0, 0.25, 0.45, 0.7, 1];
	return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alphaByLevel[level]})`;
}

export const YearInPixelsStrip = memo(function YearInPixelsStrip({
	data,
	theme,
	colorBlindMode = false,
	timeRange,
}: YearInPixelsStripProps) {
	const [hovered, setHovered] = useState<DayCell | null>(null);
	const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
	// The roving tab stop. -1 = the last cell (today), so a fresh strip focuses today.
	const [activeIndex, setActiveIndex] = useState(-1);
	const cellRefs = useRef<Array<HTMLDivElement | null>>([]);

	const { cells, monthMarkers, hasData } = useMemo(() => {
		let max = 0;
		for (const day of data.byDay) if (day.count > max) max = day.count;

		const markers: Array<{ index: number; label: string }> = [];
		let lastMonth = -1;
		const arr: DayCell[] = data.byDay.map((day, index) => {
			const date = parseLocalYmd(day.date);
			const monthIndex = date ? date.getMonth() : lastMonth;
			if (monthIndex !== lastMonth) markers.push({ index, label: MONTH_ABBR[monthIndex] });
			lastMonth = monthIndex;
			return {
				dateStr: day.date,
				displayDate: date
					? date.toLocaleDateString('en-US', {
							weekday: 'short',
							month: 'short',
							day: 'numeric',
							year: 'numeric',
						})
					: day.date,
				count: day.count,
				duration: day.duration,
				intensity: calcIntensity(day.count, max),
			};
		});
		return { cells: arr, monthMarkers: markers, hasData: max > 0 };
	}, [data.byDay]);

	// Hide for a single-day window (nothing to compare), or when the range has
	// no queries at all.
	if (!hasData || timeRange === 'day' || cells.length < 2) {
		return null;
	}

	const totalDays = cells.length;
	const focusIndex = activeIndex < 0 || activeIndex >= totalDays ? totalDays - 1 : activeIndex;
	const gapless = totalDays > GAPLESS_CELL_COUNT;

	const showAt = (cell: DayCell, el: HTMLElement) => {
		const rect = el.getBoundingClientRect();
		setHovered(cell);
		setAnchor({ x: rect.left + rect.width / 2, y: rect.top });
	};
	const handleEnter = (cell: DayCell, e: MouseEvent<HTMLDivElement>) => {
		setHovered(cell);
		setAnchor({ x: e.clientX, y: e.clientY });
	};
	const handleMove = (e: MouseEvent<HTMLDivElement>) => {
		setAnchor({ x: e.clientX, y: e.clientY });
	};
	const handleLeave = () => {
		setHovered(null);
		setAnchor(null);
	};
	const handleFocus = (index: number, e: FocusEvent<HTMLDivElement>) => {
		setActiveIndex(index);
		showAt(cells[index], e.currentTarget);
	};
	const handleKeyDown = (index: number, e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === 'Escape') {
			handleLeave();
			return;
		}
		let next: number | null = null;
		if (e.key === 'ArrowRight') next = Math.min(totalDays - 1, index + 1);
		else if (e.key === 'ArrowLeft') next = Math.max(0, index - 1);
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = totalDays - 1;
		if (next === null) return;
		e.preventDefault();
		e.stopPropagation();
		setActiveIndex(next);
		cellRefs.current[next]?.focus();
	};

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Queries per day over ${totalDays} days`}
			data-testid="year-in-pixels-strip"
		>
			<div className="flex items-baseline justify-between mb-2">
				<h3
					className="text-xs font-medium uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					{getTimeRangeLabel(timeRange, data.earliestQueryAt)}
				</h3>
			</div>

			<div className="relative">
				<div
					className="flex"
					style={{ height: 26, gap: gapless ? 0 : 1 }}
					role="grid"
					aria-label="Queries per day. Use the arrow keys to move between days."
					data-gapless={gapless ? 'true' : 'false'}
				>
					<div role="row" className="contents">
						{cells.map((cell, idx) => (
							<div
								key={cell.dateStr}
								ref={(el) => {
									cellRefs.current[idx] = el;
								}}
								className={`${gapless ? '' : 'rounded-[2px] '}focus:outline-none`}
								style={{
									flex: '1 1 0',
									minWidth: 0,
									height: '100%',
									backgroundColor: intensityColor(cell.intensity, theme, colorBlindMode),
									outline:
										hovered?.dateStr === cell.dateStr ? `1px solid ${theme.colors.accent}` : 'none',
									outlineOffset: 1,
									transition: 'background-color 0.3s ease, outline 0.15s ease',
								}}
								onMouseEnter={(e) => handleEnter(cell, e)}
								onMouseMove={handleMove}
								onMouseLeave={handleLeave}
								onFocus={(e) => handleFocus(idx, e)}
								onBlur={handleLeave}
								onKeyDown={(e) => handleKeyDown(idx, e)}
								role="gridcell"
								tabIndex={idx === focusIndex ? 0 : -1}
								aria-label={`${cell.displayDate}: ${formatNumber(cell.count)} ${
									cell.count === 1 ? 'query' : 'queries'
								}`}
								data-testid={idx === 0 ? 'year-strip-first-cell' : 'year-strip-cell'}
							/>
						))}
					</div>
				</div>

				{/* Month-marker labels under the strip, each at its first-of-month
				    cell's horizontal position as a percent of the row. */}
				<div className="relative h-4 mt-1" aria-hidden="true">
					{monthMarkers.map((marker) => (
						<span
							key={`${marker.label}-${marker.index}`}
							className="absolute text-2xs"
							style={{
								color: theme.colors.textDim,
								left: `${(marker.index / totalDays) * 100}%`,
								transform: 'translateX(-50%)',
							}}
						>
							{marker.label}
						</span>
					))}
				</div>
			</div>

			{hovered && (
				<ChartTooltip anchor={anchor} theme={theme} width={220} height={56}>
					<div className="font-medium mb-1">{hovered.displayDate}</div>
					<div style={{ color: theme.colors.textDim }}>
						<div>
							{formatNumber(hovered.count)} {hovered.count === 1 ? 'query' : 'queries'}
						</div>
						{hovered.duration > 0 && <div>{formatDuration(hovered.duration)}</div>}
					</div>
				</ChartTooltip>
			)}
		</div>
	);
});

export default YearInPixelsStrip;
