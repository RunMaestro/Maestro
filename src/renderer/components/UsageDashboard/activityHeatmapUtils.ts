/**
 * Pure helpers behind the Activity Heatmap.
 *
 * Every cell is REAL data: the hour layouts read `StatsAggregation.byDayHour`
 * (queries per local day and hour, straight from SQL) and the day layout reads
 * the gap-filled `byDay`. Nothing is distributed, weighted or estimated, so a
 * cell that says "3 queries at 2 PM" means three queries ran at 2 PM.
 *
 * All three layouts share one cell model: a list of columns, each a list of
 * cells top to bottom. That lets the component draw, color, and keyboard-walk
 * every layout with one grid.
 */

import type { Theme } from '../../types';
import type { StatsAggregation } from '../../../shared/stats-types';
import { COLORBLIND_HEATMAP_SCALE } from '../../constants/colorblindPalettes';
import { cssColorToHex, hexToRgb } from '../../../shared/colorContrast';
import { formatHourOfDay } from '../../../shared/formatters';
import { localDaysBetween } from '../../../shared/daySeries';
import { addLocalDays, parseLocalYmd, toLocalYmd } from '../../../shared/localDay';

import type { ChartMetricMode } from './MetricModeToggle';

/** Heatmap measures. Re-exported from the shared toggle so both stay in step. */
export type MetricMode = ChartMetricMode;

/**
 * How the window is drawn:
 * - `hours`: one column per day, one row per hour (up to a week).
 * - `blocks`: one column per day, one row per 4-hour block (up to ~a quarter).
 * - `days`: GitHub-style, one column per week, one row per weekday.
 */
export type HeatmapLayout = 'hours' | 'blocks' | 'days';

/** Longest window (days) still drawn hour by hour. */
export const HOURS_LAYOUT_MAX_DAYS = 7;
/** Longest window (days) still drawn in 4-hour blocks. */
export const BLOCKS_LAYOUT_MAX_DAYS = 92;

/** Hours per block in the `blocks` layout. */
const BLOCK_HOURS = 4;

/** "12 AM - 4 AM" ... "8 PM - 12 AM": one label per 4-hour block. */
export const TIME_BLOCK_LABELS = Array.from(
	{ length: 24 / BLOCK_HOURS },
	(_, block) =>
		`${formatHourOfDay(block * BLOCK_HOURS)} - ${formatHourOfDay(((block + 1) * BLOCK_HOURS) % 24)}`
);

/** Weekday names, Sunday first (the day layout's row order, like GitHub's). */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Pick the layout for a window of `dayCount` days. */
export function heatmapLayoutFor(dayCount: number): HeatmapLayout {
	if (dayCount <= HOURS_LAYOUT_MAX_DAYS) return 'hours';
	if (dayCount <= BLOCKS_LAYOUT_MAX_DAYS) return 'blocks';
	return 'days';
}

/**
 * Whether a layout can show a metric. Tokens are known per day only (the
 * transcript parse yields no per-hour split), so the hour layouts offer
 * queries and time and nothing else.
 */
export function layoutSupportsMetric(layout: HeatmapLayout, metric: MetricMode): boolean {
	return metric !== 'tokens' || layout === 'days';
}

/** One drawn cell. `tokens` is null where tokens are not known at this grain. */
export interface HeatmapCell {
	/** Stable DOM id suffix (also the React key). */
	key: string;
	/** Local `YYYY-MM-DD` the cell belongs to. */
	date: string;
	/** Human description of the cell's time span, e.g. "Mon, Nov 10, 2 PM - 3 PM". */
	label: string;
	count: number;
	duration: number;
	tokens: number | null;
	/** Pads a partial first/last week in the day layout; not data, not focusable. */
	placeholder?: boolean;
}

export interface HeatmapColumn {
	key: string;
	/** Text above the column; empty to print nothing. */
	header: string;
	/** True where the header starts a new month (drawn in the accent color). */
	monthStart: boolean;
	/** Hover title for the header. */
	title: string;
	cells: HeatmapCell[];
}

export interface HeatmapGrid {
	layout: HeatmapLayout;
	columns: HeatmapColumn[];
	/** One label per row, top to bottom. */
	rowLabels: string[];
	/** Number of real (non-placeholder) days the grid covers. */
	dayCount: number;
}

/** The value of `metric` in a cell (tokens read as 0 where unknown). */
export function cellValue(cell: HeatmapCell, metric: MetricMode): number {
	if (metric === 'tokens') return cell.tokens ?? 0;
	return metric === 'count' ? cell.count : cell.duration;
}

function dayDate(ymd: string): Date {
	return parseLocalYmd(ymd) ?? new Date(NaN);
}

function dayLabel(ymd: string): string {
	return dayDate(ymd).toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}

/**
 * The aggregation's calendar window. Falls back to the first..last `byDay` row
 * (or today) for a payload from an older main process without `window`.
 */
export function heatmapWindow(
	data: Pick<StatsAggregation, 'byDay'> & Partial<Pick<StatsAggregation, 'window'>>,
	now: number = Date.now()
): { startYmd: string; endYmd: string } {
	if (data.window) return data.window;
	const dates = data.byDay.map((d) => d.date).sort();
	const today = toLocalYmd(now);
	return { startYmd: dates[0] ?? today, endYmd: dates[dates.length - 1] ?? today };
}

type HourRow = { date: string; hour: number; count: number; duration: number };

/** `byDayHour` indexed by `date|hour`. */
function indexByDayHour(rows: readonly HourRow[]): Map<string, HourRow> {
	const map = new Map<string, HourRow>();
	for (const row of rows) map.set(`${row.date}|${row.hour}`, row);
	return map;
}

/** Column header for a day column: weekday names for a week, else day numbers. */
function dayColumnHeader(ymd: string, dayCount: number): { header: string; monthStart: boolean } {
	const date = dayDate(ymd);
	if (dayCount <= HOURS_LAYOUT_MAX_DAYS) {
		return { header: date.toLocaleDateString(undefined, { weekday: 'short' }), monthStart: false };
	}
	const monthStart = date.getDate() === 1;
	return {
		header: monthStart
			? date.toLocaleDateString(undefined, { month: 'short' })
			: String(date.getDate()),
		monthStart,
	};
}

/** One column per day, 24 hour cells each. */
export function buildHourGrid(days: readonly string[], byDayHour: readonly HourRow[]): HeatmapGrid {
	const index = indexByDayHour(byDayHour);
	const columns = days.map<HeatmapColumn>((date) => ({
		key: date,
		...dayColumnHeader(date, days.length),
		title: dayLabel(date),
		cells: Array.from({ length: 24 }, (_, hour) => {
			const row = index.get(`${date}|${hour}`);
			return {
				key: `${date}-h${hour}`,
				date,
				label: `${dayLabel(date)}, ${formatHourOfDay(hour)} - ${formatHourOfDay((hour + 1) % 24)}`,
				count: row?.count ?? 0,
				duration: row?.duration ?? 0,
				tokens: null,
			};
		}),
	}));
	return {
		layout: 'hours',
		columns,
		rowLabels: Array.from({ length: 24 }, (_, hour) => formatHourOfDay(hour)),
		dayCount: days.length,
	};
}

/** One column per day, one cell per 4-hour block, each the sum of its real hours. */
export function buildBlockGrid(
	days: readonly string[],
	byDayHour: readonly HourRow[]
): HeatmapGrid {
	const index = indexByDayHour(byDayHour);
	const columns = days.map<HeatmapColumn>((date) => ({
		key: date,
		...dayColumnHeader(date, days.length),
		title: dayLabel(date),
		cells: TIME_BLOCK_LABELS.map((blockLabel, block) => {
			let count = 0;
			let duration = 0;
			for (let hour = block * BLOCK_HOURS; hour < (block + 1) * BLOCK_HOURS; hour++) {
				const row = index.get(`${date}|${hour}`);
				count += row?.count ?? 0;
				duration += row?.duration ?? 0;
			}
			return {
				key: `${date}-b${block}`,
				date,
				label: `${dayLabel(date)}, ${blockLabel}`,
				count,
				duration,
				tokens: null,
			};
		}),
	}));
	return { layout: 'blocks', columns, rowLabels: TIME_BLOCK_LABELS, dayCount: days.length };
}

/**
 * GitHub-style weeks: one column per Sunday-started week, a cell per weekday,
 * placeholders before the window's first day and after its last.
 */
export function buildDayGrid(
	days: readonly string[],
	byDay: readonly { date: string; count: number; duration: number }[],
	tokensByDay: Record<string, number> | null
): HeatmapGrid {
	const byDate = new Map(byDay.map((d) => [d.date, d]));
	const inWindow = new Set(days);
	const columns: HeatmapColumn[] = [];
	if (days.length > 0) {
		const first = dayDate(days[0]);
		let cursor = addLocalDays(days[0], -first.getDay());
		const last = days[days.length - 1];
		let lastMonth = -1;
		while (cursor <= last) {
			const weekStart = cursor;
			const cells: HeatmapCell[] = [];
			let monthStart = false;
			let header = '';
			for (let weekday = 0; weekday < 7; weekday++) {
				const date = cursor;
				const real = inWindow.has(date);
				const row = byDate.get(date);
				const month = dayDate(date).getMonth();
				if (real && month !== lastMonth) {
					// The first week holding a new month carries its name.
					header = dayDate(date).toLocaleDateString(undefined, { month: 'short' });
					monthStart = lastMonth !== -1;
					lastMonth = month;
				}
				cells.push({
					key: date,
					date,
					label: dayDate(date).toLocaleDateString(undefined, {
						weekday: 'short',
						month: 'short',
						day: 'numeric',
						year: 'numeric',
					}),
					count: real ? (row?.count ?? 0) : 0,
					duration: real ? (row?.duration ?? 0) : 0,
					tokens: real && tokensByDay ? (tokensByDay[date] ?? 0) : null,
					placeholder: !real,
				});
				cursor = addLocalDays(cursor, 1);
			}
			columns.push({
				key: weekStart,
				header,
				monthStart,
				title: `Week of ${dayLabel(weekStart)}`,
				cells,
			});
		}
	}
	return { layout: 'days', columns, rowLabels: WEEKDAY_LABELS, dayCount: days.length };
}

/** Build the grid for an aggregation, choosing the layout from its window. */
export function buildHeatmapGrid(
	data: Pick<StatsAggregation, 'byDay'> & Partial<Pick<StatsAggregation, 'window' | 'byDayHour'>>,
	tokensByDay: Record<string, number> | null,
	now: number = Date.now()
): HeatmapGrid {
	const span = heatmapWindow(data, now);
	const days = localDaysBetween(span.startYmd, span.endYmd);
	const layout = heatmapLayoutFor(days.length);
	if (layout === 'hours') return buildHourGrid(days, data.byDayHour ?? []);
	if (layout === 'blocks') return buildBlockGrid(days, data.byDayHour ?? []);
	return buildDayGrid(days, data.byDay, tokensByDay);
}

/**
 * Which column headers to print when columns are too narrow for every one:
 * at most `maxLabels` evenly strided, and every month start.
 */
export function headerIndices(columns: readonly HeatmapColumn[], maxLabels: number): Set<number> {
	const shown = new Set<number>();
	const stride = Math.max(1, Math.ceil(columns.length / Math.max(1, maxLabels)));
	columns.forEach((column, index) => {
		if (!column.header) return;
		if (column.monthStart || index % stride === 0) shown.add(index);
	});
	// A month start claims the strided label right after it, which would print on top.
	for (const index of [...shown]) {
		if (columns[index].monthStart) {
			for (let near = index + 1; near < index + stride; near++) shown.delete(near);
		}
	}
	return shown;
}

/** Bucket a value into the 0-4 color scale relative to the grid's maximum. */
export function calculateIntensity(value: number, maxValue: number): number {
	if (value === 0) return 0;
	if (maxValue === 0) return 0;

	const ratio = value / maxValue;
	if (ratio <= 0.25) return 1;
	if (ratio <= 0.5) return 2;
	if (ratio <= 0.75) return 3;
	return 4;
}

const INTENSITY_ALPHAS = [0, 0.2, 0.4, 0.6, 0.9];

export function getIntensityColor(
	intensity: number,
	theme: Theme,
	colorBlindMode?: boolean
): string {
	const level = Math.max(0, Math.min(4, Math.round(intensity)));
	if (colorBlindMode) return COLORBLIND_HEATMAP_SCALE[level];
	if (level === 0) return theme.colors.bgActivity;

	const rgb = hexToRgb(cssColorToHex(theme.colors.accent) ?? '');
	if (!rgb) {
		// An accent the color math cannot read (a CSS variable): append an alpha
		// byte, which is what the theme system's hex accents accept.
		const opacities = [0.1, 0.3, 0.5, 0.7, 1.0];
		return `${theme.colors.accent}${Math.round(opacities[level] * 255)
			.toString(16)
			.padStart(2, '0')}`;
	}
	return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${INTENSITY_ALPHAS[level]})`;
}
