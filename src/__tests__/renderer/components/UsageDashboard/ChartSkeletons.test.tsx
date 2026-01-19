/**
 * @fileoverview Tests for ChartSkeletons component
 * Tests: rendering, structure, styling, animation, accessibility
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
	SummaryCardsSkeleton,
	AgentComparisonChartSkeleton,
	SourceDistributionChartSkeleton,
	ActivityHeatmapSkeleton,
	DurationTrendsChartSkeleton,
	AutoRunStatsSkeleton,
	DashboardSkeleton,
} from '../../../../renderer/components/UsageDashboard/ChartSkeletons';
import type { Theme } from '../../../../renderer/types';

// Create test theme
const createTheme = (): Theme => ({
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
});

describe('ChartSkeletons', () => {
	const theme = createTheme();

	describe('SummaryCardsSkeleton', () => {
		it('renders 5 skeleton cards by default', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('summary-cards-skeleton');
			expect(skeleton).toBeInTheDocument();

			// Each card has 3 skeleton boxes (icon, label, value)
			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			expect(skeletonBoxes.length).toBe(15); // 5 cards × 3 boxes
		});

		it('respects custom column count', () => {
			render(<SummaryCardsSkeleton theme={theme} columns={3} />);

			const skeleton = screen.getByTestId('summary-cards-skeleton');
			expect(skeleton).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('uses theme background color for cards', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('summary-cards-skeleton');
			const cards = skeleton.querySelectorAll('.rounded-lg');
			cards.forEach((card) => {
				expect(card).toHaveStyle({ backgroundColor: theme.colors.bgMain });
			});
		});

		it('skeleton boxes have shimmer animation', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({
					animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
				});
			});
		});
	});

	describe('AgentComparisonChartSkeleton', () => {
		it('renders with proper structure', () => {
			render(<AgentComparisonChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('agent-comparison-skeleton');
			expect(skeleton).toBeInTheDocument();
			expect(skeleton).toHaveStyle({ backgroundColor: theme.colors.bgMain });
		});

		it('renders header, bars, and legend sections', () => {
			render(<AgentComparisonChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('agent-comparison-skeleton');

			// Header section
			const header = skeleton.querySelector('.flex.items-center.justify-between.mb-4');
			expect(header).toBeInTheDocument();

			// Bar section (4 bars)
			const bars = skeleton.querySelectorAll('.space-y-2 > div');
			expect(bars.length).toBe(4);

			// Legend section with border-t
			const legend = skeleton.querySelector('.border-t');
			expect(legend).toBeInTheDocument();
		});

		it('renders skeleton boxes for bar chart elements', () => {
			render(<AgentComparisonChartSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			// Header: 2 (title + toggle) + Bars: 4×3=12 (name + bar + value) + Legend: 4×2=8
			expect(skeletonBoxes.length).toBeGreaterThanOrEqual(14);
		});
	});

	describe('SourceDistributionChartSkeleton', () => {
		it('renders with circular placeholder for pie chart', () => {
			render(<SourceDistributionChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('source-distribution-skeleton');
			expect(skeleton).toBeInTheDocument();

			const circle = screen.getByTestId('skeleton-circle');
			expect(circle).toBeInTheDocument();
			expect(circle).toHaveClass('rounded-full');
		});

		it('circle has shimmer animation', () => {
			render(<SourceDistributionChartSkeleton theme={theme} />);

			const circle = screen.getByTestId('skeleton-circle');
			expect(circle).toHaveStyle({
				animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
			});
		});

		it('renders legend items', () => {
			render(<SourceDistributionChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('source-distribution-skeleton');
			const legendSection = skeleton.querySelector('.flex.justify-center.gap-6');
			expect(legendSection).toBeInTheDocument();
		});
	});

	describe('ActivityHeatmapSkeleton', () => {
		it('renders with proper grid structure', () => {
			render(<ActivityHeatmapSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('activity-heatmap-skeleton');
			expect(skeleton).toBeInTheDocument();
		});

		it('renders day labels (7 rows)', () => {
			render(<ActivityHeatmapSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('activity-heatmap-skeleton');
			// Day labels column exists
			const dayLabelsColumn = skeleton.querySelector('.flex-col.justify-between');
			expect(dayLabelsColumn).toBeInTheDocument();
		});

		it('renders week columns (multiple)', () => {
			render(<ActivityHeatmapSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('activity-heatmap-skeleton');
			const gridColumns = skeleton.querySelectorAll('.flex.flex-col');
			// Should have multiple columns for weeks
			expect(gridColumns.length).toBeGreaterThan(5);
		});

		it('renders legend with intensity levels', () => {
			render(<ActivityHeatmapSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('activity-heatmap-skeleton');
			const legendSection = skeleton.querySelector('.flex.items-center.justify-end.gap-2');
			expect(legendSection).toBeInTheDocument();
		});
	});

	describe('DurationTrendsChartSkeleton', () => {
		it('renders with SVG wave placeholder', () => {
			render(<DurationTrendsChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('duration-trends-skeleton');
			expect(skeleton).toBeInTheDocument();

			// SVG element should exist
			const svg = skeleton.querySelector('svg');
			expect(svg).toBeInTheDocument();
		});

		it('renders Y-axis label placeholders', () => {
			render(<DurationTrendsChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('duration-trends-skeleton');
			// 5 Y-axis labels
			const yAxisContainer = skeleton.querySelector('.flex.flex-col.justify-between');
			const yLabels = yAxisContainer?.querySelectorAll('[data-testid="skeleton-box"]');
			expect(yLabels?.length).toBe(5);
		});

		it('renders X-axis label placeholders', () => {
			render(<DurationTrendsChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('duration-trends-skeleton');
			const xAxisContainer = skeleton.querySelector('.flex.justify-between.mt-2');
			const xLabels = xAxisContainer?.querySelectorAll('[data-testid="skeleton-box"]');
			expect(xLabels?.length).toBe(6);
		});

		it('renders gridlines placeholders', () => {
			render(<DurationTrendsChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('duration-trends-skeleton');
			const gridlines = skeleton.querySelectorAll('.absolute.w-full');
			expect(gridlines.length).toBe(4);
		});
	});

	describe('AutoRunStatsSkeleton', () => {
		it('renders 6 skeleton cards by default', () => {
			render(<AutoRunStatsSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('autorun-stats-skeleton');
			expect(skeleton).toBeInTheDocument();

			const cards = skeleton.querySelectorAll('.rounded-lg');
			expect(cards.length).toBe(6);
		});

		it('respects custom column count', () => {
			render(<AutoRunStatsSkeleton theme={theme} columns={3} />);

			const skeleton = screen.getByTestId('autorun-stats-skeleton');
			expect(skeleton).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('each card has icon, label, and value placeholders', () => {
			render(<AutoRunStatsSkeleton theme={theme} />);

			// 6 cards × 3 elements = 18 skeleton boxes
			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			expect(skeletonBoxes.length).toBe(18);
		});
	});

	describe('DashboardSkeleton', () => {
		it('renders overview mode skeleton by default', () => {
			render(<DashboardSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('dashboard-skeleton');
			expect(skeleton).toBeInTheDocument();

			// Should contain all overview components
			expect(screen.getByTestId('summary-cards-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('agent-comparison-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('source-distribution-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('activity-heatmap-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('duration-trends-skeleton')).toBeInTheDocument();
		});

		it('renders agents mode skeleton', () => {
			render(<DashboardSkeleton theme={theme} viewMode="agents" />);

			const skeleton = screen.getByTestId('dashboard-skeleton');
			expect(skeleton).toBeInTheDocument();

			expect(screen.getByTestId('agent-comparison-skeleton')).toBeInTheDocument();
			expect(screen.queryByTestId('summary-cards-skeleton')).not.toBeInTheDocument();
		});

		it('renders activity mode skeleton', () => {
			render(<DashboardSkeleton theme={theme} viewMode="activity" />);

			expect(screen.getByTestId('activity-heatmap-skeleton')).toBeInTheDocument();
			expect(screen.getByTestId('duration-trends-skeleton')).toBeInTheDocument();
			expect(screen.queryByTestId('summary-cards-skeleton')).not.toBeInTheDocument();
		});

		it('renders autorun mode skeleton', () => {
			render(<DashboardSkeleton theme={theme} viewMode="autorun" />);

			expect(screen.getByTestId('autorun-stats-skeleton')).toBeInTheDocument();
			expect(screen.queryByTestId('summary-cards-skeleton')).not.toBeInTheDocument();
		});

		it('respects chartGridCols prop', () => {
			render(<DashboardSkeleton theme={theme} chartGridCols={1} />);

			const skeleton = screen.getByTestId('dashboard-skeleton');
			const chartGrid = skeleton.querySelector('.grid.gap-6');
			expect(chartGrid).toHaveStyle({
				gridTemplateColumns: 'repeat(1, minmax(0, 1fr))',
			});
		});

		it('respects summaryCardsCols prop', () => {
			render(<DashboardSkeleton theme={theme} summaryCardsCols={3} />);

			const summaryCards = screen.getByTestId('summary-cards-skeleton');
			expect(summaryCards).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
		});

		it('respects autoRunStatsCols prop', () => {
			render(<DashboardSkeleton theme={theme} viewMode="autorun" autoRunStatsCols={4} />);

			const autoRunStats = screen.getByTestId('autorun-stats-skeleton');
			expect(autoRunStats).toHaveStyle({
				gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
			});
		});
	});

	describe('Theme Integration', () => {
		it('uses theme border color for skeleton boxes', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({ backgroundColor: theme.colors.border });
			});
		});

		it('uses theme bgMain for card backgrounds', () => {
			render(<AgentComparisonChartSkeleton theme={theme} />);

			const skeleton = screen.getByTestId('agent-comparison-skeleton');
			expect(skeleton).toHaveStyle({ backgroundColor: theme.colors.bgMain });
		});

		it('works with light theme', () => {
			const lightTheme: Theme = {
				...theme,
				mode: 'light',
				colors: {
					...theme.colors,
					bgMain: '#ffffff',
					border: '#e5e5e5',
				},
			};

			render(<SummaryCardsSkeleton theme={lightTheme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({ backgroundColor: lightTheme.colors.border });
			});
		});
	});

	describe('Animation', () => {
		it('all skeleton boxes have consistent animation timing', () => {
			render(<DashboardSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({
					animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
				});
			});
		});

		it('skeleton circle has animation', () => {
			render(<SourceDistributionChartSkeleton theme={theme} />);

			const circle = screen.getByTestId('skeleton-circle');
			expect(circle).toHaveStyle({
				animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
			});
		});
	});

	describe('Accessibility', () => {
		it('skeleton elements use opacity for visibility', () => {
			render(<SummaryCardsSkeleton theme={theme} />);

			const skeletonBoxes = screen.getAllByTestId('skeleton-box');
			skeletonBoxes.forEach((box) => {
				expect(box).toHaveStyle({ opacity: '0.3' });
			});
		});

		it('renders with appropriate structure for screen readers', () => {
			render(<DashboardSkeleton theme={theme} />);

			// Dashboard skeleton should be recognizable as a loading state
			const skeleton = screen.getByTestId('dashboard-skeleton');
			expect(skeleton).toBeInTheDocument();
		});
	});
});
