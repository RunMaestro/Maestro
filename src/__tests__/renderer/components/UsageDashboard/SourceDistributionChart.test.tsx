/**
 * Tests for SourceDistributionChart component
 *
 * Verifies:
 * - Renders donut/pie chart showing Interactive vs Auto breakdown
 * - Toggle between count-based and duration-based views
 * - Center label shows total
 * - Legend with percentages
 * - Theme-aware colors (accent for interactive, secondary for auto)
 * - Tooltip shows details on hover
 * - Handles empty data gracefully
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { SourceDistributionChart } from '../../../../renderer/components/UsageDashboard/SourceDistributionChart';
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
		codex: { count: 20, duration: 1600000 },
	},
	bySource: { user: 35, auto: 15 },
	byDay: [
		{ date: '2024-12-20', count: 5, duration: 300000 },
		{ date: '2024-12-21', count: 10, duration: 600000 },
	],
};

// Data with only interactive (user) queries
const interactiveOnlyData: StatsAggregation = {
	totalQueries: 30,
	totalDuration: 1800000, // 30 minutes
	avgDuration: 60000,
	byAgent: {
		'claude-code': { count: 30, duration: 1800000 },
	},
	bySource: { user: 30, auto: 0 },
	byDay: [],
};

// Data with only auto queries
const autoOnlyData: StatsAggregation = {
	totalQueries: 20,
	totalDuration: 1200000, // 20 minutes
	avgDuration: 60000,
	byAgent: {
		'claude-code': { count: 20, duration: 1200000 },
	},
	bySource: { user: 0, auto: 20 },
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

// Data with equal distribution
const equalDistributionData: StatsAggregation = {
	totalQueries: 100,
	totalDuration: 6000000, // 100 minutes
	avgDuration: 60000,
	byAgent: {
		'claude-code': { count: 100, duration: 6000000 },
	},
	bySource: { user: 50, auto: 50 },
	byDay: [],
};

describe('SourceDistributionChart', () => {
	describe('Rendering', () => {
		it('renders the component with title', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			expect(screen.getByText('Session Type')).toBeInTheDocument();
		});

		it('renders metric toggle buttons', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			expect(screen.getByText('Count')).toBeInTheDocument();
			expect(screen.getByText('Duration')).toBeInTheDocument();
		});

		it('renders SVG donut chart', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('renders chart segments as paths', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBe(2); // Interactive and Auto
		});

		it('renders with empty data showing message', () => {
			render(<SourceDistributionChart data={emptyData} theme={theme} />);

			expect(screen.getByText('No source data available')).toBeInTheDocument();
		});

		it('renders single source (interactive only) correctly', () => {
			render(<SourceDistributionChart data={interactiveOnlyData} theme={theme} />);

			expect(screen.getByText('Interactive')).toBeInTheDocument();
			// With only interactive, should show 100%
			expect(screen.getByText(/100\.0%/)).toBeInTheDocument();
		});

		it('renders single source (auto only) correctly', () => {
			render(<SourceDistributionChart data={autoOnlyData} theme={theme} />);

			expect(screen.getByText('Auto Run')).toBeInTheDocument();
			// With only auto, should show 100%
			expect(screen.getByText(/100\.0%/)).toBeInTheDocument();
		});
	});

	describe('Center Label', () => {
		it('shows total count in count mode', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			// Total is 35 + 15 = 50
			expect(screen.getByText('50')).toBeInTheDocument();
			expect(screen.getByText('total')).toBeInTheDocument();
		});

		it('shows total duration in duration mode', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			// Switch to duration mode
			fireEvent.click(screen.getByText('Duration'));

			// Should show formatted duration
			expect(screen.getByText('time')).toBeInTheDocument();
		});

		it('formats large numbers with K suffix', () => {
			const largeData: StatsAggregation = {
				...mockData,
				bySource: { user: 1500, auto: 500 },
			};

			render(<SourceDistributionChart data={largeData} theme={theme} />);

			// Total is 2000, should show as 2K (with decimal)
			expect(screen.getByText('2.0K')).toBeInTheDocument();
		});
	});

	describe('Legend', () => {
		it('renders legend with source labels', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			expect(screen.getByText('Interactive')).toBeInTheDocument();
			expect(screen.getByText('Auto Run')).toBeInTheDocument();
		});

		it('shows percentages in legend', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			// Interactive is 35/50 = 70%, Auto is 15/50 = 30%
			expect(screen.getByText(/70\.0%/)).toBeInTheDocument();
			expect(screen.getByText(/30\.0%/)).toBeInTheDocument();
		});

		it('shows color indicators for each source', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			// Legend color indicators
			const colorIndicators = container.querySelectorAll('.w-3.h-3.rounded-sm');
			expect(colorIndicators.length).toBe(2);
		});

		it('highlights legend item on hover', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			// Find legend item container
			const legendItems = container.querySelectorAll('.flex.items-center.gap-3.cursor-default');

			if (legendItems.length > 0) {
				const labelBefore = legendItems[0].querySelector('.text-sm.font-medium');
				expect(labelBefore).toHaveStyle({ color: theme.colors.textDim });

				fireEvent.mouseEnter(legendItems[0]);

				const labelAfter = legendItems[0].querySelector('.text-sm.font-medium');
				expect(labelAfter).toHaveStyle({ color: theme.colors.textMain });
			}
		});
	});

	describe('Metric Mode Toggle', () => {
		it('defaults to count mode', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			const countButton = screen.getByText('Count');
			expect(countButton).toHaveStyle({
				color: theme.colors.accent,
			});
		});

		it('switches to duration mode when clicked', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			const durationButton = screen.getByText('Duration');
			fireEvent.click(durationButton);

			expect(durationButton).toHaveStyle({
				color: theme.colors.accent,
			});
		});

		it('updates legend values when switching modes', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			// In count mode, should show count values
			expect(screen.getByText(/35$/)).toBeInTheDocument(); // Interactive: 35

			// Switch to duration mode
			fireEvent.click(screen.getByText('Duration'));

			// Should now show duration-based values
			// Legend text should update to show time values
			const legendTexts = screen.getAllByText(/•/);
			expect(legendTexts.length).toBeGreaterThan(0);
		});
	});

	describe('Chart Segments', () => {
		it('uses accent color for interactive segment', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const paths = container.querySelectorAll('svg path');
			const fills = Array.from(paths).map((p) => (p as SVGPathElement).getAttribute('fill'));

			// Interactive segment should use accent color
			expect(fills).toContain(theme.colors.accent);
		});

		it('uses different color for auto segment', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const paths = container.querySelectorAll('svg path');
			const fills = Array.from(paths)
				.map((p) => (p as SVGPathElement).getAttribute('fill'))
				.filter((f) => f !== null);

			// Should have 2 different colors
			expect(new Set(fills).size).toBe(2);
		});

		it('renders full donut for single source', () => {
			const { container } = render(
				<SourceDistributionChart data={interactiveOnlyData} theme={theme} />
			);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBe(1);
		});

		it('shows equal segments for 50/50 distribution', () => {
			render(<SourceDistributionChart data={equalDistributionData} theme={theme} />);

			// Both should show 50%
			const percentages = screen.getAllByText(/50\.0%/);
			expect(percentages.length).toBe(2);
		});
	});

	// Note: Tooltip functionality was removed in commit 287821dd
	// "Source distribution chart simplified by removing floating tooltip overlay"
	// The chart now uses legend highlighting on hover instead of a floating tooltip

	describe('Hover Effects', () => {
		it('expands segment on hover', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const paths = container.querySelectorAll('svg path');

			if (paths.length > 0) {
				// Before hover, segment should have normal opacity
				expect(paths[0]).toHaveAttribute('opacity', '1');

				fireEvent.mouseEnter(paths[0]);

				// Hovered segment stays at opacity 1
				expect(paths[0]).toHaveAttribute('opacity', '1');

				// Other segment should dim
				if (paths.length > 1) {
					expect(paths[1]).toHaveAttribute('opacity', '0.5');
				}
			}
		});

		it('dims other segments when one is hovered', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const paths = container.querySelectorAll('svg path');

			if (paths.length > 1) {
				fireEvent.mouseEnter(paths[0]);

				expect(paths[1]).toHaveAttribute('opacity', '0.5');
			}
		});

		it('restores opacity on mouse leave', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const paths = container.querySelectorAll('svg path');

			if (paths.length > 1) {
				fireEvent.mouseEnter(paths[0]);
				fireEvent.mouseLeave(paths[0]);

				expect(paths[1]).toHaveAttribute('opacity', '1');
			}
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const wrapper = container.firstChild as HTMLElement;
			expect(wrapper).toHaveStyle({
				backgroundColor: theme.colors.bgMain,
			});
		});

		it('applies theme text colors', () => {
			render(<SourceDistributionChart data={mockData} theme={theme} />);

			const title = screen.getByText('Session Type');
			expect(title).toHaveStyle({
				color: theme.colors.textMain,
			});
		});

		it('works with light theme', () => {
			const lightTheme = THEMES['github-light'];

			render(<SourceDistributionChart data={mockData} theme={lightTheme} />);

			expect(screen.getByText('Session Type')).toBeInTheDocument();
		});

		it('applies border colors from theme', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			// Toggle buttons should have border
			const toggleContainer = container.querySelector('.flex.rounded.overflow-hidden.border');
			expect(toggleContainer).toHaveStyle({
				borderColor: theme.colors.border,
			});
		});

		it('center label uses theme text colors', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			// Find the center label container
			const centerLabel = container.querySelector('.absolute.inset-0');
			const mainText = centerLabel?.querySelector('.text-lg.font-semibold');
			const subText = centerLabel?.querySelector('.text-xs');

			expect(mainText).toHaveStyle({ color: theme.colors.textMain });
			expect(subText).toHaveStyle({ color: theme.colors.textDim });
		});
	});

	describe('Value Formatting', () => {
		it('formats large numbers with K suffix in center', () => {
			const largeData: StatsAggregation = {
				...mockData,
				bySource: { user: 5000, auto: 3000 },
			};

			render(<SourceDistributionChart data={largeData} theme={theme} />);

			expect(screen.getByText('8.0K')).toBeInTheDocument();
		});

		it('formats millions with M suffix', () => {
			const hugeData: StatsAggregation = {
				...mockData,
				bySource: { user: 1500000, auto: 500000 },
			};

			render(<SourceDistributionChart data={hugeData} theme={theme} />);

			expect(screen.getByText('2.0M')).toBeInTheDocument();
		});

		it('formats duration correctly in duration mode', () => {
			const durationData: StatsAggregation = {
				...mockData,
				totalDuration: 7200000, // 2 hours
				bySource: { user: 40, auto: 10 },
			};

			render(<SourceDistributionChart data={durationData} theme={theme} />);

			fireEvent.click(screen.getByText('Duration'));

			// Should show hours/minutes format
			expect(screen.getByText('time')).toBeInTheDocument();
		});
	});

	describe('Edge Cases', () => {
		it('handles zero total gracefully', () => {
			render(<SourceDistributionChart data={emptyData} theme={theme} />);

			expect(screen.getByText('No source data available')).toBeInTheDocument();
		});

		it('handles very small percentages', () => {
			const skewedData: StatsAggregation = {
				...mockData,
				bySource: { user: 999, auto: 1 },
			};

			render(<SourceDistributionChart data={skewedData} theme={theme} />);

			// Should show 0.1% for auto
			expect(screen.getByText(/0\.1%/)).toBeInTheDocument();
		});

		it('handles very large percentages', () => {
			const skewedData: StatsAggregation = {
				...mockData,
				bySource: { user: 999, auto: 1 },
			};

			render(<SourceDistributionChart data={skewedData} theme={theme} />);

			// Should show 99.9% for interactive
			expect(screen.getByText(/99\.9%/)).toBeInTheDocument();
		});
	});

	describe('Smooth Animations', () => {
		it('applies CSS transitions to arc paths for smooth updates', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBeGreaterThan(0);

			// All arc paths should have transition styles
			const firstPath = paths[0] as HTMLElement;
			expect(firstPath.style.transition).toContain('d');
			expect(firstPath.style.transition).toContain('0.5s');
		});

		it('uses cubic-bezier easing for smooth animation curves', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBeGreaterThan(0);

			const firstPath = paths[0] as HTMLElement;
			expect(firstPath.style.transition).toContain('cubic-bezier');
		});

		it('applies opacity transition for hover effects', () => {
			const { container } = render(<SourceDistributionChart data={mockData} theme={theme} />);

			const paths = container.querySelectorAll('svg path');
			expect(paths.length).toBeGreaterThan(0);

			const firstPath = paths[0] as HTMLElement;
			expect(firstPath.style.transition).toContain('opacity');
		});
	});
});
