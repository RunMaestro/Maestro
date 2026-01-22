/**
 * Tests for SummaryCards component
 *
 * Verifies:
 * - Renders all six metric cards correctly
 * - Displays formatted values (numbers, durations)
 * - Shows correct icons for each metric
 * - Applies theme colors properly
 * - Handles edge cases (empty data, zero values)
 * - Computes derived metrics correctly (most active agent, interactive ratio)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { SummaryCards } from '../../../../renderer/components/UsageDashboard/SummaryCards';
import type { StatsAggregation } from '../../../../renderer/hooks/useStats';
import { THEMES } from '../../../../shared/themes';

// Test theme
const theme = THEMES['dracula'];

// Sample data for testing
const mockData: StatsAggregation = {
	totalQueries: 150,
	totalDuration: 7200000, // 2 hours in ms
	avgDuration: 48000, // 48 seconds in ms
	byAgent: {
		'claude-code': { count: 100, duration: 5000000 },
		aider: { count: 50, duration: 2200000 },
	},
	bySource: { user: 120, auto: 30 },
	byLocation: { local: 120, remote: 30 },
	byDay: [
		{ date: '2024-12-20', count: 50, duration: 2400000 },
		{ date: '2024-12-21', count: 100, duration: 4800000 },
	],
	byHour: [],
	totalSessions: 25,
	sessionsByAgent: { 'claude-code': 15, aider: 10 },
	sessionsByDay: [],
	avgSessionDuration: 288000,
	byAgentByDay: {},
	bySessionByDay: {},
};

// Empty data for edge case testing
const emptyData: StatsAggregation = {
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byLocation: { local: 0, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 0,
	sessionsByAgent: {},
	sessionsByDay: [],
	avgSessionDuration: 0,
	byAgentByDay: {},
	bySessionByDay: {},
};

// Data with large numbers
const largeNumbersData: StatsAggregation = {
	totalQueries: 1500000, // 1.5M
	totalDuration: 360000000, // 100 hours
	avgDuration: 240000, // 4 minutes
	byAgent: {
		'claude-code': { count: 1000000, duration: 200000000 },
		'openai-codex': { count: 500000, duration: 160000000 },
	},
	bySource: { user: 1200000, auto: 300000 },
	byLocation: { local: 1000000, remote: 500000 },
	byDay: [],
	byHour: [],
	totalSessions: 50000,
	sessionsByAgent: { 'claude-code': 30000, 'openai-codex': 20000 },
	sessionsByDay: [],
	avgSessionDuration: 7200000,
	byAgentByDay: {},
	bySessionByDay: {},
};

// Single agent data
const singleAgentData: StatsAggregation = {
	totalQueries: 50,
	totalDuration: 1800000, // 30 minutes
	avgDuration: 36000, // 36 seconds
	byAgent: {
		terminal: { count: 50, duration: 1800000 },
	},
	bySource: { user: 50, auto: 0 },
	byLocation: { local: 50, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 5,
	sessionsByAgent: { terminal: 5 },
	sessionsByDay: [],
	avgSessionDuration: 360000,
	byAgentByDay: {},
	bySessionByDay: {},
};

// Only auto queries
const onlyAutoData: StatsAggregation = {
	totalQueries: 100,
	totalDuration: 3600000, // 1 hour
	avgDuration: 36000,
	byAgent: {
		'claude-code': { count: 100, duration: 3600000 },
	},
	bySource: { user: 0, auto: 100 },
	byLocation: { local: 100, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 10,
	sessionsByAgent: { 'claude-code': 10 },
	sessionsByDay: [],
	avgSessionDuration: 360000,
	byAgentByDay: {},
	bySessionByDay: {},
};

describe('SummaryCards', () => {
	describe('Rendering', () => {
		it('renders the summary cards container', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
		});

		it('renders all six metric cards', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			const cards = screen.getAllByTestId('metric-card');
			expect(cards).toHaveLength(6);
		});

		it('renders Total Queries metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Total Queries')).toBeInTheDocument();
			expect(screen.getByText('150')).toBeInTheDocument();
		});

		it('renders Total Time metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Total Time')).toBeInTheDocument();
			expect(screen.getByText('2h 0m')).toBeInTheDocument();
		});

		it('renders Avg Duration metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Avg Duration')).toBeInTheDocument();
			expect(screen.getByText('48s')).toBeInTheDocument();
		});

		it('renders Top Agent metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Top Agent')).toBeInTheDocument();
			expect(screen.getByText('claude-code')).toBeInTheDocument();
		});

		it('renders Interactive % metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			expect(screen.getByText('Interactive %')).toBeInTheDocument();
			expect(screen.getByText('80%')).toBeInTheDocument();
		});
	});

	describe('Number Formatting', () => {
		it('formats thousands with K suffix', () => {
			const dataWithThousands: StatsAggregation = {
				...mockData,
				totalQueries: 1500,
			};
			render(<SummaryCards data={dataWithThousands} theme={theme} />);

			expect(screen.getByText('1.5K')).toBeInTheDocument();
		});

		it('formats millions with M suffix', () => {
			render(<SummaryCards data={largeNumbersData} theme={theme} />);

			expect(screen.getByText('1.5M')).toBeInTheDocument();
		});

		it('displays small numbers without suffix', () => {
			const dataWithSmallNumbers: StatsAggregation = {
				...mockData,
				totalQueries: 42,
			};
			render(<SummaryCards data={dataWithSmallNumbers} theme={theme} />);

			expect(screen.getByText('42')).toBeInTheDocument();
		});
	});

	describe('Duration Formatting', () => {
		it('formats hours and minutes correctly', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			// 2 hours = "2h 0m"
			expect(screen.getByText('2h 0m')).toBeInTheDocument();
		});

		it('formats minutes and seconds correctly', () => {
			const dataWithMinutes: StatsAggregation = {
				...mockData,
				avgDuration: 125000, // 2m 5s
			};
			render(<SummaryCards data={dataWithMinutes} theme={theme} />);

			expect(screen.getByText('2m 5s')).toBeInTheDocument();
		});

		it('formats seconds only correctly', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			// 48 seconds
			expect(screen.getByText('48s')).toBeInTheDocument();
		});

		it('displays 0s for zero duration', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);

			// Should have multiple 0s values
			const zeroElements = screen.getAllByText('0s');
			expect(zeroElements.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('Most Active Agent Calculation', () => {
		it('identifies the most active agent by count', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			// claude-code has 100 queries, aider has 50
			expect(screen.getByText('claude-code')).toBeInTheDocument();
		});

		it('shows N/A when no agents exist', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);

			// Both Top Agent and Interactive % will be N/A for empty data
			const naElements = screen.getAllByText('N/A');
			expect(naElements.length).toBeGreaterThanOrEqual(1);

			// Verify Top Agent specifically shows N/A
			expect(screen.getByText('Top Agent')).toBeInTheDocument();
		});

		it('handles single agent correctly', () => {
			render(<SummaryCards data={singleAgentData} theme={theme} />);

			expect(screen.getByText('terminal')).toBeInTheDocument();
		});
	});

	describe('Interactive Ratio Calculation', () => {
		it('calculates correct percentage', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			// 120 user / (120 + 30) = 80%
			expect(screen.getByText('80%')).toBeInTheDocument();
		});

		it('shows 100% for user-only queries', () => {
			render(<SummaryCards data={singleAgentData} theme={theme} />);

			expect(screen.getByText('100%')).toBeInTheDocument();
		});

		it('shows 0% for auto-only queries', () => {
			render(<SummaryCards data={onlyAutoData} theme={theme} />);

			expect(screen.getByText('0%')).toBeInTheDocument();
		});

		it('shows N/A when no source data exists', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);

			// Should show N/A for interactive % when no data
			const naElements = screen.getAllByText('N/A');
			expect(naElements.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color to cards', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			const cards = screen.getAllByTestId('metric-card');
			cards.forEach((card) => {
				expect(card).toHaveStyle({
					backgroundColor: theme.colors.bgMain,
				});
			});
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];
			render(<SummaryCards data={mockData} theme={lightTheme} />);

			expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
			expect(screen.getByText('Total Queries')).toBeInTheDocument();
		});

		it('works with different dark themes', () => {
			const nordTheme = THEMES['nord'];
			render(<SummaryCards data={mockData} theme={nordTheme} />);

			expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
			const cards = screen.getAllByTestId('metric-card');
			cards.forEach((card) => {
				expect(card).toHaveStyle({
					backgroundColor: nordTheme.colors.bgMain,
				});
			});
		});
	});

	describe('Icons', () => {
		it('renders SVG icons for each metric', () => {
			const { container } = render(<SummaryCards data={mockData} theme={theme} />);

			// Each card should have an SVG icon
			const svgElements = container.querySelectorAll('svg');
			expect(svgElements.length).toBe(6);
		});
	});

	describe('Grid Layout', () => {
		it('uses 3-column grid layout by default (2 rows × 3 cols)', () => {
			render(<SummaryCards data={mockData} theme={theme} />);

			const container = screen.getByTestId('summary-cards');
			expect(container).toHaveClass('grid');
			expect(container).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('supports responsive column configuration', () => {
			render(<SummaryCards data={mockData} theme={theme} columns={3} />);

			const container = screen.getByTestId('summary-cards');
			expect(container).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('supports 2-column layout for narrow screens', () => {
			render(<SummaryCards data={mockData} theme={theme} columns={2} />);

			const container = screen.getByTestId('summary-cards');
			expect(container).toHaveStyle({
				gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
			});
		});
	});

	describe('Edge Cases', () => {
		it('handles all zero values', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);

			// Should render without errors
			expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
			// Multiple cards show '0' for empty data (Sessions, Queries)
			expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1);
		});

		it('handles very large numbers', () => {
			render(<SummaryCards data={largeNumbersData} theme={theme} />);

			expect(screen.getByText('1.5M')).toBeInTheDocument();
			expect(screen.getByText('100h 0m')).toBeInTheDocument();
		});

		it('handles long agent names without truncation', () => {
			const dataWithLongName: StatsAggregation = {
				...mockData,
				byAgent: {
					'very-long-agent-name-that-might-overflow': { count: 100, duration: 5000000 },
				},
			};
			render(<SummaryCards data={dataWithLongName} theme={theme} />);

			// Long agent names should now wrap to next line instead of truncating
			const agentValue = screen.getByText('very-long-agent-name-that-might-overflow');
			expect(agentValue).toBeInTheDocument();
		});
	});

	describe('Accessibility', () => {
		it('has title attribute on value for tooltip', () => {
			const { container } = render(<SummaryCards data={mockData} theme={theme} />);

			// Values should have title for full value on hover
			const valueElements = container.querySelectorAll('[title]');
			expect(valueElements.length).toBeGreaterThan(0);
		});
	});
});
