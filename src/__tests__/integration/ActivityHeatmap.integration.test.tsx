/**
 * Tests for ActivityHeatmap component
 *
 * Verifies:
 * - Renders GitHub-style contribution grid
 * - Displays correct day labels (Sun-Sat)
 * - Shows color intensity based on count/duration
 * - Toggle between count and duration modes
 * - Tooltip shows date and values on hover
 * - Handles empty data gracefully
 * - Applies theme colors correctly
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { format, subDays } from 'date-fns';
import { ActivityHeatmap } from '../../renderer/components/UsageDashboard/ActivityHeatmap';
import type { StatsAggregation } from '../../renderer/hooks/stats/useStats';
import { THEMES } from '../../shared/themes';

// Test theme
const theme = THEMES['dracula'];

// Sample data for testing
const mockData: StatsAggregation = {
	totalQueries: 50,
	totalDuration: 3600000, // 1 hour
	avgDuration: 72000, // 72 seconds
	byAgent: {
		'claude-code': { count: 30, duration: 2000000 },
		codex: { count: 20, duration: 1600000 },
	},
	bySource: { user: 35, auto: 15 },
	byDay: [
		{ date: '2024-12-20', count: 5, duration: 300000 },
		{ date: '2024-12-21', count: 10, duration: 600000 },
		{ date: '2024-12-22', count: 3, duration: 180000 },
		{ date: '2024-12-23', count: 8, duration: 480000 },
		{ date: '2024-12-24', count: 12, duration: 720000 },
		{ date: '2024-12-25', count: 0, duration: 0 },
		{ date: '2024-12-26', count: 7, duration: 420000 },
		{ date: '2024-12-27', count: 5, duration: 300000 },
	],
};

// Empty data for edge case testing
const emptyData: StatsAggregation = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byDay: [],
};

function makeDataForDate(date: Date, count = 9, duration = 540_000): StatsAggregation {
	return {
		...emptyData,
		totalQueries: count,
		totalDuration: duration,
		avgDuration: duration,
		byDay: [{ date: format(date, 'yyyy-MM-dd'), count, duration }],
	};
}

function makeTodayData(count = 9, duration = 540_000): StatsAggregation {
	return makeDataForDate(new Date(), count, duration);
}

describe('ActivityHeatmap', () => {
	describe('Rendering', () => {
		it('renders the component with title', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders metric toggle buttons', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Count')).toBeInTheDocument();
			expect(screen.getByText('Duration')).toBeInTheDocument();
		});

		it('renders day labels (Mon, Wed, Fri visible)', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			// Mon, Wed, Fri should be visible (idx % 2 === 1)
			expect(screen.getByText('Mon')).toBeInTheDocument();
			expect(screen.getByText('Wed')).toBeInTheDocument();
			expect(screen.getByText('Fri')).toBeInTheDocument();
		});

		it('renders intensity legend', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Less')).toBeInTheDocument();
			expect(screen.getByText('More')).toBeInTheDocument();
		});

		it('renders with empty data without crashing', () => {
			render(<ActivityHeatmap data={emptyData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});
	});

	describe('Metric Mode Toggle', () => {
		it('defaults to count mode', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			const countButton = screen.getByText('Count');
			// Count button should have accent background when active
			expect(countButton).toHaveStyle({
				backgroundColor: expect.stringContaining('20'),
			});
		});

		it('switches to duration mode when clicked', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			const durationButton = screen.getByText('Duration');
			fireEvent.click(durationButton);

			// Duration button should now be active
			expect(durationButton).toHaveStyle({
				color: theme.colors.accent,
			});

			const countButton = screen.getByText('Count');
			fireEvent.click(countButton);
			expect(countButton).toHaveAttribute('aria-pressed', 'true');
		});
	});

	describe('Time Range Handling', () => {
		it('renders for day time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="day" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders for week time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders for month time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="month" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders for year time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="year" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders for all time range', () => {
			render(<ActivityHeatmap data={mockData} timeRange="all" theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('renders quarter range with 4-hour block cells and block labels', () => {
			const today = new Date();
			render(<ActivityHeatmap data={makeDataForDate(today)} timeRange="quarter" theme={theme} />);

			expect(screen.getByText('12a-4a')).toBeInTheDocument();
			expect(screen.getByText('8a-12p')).toBeInTheDocument();
			expect(
				screen.getByRole('gridcell', {
					name: new RegExp(`${format(today, 'MMM d')} 8a-12p: 2 queries`),
				})
			).toBeInTheDocument();
		});

		it('uses duration intensity mode for quarter block cells', () => {
			const today = new Date();
			render(
				<ActivityHeatmap
					data={makeDataForDate(today, 9, 540_000)}
					timeRange="quarter"
					theme={theme}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Show total duration' }));

			expect(screen.getByRole('button', { name: 'Show total duration' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			expect(
				screen.getByRole('gridcell', {
					name: new RegExp(`${format(today, 'MMM d')} 8a-12p: 2 queries, 2m 0s`),
				})
			).toBeInTheDocument();
		});

		it('uses duration intensity mode for year cells', () => {
			const today = new Date();
			render(
				<ActivityHeatmap
					data={makeDataForDate(today, 2, 3_600_000)}
					timeRange="year"
					theme={theme}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Show total duration' }));

			expect(screen.getByRole('button', { name: 'Show total duration' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			expect(
				screen.getByRole('gridcell', {
					name: new RegExp(`${format(today, 'MMM d, yyyy')}: 2 queries, 1h 0m`),
				})
			).toBeInTheDocument();
		});

		it('falls back to week layout for unknown time ranges', () => {
			render(<ActivityHeatmap data={mockData} timeRange={'unexpected' as any} theme={theme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
			expect(screen.getByText('12a')).toBeInTheDocument();
			expect(screen.getByText('10p')).toBeInTheDocument();
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveStyle({
				backgroundColor: theme.colors.bgMain,
			});
		});

		it('applies theme text colors', () => {
			render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);

			const title = screen.getByText('Activity Heatmap');
			expect(title).toHaveStyle({
				color: theme.colors.textMain,
			});
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];

			render(<ActivityHeatmap data={mockData} timeRange="week" theme={lightTheme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});

		it('uses the colorblind-safe palette when enabled', () => {
			const { container } = render(
				<ActivityHeatmap data={makeTodayData()} timeRange="week" theme={theme} colorBlindMode />
			);

			expect(screen.getByLabelText('Intensity level 4: High activity')).toHaveStyle({
				backgroundColor: '#253494',
			});
		});

		it('parses rgb accent colors for intensity backgrounds', () => {
			const rgbTheme = {
				...theme,
				colors: {
					...theme.colors,
					accent: 'rgb(10, 20, 30)',
				},
			};
			const { container } = render(
				<ActivityHeatmap data={makeTodayData()} timeRange="week" theme={rgbTheme} />
			);

			const cells = Array.from(
				container.querySelectorAll<HTMLElement>('.rounded-sm.cursor-default')
			);
			expect(cells.some((cell) => cell.style.backgroundColor.includes('10, 20, 30'))).toBe(true);
		});

		it('falls back to opacity suffixes when accent color cannot be parsed', () => {
			const fallbackTheme = {
				...theme,
				colors: {
					...theme.colors,
					accent: 'var(--accent)',
				},
			};

			render(<ActivityHeatmap data={makeTodayData()} timeRange="week" theme={fallbackTheme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
			expect(screen.getAllByRole('listitem')).toHaveLength(5);
		});

		it('falls back when an rgb accent has no numeric channels', () => {
			const fallbackTheme = {
				...theme,
				colors: {
					...theme.colors,
					accent: 'rgb(not-a-color)',
				},
			};

			render(<ActivityHeatmap data={makeTodayData()} timeRange="week" theme={fallbackTheme} />);

			expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
			expect(screen.getAllByRole('listitem')).toHaveLength(5);
		});
	});

	describe('Tooltip Functionality', () => {
		it('shows tooltip on cell hover', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			// Find a heatmap cell (the colored divs in the grid)
			const cells = container.querySelectorAll('.rounded-sm.cursor-default');

			if (cells.length > 0) {
				fireEvent.mouseEnter(cells[0]);

				// Tooltip should appear with date and query count
				// Note: Tooltip content depends on the specific day data
				// We just verify a tooltip-like element appears (uses z-[99999] for high stacking)
				const tooltip = container.querySelector('.fixed.z-\\[99999\\]');
				expect(tooltip).toBeInTheDocument();
			}
		});

		it('hides tooltip on mouse leave', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const cells = container.querySelectorAll('.rounded-sm.cursor-default');

			if (cells.length > 0) {
				fireEvent.mouseEnter(cells[0]);
				fireEvent.mouseLeave(cells[0]);

				const tooltip = container.querySelector('.fixed.z-\\[99999\\]');
				expect(tooltip).not.toBeInTheDocument();
			}
		});

		it('ignores placeholder day cells and shows tooltip for real year cells', () => {
			const today = new Date();
			const { container } = render(
				<ActivityHeatmap data={makeDataForDate(today, 1, 4_000)} timeRange="year" theme={theme} />
			);
			const cells = screen.getAllByRole('gridcell');
			const placeholderCell = cells.find((cell) => cell.getAttribute('aria-label') === '');
			const realCell = screen.getByRole('gridcell', {
				name: new RegExp(`${format(today, 'MMM d, yyyy')}: 1 query, 4s`),
			});

			expect(placeholderCell).toBeInstanceOf(HTMLElement);
			fireEvent.mouseEnter(placeholderCell as HTMLElement);
			expect(container.querySelector('.fixed.z-\\[99999\\]')).not.toBeInTheDocument();

			fireEvent.mouseEnter(realCell);
			expect(container.querySelector('.fixed.z-\\[99999\\]')).toBeInTheDocument();
			expect(screen.getByText('1 query')).toBeInTheDocument();
		});

		it('shows block tooltip and outline for hovered quarter cells', () => {
			const today = new Date();
			const { container } = render(
				<ActivityHeatmap
					data={makeDataForDate(today, 9, 540_000)}
					timeRange="quarter"
					theme={theme}
				/>
			);
			const blockCell = screen.getByRole('gridcell', {
				name: new RegExp(`${format(today, 'MMM d')} 8a-12p: 2 queries`),
			});

			fireEvent.mouseEnter(blockCell);

			expect(container.querySelector('.fixed.z-\\[99999\\]')).toBeInTheDocument();
			expect(screen.getByText('8a-12p')).toBeInTheDocument();
			expect(blockCell).toHaveStyle({ outline: `2px solid ${theme.colors.accent}` });
		});

		it('keeps tooltip inside the viewport near right and bottom edges', () => {
			const today = new Date();
			const { container } = render(
				<ActivityHeatmap data={makeDataForDate(today, 9, 540_000)} timeRange="week" theme={theme} />
			);
			const cell = screen.getByRole('gridcell', {
				name: new RegExp(`${format(today, 'MMM d')} 9:00`),
			});
			const rect = {
				left: 1000,
				right: 1014,
				top: 740,
				bottom: 754,
				width: 14,
				height: 14,
				x: 1000,
				y: 740,
				toJSON: () => ({}),
			} as DOMRect;
			vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(rect);

			fireEvent.mouseEnter(cell);

			const tooltip = container.querySelector<HTMLElement>('.fixed.z-\\[99999\\]');
			expect(tooltip).toBeInTheDocument();
			expect(Number.parseFloat(tooltip!.style.left)).toBeLessThan(rect.left);
			expect(Number.parseFloat(tooltip!.style.top)).toBeLessThan(rect.top);
		});

		it('centers tooltip below cells away from viewport edges', () => {
			const today = new Date();
			const { container } = render(
				<ActivityHeatmap data={makeDataForDate(today, 9, 540_000)} timeRange="week" theme={theme} />
			);
			const cell = screen.getByRole('gridcell', {
				name: new RegExp(`${format(today, 'MMM d')} 9:00`),
			});
			const rect = {
				left: 300,
				right: 314,
				top: 120,
				bottom: 134,
				width: 14,
				height: 14,
				x: 300,
				y: 120,
				toJSON: () => ({}),
			} as DOMRect;
			vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(rect);

			fireEvent.mouseEnter(cell);

			const tooltip = container.querySelector<HTMLElement>('.fixed.z-\\[99999\\]');
			expect(tooltip).toBeInTheDocument();
			expect(Number.parseFloat(tooltip!.style.left)).toBeCloseTo(197, 0);
			expect(Number.parseFloat(tooltip!.style.top)).toBe(rect.bottom + 4);
		});
	});

	describe('Data Visualization', () => {
		it('fills a partial final week in year layout with placeholder cells', () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
			try {
				render(<ActivityHeatmap data={makeTodayData()} timeRange="year" theme={theme} />);

				const placeholderCells = screen
					.getAllByRole('gridcell')
					.filter((cell) => cell.getAttribute('aria-label') === '');
				expect(placeholderCells.length).toBeGreaterThan(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it('formats year cells with hour-scale durations', () => {
			const today = new Date();
			render(
				<ActivityHeatmap
					data={makeDataForDate(today, 2, 3_600_000)}
					timeRange="year"
					theme={theme}
				/>
			);

			expect(
				screen.getByRole('gridcell', {
					name: new RegExp(`${format(today, 'MMM d, yyyy')}: 2 queries, 1h 0m`),
				})
			).toBeInTheDocument();
		});

		it('maps year cells across low and medium intensity levels', () => {
			const today = new Date();
			const intensityData: StatsAggregation = {
				...emptyData,
				totalQueries: 10,
				byDay: [
					{ date: format(subDays(today, 3), 'yyyy-MM-dd'), count: 1, duration: 1_000 },
					{ date: format(subDays(today, 2), 'yyyy-MM-dd'), count: 2, duration: 2_000 },
					{ date: format(subDays(today, 1), 'yyyy-MM-dd'), count: 3, duration: 3_000 },
					{ date: format(today, 'yyyy-MM-dd'), count: 4, duration: 4_000 },
				],
			};

			render(<ActivityHeatmap data={intensityData} timeRange="year" theme={theme} />);

			const low = screen.getByRole('gridcell', {
				name: new RegExp(`${format(subDays(today, 3), 'MMM d, yyyy')}: 1 query`),
			});
			const mediumLow = screen.getByRole('gridcell', {
				name: new RegExp(`${format(subDays(today, 2), 'MMM d, yyyy')}: 2 queries`),
			});
			const mediumHigh = screen.getByRole('gridcell', {
				name: new RegExp(`${format(subDays(today, 1), 'MMM d, yyyy')}: 3 queries`),
			});
			const high = screen.getByRole('gridcell', {
				name: new RegExp(`${format(today, 'MMM d, yyyy')}: 4 queries`),
			});

			expect((low as HTMLElement).style.backgroundColor).toContain('0.2');
			expect((mediumLow as HTMLElement).style.backgroundColor).toContain('0.4');
			expect((mediumHigh as HTMLElement).style.backgroundColor).toContain('0.6');
			expect((high as HTMLElement).style.backgroundColor).toContain('0.9');
		});

		it('creates heatmap cells based on data', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			// Should have some cells rendered
			const cells = container.querySelectorAll('.rounded-sm.cursor-default');
			expect(cells.length).toBeGreaterThan(0);
		});

		it('applies different intensities based on values', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			// Get all cells and check they have background colors
			const cells = container.querySelectorAll('.rounded-sm.cursor-default');

			if (cells.length > 0) {
				// At least one cell should have a background style
				const hasBackgroundStyles = Array.from(cells).some(
					(cell) => (cell as HTMLElement).style.backgroundColor !== ''
				);
				expect(hasBackgroundStyles).toBe(true);
			}
		});
	});

	describe('Smooth Animations', () => {
		it('applies CSS transitions to cells for smooth color changes', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const cells = container.querySelectorAll('.rounded-sm.cursor-default');
			expect(cells.length).toBeGreaterThan(0);

			const firstCell = cells[0] as HTMLElement;
			expect(firstCell.style.transition).toContain('background-color');
			expect(firstCell.style.transition).toContain('0.3s');
		});

		it('uses ease timing function for smooth animation curves', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const cells = container.querySelectorAll('.rounded-sm.cursor-default');
			expect(cells.length).toBeGreaterThan(0);

			const firstCell = cells[0] as HTMLElement;
			expect(firstCell.style.transition).toContain('ease');
		});

		it('applies outline transition for hover effects', () => {
			const { container } = render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
			);

			const cells = container.querySelectorAll('.rounded-sm.cursor-default');
			expect(cells.length).toBeGreaterThan(0);

			const firstCell = cells[0] as HTMLElement;
			expect(firstCell.style.transition).toContain('outline');
		});
	});
});
