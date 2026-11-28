/**
 * Tests for ActivityHeatmap.
 *
 * What matters:
 * - Hour layouts draw REAL per-hour data from `byDayHour` (the old version
 *   spread each day's total evenly across the hours and invented the shape).
 * - The layout follows the window (`data.window`), so All Time is not cut to a
 *   year.
 * - Tokens are offered only in the day layout, where per-day tokens exist.
 * - The metric choice is remembered.
 * - The grid is ONE tab stop; arrow keys move the active cell and its tooltip.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { StatsAggregation } from '../../../../shared/stats-types';
import { THEMES } from '../../../../shared/themes';

const storage = new Map<string, string>();
vi.mock('../../../../renderer/utils/safeLocalStorage', () => ({
	safeStorageGet: (key: string) => (storage.has(key) ? storage.get(key)! : null),
	safeStorageSet: (key: string, value: string) => {
		storage.set(key, value);
	},
}));

const tokenSeriesState = vi.hoisted(() => ({
	series: null as null | { byDay: Record<string, number> },
	requested: [] as boolean[],
}));
vi.mock('../../../../renderer/components/UsageDashboard/TokenSeriesContext', () => ({
	useTokenSeries: (enabled: boolean) => {
		tokenSeriesState.requested.push(enabled);
		return { series: tokenSeriesState.series, loading: false, error: null };
	},
}));

import {
	ActivityHeatmap,
	HEATMAP_METRIC_KEY,
} from '../../../../renderer/components/UsageDashboard/ActivityHeatmap';

const theme = THEMES['dracula'];

function aggregation(over: Partial<StatsAggregation>): StatsAggregation {
	return {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byDay: [],
		byDayHour: [],
		window: { startYmd: '2026-11-08', endYmd: '2026-11-14' },
		...over,
	} as StatsAggregation;
}

const weekData = aggregation({
	window: { startYmd: '2026-11-08', endYmd: '2026-11-14' },
	byDay: [{ date: '2026-11-12', count: 4, duration: 4_000 }],
	byDayHour: [
		{ date: '2026-11-12', hour: 9, count: 3, duration: 3_000 },
		{ date: '2026-11-12', hour: 15, count: 1, duration: 1_000 },
	],
});

const yearData = aggregation({
	window: { startYmd: '2025-11-15', endYmd: '2026-11-14' },
	byDay: [
		{ date: '2026-11-12', count: 4, duration: 4_000 },
		{ date: '2026-11-13', count: 1, duration: 100 },
	],
});

function cellLabels(): string[] {
	return screen
		.getAllByTestId('activity-heatmap-cell')
		.map((el) => el.getAttribute('aria-label') ?? '');
}

describe('ActivityHeatmap', () => {
	beforeEach(() => {
		storage.clear();
		tokenSeriesState.series = null;
		tokenSeriesState.requested = [];
	});

	it('draws a week hour by hour from real per-hour rows', () => {
		render(<ActivityHeatmap data={weekData} theme={theme} />);
		expect(screen.getByTestId('activity-heatmap').getAttribute('data-layout')).toBe('hours');
		expect(screen.getAllByTestId('activity-heatmap-cell')).toHaveLength(7 * 24);

		const labels = cellLabels();
		expect(labels.filter((l) => l.includes(': 3 queries'))).toHaveLength(1);
		expect(labels.filter((l) => l.includes(': 1 query'))).toHaveLength(1);
		// Every other hour is empty: nothing was spread across the day.
		expect(labels.filter((l) => l.includes(': 0 queries'))).toHaveLength(7 * 24 - 2);
	});

	it('draws a month in 4-hour blocks', () => {
		render(
			<ActivityHeatmap
				data={aggregation({
					...weekData,
					window: { startYmd: '2026-10-16', endYmd: '2026-11-14' },
				})}
				theme={theme}
			/>
		);
		expect(screen.getByTestId('activity-heatmap').getAttribute('data-layout')).toBe('blocks');
		expect(screen.getAllByTestId('activity-heatmap-cell')).toHaveLength(30 * 6);
		// 9 AM and 3 PM land in different blocks: 8 AM - 12 PM and 12 PM - 4 PM.
		const labels = cellLabels();
		expect(labels.some((l) => l.includes('8 AM - 12 PM: 3 queries'))).toBe(true);
		expect(labels.some((l) => l.includes('12 PM - 4 PM: 1 query'))).toBe(true);
	});

	it('draws a year (or longer) as GitHub-style weeks', () => {
		render(<ActivityHeatmap data={yearData} theme={theme} />);
		expect(screen.getByTestId('activity-heatmap').getAttribute('data-layout')).toBe('days');
		expect(screen.getAllByTestId('activity-heatmap-cell')).toHaveLength(365);
	});

	it('offers Tokens only in the day layout', () => {
		const { unmount } = render(<ActivityHeatmap data={weekData} theme={theme} />);
		expect(screen.queryByRole('button', { name: /token usage/i })).toBeNull();
		expect(screen.getByText(/Tokens have no hourly breakdown/)).toBeInTheDocument();
		unmount();

		render(<ActivityHeatmap data={yearData} theme={theme} />);
		expect(screen.getByRole('button', { name: /token usage/i })).toBeInTheDocument();
	});

	it('falls back to queries in an hour layout when Tokens is remembered', () => {
		storage.set(HEATMAP_METRIC_KEY, 'tokens');
		render(<ActivityHeatmap data={weekData} theme={theme} />);
		expect(screen.getByRole('button', { name: /query count/i }).getAttribute('aria-pressed')).toBe(
			'true'
		);
		// The token series is not requested for a layout that cannot show it.
		expect(tokenSeriesState.requested.every((r) => r === false)).toBe(true);
	});

	it('shows real per-day tokens in the day layout', () => {
		storage.set(HEATMAP_METRIC_KEY, 'tokens');
		tokenSeriesState.series = { byDay: { '2026-11-12': 2_500_000 } };
		render(<ActivityHeatmap data={yearData} theme={theme} />);
		expect(cellLabels().some((l) => l.includes('2.5M tokens'))).toBe(true);
	});

	it('remembers the metric choice', () => {
		render(<ActivityHeatmap data={weekData} theme={theme} />);
		fireEvent.click(screen.getByRole('button', { name: /total duration/i }));
		expect(storage.get(HEATMAP_METRIC_KEY)).toBe('duration');
	});

	it('is one tab stop whose arrow keys move the active cell', () => {
		render(<ActivityHeatmap data={weekData} theme={theme} />);
		const grid = screen.getByTestId('activity-heatmap-grid');
		expect(grid.getAttribute('tabindex')).toBe('0');
		for (const cell of screen.getAllByTestId('activity-heatmap-cell')) {
			expect(cell.getAttribute('tabindex')).toBeNull();
		}

		fireEvent.focus(grid);
		const first = grid.getAttribute('aria-activedescendant');
		expect(first).toBeTruthy();

		fireEvent.keyDown(grid, { key: 'ArrowDown' });
		const second = grid.getAttribute('aria-activedescendant');
		expect(second).not.toBe(first);

		fireEvent.keyDown(grid, { key: 'Home' });
		expect(document.getElementById(grid.getAttribute('aria-activedescendant')!)).not.toBeNull();
		expect(screen.getByTestId('activity-heatmap-tooltip')).toBeInTheDocument();
	});

	it('does not let the arrow keys reach the dashboard section handler', () => {
		const onKeyDown = vi.fn();
		render(
			<div onKeyDown={onKeyDown}>
				<ActivityHeatmap data={weekData} theme={theme} />
			</div>
		);
		fireEvent.keyDown(screen.getByTestId('activity-heatmap-grid'), { key: 'ArrowLeft' });
		expect(onKeyDown).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByTestId('activity-heatmap-grid'), { key: 'Tab' });
		expect(onKeyDown).toHaveBeenCalled();
	});

	it('shows the active metric first in the hover tooltip', () => {
		render(<ActivityHeatmap data={weekData} theme={theme} />);
		const busy = screen
			.getAllByTestId('activity-heatmap-cell')
			.find((el) => el.getAttribute('aria-label')?.includes(': 3 queries'))!;
		fireEvent.mouseEnter(busy, { clientX: 50, clientY: 50 });
		const tooltip = screen.getByTestId('activity-heatmap-tooltip');
		expect(tooltip.textContent).toContain('9 AM - 10 AM');
		expect(tooltip.textContent).toContain('3 queries');
	});
});
