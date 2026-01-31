/**
 * Tests for AgentComparisonChart component
 *
 * Verifies:
 * - Renders horizontal bar chart comparing agent usage
 * - Shows correct agent names and values
 * - Toggle between count and duration modes
 * - Bars sorted by value descending
 * - Distinct colors per agent
 * - Percentage labels on bars
 * - Tooltip shows details on hover
 * - Handles empty data gracefully
 * - Applies theme colors correctly
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { AgentComparisonChart } from '../../../../renderer/components/UsageDashboard/AgentComparisonChart';
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
		'factory-droid': { count: 20, duration: 1600000 },
		terminal: { count: 10, duration: 500000 },
	},
	bySource: { user: 35, auto: 15 },
	byDay: [
		{ date: '2024-12-20', count: 5, duration: 300000 },
		{ date: '2024-12-21', count: 10, duration: 600000 },
	],
};

// Data with single agent
const singleAgentData: StatsAggregation = {
	totalQueries: 20,
	totalDuration: 1000000,
	avgDuration: 50000,
	byAgent: {
		'claude-code': { count: 20, duration: 1000000 },
	},
	bySource: { user: 20, auto: 0 },
	byDay: [],
};

// Data with many agents
const manyAgentsData: StatsAggregation = {
	totalQueries: 100,
	totalDuration: 5000000,
	avgDuration: 50000,
	byAgent: {
		'claude-code': { count: 30, duration: 1500000 },
		'factory-droid': { count: 25, duration: 1200000 },
		terminal: { count: 15, duration: 800000 },
		opencode: { count: 12, duration: 600000 },
		gemini: { count: 10, duration: 500000 },
		codex: { count: 5, duration: 250000 },
		qwen: { count: 3, duration: 150000 },
	},
	bySource: { user: 70, auto: 30 },
	byDay: [],
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

describe('AgentComparisonChart', () => {
	describe('Rendering', () => {
		it('renders the component with title', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			expect(screen.getByText('Provider Comparison')).toBeInTheDocument();
		});

		it('renders count and duration labels for each agent', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Component now shows both count and duration for each agent (no toggle)
			// Check that query count labels are present
			expect(screen.getAllByText(/queries/).length).toBeGreaterThan(0);
			// Check that duration is displayed (e.g., "33m 20s" for claude-code)
			expect(screen.getByText('33m 20s')).toBeInTheDocument();
		});

		it('renders agent names', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Use getAllByText since agent names appear in both bar labels and legend
			expect(screen.getAllByText('claude-code').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('factory-droid').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('terminal').length).toBeGreaterThanOrEqual(1);
		});

		it('renders with empty data showing message', () => {
			render(<AgentComparisonChart data={emptyData} theme={theme} />);

			expect(screen.getByText('No agent data available')).toBeInTheDocument();
		});

		it('renders single agent correctly', () => {
			render(<AgentComparisonChart data={singleAgentData} theme={theme} />);

			// Use getAllByText since agent name appears in both bar label and legend
			expect(screen.getAllByText('claude-code').length).toBeGreaterThanOrEqual(1);
			// Single agent should show 100%
			expect(screen.getByText('100.0%')).toBeInTheDocument();
		});
	});

	describe('Unified Count and Duration Display', () => {
		it('shows both count and duration for each agent', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Should show duration for claude-code: 2000000ms = 33m 20s
			expect(screen.getByText('33m 20s')).toBeInTheDocument();

			// Should show count values - multiple "queries" labels will be present for multiple agents
			expect(screen.getAllByText(/queries/).length).toBeGreaterThan(0);
		});

		it('shows query count label for single query', () => {
			const singleQueryData: StatsAggregation = {
				...singleAgentData,
				byAgent: {
					'claude-code': { count: 1, duration: 1000000 },
				},
			};
			render(<AgentComparisonChart data={singleQueryData} theme={theme} />);

			// Should show "query" for count of 1 (singular form)
			expect(screen.getByText(/1 query$/)).toBeInTheDocument();
		});

		it('shows formatted count with queries label', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// claude-code has 30 queries - should be displayed with "queries" suffix
			// Multiple agents have "queries" label, so use getAllByText
			const queryLabels = screen.getAllByText(/\d+ queries/);
			expect(queryLabels.length).toBeGreaterThan(0);
		});
	});

	describe('Bar Sorting', () => {
		it('sorts bars by value descending', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Get all agent name labels
			const agentLabels = container.querySelectorAll('.w-28.truncate');
			const agentNames = Array.from(agentLabels).map((el) => el.textContent);

			// In duration mode, claude-code has highest duration (2000000), then codex (1600000), then terminal (500000)
			expect(agentNames[0]).toBe('claude-code');
			expect(agentNames[1]).toBe('factory-droid');
			expect(agentNames[2]).toBe('terminal');
		});
	});

	describe('Percentage Labels', () => {
		it('shows percentage labels on bars', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Should have percentage labels for each agent
			// Total duration is 4100000, claude-code is 2000000 = ~48.8%
			// Using regex to find percentage patterns
			const percentages = screen.getAllByText(/\d+\.\d+%/);
			expect(percentages.length).toBeGreaterThan(0);
		});
	});

	describe('Agent Colors', () => {
		it('assigns distinct colors to different agents', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Find the bar fill divs (with h-full, rounded, and flex classes - the actual colored bars)
			// These bars now use inline styles for transitions instead of Tailwind classes
			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
			const colors = Array.from(bars)
				.map((bar) => (bar as HTMLElement).style.backgroundColor)
				.filter((c) => c !== '');

			// Should have 3 bars with colors
			expect(colors.length).toBe(3);
			// Should have different colors for each agent
			expect(new Set(colors).size).toBe(colors.length);
		});
	});

	describe('Legend', () => {
		it('shows legend with agent colors', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Legend should have color indicators
			const legendItems = container.querySelectorAll('.w-2\\.5.h-2\\.5.rounded-sm');
			expect(legendItems.length).toBeGreaterThan(0);
		});

		it('shows +N more when there are many agents', () => {
			render(<AgentComparisonChart data={manyAgentsData} theme={theme} />);

			// With 7 agents, should show 6 in legend and "+1 more"
			expect(screen.getByText('+1 more')).toBeInTheDocument();
		});

		it('does not show legend with empty data', () => {
			const { container } = render(<AgentComparisonChart data={emptyData} theme={theme} />);

			// No legend items should be present
			const legendItems = container.querySelectorAll('.w-2\\.5.h-2\\.5.rounded-sm');
			expect(legendItems.length).toBe(0);
		});
	});

	describe('Tooltip Functionality', () => {
		it('shows tooltip on bar hover', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Find the first bar row
			const barRows = container.querySelectorAll('.flex.items-center.gap-3');

			if (barRows.length > 0) {
				fireEvent.mouseEnter(barRows[0]);

				// Tooltip should appear
				const tooltip = container.querySelector('.fixed.z-50');
				expect(tooltip).toBeInTheDocument();
			}
		});

		it('hides tooltip on mouse leave', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const barRows = container.querySelectorAll('.flex.items-center.gap-3');

			if (barRows.length > 0) {
				fireEvent.mouseEnter(barRows[0]);
				fireEvent.mouseLeave(barRows[0]);

				const tooltip = container.querySelector('.fixed.z-50');
				expect(tooltip).not.toBeInTheDocument();
			}
		});

		it('tooltip shows query count and duration', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const barRows = container.querySelectorAll('.flex.items-center.gap-3');

			if (barRows.length > 0) {
				fireEvent.mouseEnter(barRows[0]);

				// Tooltip should contain queries text and total text
				const tooltip = container.querySelector('.fixed.z-50');
				expect(tooltip?.textContent).toContain('queries');
				expect(tooltip?.textContent).toContain('total');
			}
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveStyle({
				backgroundColor: theme.colors.bgMain,
			});
		});

		it('applies theme text colors', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			const title = screen.getByText('Provider Comparison');
			expect(title).toHaveStyle({
				color: theme.colors.textMain,
			});
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];

			render(<AgentComparisonChart data={mockData} theme={lightTheme} />);

			expect(screen.getByText('Provider Comparison')).toBeInTheDocument();
		});

		it('applies border colors from theme', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Legend container should have border-top
			const legendContainer = container.querySelector('.flex.flex-wrap.gap-3.mt-4.pt-3.border-t');
			expect(legendContainer).toHaveStyle({
				borderColor: theme.colors.border,
			});
		});
	});

	describe('Value Formatting', () => {
		it('formats duration values correctly', () => {
			render(<AgentComparisonChart data={mockData} theme={theme} />);

			// claude-code duration: 2000000ms = 33m 20s
			expect(screen.getByText('33m 20s')).toBeInTheDocument();
		});

		it('formats large count values with K suffix', () => {
			const largeCountData: StatsAggregation = {
				...mockData,
				byAgent: {
					'claude-code': { count: 1500, duration: 100000 },
				},
			};

			render(<AgentComparisonChart data={largeCountData} theme={theme} />);

			// 1500 should be formatted as 1.5K (now shown alongside duration, no toggle needed)
			expect(screen.getByText(/1\.5K/)).toBeInTheDocument();
		});

		it('formats hours correctly', () => {
			const longDurationData: StatsAggregation = {
				...mockData,
				byAgent: {
					'claude-code': { count: 10, duration: 7200000 }, // 2 hours
				},
			};

			render(<AgentComparisonChart data={longDurationData} theme={theme} />);

			expect(screen.getByText('2h 0m')).toBeInTheDocument();
		});
	});

	describe('Bar Width Calculation', () => {
		it('highest value agent has full width bar', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Find the first bar (should be claude-code with highest duration)
			// Bars have h-full, rounded, and flex classes with inline transition styles
			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');

			if (bars.length > 0) {
				const firstBar = bars[0] as HTMLElement;
				// Should have close to 100% width
				expect(firstBar.style.width).toBe('100%');
			}
		});
	});

	describe('Hover State', () => {
		it('highlights agent name on hover', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const barRows = container.querySelectorAll('.flex.items-center.gap-3');

			if (barRows.length > 0) {
				const agentLabel = barRows[0].querySelector('.w-28');

				// Before hover, should have textDim color
				expect(agentLabel).toHaveStyle({
					color: theme.colors.textDim,
				});

				fireEvent.mouseEnter(barRows[0]);

				// After hover, should have textMain color
				expect(agentLabel).toHaveStyle({
					color: theme.colors.textMain,
				});
			}
		});
	});

	describe('Smooth Animations', () => {
		it('applies CSS transitions to bars for smooth width changes', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			// Find bar elements - they have h-full, rounded, and flex classes
			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
			expect(bars.length).toBeGreaterThan(0);

			const firstBar = bars[0] as HTMLElement;
			expect(firstBar.style.transition).toContain('width');
			expect(firstBar.style.transition).toContain('0.5s');
		});

		it('uses cubic-bezier easing for smooth animation curves', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
			expect(bars.length).toBeGreaterThan(0);

			const firstBar = bars[0] as HTMLElement;
			expect(firstBar.style.transition).toContain('cubic-bezier');
		});

		it('applies opacity transition for hover effects', () => {
			const { container } = render(<AgentComparisonChart data={mockData} theme={theme} />);

			const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
			expect(bars.length).toBeGreaterThan(0);

			const firstBar = bars[0] as HTMLElement;
			expect(firstBar.style.transition).toContain('opacity');
		});
	});
});
