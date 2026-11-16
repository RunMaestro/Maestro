import { describe, expect, it } from 'vitest';
import { COLORBLIND_HEATMAP_SCALE } from '../../../../renderer/constants/colorblindPalettes';
import {
	buildBlockGrid,
	buildDayGrid,
	buildHeatmapGrid,
	buildHourGrid,
	calculateIntensity,
	cellValue,
	getIntensityColor,
	headerIndices,
	heatmapLayoutFor,
	heatmapWindow,
	layoutSupportsMetric,
	TIME_BLOCK_LABELS,
} from '../../../../renderer/components/UsageDashboard/activityHeatmapUtils';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES.dracula;

describe('activityHeatmapUtils', () => {
	it('picks the layout from the window length, not the range name', () => {
		expect(heatmapLayoutFor(1)).toBe('hours');
		expect(heatmapLayoutFor(7)).toBe('hours');
		expect(heatmapLayoutFor(8)).toBe('blocks');
		expect(heatmapLayoutFor(90)).toBe('blocks');
		expect(heatmapLayoutFor(365)).toBe('days');
		// All Time with a long history stays the day layout; a short one is drawn by hour.
		expect(heatmapLayoutFor(1200)).toBe('days');
	});

	it('offers tokens only where per-day tokens exist', () => {
		expect(layoutSupportsMetric('days', 'tokens')).toBe(true);
		expect(layoutSupportsMetric('hours', 'tokens')).toBe(false);
		expect(layoutSupportsMetric('blocks', 'tokens')).toBe(false);
		expect(layoutSupportsMetric('blocks', 'duration')).toBe(true);
	});

	it('labels 4-hour blocks with the canonical hour format', () => {
		expect(TIME_BLOCK_LABELS[0]).toBe('12 AM - 4 AM');
		expect(TIME_BLOCK_LABELS[5]).toBe('8 PM - 12 AM');
	});

	it('fills hour cells from real per-hour rows, nothing distributed', () => {
		const grid = buildHourGrid(
			['2026-11-13', '2026-11-14'],
			[
				{ date: '2026-11-13', hour: 14, count: 3, duration: 9_000 },
				{ date: '2026-11-14', hour: 2, count: 1, duration: 500 },
			]
		);
		expect(grid.layout).toBe('hours');
		expect(grid.columns).toHaveLength(2);
		expect(grid.columns[0].cells).toHaveLength(24);
		expect(grid.columns[0].cells[14].count).toBe(3);
		expect(grid.columns[0].cells[13].count).toBe(0);
		expect(grid.columns[1].cells[2].duration).toBe(500);
		// Total queries in the grid equal the input exactly.
		const total = grid.columns.flatMap((c) => c.cells).reduce((sum, c) => sum + c.count, 0);
		expect(total).toBe(4);
		expect(grid.columns[0].cells[14].tokens).toBeNull();
	});

	it('sums each 4-hour block from its own hours', () => {
		const grid = buildBlockGrid(
			['2026-11-14'],
			[
				{ date: '2026-11-14', hour: 9, count: 2, duration: 100 },
				{ date: '2026-11-14', hour: 11, count: 1, duration: 50 },
				{ date: '2026-11-14', hour: 12, count: 5, duration: 10 },
			]
		);
		const cells = grid.columns[0].cells;
		expect(cells).toHaveLength(6);
		expect(cells[2].count).toBe(3); // 8 AM - 12 PM
		expect(cells[2].duration).toBe(150);
		expect(cells[3].count).toBe(5); // 12 PM - 4 PM
		expect(cells[0].count).toBe(0);
	});

	it('lays the day grid out in Sunday-started weeks with placeholders at the ends', () => {
		// 2026-11-11 is a Wednesday, 2026-11-14 a Saturday.
		const grid = buildDayGrid(
			['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'],
			[{ date: '2026-11-12', count: 4, duration: 40 }],
			{ '2026-11-12': 1234 }
		);
		expect(grid.columns).toHaveLength(1);
		const cells = grid.columns[0].cells;
		expect(cells.map((c) => !!c.placeholder)).toEqual([
			true,
			true,
			true,
			false,
			false,
			false,
			false,
		]);
		expect(cells[4].count).toBe(4);
		expect(cells[4].tokens).toBe(1234);
		expect(cells[5].tokens).toBe(0);
	});

	it('leaves tokens unknown in the day grid until the series has loaded', () => {
		const grid = buildDayGrid(['2026-11-14'], [], null);
		expect(grid.columns[0].cells[6].tokens).toBeNull();
	});

	it('spans the whole window, so All Time is not cut to a year', () => {
		const grid = buildHeatmapGrid(
			{ byDay: [], window: { startYmd: '2024-01-01', endYmd: '2026-11-14' } },
			null
		);
		expect(grid.layout).toBe('days');
		expect(grid.dayCount).toBeGreaterThan(1000);
	});

	it('falls back to the byDay span for a payload without a window', () => {
		expect(
			heatmapWindow({
				byDay: [
					{ date: '2026-11-03', count: 1, duration: 1 },
					{ date: '2026-11-01', count: 1, duration: 1 },
				],
			})
		).toEqual({ startYmd: '2026-11-01', endYmd: '2026-11-03' });
	});

	it('reads the metric off a cell', () => {
		const cell = { key: 'k', date: 'd', label: 'l', count: 2, duration: 30, tokens: null };
		expect(cellValue(cell, 'count')).toBe(2);
		expect(cellValue(cell, 'duration')).toBe(30);
		expect(cellValue(cell, 'tokens')).toBe(0);
	});

	it('thins column headers but keeps month starts', () => {
		const columns = Array.from({ length: 30 }, (_, i) => ({
			key: String(i),
			header: String(i + 1),
			monthStart: i === 10,
			title: '',
			cells: [],
		}));
		const shown = headerIndices(columns, 6);
		expect(shown.has(0)).toBe(true);
		expect(shown.has(10)).toBe(true);
		expect(shown.size).toBeLessThanOrEqual(8);
	});

	it('calculates heatmap intensity thresholds', () => {
		expect(calculateIntensity(0, 100)).toBe(0);
		expect(calculateIntensity(10, 100)).toBe(1);
		expect(calculateIntensity(50, 100)).toBe(2);
		expect(calculateIntensity(75, 100)).toBe(3);
		expect(calculateIntensity(76, 100)).toBe(4);
		expect(calculateIntensity(5, 0)).toBe(0);
	});

	it('returns theme, rgb, fallback, and colorblind colors', () => {
		expect(getIntensityColor(0, theme)).toBe(theme.colors.bgActivity);
		expect(getIntensityColor(2, theme)).toBe('rgba(189, 147, 249, 0.4)');
		expect(
			getIntensityColor(3, { ...theme, colors: { ...theme.colors, accent: 'rgb(1, 2, 3)' } })
		).toBe('rgba(1, 2, 3, 0.6)');
		expect(
			getIntensityColor(1, { ...theme, colors: { ...theme.colors, accent: 'var(--accent)' } })
		).toBe('var(--accent)4d');
		expect(getIntensityColor(99, theme, true)).toBe(COLORBLIND_HEATMAP_SCALE[4]);
	});
});
