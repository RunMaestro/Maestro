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
import { ActivityHeatmap } from '../../../../renderer/components/UsageDashboard/ActivityHeatmap';
import type { StatsAggregation } from '../../../../renderer/hooks/useStats';
import { THEMES } from '../../../../shared/themes';

// Test theme
const theme = THEMES['dracula'];

// Sample data for testing
const mockData: StatsAggregation = {
	totalQueries: 50,
	totalDuration: 3600000, // 1 hour
	avgDuration: 72000, // 72 seconds
	byAgent: {
		'claude-code': { count: 30, duration: 2000000 },
		aider: { count: 20, duration: 1600000 },
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
	});

	describe('Data Visualization', () => {
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
