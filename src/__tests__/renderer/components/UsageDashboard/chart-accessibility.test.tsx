/**
 * Chart Accessibility Tests
 *
 * Tests verifying ARIA labels, roles, and accessibility features
 * across all Usage Dashboard chart components.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { AgentComparisonChart } from '../../../../renderer/components/UsageDashboard/AgentComparisonChart';
import { SourceDistributionChart } from '../../../../renderer/components/UsageDashboard/SourceDistributionChart';
import { ActivityHeatmap } from '../../../../renderer/components/UsageDashboard/ActivityHeatmap';
import { DurationTrendsChart } from '../../../../renderer/components/UsageDashboard/DurationTrendsChart';
import { SummaryCards } from '../../../../renderer/components/UsageDashboard/SummaryCards';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';

import { mockTheme } from '../../../helpers/mockTheme';
// Mock theme for testing

// Mock data for testing
const mockStatsData = {
	totalQueries: 150,
	totalDuration: 7200000, // 2 hours
	avgDuration: 48000, // 48 seconds
	byAgent: {
		'claude-code': { count: 100, duration: 5000000 },
		opencode: { count: 30, duration: 1500000 },
		'gemini-cli': { count: 20, duration: 700000 },
	},
	bySource: {
		user: 120,
		auto: 30,
	},
	byLocation: { local: 120, remote: 30 },
	byDay: [
		{ date: '2025-01-20', count: 50, duration: 2400000 },
		{ date: '2025-01-21', count: 45, duration: 2160000 },
		{ date: '2025-01-22', count: 55, duration: 2640000 },
	],
	byHour: [
		{ hour: 9, count: 50, duration: 2400000 },
		{ hour: 14, count: 100, duration: 4800000 },
	],
	byDayHour: [],
	window: { startYmd: '2025-01-20', endYmd: '2025-01-22' },
	earliestQueryAt: null,
	streak: { current: 3, longest: 3 },
	totalSessions: 25,
	byAgentByDay: {},
	bySessionByDay: {},
	bySessionSource: {},
	byAgentWorktree: {},
} as unknown as StatsAggregation;

describe('Chart Accessibility - AgentComparisonChart', () => {
	it('has role="figure" on the container', () => {
		render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
		const figure = screen.getByRole('figure');
		expect(figure).toBeInTheDocument();
	});

	it('has descriptive aria-label on the container', () => {
		render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
		const figure = screen.getByRole('figure');
		expect(figure.getAttribute('aria-label')).toContain('Provider comparison chart');
		expect(figure.getAttribute('aria-label')).toContain('3 rows displayed');
	});

	it('has role="list" on the data container', () => {
		render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
		const list = screen.getByRole('list', { name: /provider usage data/i });
		expect(list).toBeInTheDocument();
	});

	it('labels each provider row with all three measures', () => {
		render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
		const list = screen.getByRole('list', { name: /provider usage data/i });
		const rows = within(list).getAllByRole('listitem');
		expect(rows).toHaveLength(3);
		rows.forEach((row) => {
			const label = row.getAttribute('aria-label') || '';
			expect(label).toMatch(/quer(y|ies)/);
			expect(label).toContain('total');
			expect(label).toContain('average');
		});
	});

	it('has aria-pressed on the metric toggle buttons', () => {
		render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
		expect(screen.getByRole('button', { name: /show query count/i })).toHaveAttribute(
			'aria-pressed'
		);
		expect(screen.getByRole('button', { name: /show average time per query/i })).toHaveAttribute(
			'aria-pressed'
		);
	});
});

describe('Chart Accessibility - SourceDistributionChart', () => {
	it('has role="figure" on the container', () => {
		render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
		const figure = screen.getByRole('figure');
		expect(figure).toBeInTheDocument();
	});

	it('has descriptive aria-label naming the query source', () => {
		render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
		const figure = screen.getByRole('figure');
		expect(figure.getAttribute('aria-label')).toContain('Query source chart');
	});

	it('has aria-pressed on toggle buttons', () => {
		render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
		const countButton = screen.getByRole('button', { name: /show query count/i });
		const tokensButton = screen.getByRole('button', { name: /show token usage/i });

		expect(countButton).toHaveAttribute('aria-pressed');
		expect(tokensButton).toHaveAttribute('aria-pressed');
	});

	it('has role="img" on the SVG donut chart', () => {
		render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
		const svgChart = screen.getByRole('img');
		expect(svgChart.getAttribute('aria-label')).toContain('Query source');
	});

	it('has legend with role="list" and listitem roles', () => {
		render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
		const legend = screen.getByRole('list', { name: /chart legend/i });
		expect(legend).toBeInTheDocument();

		const legendItems = within(legend).getAllByRole('listitem');
		expect(legendItems.length).toBeGreaterThanOrEqual(1);
	});

	it('legend items have descriptive aria-labels', () => {
		render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
		const legend = screen.getByRole('list', { name: /chart legend/i });
		const legendItems = within(legend).getAllByRole('listitem');

		legendItems.forEach((item) => {
			expect(item).toHaveAttribute('aria-label');
			const label = item.getAttribute('aria-label') || '';
			expect(label).toMatch(/\d+\.\d+%/); // Contains percentage
		});
	});
});

describe('Chart Accessibility - ActivityHeatmap', () => {
	it('has a figure with a descriptive aria-label', () => {
		render(<ActivityHeatmap data={mockStatsData} theme={mockTheme} />);
		const figure = screen.getByRole('figure');
		expect(figure.getAttribute('aria-label')).toContain('Activity heatmap');
		expect(figure.getAttribute('aria-label')).toContain('days');
	});

	it('has aria-pressed on toggle buttons', () => {
		render(<ActivityHeatmap data={mockStatsData} theme={mockTheme} />);
		expect(screen.getByRole('button', { name: /show query count/i })).toHaveAttribute(
			'aria-pressed'
		);
		expect(screen.getByRole('button', { name: /show total duration/i })).toHaveAttribute(
			'aria-pressed'
		);
	});

	it('cells carry descriptive aria-labels with real counts', () => {
		render(<ActivityHeatmap data={mockStatsData} theme={mockTheme} />);
		const cells = screen.getAllByTestId('activity-heatmap-cell');
		expect(cells.length).toBeGreaterThan(0);
		cells.forEach((cell) => {
			expect(cell.getAttribute('aria-label') || '').toMatch(/\d+ quer(y|ies)/);
		});
	});

	it('is one tab stop (roving), not one per cell', () => {
		render(<ActivityHeatmap data={mockStatsData} theme={mockTheme} />);
		expect(screen.getByTestId('activity-heatmap-grid')).toHaveAttribute('tabIndex', '0');
		screen.getAllByTestId('activity-heatmap-cell').forEach((cell) => {
			expect(cell).not.toHaveAttribute('tabIndex');
		});
	});

	it('legend has role="list" with five described levels', () => {
		render(<ActivityHeatmap data={mockStatsData} theme={mockTheme} />);
		const legend = screen.getByRole('list', { name: /intensity scale/i });
		const legendItems = within(legend).getAllByRole('listitem');
		expect(legendItems).toHaveLength(5);
		const labels = legendItems.map((item) => item.getAttribute('aria-label') || '');
		expect(labels.some((l) => l.includes('No activity'))).toBe(true);
		expect(labels.some((l) => l.includes('High'))).toBe(true);
	});
});
describe('Chart Accessibility - DurationTrendsChart', () => {
	it('has a figure whose aria-label names what is plotted', () => {
		render(<DurationTrendsChart data={mockStatsData} theme={mockTheme} />);
		const figure = screen.getByRole('figure');
		expect(figure.getAttribute('aria-label')).toContain('Mean query duration');
	});

	it('draws the line chart as one labeled image with no per-point tab stops', () => {
		const { container } = render(<DurationTrendsChart data={mockStatsData} theme={mockTheme} />);
		const chart = screen.getByRole('img');
		expect(chart.getAttribute('aria-label')).toContain('Mean query duration');
		expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
	});

	it('smoothing is a labeled switch', () => {
		render(<DurationTrendsChart data={mockStatsData} theme={mockTheme} />);
		const toggle = screen.getByRole('switch', { name: /trailing/i });
		expect(toggle).toHaveAttribute('aria-checked', 'false');
	});
});
describe('Chart Accessibility - SummaryCards', () => {
	it('has role="region" on the container', () => {
		render(<SummaryCards data={mockStatsData} theme={mockTheme} />);
		const region = screen.getByRole('region', { name: /usage summary metrics/i });
		expect(region).toBeInTheDocument();
	});

	it('each metric card has role="group"', () => {
		render(<SummaryCards data={mockStatsData} theme={mockTheme} />);
		const metricCards = screen.getAllByTestId('metric-card');
		expect(metricCards).toHaveLength(13); // 13 metric cards (no delegation split passed)
		metricCards.forEach((card) => {
			expect(card).toHaveAttribute('role', 'group');
		});
	});

	it('metric cards have descriptive aria-labels', () => {
		render(<SummaryCards data={mockStatsData} theme={mockTheme} />);
		const metricCards = screen.getAllByTestId('metric-card');

		// The peak hour lives on the radial Activity by Hour chart, not here.
		const expectedLabels = [
			/Agents \(now\)/i,
			/Open Tabs \(now\)/i,
			/Total Queries/i,
			/Queries\/Agent/i,
			/Tokens/i,
			/Cost/i,
			/Total Time/i,
			/Avg Duration/i,
			/Top Provider/i,
			/Current Streak/i,
			/Best Day/i,
			/Active Days/i,
			/Image Annotations/i,
		];

		metricCards.forEach((card, index) => {
			expect(card).toHaveAttribute('aria-label');
			const label = card.getAttribute('aria-label') || '';
			expect(label).toMatch(expectedLabels[index]);
		});
	});

	it('metric cards include values in aria-labels', () => {
		render(<SummaryCards data={mockStatsData} theme={mockTheme} />);
		const metricCards = screen.getAllByTestId('metric-card');

		metricCards.forEach((card) => {
			const label = card.getAttribute('aria-label') || '';
			// Should contain a value (number, time, or percentage)
			expect(label).toMatch(/: .+/); // Has colon followed by value
		});
	});
});

describe('Chart Accessibility - General ARIA Patterns', () => {
	it('all charts have proper heading structure', () => {
		// Render each chart and verify h3 headings exist
		const { unmount: u1 } = render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
		expect(
			screen.getByRole('heading', { level: 3, name: /provider comparison/i })
		).toBeInTheDocument();
		u1();

		const { unmount: u2 } = render(
			<SourceDistributionChart data={mockStatsData} theme={mockTheme} />
		);
		expect(screen.getByRole('heading', { level: 3, name: /query source/i })).toBeInTheDocument();
		u2();

		const { unmount: u3 } = render(
			<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />
		);
		expect(
			screen.getByRole('heading', { level: 3, name: /activity heatmap/i })
		).toBeInTheDocument();
		u3();

		const { unmount: u4 } = render(
			<DurationTrendsChart data={mockStatsData} timeRange="week" theme={mockTheme} />
		);
		expect(screen.getByRole('heading', { level: 3, name: /duration trends/i })).toBeInTheDocument();
		u4();
	});

	it('empty states are properly announced', () => {
		const emptyData = {
			...mockStatsData,
			totalQueries: 0,
			totalDuration: 0,
			avgDuration: 0,
			byAgent: {},
			bySource: { user: 0, auto: 0 },
			byLocation: { local: 0, remote: 0 },
			byDay: [],
			byHour: [],
			totalSessions: 0,
		} as StatsAggregation;

		render(<AgentComparisonChart data={emptyData} theme={mockTheme} />);
		expect(screen.getByText(/no queries in this range/i)).toBeInTheDocument();
	});

	it('interactive elements are keyboard accessible', () => {
		render(<ActivityHeatmap data={mockStatsData} timeRange="week" theme={mockTheme} />);

		// All toggle buttons should be focusable
		const buttons = screen.getAllByRole('button');
		buttons.forEach((button) => {
			expect(button.tabIndex).not.toBe(-1);
		});

		// The heatmap grid is ONE tab stop (arrow keys move between cells), so a
		// year of cells does not cost a keyboard user hundreds of Tab presses.
		expect(screen.getByTestId('activity-heatmap-grid')).toHaveAttribute('tabIndex', '0');
		const cells = screen.getAllByTestId('activity-heatmap-cell');
		expect(cells.length).toBeGreaterThan(0);
		cells.forEach((cell) => expect(cell).not.toHaveAttribute('tabIndex', '0'));
	});
});

describe('Chart Accessibility - Screen Reader Announcements', () => {
	it('AgentComparisonChart aria-label describes displayed data', () => {
		render(<AgentComparisonChart data={mockStatsData} theme={mockTheme} />);
		const figure = screen.getByRole('figure');

		// Names the measure the active mode plots (queries by default).
		const ariaLabel = figure.getAttribute('aria-label') || '';
		expect(ariaLabel).toContain('queries by provider');
		expect(ariaLabel).toContain('rows displayed');
	});

	it('SourceDistributionChart provides percentage summary in SVG', () => {
		render(<SourceDistributionChart data={mockStatsData} theme={mockTheme} />);
		const svg = screen.getByRole('img');
		const label = svg.getAttribute('aria-label') || '';

		// Should contain percentages for both sources
		expect(label).toContain('%');
		expect(label).toContain('Interactive');
	});

	it('DurationTrendsChart announces data range in SVG', () => {
		render(<DurationTrendsChart data={mockStatsData} theme={mockTheme} />);
		const svg = screen.getByRole('img');
		const label = svg.getAttribute('aria-label') || '';

		expect(label).toContain('Range from');
		expect(label).toContain('to');
	});

	it('ActivityHeatmap cells announce date and value', () => {
		render(<ActivityHeatmap data={mockStatsData} theme={mockTheme} />);
		const cells = screen.getAllByTestId('activity-heatmap-cell');

		// Each cell announces its date, its hour span, and its real query count,
		// e.g. "Mon, Jan 20, 12 AM - 1 AM: 0 queries (0ms)".
		const firstCellLabel = cells[0].getAttribute('aria-label') || '';
		expect(firstCellLabel).toMatch(/\w+ \d+/); // Month and day (e.g., "Dec 24")
		expect(firstCellLabel).toContain('quer'); // query or queries
	});
});
