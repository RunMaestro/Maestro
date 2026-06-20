/**
 * Tests for DurationTrendsChart component
 *
 * Verifies:
 * - Renders line chart correctly
 * - X-axis shows time labels (grouped by day/week)
 * - Y-axis shows duration labels
 * - Smoothing toggle works correctly
 * - Tooltip shows exact values on hover
 * - Handles empty data gracefully
 * - Applies theme colors correctly
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { DurationTrendsChart } from '../../renderer/components/UsageDashboard/DurationTrendsChart';
import { COLORBLIND_LINE_COLORS } from '../../renderer/constants/colorblindPalettes';
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
		{ date: '2024-12-20', count: 5, duration: 300000 }, // avg: 60s
		{ date: '2024-12-21', count: 10, duration: 600000 }, // avg: 60s
		{ date: '2024-12-22', count: 3, duration: 180000 }, // avg: 60s
		{ date: '2024-12-23', count: 8, duration: 480000 }, // avg: 60s
		{ date: '2024-12-24', count: 12, duration: 960000 }, // avg: 80s
		{ date: '2024-12-25', count: 4, duration: 120000 }, // avg: 30s
		{ date: '2024-12-26', count: 7, duration: 420000 }, // avg: 60s
		{ date: '2024-12-27', count: 5, duration: 300000 }, // avg: 60s
	],
};

// Data with varying durations to test intensity
const varyingData: StatsAggregation = {
	totalQueries: 100,
	totalDuration: 7200000,
	avgDuration: 72000,
	byAgent: {
		'claude-code': { count: 100, duration: 7200000 },
	},
	bySource: { user: 80, auto: 20 },
	byDay: [
		{ date: '2024-12-20', count: 10, duration: 300000 }, // 30s avg
		{ date: '2024-12-21', count: 10, duration: 600000 }, // 60s avg
		{ date: '2024-12-22', count: 10, duration: 1200000 }, // 120s avg
		{ date: '2024-12-23', count: 10, duration: 1800000 }, // 180s avg
		{ date: '2024-12-24', count: 10, duration: 600000 }, // 60s avg
		{ date: '2024-12-25', count: 10, duration: 900000 }, // 90s avg
		{ date: '2024-12-26', count: 10, duration: 300000 }, // 30s avg
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

// Data with zero counts (should handle division by zero)
const zeroCountData: StatsAggregation = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byDay: [
		{ date: '2024-12-20', count: 0, duration: 0 },
		{ date: '2024-12-21', count: 0, duration: 0 },
		{ date: '2024-12-22', count: 0, duration: 0 },
	],
};

// Single data point
const singlePointData: StatsAggregation = {
	totalQueries: 5,
	totalDuration: 300000,
	avgDuration: 60000,
	byAgent: {
		'claude-code': { count: 5, duration: 300000 },
	},
	bySource: { user: 5, auto: 0 },
	byDay: [{ date: '2024-12-27', count: 5, duration: 300000 }],
};

const longRangeData: StatsAggregation = {
	totalQueries: 21,
	totalDuration: 1260000,
	avgDuration: 60000,
	byAgent: {
		'claude-code': { count: 21, duration: 1260000 },
	},
	bySource: { user: 21, auto: 0 },
	byDay: Array.from({ length: 21 }, (_, index) => ({
		date: `2024-01-${String(index + 1).padStart(2, '0')}`,
		count: 1,
		duration: 60000,
	})),
};

const highDurationData: StatsAggregation = {
	totalQueries: 1,
	totalDuration: 7200000,
	avgDuration: 7200000,
	byAgent: {
		'claude-code': { count: 1, duration: 7200000 },
	},
	bySource: { user: 1, auto: 0 },
	byDay: [{ date: '2024-12-27', count: 1, duration: 7200000 }],
};

describe('DurationTrendsChart', () => {
	describe('Rendering', () => {
		it('renders the component with title', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders smoothing toggle', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Smoothing:')).toBeInTheDocument();
		});

		it('renders SVG chart element', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('renders data points as circles', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBe(mockData.byDay.length);
		});

		it('renders line path', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const paths = container.querySelectorAll('path');
			// Should have area path and line path
			expect(paths.length).toBeGreaterThanOrEqual(2);
		});

		it('renders Y-axis label', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Duration')).toBeInTheDocument();
		});

		it('renders legend', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Avg Duration')).toBeInTheDocument();
		});
	});

	describe('Empty State', () => {
		it('renders empty state message when no data', () => {
			render(<DurationTrendsChart data={emptyData} timeRange="week" theme={theme} />);

			expect(screen.getByText('No duration data available')).toBeInTheDocument();
		});

		it('does not render SVG when no data', () => {
			const { container } = render(
				<DurationTrendsChart data={emptyData} timeRange="week" theme={theme} />
			);

			const svg = container.querySelector('svg');
			expect(svg).not.toBeInTheDocument();
		});
	});

	describe('Smoothing Toggle', () => {
		it('defaults to smoothing off', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			// Legend should show "Avg Duration" not "Moving Average"
			expect(screen.getByText('Avg Duration')).toBeInTheDocument();
			expect(screen.queryByText('Moving Average')).not.toBeInTheDocument();
		});

		it('toggles smoothing on when clicked', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const toggleButton = screen.getByRole('button', { name: /smoothing/i });
			fireEvent.click(toggleButton);

			// Legend should now show "Moving Average"
			expect(screen.getByText('Moving Average')).toBeInTheDocument();
		});

		it('shows window size when smoothing is on', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const toggleButton = screen.getByRole('button', { name: /smoothing/i });
			fireEvent.click(toggleButton);

			expect(screen.getByText(/Window: \d+ periods/)).toBeInTheDocument();
		});

		it('toggles smoothing off when clicked again', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const toggleButton = screen.getByRole('button', { name: /smoothing/i });

			// Turn on
			fireEvent.click(toggleButton);
			expect(screen.getByText('Moving Average')).toBeInTheDocument();

			// Turn off
			fireEvent.click(toggleButton);
			expect(screen.getByText('Avg Duration')).toBeInTheDocument();
		});
	});

	describe('Time Range Handling', () => {
		it('renders for day time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="day" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders for week time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders for month time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="month" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders for year time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="year" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('renders for all time range', () => {
			render(<DurationTrendsChart data={mockData} timeRange="all" theme={theme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('uses the quarter smoothing window and quarter date labels', () => {
			render(<DurationTrendsChart data={mockData} timeRange="quarter" theme={theme} />);

			fireEvent.click(screen.getByRole('button', { name: /enable smoothing/i }));

			expect(screen.getByText('Window: 7 periods')).toBeInTheDocument();
			expect(screen.getByText('Dec 20')).toBeInTheDocument();
		});

		it('falls back to month-day labels and a five-period window for unknown ranges', () => {
			render(<DurationTrendsChart data={mockData} timeRange={'custom' as never} theme={theme} />);

			fireEvent.click(screen.getByRole('button', { name: /enable smoothing/i }));

			expect(screen.getByText('Window: 5 periods')).toBeInTheDocument();
			expect(screen.getByText('Dec 20')).toBeInTheDocument();
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveStyle({
				backgroundColor: theme.colors.bgMain,
			});
		});

		it('applies theme text colors', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const title = screen.getByText('Duration Trends');
			expect(title).toHaveStyle({
				color: theme.colors.textMain,
			});
		});

		it('uses theme accent color for line', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			// Find the main line path (has stroke and no fill)
			const paths = container.querySelectorAll('path');
			const linePath = Array.from(paths).find(
				(p) => p.getAttribute('fill') === 'none' && p.getAttribute('stroke')
			);

			expect(linePath).toHaveAttribute('stroke', theme.colors.accent);
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];

			render(<DurationTrendsChart data={mockData} timeRange="week" theme={lightTheme} />);

			expect(screen.getByText('Duration Trends')).toBeInTheDocument();
		});

		it('applies border color to toggle button', () => {
			render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);

			const toggleButton = screen.getByRole('button', { name: /smoothing/i });
			expect(toggleButton).toHaveStyle({
				backgroundColor: expect.stringMatching(/^(rgb|#)/),
			});
		});

		it('uses the colorblind-safe line color when enabled', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} colorBlindMode />
			);
			const linePath = Array.from(container.querySelectorAll('path')).find(
				(path) => path.getAttribute('fill') === 'none' && path.getAttribute('stroke')
			);

			expect(linePath).toHaveAttribute('stroke', COLORBLIND_LINE_COLORS.primary);
		});

		it('parses rgb accent colors for the chart gradient', () => {
			const rgbTheme = {
				...theme,
				colors: { ...theme.colors, accent: 'rgb(10, 20, 30)' },
			};
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={rgbTheme} />
			);

			expect(container.querySelector('stop')).toHaveAttribute(
				'stop-color',
				'rgba(10, 20, 30, 0.3)'
			);
		});

		it('falls back to the default gradient color for unparseable accent values', () => {
			const fallbackTheme = {
				...theme,
				colors: { ...theme.colors, accent: 'var(--accent)' },
			};
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={fallbackTheme} />
			);

			expect(container.querySelector('stop')).toHaveAttribute(
				'stop-color',
				'rgba(100, 149, 237, 0.3)'
			);
		});

		it('falls back to the default gradient color for incomplete rgb accent values', () => {
			const fallbackTheme = {
				...theme,
				colors: { ...theme.colors, accent: 'rgb(10)' },
			};
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={fallbackTheme} />
			);

			expect(container.querySelector('stop')).toHaveAttribute(
				'stop-color',
				'rgba(100, 149, 237, 0.3)'
			);
		});
	});

	describe('Tooltip Functionality', () => {
		it('shows tooltip on data point hover', async () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				fireEvent.mouseEnter(circles[0]);

				expect(await screen.findByText('Friday, Dec 20, 2024')).toBeInTheDocument();
			}
		});

		it('hides tooltip on mouse leave', async () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				fireEvent.mouseEnter(circles[0]);
				expect(await screen.findByText('Friday, Dec 20, 2024')).toBeInTheDocument();
				fireEvent.mouseLeave(circles[0]);

				await waitFor(() => {
					expect(screen.queryByText('Friday, Dec 20, 2024')).not.toBeInTheDocument();
				});
			}
		});

		it('tooltip shows query count', async () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				fireEvent.mouseEnter(circles[0]);

				expect(await screen.findByText('Queries:')).toBeInTheDocument();
			}
		});

		it('tooltip shows avg duration label', async () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				fireEvent.mouseEnter(circles[0]);

				expect(await screen.findByText('Avg Duration:')).toBeInTheDocument();
			}
		});

		it('shows raw duration when hovering a smoothed point whose raw value changed', async () => {
			const { container } = render(
				<DurationTrendsChart data={varyingData} timeRange="week" theme={theme} />
			);
			const firstPoint = container.querySelector('circle');

			fireEvent.click(screen.getByRole('button', { name: /enable smoothing/i }));
			expect(firstPoint).toBeInTheDocument();
			fireEvent.mouseEnter(firstPoint as SVGCircleElement);

			expect(await screen.findByText('Raw:')).toBeInTheDocument();
		});
	});

	describe('Edge Cases', () => {
		it('handles single data point', () => {
			const { container } = render(
				<DurationTrendsChart data={singlePointData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBe(1);
		});

		it('handles zero count days gracefully', () => {
			const { container } = render(
				<DurationTrendsChart data={zeroCountData} timeRange="week" theme={theme} />
			);

			// Should render without errors
			expect(screen.getByText('Duration Trends')).toBeInTheDocument();

			// Should have 3 data points even with zero counts
			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBe(3);
		});

		it('handles varying duration data', () => {
			const { container } = render(
				<DurationTrendsChart data={varyingData} timeRange="week" theme={theme} />
			);

			// Should render all data points
			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBe(varyingData.byDay.length);
		});

		it('formats hour-scale durations and singular query labels', () => {
			const { container } = render(
				<DurationTrendsChart data={highDurationData} timeRange="week" theme={theme} />
			);

			expect(screen.getByLabelText(/Average duration 2h 0m, 1 query/)).toBeInTheDocument();
			expect(
				Array.from(container.querySelectorAll('text')).some((el) => el.textContent === '2h')
			).toBe(true);
		});
	});

	describe('Grid and Axes', () => {
		it('renders horizontal grid lines', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const gridLines = container.querySelectorAll('line');
			expect(gridLines.length).toBeGreaterThan(0);
		});

		it('renders Y-axis tick labels', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			// Y-axis should have duration labels (0s, etc.)
			const textElements = container.querySelectorAll('text');
			const hasYLabel = Array.from(textElements).some((el) =>
				el.textContent?.match(/^\d+(s|m|h)$/)
			);
			expect(hasYLabel).toBe(true);
		});

		it('renders X-axis date labels', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			// Should have date labels (day abbreviations for week view)
			const textElements = container.querySelectorAll('text');
			const hasDateLabels = Array.from(textElements).some((el) =>
				el.textContent?.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)
			);
			expect(hasDateLabels).toBe(true);
		});

		it('reduces X-axis labels for long date ranges while preserving the final label', () => {
			const { container } = render(
				<DurationTrendsChart data={longRangeData} timeRange="month" theme={theme} />
			);
			const dateLabels = Array.from(container.querySelectorAll('text'))
				.map((el) => el.textContent)
				.filter((text): text is string => /^Jan \d+$/.test(text ?? ''));

			expect(dateLabels.length).toBeLessThan(longRangeData.byDay.length);
			expect(dateLabels).toContain('Jan 21');
		});
	});

	describe('Area Fill', () => {
		it('renders gradient-filled area under line', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			// Should have a linearGradient defined
			const gradient = container.querySelector('linearGradient');
			expect(gradient).toBeInTheDocument();

			// Should have a path using the gradient
			const paths = container.querySelectorAll('path');
			const areaPath = Array.from(paths).find((p) =>
				p.getAttribute('fill')?.includes('url(#duration-gradient')
			);
			expect(areaPath).toBeInTheDocument();
		});
	});

	describe('Data Point Interaction', () => {
		it('enlarges data point on hover', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');

			if (circles.length > 0) {
				const initialRadius = circles[0].getAttribute('r');
				fireEvent.mouseEnter(circles[0]);
				const hoveredRadius = circles[0].getAttribute('r');

				expect(parseInt(hoveredRadius || '0')).toBeGreaterThan(parseInt(initialRadius || '0'));
			}
		});
	});

	describe('Smooth Animations', () => {
		it('applies CSS transitions to line path for smooth updates', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const paths = container.querySelectorAll('path');
			// Find the main line path (has stroke but no fill)
			const linePath = Array.from(paths).find(
				(p) => p.getAttribute('stroke') && p.getAttribute('fill') === 'none'
			);

			expect(linePath).toBeInTheDocument();
			const style = (linePath as HTMLElement).style;
			expect(style.transition).toContain('d');
			expect(style.transition).toContain('0.5s');
		});

		it('applies CSS transitions to area path for smooth updates', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const paths = container.querySelectorAll('path');
			// Find the area path (has gradient fill)
			const areaPath = Array.from(paths).find((p) =>
				p.getAttribute('fill')?.includes('url(#duration-gradient')
			);

			expect(areaPath).toBeInTheDocument();
			const style = (areaPath as HTMLElement).style;
			expect(style.transition).toContain('d');
			expect(style.transition).toContain('0.5s');
		});

		it('applies CSS transitions to data points for smooth position updates', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBeGreaterThan(0);

			const style = (circles[0] as unknown as HTMLElement).style;
			expect(style.transition).toContain('cx');
			expect(style.transition).toContain('cy');
			expect(style.transition).toContain('0.5s');
		});

		it('uses cubic-bezier easing for smooth animation curves', () => {
			const { container } = render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />
			);

			const paths = container.querySelectorAll('path');
			const linePath = Array.from(paths).find(
				(p) => p.getAttribute('stroke') && p.getAttribute('fill') === 'none'
			);

			const style = (linePath as HTMLElement).style;
			expect(style.transition).toContain('cubic-bezier');
		});
	});
});
