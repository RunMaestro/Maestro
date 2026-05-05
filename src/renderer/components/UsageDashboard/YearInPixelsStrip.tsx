/**
 * YearInPixelsStrip
 *
 * Single-row "year in pixels" hero — one cell per day across the active
 * dashboard time range, colored by activity intensity (same 5-bucket scale
 * used by the Activity Heatmap so the colors are consistent across the
 * dashboard).
 *
 * Designed to sit at the top of the Overview tab as a glanceable signature
 * graphic — the user sees their selected window of work in one strip, with
 * peaks, dry spells, and recent momentum all readable at once.
 */

import {
	memo,
	useMemo,
	useState,
	type MouseEvent,
	type KeyboardEvent,
	type FocusEvent,
} from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import type { StatsTimeRange } from '../../../shared/stats-types';
import { formatDurationHuman as formatDuration, formatNumber } from '../../../shared/formatters';
import { COLORBLIND_HEATMAP_SCALE } from '../../constants/colorblindPalettes';
import { ChartTooltip } from './ChartTooltip';

interface YearInPixelsStripProps {
	data: StatsAggregation;
	theme: Theme;
	colorBlindMode?: boolean;
	/** Active dashboard time window — controls how many day cells render. */
	timeRange: StatsTimeRange;
}

const RANGE_TITLES: Record<StatsTimeRange, string> = {
	day: 'Today',
	week: 'Past Week',
	month: 'Past Month',
	quarter: 'Past Quarter',
	year: 'Past Year',
	all: 'All Time',
};

const FIXED_RANGE_DAYS: Partial<Record<StatsTimeRange, number>> = {
	week: 7,
	month: 30,
	quarter: 90,
	year: 365,
};

interface DayCell {
	dateStr: string;
	displayDate: string;
	count: number;
	duration: number;
	intensity: number; // 0-4
	monthIndex: number;
	isFirstOfMonth: boolean;
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
 * the project's curated palette; otherwise we mix the theme accent against
 * a transparent background so the strip looks "right" against any theme.
 */
function intensityColor(level: number, theme: Theme, colorBlindMode: boolean): string {
	if (colorBlindMode) {
		const clamped = Math.max(0, Math.min(4, Math.round(level)));
		return COLORBLIND_HEATMAP_SCALE[clamped];
	}
	const accent = theme.colors.accent;
	if (level === 0) return theme.colors.bgActivity;
	let rgb: { r: number; g: number; b: number } | null = null;
	if (accent.startsWith('#')) {
		const hex = accent.slice(1);
		rgb = {
			r: parseInt(hex.slice(0, 2), 16),
			g: parseInt(hex.slice(2, 4), 16),
			b: parseInt(hex.slice(4, 6), 16),
		};
	} else if (accent.startsWith('rgb')) {
		const match = accent.match(/\d+/g);
		if (match && match.length >= 3) {
			rgb = { r: +match[0], g: +match[1], b: +match[2] };
		}
	}
	if (!rgb) return accent;
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

	const { cells, monthMarkers, totalDays, hasData } = useMemo(() => {
		// Index byDay rows by date for O(1) lookup.
		const byDate = new Map<string, { count: number; duration: number }>();
		for (const day of data.byDay) {
			byDate.set(day.date, { count: day.count, duration: day.duration });
		}

		const fmt = (d: Date) =>
			`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

		// Resolve total day count for the active range. For 'all' we span from
		// the earliest recorded day to today; for fixed ranges we use the
		// canonical lookback (matches getTimeRangeStart in main/stats/utils.ts).
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		let total: number;
		if (timeRange === 'all') {
			// Parse YYYY-MM-DD as a local-midnight date (matches how `fmt`
			// emits the keys above) so the day-count math matches the cell
			// iteration below across DST and timezone boundaries.
			let earliestMs: number | null = null;
			for (const day of data.byDay) {
				const m = day.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
				if (!m) continue;
				const localMidnight = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
				if (earliestMs === null || localMidnight < earliestMs) {
					earliestMs = localMidnight;
				}
			}
			if (earliestMs === null) {
				total = 0;
			} else {
				const diffDays = Math.round((today.getTime() - earliestMs) / (24 * 60 * 60 * 1000));
				total = Math.max(1, diffDays + 1);
			}
		} else {
			total = FIXED_RANGE_DAYS[timeRange] ?? 1;
		}

		const arr: DayCell[] = [];
		const markers: Array<{ index: number; label: string }> = [];
		let lastMonth = -1;
		let max = 0;

		for (let i = total - 1; i >= 0; i--) {
			const date = new Date(today);
			date.setDate(date.getDate() - i);
			const dateStr = fmt(date);
			const stats = byDate.get(dateStr) ?? { count: 0, duration: 0 };
			if (stats.count > max) max = stats.count;
			const monthIndex = date.getMonth();
			const isFirstOfMonth = monthIndex !== lastMonth;
			if (isFirstOfMonth) {
				markers.push({ index: total - 1 - i, label: MONTH_ABBR[monthIndex] });
			}
			lastMonth = monthIndex;
			arr.push({
				dateStr,
				displayDate: date.toLocaleDateString('en-US', {
					weekday: 'short',
					month: 'short',
					day: 'numeric',
					year: 'numeric',
				}),
				count: stats.count,
				duration: stats.duration,
				intensity: 0,
				monthIndex,
				isFirstOfMonth,
			});
		}

		// Second pass: assign intensities now that max is known.
		for (const cell of arr) cell.intensity = calcIntensity(cell.count, max);

		return { cells: arr, monthMarkers: markers, totalDays: total, hasData: max > 0 };
	}, [data.byDay, timeRange]);

	// Hide for ranges where a strip has no visual value (single-day window),
	// or when there's no activity at all in the range.
	if (!hasData || timeRange === 'day' || totalDays < 2) {
		return null;
	}

	// Pointer-anchored tooltip for mouse hovers (close to cursor). Keyboard /
	// focus paths fall back to the cell's bounding rect since there's no cursor
	// to anchor to in those cases.
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
	const handleFocus = (cell: DayCell, e: FocusEvent<HTMLDivElement>) => {
		setHovered(cell);
		const rect = e.currentTarget.getBoundingClientRect();
		setAnchor({ x: rect.left + rect.width / 2, y: rect.top });
	};
	const handleKeyDown = (cell: DayCell, e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === 'Escape') {
			setHovered(null);
			setAnchor(null);
			return;
		}
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			setHovered(cell);
			const rect = e.currentTarget.getBoundingClientRect();
			setAnchor({ x: rect.left + rect.width / 2, y: rect.top });
		}
	};

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Activity over ${totalDays} ${totalDays === 1 ? 'day' : 'days'}`}
			data-testid="year-in-pixels-strip"
		>
			<div className="flex items-baseline justify-between mb-2">
				<h3
					className="text-xs font-medium uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					{RANGE_TITLES[timeRange]}
				</h3>
				<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
					{totalDays} {totalDays === 1 ? 'day' : 'days'}
				</span>
			</div>

			{/* Strip — one flex row of unit-width cells. The container caps cell
			    height so the strip stays a single visual line rather than turning
			    into a chunky bar. */}
			<div className="relative">
				<div className="flex gap-[1px]" style={{ height: 26 }}>
					{cells.map((cell, idx) => (
						<div
							key={cell.dateStr}
							className="rounded-[2px] cursor-default focus:outline-none"
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
							onFocus={(e) => handleFocus(cell, e)}
							onBlur={handleLeave}
							onKeyDown={(e) => handleKeyDown(cell, e)}
							role="gridcell"
							tabIndex={0}
							aria-label={`${cell.displayDate}: ${cell.count} ${
								cell.count === 1 ? 'query' : 'queries'
							}`}
							data-testid={idx === 0 ? 'year-strip-first-cell' : undefined}
						/>
					))}
				</div>

				{/* Month-marker labels under the strip. We render each marker at the
				    horizontal position of its first-of-month cell using a percent
				    offset so it survives the responsive flex layout above. */}
				<div className="relative h-4 mt-1">
					{monthMarkers.map((marker) => (
						<span
							key={`${marker.label}-${marker.index}`}
							className="absolute text-[10px]"
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
