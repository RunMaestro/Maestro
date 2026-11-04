// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/UsageDashboard/ChartSkeletons.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/AgentEfficiencyChart.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render as s1_render, screen as s1_screen } from '@testing-library/react';
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
import { render as s2_render, screen as s2_screen } from '@testing-library/react';
import { AgentEfficiencyChart } from '../../../../renderer/components/UsageDashboard/AgentEfficiencyChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';
import { BAR_CHART_GRID_STYLE } from '../../../../renderer/components/UsageDashboard/chartUtils';
// Source: src/__tests__/renderer/components/UsageDashboard/ChartSkeletons.test.tsx
describe('', () => {
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
				s1_render(<SummaryCardsSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('summary-cards-skeleton');
				expect(skeleton).toBeInTheDocument();
				// Each card has 3 skeleton boxes (icon, label, value)
				const skeletonBoxes = s1_screen.getAllByTestId('skeleton-box');
				expect(skeletonBoxes.length).toBe(15); // 5 cards × 3 boxes
			});
			it('respects custom column count', () => {
				s1_render(<SummaryCardsSkeleton theme={theme} columns={3} />);
				const skeleton = s1_screen.getByTestId('summary-cards-skeleton');
				expect(skeleton).toHaveStyle({
					gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
				});
			});
			it('uses theme background color for cards', () => {
				s1_render(<SummaryCardsSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('summary-cards-skeleton');
				const cards = skeleton.querySelectorAll('.rounded-lg');
				cards.forEach((card) => {
					expect(card).toHaveStyle({ backgroundColor: theme.colors.bgMain });
				});
			});
			it('skeleton boxes have shimmer animation', () => {
				s1_render(<SummaryCardsSkeleton theme={theme} />);
				const skeletonBoxes = s1_screen.getAllByTestId('skeleton-box');
				skeletonBoxes.forEach((box) => {
					expect(box).toHaveStyle({
						animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
					});
				});
			});
		});
		describe('AgentComparisonChartSkeleton', () => {
			it('renders with proper structure', () => {
				s1_render(<AgentComparisonChartSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('agent-comparison-skeleton');
				expect(skeleton).toBeInTheDocument();
				expect(skeleton).toHaveStyle({ backgroundColor: theme.colors.bgMain });
			});
			it('renders header, bars, and legend sections', () => {
				s1_render(<AgentComparisonChartSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('agent-comparison-skeleton');
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
				s1_render(<AgentComparisonChartSkeleton theme={theme} />);
				const skeletonBoxes = s1_screen.getAllByTestId('skeleton-box');
				// Header: 2 (title + toggle) + Bars: 4×3=12 (name + bar + value) + Legend: 4×2=8
				expect(skeletonBoxes.length).toBeGreaterThanOrEqual(14);
			});
		});
		describe('SourceDistributionChartSkeleton', () => {
			it('renders with circular placeholder for pie chart', () => {
				s1_render(<SourceDistributionChartSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('source-distribution-skeleton');
				expect(skeleton).toBeInTheDocument();
				const circle = s1_screen.getByTestId('skeleton-circle');
				expect(circle).toBeInTheDocument();
				expect(circle).toHaveClass('rounded-full');
			});
			it('circle has shimmer animation', () => {
				s1_render(<SourceDistributionChartSkeleton theme={theme} />);
				const circle = s1_screen.getByTestId('skeleton-circle');
				expect(circle).toHaveStyle({
					animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
				});
			});
			it('renders legend items', () => {
				s1_render(<SourceDistributionChartSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('source-distribution-skeleton');
				const legendSection = skeleton.querySelector('.flex.justify-center.gap-6');
				expect(legendSection).toBeInTheDocument();
			});
		});
		describe('ActivityHeatmapSkeleton', () => {
			it('renders with proper grid structure', () => {
				s1_render(<ActivityHeatmapSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('activity-heatmap-skeleton');
				expect(skeleton).toBeInTheDocument();
			});
			it('renders day labels (7 rows)', () => {
				s1_render(<ActivityHeatmapSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('activity-heatmap-skeleton');
				// Day labels column exists
				const dayLabelsColumn = skeleton.querySelector('.flex-col.justify-between');
				expect(dayLabelsColumn).toBeInTheDocument();
			});
			it('renders week columns (multiple)', () => {
				s1_render(<ActivityHeatmapSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('activity-heatmap-skeleton');
				const gridColumns = skeleton.querySelectorAll('.flex.flex-col');
				// Should have multiple columns for weeks
				expect(gridColumns.length).toBeGreaterThan(5);
			});
			it('renders legend with intensity levels', () => {
				s1_render(<ActivityHeatmapSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('activity-heatmap-skeleton');
				const legendSection = skeleton.querySelector('.flex.items-center.justify-end.gap-2');
				expect(legendSection).toBeInTheDocument();
			});
		});
		describe('DurationTrendsChartSkeleton', () => {
			it('renders with SVG wave placeholder', () => {
				s1_render(<DurationTrendsChartSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('duration-trends-skeleton');
				expect(skeleton).toBeInTheDocument();
				// SVG element should exist
				const svg = skeleton.querySelector('svg');
				expect(svg).toBeInTheDocument();
			});
			it('renders Y-axis label placeholders', () => {
				s1_render(<DurationTrendsChartSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('duration-trends-skeleton');
				// 5 Y-axis labels
				const yAxisContainer = skeleton.querySelector('.flex.flex-col.justify-between');
				const yLabels = yAxisContainer?.querySelectorAll('[data-testid="skeleton-box"]');
				expect(yLabels?.length).toBe(5);
			});
			it('renders X-axis label placeholders', () => {
				s1_render(<DurationTrendsChartSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('duration-trends-skeleton');
				const xAxisContainer = skeleton.querySelector('.flex.justify-between.mt-2');
				const xLabels = xAxisContainer?.querySelectorAll('[data-testid="skeleton-box"]');
				expect(xLabels?.length).toBe(6);
			});
			it('renders gridlines placeholders', () => {
				s1_render(<DurationTrendsChartSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('duration-trends-skeleton');
				const gridlines = skeleton.querySelectorAll('.absolute.w-full');
				expect(gridlines.length).toBe(4);
			});
		});
		describe('AutoRunStatsSkeleton', () => {
			it('renders 6 skeleton cards by default', () => {
				s1_render(<AutoRunStatsSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('autorun-stats-skeleton');
				expect(skeleton).toBeInTheDocument();
				const cards = skeleton.querySelectorAll('.rounded-lg');
				expect(cards.length).toBe(6);
			});
			it('respects custom column count', () => {
				s1_render(<AutoRunStatsSkeleton theme={theme} columns={3} />);
				const skeleton = s1_screen.getByTestId('autorun-stats-skeleton');
				expect(skeleton).toHaveStyle({
					gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
				});
			});
			it('each card has icon, label, and value placeholders', () => {
				s1_render(<AutoRunStatsSkeleton theme={theme} />);
				// 6 cards × 3 elements = 18 skeleton boxes
				const skeletonBoxes = s1_screen.getAllByTestId('skeleton-box');
				expect(skeletonBoxes.length).toBe(18);
			});
		});
		describe('DashboardSkeleton', () => {
			it('renders overview mode skeleton by default', () => {
				s1_render(<DashboardSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('dashboard-skeleton');
				expect(skeleton).toBeInTheDocument();
				// Should contain all overview components
				expect(s1_screen.getByTestId('summary-cards-skeleton')).toBeInTheDocument();
				expect(s1_screen.getByTestId('agent-comparison-skeleton')).toBeInTheDocument();
				expect(s1_screen.getByTestId('source-distribution-skeleton')).toBeInTheDocument();
				expect(s1_screen.getByTestId('activity-heatmap-skeleton')).toBeInTheDocument();
				expect(s1_screen.getByTestId('duration-trends-skeleton')).toBeInTheDocument();
			});
			it('renders agents mode skeleton', () => {
				s1_render(<DashboardSkeleton theme={theme} viewMode="agents" />);
				const skeleton = s1_screen.getByTestId('dashboard-skeleton');
				expect(skeleton).toBeInTheDocument();
				expect(s1_screen.getByTestId('agent-comparison-skeleton')).toBeInTheDocument();
				expect(s1_screen.queryByTestId('summary-cards-skeleton')).not.toBeInTheDocument();
			});
			it('renders activity mode skeleton', () => {
				s1_render(<DashboardSkeleton theme={theme} viewMode="activity" />);
				expect(s1_screen.getByTestId('activity-heatmap-skeleton')).toBeInTheDocument();
				expect(s1_screen.getByTestId('duration-trends-skeleton')).toBeInTheDocument();
				expect(s1_screen.queryByTestId('summary-cards-skeleton')).not.toBeInTheDocument();
			});
			it('renders autorun mode skeleton', () => {
				s1_render(<DashboardSkeleton theme={theme} viewMode="autorun" />);
				expect(s1_screen.getByTestId('autorun-stats-skeleton')).toBeInTheDocument();
				expect(s1_screen.queryByTestId('summary-cards-skeleton')).not.toBeInTheDocument();
			});
			it('respects chartGridCols prop', () => {
				s1_render(<DashboardSkeleton theme={theme} chartGridCols={1} />);
				const skeleton = s1_screen.getByTestId('dashboard-skeleton');
				const chartGrid = skeleton.querySelector('.grid.gap-6');
				expect(chartGrid).toHaveStyle({
					gridTemplateColumns: 'repeat(1, minmax(0, 1fr))',
				});
			});
			it('respects summaryCardsCols prop', () => {
				s1_render(<DashboardSkeleton theme={theme} summaryCardsCols={3} />);
				const summaryCards = s1_screen.getByTestId('summary-cards-skeleton');
				expect(summaryCards).toHaveStyle({
					gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
				});
			});
			it('respects autoRunStatsCols prop', () => {
				s1_render(<DashboardSkeleton theme={theme} viewMode="autorun" autoRunStatsCols={4} />);
				const autoRunStats = s1_screen.getByTestId('autorun-stats-skeleton');
				expect(autoRunStats).toHaveStyle({
					gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
				});
			});
		});
		describe('Theme Integration', () => {
			it('uses theme border color for skeleton boxes', () => {
				s1_render(<SummaryCardsSkeleton theme={theme} />);
				const skeletonBoxes = s1_screen.getAllByTestId('skeleton-box');
				skeletonBoxes.forEach((box) => {
					expect(box).toHaveStyle({ backgroundColor: theme.colors.border });
				});
			});
			it('uses theme bgMain for card backgrounds', () => {
				s1_render(<AgentComparisonChartSkeleton theme={theme} />);
				const skeleton = s1_screen.getByTestId('agent-comparison-skeleton');
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
				s1_render(<SummaryCardsSkeleton theme={lightTheme} />);
				const skeletonBoxes = s1_screen.getAllByTestId('skeleton-box');
				skeletonBoxes.forEach((box) => {
					expect(box).toHaveStyle({ backgroundColor: lightTheme.colors.border });
				});
			});
		});
		describe('Animation', () => {
			it('all skeleton boxes have consistent animation timing', () => {
				s1_render(<DashboardSkeleton theme={theme} />);
				const skeletonBoxes = s1_screen.getAllByTestId('skeleton-box');
				skeletonBoxes.forEach((box) => {
					expect(box).toHaveStyle({
						animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
					});
				});
			});
			it('skeleton circle has animation', () => {
				s1_render(<SourceDistributionChartSkeleton theme={theme} />);
				const circle = s1_screen.getByTestId('skeleton-circle');
				expect(circle).toHaveStyle({
					animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
				});
			});
		});
		describe('Accessibility', () => {
			it('skeleton elements use opacity for visibility', () => {
				s1_render(<SummaryCardsSkeleton theme={theme} />);
				const skeletonBoxes = s1_screen.getAllByTestId('skeleton-box');
				skeletonBoxes.forEach((box) => {
					expect(box).toHaveStyle({ opacity: '0.3' });
				});
			});
			it('renders with appropriate structure for screen readers', () => {
				s1_render(<DashboardSkeleton theme={theme} />);
				// Dashboard skeleton should be recognizable as a loading state
				const skeleton = s1_screen.getByTestId('dashboard-skeleton');
				expect(skeleton).toBeInTheDocument();
			});
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/AgentEfficiencyChart.test.tsx
describe('', () => {
	let _sessionIdCounter = 0;
	function makeSession(overrides: Partial<Session> = {}): Session {
		_sessionIdCounter++;
		return {
			id: `s${_sessionIdCounter}`,
			name: `Session ${_sessionIdCounter}`,
			toolType: 'claude-code',
			state: 'idle',
			cwd: '/tmp',
			fullPath: '/tmp',
			projectRoot: '/tmp',
			aiLogs: [],
			shellLogs: [],
			workLog: [],
			contextUsage: 0,
			inputMode: 'ai',
			aiPid: 0,
			terminalPid: 0,
			port: 0,
			isLive: false,
			changedFiles: [],
			isGitRepo: false,
			fileTree: [],
			fileExplorerExpanded: [],
			fileExplorerScrollPos: 0,
			createdAt: 0,
			...overrides,
		} as Session;
	}
	/** Bar rows, found through their name labels (each row is the label's parent). */
	function barRows(container: HTMLElement): HTMLElement[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>('[data-testid="bar-chart-label"]')
		).map((label) => label.parentElement as HTMLElement);
	}
	const theme = THEMES['dracula'];
	const baseData: StatsAggregation = {
		totalQueries: 50,
		totalDuration: 3600000,
		avgDuration: 72000,
		byAgent: {
			'claude-code': { count: 30, duration: 2000000 },
			'factory-droid': { count: 20, duration: 1600000 },
		},
		bySource: { user: 35, auto: 15 },
		byDay: [],
	};
	describe('AgentEfficiencyChart', () => {
		describe('Rendering', () => {
			it('renders the title', () => {
				s2_render(<AgentEfficiencyChart data={baseData} theme={theme} />);
				expect(s2_screen.getByText('Agent Efficiency')).toBeInTheDocument();
			});
			it('renders the empty-state message when no agent data is present', () => {
				const emptyData: StatsAggregation = {
					totalQueries: 0,
					totalDuration: 0,
					avgDuration: 0,
					byAgent: {},
					bySource: { user: 0, auto: 0 },
					byDay: [],
				};
				s2_render(<AgentEfficiencyChart data={emptyData} theme={theme} />);
				expect(s2_screen.getByText('No agent query data available')).toBeInTheDocument();
			});
		});
		describe('Session Name Resolution', () => {
			it('uses the user-assigned session name when a single session matches the provider', () => {
				const session = makeSession({
					id: 'backend-api',
					name: 'Backend API',
					toolType: 'claude-code',
				});
				const data: StatsAggregation = {
					...baseData,
					byAgent: {
						'claude-code': { count: 20, duration: 1000000 },
					},
				};
				s2_render(<AgentEfficiencyChart data={data} theme={theme} sessions={[session]} />);
				expect(s2_screen.getAllByText('Backend API').length).toBeGreaterThanOrEqual(1);
				expect(s2_screen.queryByText('Claude Code')).not.toBeInTheDocument();
			});
			it('falls back to prettified type when multiple sessions share the same provider', () => {
				const a = makeSession({ id: 'a', name: 'Frontend', toolType: 'claude-code' });
				const b = makeSession({ id: 'b', name: 'Backend', toolType: 'claude-code' });
				const data: StatsAggregation = {
					...baseData,
					byAgent: {
						'claude-code': { count: 20, duration: 1000000 },
					},
				};
				s2_render(<AgentEfficiencyChart data={data} theme={theme} sessions={[a, b]} />);
				expect(s2_screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
			});
			it('disambiguates colliding display names with " (2)" suffixes', () => {
				const a = makeSession({ id: 'a', name: 'Worker', toolType: 'claude-code' });
				const b = makeSession({ id: 'b', name: 'Worker', toolType: 'opencode' });
				const data: StatsAggregation = {
					...baseData,
					byAgent: {
						'claude-code': { count: 30, duration: 2000000 },
						opencode: { count: 20, duration: 1000000 },
					},
				};
				s2_render(<AgentEfficiencyChart data={data} theme={theme} sessions={[a, b]} />);
				expect(s2_screen.getAllByText('Worker').length).toBeGreaterThanOrEqual(1);
				expect(s2_screen.getAllByText('Worker (2)').length).toBeGreaterThanOrEqual(1);
			});
			it('prettifies raw agent type keys when no sessions are provided', () => {
				s2_render(<AgentEfficiencyChart data={baseData} theme={theme} />);
				// "claude-code" → "Claude Code", "factory-droid" → "Factory Droid"
				expect(s2_screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
				expect(s2_screen.getAllByText('Factory Droid').length).toBeGreaterThanOrEqual(1);
			});
			it('shows resolved name in row title attribute (used as tooltip on truncation)', () => {
				const session = makeSession({
					id: 'backend-api',
					name: 'Backend API',
					toolType: 'claude-code',
				});
				const data: StatsAggregation = {
					...baseData,
					byAgent: {
						'claude-code': { count: 20, duration: 1000000 },
					},
				};
				const { container } = s2_render(
					<AgentEfficiencyChart data={data} theme={theme} sessions={[session]} />
				);
				const labelEl = container.querySelector(
					'[data-testid="bar-chart-label"]'
				) as HTMLElement | null;
				expect(labelEl).not.toBeNull();
				expect(labelEl?.title).toBe('Backend API');
			});
		});
		describe('Drill-down filter', () => {
			it('renders all entries at full opacity when no activeFilterKey is provided', () => {
				const { container } = s2_render(<AgentEfficiencyChart data={baseData} theme={theme} />);
				// Each row is the parent of its name label. With no filter, neither
				// row should have the dim opacity applied.
				const rows = barRows(container);
				expect(rows.length).toBe(2);
				rows.forEach((row) => {
					expect((row as HTMLElement).style.opacity).not.toBe('0.3');
				});
			});
			it('dims rows that do not match activeFilterKey to 0.3 opacity', () => {
				const { container } = s2_render(
					<AgentEfficiencyChart data={baseData} theme={theme} activeFilterKey="claude-code" />
				);
				const rows = barRows(container);
				expect(rows.length).toBe(2);
				// Two providers: claude-code (matches) and factory-droid (dimmed).
				// Sort by efficiency: data has claude-code at 2000000/30 ≈ 66667ms,
				// factory-droid at 1600000/20 = 80000ms - claude-code is faster, so
				// it renders first. We don't depend on order; instead, find the row
				// whose label is "Claude Code" vs "Factory Droid".
				const claudeRow = Array.from(rows).find((r) => r.textContent?.includes('Claude Code'));
				const factoryRow = Array.from(rows).find((r) => r.textContent?.includes('Factory Droid'));
				expect(claudeRow).toBeDefined();
				expect(factoryRow).toBeDefined();
				expect(claudeRow?.style.opacity).not.toBe('0.3');
				expect(factoryRow?.style.opacity).toBe('0.3');
			});
			it('dims all rows when activeFilterKey matches no entry', () => {
				const { container } = s2_render(
					<AgentEfficiencyChart data={baseData} theme={theme} activeFilterKey="nonexistent" />
				);
				const rows = barRows(container);
				expect(rows.length).toBe(2);
				rows.forEach((row) => {
					expect(row.style.opacity).toBe('0.3');
				});
			});
		});
		describe('Worktree Differentiation', () => {
			it('splits worktree agents into separate rows tagged with "(Worktree)"', () => {
				const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
				const worktree = makeSession({
					id: 'wt-1',
					toolType: 'claude-code',
					parentSessionId: 'parent',
				});
				const dataWithSessions: StatsAggregation = {
					...baseData,
					bySessionByDay: {
						parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
						'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
					},
				};
				s2_render(
					<AgentEfficiencyChart
						data={dataWithSessions}
						theme={theme}
						sessions={[parent, worktree]}
					/>
				);
				// Two sessions share toolType "claude-code" so the name resolves to
				// the prettified type for the regular row plus a "(Worktree)" suffix.
				expect(s2_screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
				expect(s2_screen.getAllByText('Claude Code (Worktree)').length).toBeGreaterThanOrEqual(1);
			});
			it('sizes the label column to its content so "(Worktree)" labels are not clipped', () => {
				const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
				const worktree = makeSession({
					id: 'wt-1',
					toolType: 'claude-code',
					parentSessionId: 'parent',
				});
				const dataWithSessions: StatsAggregation = {
					...baseData,
					bySessionByDay: {
						parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
						'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
					},
				};
				const { container } = s2_render(
					<AgentEfficiencyChart
						data={dataWithSessions}
						theme={theme}
						sessions={[parent, worktree]}
					/>
				);
				const labels = Array.from(
					container.querySelectorAll<HTMLElement>('[data-testid="bar-chart-label"]')
				);
				expect(labels.length).toBeGreaterThanOrEqual(2);
				// No label carries its own (estimated) width: every row sits in the
				// parent grid's shared name column, which the browser sizes to the
				// widest label it actually renders.
				for (const label of labels) {
					expect(label.style.width).toBe('');
					expect(label.parentElement?.style.gridTemplateColumns).toBe('subgrid');
				}
				const grid = labels[0].parentElement?.parentElement as HTMLElement;
				expect(grid.style.gridTemplateColumns).toBe(BAR_CHART_GRID_STYLE.gridTemplateColumns);
			});
		});
	});
});
