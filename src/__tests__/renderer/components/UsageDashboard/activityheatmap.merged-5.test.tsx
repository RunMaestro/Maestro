// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/UsageDashboard/ActivityHeatmap.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/AgentUsageChart.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/SourceDistributionChart.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
	render as s1_render,
	screen as s1_screen,
	fireEvent as s1_fireEvent,
	within,
} from '@testing-library/react';
import S1_React from 'react';
import { ActivityHeatmap } from '../../../../renderer/components/UsageDashboard/ActivityHeatmap';
import type { StatsAggregation as S1_StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { THEMES as S1_THEMES } from '../../../../shared/themes';
import { useElementWidth } from '../../../../renderer/hooks/ui/useElementWidth';
import {
	render as s2_render,
	screen as s2_screen,
	fireEvent as s2_fireEvent,
} from '@testing-library/react';
import { AgentUsageChart } from '../../../../renderer/components/UsageDashboard/AgentUsageChart';
import type { StatsAggregation as S2_StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES as S2_THEMES } from '../../../../shared/themes';
import {
	render as s3_render,
	screen as s3_screen,
	fireEvent as s3_fireEvent,
} from '@testing-library/react';
import S3_React from 'react';
import { SourceDistributionChart } from '../../../../renderer/components/UsageDashboard/SourceDistributionChart';
import type { StatsAggregation as S3_StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { THEMES as S3_THEMES } from '../../../../shared/themes';
// The 4-hour-block month grid prints a day number per column. On a phone that
// grid is ~270px wide across ~30 columns, so each column is about 6px where a
// two-digit label needs 16 - every column printed one anyway and the row
// rendered as a solid line of overlapping digits.
vi.mock('../../../../renderer/hooks/ui/useElementWidth', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/hooks/ui/useElementWidth')>()),
	useElementWidth: vi.fn(() => 0),
}));
// Source: src/__tests__/renderer/components/UsageDashboard/ActivityHeatmap.test.tsx
describe('', () => {
	// Test theme
	const theme = S1_THEMES['dracula'];
	// Sample data for testing
	const mockData: S1_StatsAggregation = {
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
	const emptyData: S1_StatsAggregation = {
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
				s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
				expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
			});
			it('renders metric toggle buttons', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
				expect(s1_screen.getByText('Count')).toBeInTheDocument();
				expect(s1_screen.getByText('Duration')).toBeInTheDocument();
			});
			it('renders day labels (Mon, Wed, Fri visible)', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
				// Mon, Wed, Fri should be visible (idx % 2 === 1)
				expect(s1_screen.getByText('Mon')).toBeInTheDocument();
				expect(s1_screen.getByText('Wed')).toBeInTheDocument();
				expect(s1_screen.getByText('Fri')).toBeInTheDocument();
			});
			it('renders intensity legend', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
				expect(s1_screen.getByText('Less')).toBeInTheDocument();
				expect(s1_screen.getByText('More')).toBeInTheDocument();
			});
			it('renders with empty data without crashing', () => {
				s1_render(<ActivityHeatmap data={emptyData} timeRange="week" theme={theme} />);
				expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
			});
		});
		describe('Metric Mode Toggle', () => {
			it('defaults to count mode', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
				const countButton = s1_screen.getByText('Count');
				// Count button should have accent background when active
				expect(countButton).toHaveStyle({
					backgroundColor: expect.stringContaining('20'),
				});
			});
			it('switches to duration mode when clicked', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
				const durationButton = s1_screen.getByText('Duration');
				s1_fireEvent.click(durationButton);
				// Duration button should now be active
				expect(durationButton).toHaveStyle({
					color: theme.colors.accent,
				});
			});
		});
		describe('Time Range Handling', () => {
			it('renders for day time range', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="day" theme={theme} />);
				expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
			});
			it('renders for week time range', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
				expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
			});
			it('renders for month time range', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="month" theme={theme} />);
				expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
			});
			it('renders for year time range', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="year" theme={theme} />);
				expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
			});
			it('renders for all time range', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="all" theme={theme} />);
				expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
			});
		});
		describe('Theme Support', () => {
			it('applies theme background color', () => {
				const { container } = s1_render(
					<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
				);
				const wrapper = container.firstChild as HTMLElement;
				expect(wrapper).toHaveStyle({
					backgroundColor: theme.colors.bgMain,
				});
			});
			it('applies theme text colors', () => {
				s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
				const title = s1_screen.getByText('Activity Heatmap');
				expect(title).toHaveStyle({
					color: theme.colors.textMain,
				});
			});
			it('works with light theme', () => {
				const lightTheme = S1_THEMES['github-light'];
				s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={lightTheme} />);
				expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
			});
		});
		describe('Tooltip Functionality', () => {
			it('shows tooltip on cell hover', () => {
				const { container } = s1_render(
					<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
				);
				// Find a heatmap cell (the colored divs in the grid)
				const cells = container.querySelectorAll('.rounded-sm.cursor-default');
				if (cells.length > 0) {
					s1_fireEvent.mouseEnter(cells[0]);
					// Tooltip should appear with date and query count
					// Note: Tooltip content depends on the specific day data
					// We just verify a tooltip-like element appears (uses z-[99999] for high stacking)
					const tooltip = container.querySelector('.fixed.z-\\[99999\\]');
					expect(tooltip).toBeInTheDocument();
				}
			});
			it('hides tooltip on mouse leave', () => {
				const { container } = s1_render(
					<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
				);
				const cells = container.querySelectorAll('.rounded-sm.cursor-default');
				if (cells.length > 0) {
					s1_fireEvent.mouseEnter(cells[0]);
					s1_fireEvent.mouseLeave(cells[0]);
					const tooltip = container.querySelector('.fixed.z-\\[99999\\]');
					expect(tooltip).not.toBeInTheDocument();
				}
			});
		});
		describe('Data Visualization', () => {
			it('creates heatmap cells based on data', () => {
				const { container } = s1_render(
					<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
				);
				// Should have some cells rendered
				const cells = container.querySelectorAll('.rounded-sm.cursor-default');
				expect(cells.length).toBeGreaterThan(0);
			});
			it('applies different intensities based on values', () => {
				const { container } = s1_render(
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
				const { container } = s1_render(
					<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
				);
				const cells = container.querySelectorAll('.rounded-sm.cursor-default');
				expect(cells.length).toBeGreaterThan(0);
				const firstCell = cells[0] as HTMLElement;
				expect(firstCell.style.transition).toContain('background-color');
				expect(firstCell.style.transition).toContain('0.3s');
			});
			it('uses ease timing function for smooth animation curves', () => {
				const { container } = s1_render(
					<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
				);
				const cells = container.querySelectorAll('.rounded-sm.cursor-default');
				expect(cells.length).toBeGreaterThan(0);
				const firstCell = cells[0] as HTMLElement;
				expect(firstCell.style.transition).toContain('ease');
			});
			it('applies outline transition for hover effects', () => {
				const { container } = s1_render(
					<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />
				);
				const cells = container.querySelectorAll('.rounded-sm.cursor-default');
				expect(cells.length).toBeGreaterThan(0);
				const firstCell = cells[0] as HTMLElement;
				expect(firstCell.style.transition).toContain('outline');
			});
		});
	});
	function monthData(): S1_StatsAggregation {
		const byDay = Array.from({ length: 30 }, (_, i) => ({
			date: `2024-12-${String(i + 1).padStart(2, '0')}`,
			count: i,
			duration: i * 1000,
		}));
		return { ...mockData, byDay };
	}
	/** Day numbers actually printed above the 4-hour-block grid. */
	function printedDayLabels(container: HTMLElement): string[] {
		return Array.from(container.querySelectorAll('div[title]'))
			.filter((el) => /^[A-Z][a-z]+day, /.test(el.getAttribute('title') ?? ''))
			.map((el) => el.textContent ?? '')
			.filter((text) => text.length > 0);
	}
	describe('ActivityHeatmap day labels', () => {
		// The grid is built from today, not from the data. Pin the clock mid-month
		// so the 30-day window always crosses a month boundary: on the last day of
		// a 31-day month it starts on the 2nd and holds no boundary at all.
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date(2024, 11, 15, 12, 0, 0));
		});
		afterEach(() => {
			vi.useRealTimers();
			vi.mocked(useElementWidth).mockReturnValue(0);
		});
		it('labels every column when each one has room', () => {
			vi.mocked(useElementWidth).mockReturnValue(900);
			const { container } = s1_render(
				<ActivityHeatmap data={monthData()} timeRange="month" theme={theme} />
			);
			expect(printedDayLabels(container).length).toBe(30);
		});
		it('thins the labels when the columns are too narrow to print into', () => {
			vi.mocked(useElementWidth).mockReturnValue(270);
			const { container } = s1_render(
				<ActivityHeatmap data={monthData()} timeRange="month" theme={theme} />
			);
			const labels = printedDayLabels(container);
			expect(labels.length).toBeGreaterThan(1);
			expect(labels.length).toBeLessThan(30);
			// The month boundary is the one label kept off-stride: a month
			// abbreviation among the day numbers.
			expect(labels.filter((text) => !/^\d+$/.test(text)).length).toBeGreaterThanOrEqual(1);
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/AgentUsageChart.test.tsx
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
	const theme = S2_THEMES['dracula'];
	const baseEmptyData: S2_StatsAggregation = {
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
		bySessionSource: {},
	};
	function dataForSessions(
		sessionDays: Record<
			string,
			Array<{
				date: string;
				count: number;
				duration: number;
			}>
		>
	): S2_StatsAggregation {
		return { ...baseEmptyData, bySessionByDay: sessionDays };
	}
	describe('AgentUsageChart', () => {
		describe('Rendering', () => {
			it('renders the title', () => {
				s2_render(<AgentUsageChart data={baseEmptyData} timeRange="week" theme={theme} />);
				expect(s2_screen.getByText('Agent Usage Over Time')).toBeInTheDocument();
			});
			it('renders the empty-state message when no session data is present', () => {
				s2_render(<AgentUsageChart data={baseEmptyData} timeRange="week" theme={theme} />);
				expect(s2_screen.getByText('No usage data available')).toBeInTheDocument();
			});
		});
		describe('Session Name Resolution', () => {
			it('uses the user-assigned session name when the stat key matches a session', () => {
				const session = makeSession({ id: 'sess-aaa', name: 'Backend API' });
				const data = dataForSessions({
					'sess-aaa': [{ date: '2024-12-20', count: 5, duration: 60000 }],
				});
				s2_render(
					<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={[session]} />
				);
				expect(s2_screen.getByText('Backend API')).toBeInTheDocument();
			});
			it('matches stat keys with tab-id suffixes back to the underlying session', () => {
				const session = makeSession({ id: 'sess-bbb', name: 'Frontend' });
				const data = dataForSessions({
					'sess-bbb-ai-tab1': [{ date: '2024-12-20', count: 3, duration: 30000 }],
				});
				s2_render(
					<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={[session]} />
				);
				expect(s2_screen.getByText('Frontend')).toBeInTheDocument();
			});
			it('disambiguates colliding session names with " (2)" suffixes', () => {
				const a = makeSession({ id: 'sess-aaa', name: 'Worker' });
				const b = makeSession({ id: 'sess-bbb', name: 'Worker' });
				const data = dataForSessions({
					'sess-aaa': [{ date: '2024-12-20', count: 5, duration: 60000 }],
					'sess-bbb': [{ date: '2024-12-20', count: 3, duration: 30000 }],
				});
				s2_render(<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={[a, b]} />);
				expect(s2_screen.getByText('Worker')).toBeInTheDocument();
				expect(s2_screen.getByText('Worker (2)')).toBeInTheDocument();
			});
			it('appends " (WT)" suffix to worktree-child session names', () => {
				const parent = makeSession({ id: 'parent', name: 'Main App' });
				const worktree = makeSession({
					id: 'wt-1',
					name: 'Feature Branch',
					parentSessionId: 'parent',
				});
				const data = dataForSessions({
					parent: [{ date: '2024-12-20', count: 5, duration: 60000 }],
					'wt-1': [{ date: '2024-12-20', count: 3, duration: 30000 }],
				});
				s2_render(
					<AgentUsageChart
						data={data}
						timeRange="week"
						theme={theme}
						sessions={[parent, worktree]}
					/>
				);
				expect(s2_screen.getByText('Main App')).toBeInTheDocument();
				expect(s2_screen.getByText('Feature Branch (WT)')).toBeInTheDocument();
			});
			it('falls back to a prettified key when no matching session exists', () => {
				// "claude-code" is the canonical agent id, so prettifyAgentType returns
				// "Claude Code" - used as the legend label when no session is registered
				// for this stat key.
				const data = dataForSessions({
					'claude-code': [{ date: '2024-12-20', count: 5, duration: 60000 }],
				});
				s2_render(<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={[]} />);
				expect(s2_screen.getByText('Claude Code')).toBeInTheDocument();
			});
		});
		describe('Drill-down filter', () => {
			// Two-session fixture used across the drill-down tests below.
			function buildTwoSessionFixture() {
				const sessionA = makeSession({ id: 'sess-aaa', name: 'Backend' });
				const sessionB = makeSession({ id: 'sess-bbb', name: 'Frontend' });
				const data = dataForSessions({
					'sess-aaa': [{ date: '2024-12-20', count: 5, duration: 60000 }],
					'sess-bbb': [{ date: '2024-12-20', count: 3, duration: 30000 }],
				});
				return { sessions: [sessionA, sessionB], data };
			}
			it('renders legend items as non-interactive when onAgentClick is not provided', () => {
				const { sessions, data } = buildTwoSessionFixture();
				const { container } = s2_render(
					<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={sessions} />
				);
				const legendButtons = container.querySelectorAll('[role="button"]');
				expect(legendButtons.length).toBe(0);
			});
			it('renders legend items as buttons with tabIndex when onAgentClick is provided', () => {
				const { sessions, data } = buildTwoSessionFixture();
				const { container } = s2_render(
					<AgentUsageChart
						data={data}
						timeRange="week"
						theme={theme}
						sessions={sessions}
						onAgentClick={vi.fn()}
					/>
				);
				const legendButtons = container.querySelectorAll('[role="button"]');
				// Sorted by total queries desc → Backend (5), Frontend (3).
				expect(legendButtons.length).toBe(2);
				legendButtons.forEach((btn) => {
					expect(btn.getAttribute('tabIndex')).toBe('0');
					expect((btn as HTMLElement).style.cursor).toBe('pointer');
				});
			});
			it('fires onAgentClick with the session key and resolved display name', () => {
				const { sessions, data } = buildTwoSessionFixture();
				const onAgentClick = vi.fn();
				const { container } = s2_render(
					<AgentUsageChart
						data={data}
						timeRange="week"
						theme={theme}
						sessions={sessions}
						onAgentClick={onAgentClick}
					/>
				);
				const legendButtons = container.querySelectorAll('[role="button"]');
				s2_fireEvent.click(legendButtons[0]); // Backend (sorted first by total)
				expect(onAgentClick).toHaveBeenCalledTimes(1);
				expect(onAgentClick).toHaveBeenCalledWith('sess-aaa', 'Backend');
			});
			it('fires onAgentClick on Enter and Space key activation', () => {
				const { sessions, data } = buildTwoSessionFixture();
				const onAgentClick = vi.fn();
				const { container } = s2_render(
					<AgentUsageChart
						data={data}
						timeRange="week"
						theme={theme}
						sessions={sessions}
						onAgentClick={onAgentClick}
					/>
				);
				const legendButtons = container.querySelectorAll('[role="button"]');
				s2_fireEvent.keyDown(legendButtons[0], { key: 'Enter' });
				s2_fireEvent.keyDown(legendButtons[0], { key: ' ' });
				expect(onAgentClick).toHaveBeenCalledTimes(2);
			});
			it('highlights the matching legend item with an accent background', () => {
				const { sessions, data } = buildTwoSessionFixture();
				const { container } = s2_render(
					<AgentUsageChart
						data={data}
						timeRange="week"
						theme={theme}
						sessions={sessions}
						onAgentClick={vi.fn()}
						activeFilterKey="sess-aaa"
					/>
				);
				const legendButtons = container.querySelectorAll(
					'[role="button"]'
				) as NodeListOf<HTMLElement>;
				// Backend (sorted first) is selected; Frontend is not.
				expect(legendButtons[0].style.backgroundColor).not.toBe('');
				expect(legendButtons[1].style.backgroundColor).toBe('');
			});
			it('reflects selection state via aria-pressed', () => {
				const { sessions, data } = buildTwoSessionFixture();
				const { container } = s2_render(
					<AgentUsageChart
						data={data}
						timeRange="week"
						theme={theme}
						sessions={sessions}
						onAgentClick={vi.fn()}
						activeFilterKey="sess-bbb"
					/>
				);
				const legendButtons = container.querySelectorAll('[role="button"]');
				// Sorted: Backend (false), Frontend (true).
				expect(legendButtons[0].getAttribute('aria-pressed')).toBe('false');
				expect(legendButtons[1].getAttribute('aria-pressed')).toBe('true');
			});
			it('dims non-selected lines to 0.15 stroke-opacity and thickens the selected line', () => {
				const { sessions, data } = buildTwoSessionFixture();
				const { container } = s2_render(
					<AgentUsageChart
						data={data}
						timeRange="week"
						theme={theme}
						sessions={sessions}
						onAgentClick={vi.fn()}
						activeFilterKey="sess-aaa"
					/>
				);
				// Two lines, sorted: sess-aaa (selected), sess-bbb (dimmed).
				const lines = container.querySelectorAll('path');
				expect(lines.length).toBe(2);
				expect(lines[0].getAttribute('stroke-opacity')).toBe('1');
				expect(lines[0].getAttribute('stroke-width')).toBe('2.5');
				expect(lines[1].getAttribute('stroke-opacity')).toBe('0.15');
				expect(lines[1].getAttribute('stroke-width')).toBe('2');
			});
			it('renders all lines at full opacity and default width when no filter is active', () => {
				const { sessions, data } = buildTwoSessionFixture();
				const { container } = s2_render(
					<AgentUsageChart
						data={data}
						timeRange="week"
						theme={theme}
						sessions={sessions}
						onAgentClick={vi.fn()}
						activeFilterKey={null}
					/>
				);
				const lines = container.querySelectorAll('path');
				lines.forEach((line) => {
					expect(line.getAttribute('stroke-opacity')).toBe('1');
					expect(line.getAttribute('stroke-width')).toBe('2');
				});
			});
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/SourceDistributionChart.test.tsx
describe('', () => {
	// Test theme
	const theme = S3_THEMES['dracula'];
	// Sample data for testing
	const mockData: S3_StatsAggregation = {
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
	const interactiveOnlyData: S3_StatsAggregation = {
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
	const autoOnlyData: S3_StatsAggregation = {
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
	const emptyData: S3_StatsAggregation = {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byDay: [],
	};
	// Data with equal distribution
	const equalDistributionData: S3_StatsAggregation = {
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
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				expect(s3_screen.getByText('Session Type')).toBeInTheDocument();
			});
			it('renders metric toggle buttons', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				expect(s3_screen.getByText('Count')).toBeInTheDocument();
				expect(s3_screen.getByText('Duration')).toBeInTheDocument();
			});
			it('renders SVG donut chart', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const svg = container.querySelector('svg');
				expect(svg).toBeInTheDocument();
			});
			it('renders chart segments as paths', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const paths = container.querySelectorAll('svg path');
				expect(paths.length).toBe(2); // Interactive and Auto
			});
			it('renders with empty data showing message', () => {
				s3_render(<SourceDistributionChart data={emptyData} theme={theme} />);
				expect(s3_screen.getByText('No source data available')).toBeInTheDocument();
			});
			it('renders single source (interactive only) correctly', () => {
				s3_render(<SourceDistributionChart data={interactiveOnlyData} theme={theme} />);
				expect(s3_screen.getByText('Interactive')).toBeInTheDocument();
				// With only interactive, should show 100%
				expect(s3_screen.getByText(/100\.0%/)).toBeInTheDocument();
			});
			it('renders single source (auto only) correctly', () => {
				s3_render(<SourceDistributionChart data={autoOnlyData} theme={theme} />);
				expect(s3_screen.getByText('Auto Run')).toBeInTheDocument();
				// With only auto, should show 100%
				expect(s3_screen.getByText(/100\.0%/)).toBeInTheDocument();
			});
		});
		describe('Center Label', () => {
			it('shows total count in count mode', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				// Total is 35 + 15 = 50
				expect(s3_screen.getByText('50')).toBeInTheDocument();
				expect(s3_screen.getByText('total')).toBeInTheDocument();
			});
			it('shows total duration in duration mode', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				// Switch to duration mode
				s3_fireEvent.click(s3_screen.getByText('Duration'));
				// Should show formatted duration
				expect(s3_screen.getByText('time')).toBeInTheDocument();
			});
			it('formats large numbers with K suffix', () => {
				const largeData: S3_StatsAggregation = {
					...mockData,
					bySource: { user: 1500, auto: 500 },
				};
				s3_render(<SourceDistributionChart data={largeData} theme={theme} />);
				// Total is 2000, should show as 2K (with decimal)
				expect(s3_screen.getByText('2.0K')).toBeInTheDocument();
			});
		});
		describe('Legend', () => {
			it('renders legend with source labels', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				expect(s3_screen.getByText('Interactive')).toBeInTheDocument();
				expect(s3_screen.getByText('Auto Run')).toBeInTheDocument();
			});
			it('shows percentages in legend', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				// Interactive is 35/50 = 70%, Auto is 15/50 = 30%
				expect(s3_screen.getByText(/70\.0%/)).toBeInTheDocument();
				expect(s3_screen.getByText(/30\.0%/)).toBeInTheDocument();
			});
			it('shows color indicators for each source', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				// Legend color indicators
				const colorIndicators = container.querySelectorAll('.w-3.h-3.rounded-sm');
				expect(colorIndicators.length).toBe(2);
			});
			it('highlights legend item on hover', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				// Find legend item container
				const legendItems = container.querySelectorAll('.flex.items-center.gap-3.cursor-default');
				if (legendItems.length > 0) {
					const labelBefore = legendItems[0].querySelector('.text-sm.font-medium');
					expect(labelBefore).toHaveStyle({ color: theme.colors.textDim });
					s3_fireEvent.mouseEnter(legendItems[0]);
					const labelAfter = legendItems[0].querySelector('.text-sm.font-medium');
					expect(labelAfter).toHaveStyle({ color: theme.colors.textMain });
				}
			});
		});
		describe('Metric Mode Toggle', () => {
			it('defaults to count mode', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const countButton = s3_screen.getByText('Count');
				expect(countButton).toHaveStyle({
					color: theme.colors.accent,
				});
			});
			it('switches to duration mode when clicked', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const durationButton = s3_screen.getByText('Duration');
				s3_fireEvent.click(durationButton);
				expect(durationButton).toHaveStyle({
					color: theme.colors.accent,
				});
			});
			it('updates legend values when switching modes', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				// In count mode, should show count values
				expect(s3_screen.getByText(/35$/)).toBeInTheDocument(); // Interactive: 35
				// Switch to duration mode
				s3_fireEvent.click(s3_screen.getByText('Duration'));
				// Should now show duration-based values
				// Legend text should update to show time values
				const legendTexts = s3_screen.getAllByText(/•/);
				expect(legendTexts.length).toBeGreaterThan(0);
			});
		});
		describe('Chart Segments', () => {
			it('uses accent color for interactive segment', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const paths = container.querySelectorAll('svg path');
				const fills = Array.from(paths).map((p) => (p as SVGPathElement).getAttribute('fill'));
				// Interactive segment should use accent color
				expect(fills).toContain(theme.colors.accent);
			});
			it('uses different color for auto segment', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const paths = container.querySelectorAll('svg path');
				const fills = Array.from(paths)
					.map((p) => (p as SVGPathElement).getAttribute('fill'))
					.filter((f) => f !== null);
				// Should have 2 different colors
				expect(new Set(fills).size).toBe(2);
			});
			it('renders full donut for single source', () => {
				const { container } = s3_render(
					<SourceDistributionChart data={interactiveOnlyData} theme={theme} />
				);
				const paths = container.querySelectorAll('svg path');
				expect(paths.length).toBe(1);
			});
			it('shows equal segments for 50/50 distribution', () => {
				s3_render(<SourceDistributionChart data={equalDistributionData} theme={theme} />);
				// Both should show 50%
				const percentages = s3_screen.getAllByText(/50\.0%/);
				expect(percentages.length).toBe(2);
			});
		});
		// Note: Tooltip functionality was removed in commit 287821dd
		// "Source distribution chart simplified by removing floating tooltip overlay"
		// The chart now uses legend highlighting on hover instead of a floating tooltip
		describe('Hover Effects', () => {
			it('expands segment on hover', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const paths = container.querySelectorAll('svg path');
				if (paths.length > 0) {
					// Before hover, segment should have normal opacity
					expect(paths[0]).toHaveAttribute('opacity', '1');
					s3_fireEvent.mouseEnter(paths[0]);
					// Hovered segment stays at opacity 1
					expect(paths[0]).toHaveAttribute('opacity', '1');
					// Other segment should dim
					if (paths.length > 1) {
						expect(paths[1]).toHaveAttribute('opacity', '0.5');
					}
				}
			});
			it('dims other segments when one is hovered', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const paths = container.querySelectorAll('svg path');
				if (paths.length > 1) {
					s3_fireEvent.mouseEnter(paths[0]);
					expect(paths[1]).toHaveAttribute('opacity', '0.5');
				}
			});
			it('restores opacity on mouse leave', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const paths = container.querySelectorAll('svg path');
				if (paths.length > 1) {
					s3_fireEvent.mouseEnter(paths[0]);
					s3_fireEvent.mouseLeave(paths[0]);
					expect(paths[1]).toHaveAttribute('opacity', '1');
				}
			});
		});
		describe('Theme Support', () => {
			it('applies theme background color', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const wrapper = container.firstChild as HTMLElement;
				expect(wrapper).toHaveStyle({
					backgroundColor: theme.colors.bgMain,
				});
			});
			it('applies theme text colors', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const title = s3_screen.getByText('Session Type');
				expect(title).toHaveStyle({
					color: theme.colors.textMain,
				});
			});
			it('works with light theme', () => {
				const lightTheme = S3_THEMES['github-light'];
				s3_render(<SourceDistributionChart data={mockData} theme={lightTheme} />);
				expect(s3_screen.getByText('Session Type')).toBeInTheDocument();
			});
			it('applies border colors from theme', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				// Toggle buttons should have border
				const toggleContainer = container.querySelector('.flex.rounded.overflow-hidden.border');
				expect(toggleContainer).toHaveStyle({
					borderColor: theme.colors.border,
				});
			});
			it('center label uses theme text colors', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
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
				const largeData: S3_StatsAggregation = {
					...mockData,
					bySource: { user: 5000, auto: 3000 },
				};
				s3_render(<SourceDistributionChart data={largeData} theme={theme} />);
				expect(s3_screen.getByText('8.0K')).toBeInTheDocument();
			});
			it('formats millions with M suffix', () => {
				const hugeData: S3_StatsAggregation = {
					...mockData,
					bySource: { user: 1500000, auto: 500000 },
				};
				s3_render(<SourceDistributionChart data={hugeData} theme={theme} />);
				expect(s3_screen.getByText('2.0M')).toBeInTheDocument();
			});
			it('formats duration correctly in duration mode', () => {
				const durationData: S3_StatsAggregation = {
					...mockData,
					totalDuration: 7200000, // 2 hours
					bySource: { user: 40, auto: 10 },
				};
				s3_render(<SourceDistributionChart data={durationData} theme={theme} />);
				s3_fireEvent.click(s3_screen.getByText('Duration'));
				// Should show hours/minutes format
				expect(s3_screen.getByText('time')).toBeInTheDocument();
			});
		});
		describe('Edge Cases', () => {
			it('handles zero total gracefully', () => {
				s3_render(<SourceDistributionChart data={emptyData} theme={theme} />);
				expect(s3_screen.getByText('No source data available')).toBeInTheDocument();
			});
			it('handles very small percentages', () => {
				const skewedData: S3_StatsAggregation = {
					...mockData,
					bySource: { user: 999, auto: 1 },
				};
				s3_render(<SourceDistributionChart data={skewedData} theme={theme} />);
				// Should show 0.1% for auto
				expect(s3_screen.getByText(/0\.1%/)).toBeInTheDocument();
			});
			it('handles very large percentages', () => {
				const skewedData: S3_StatsAggregation = {
					...mockData,
					bySource: { user: 999, auto: 1 },
				};
				s3_render(<SourceDistributionChart data={skewedData} theme={theme} />);
				// Should show 99.9% for interactive
				expect(s3_screen.getByText(/99\.9%/)).toBeInTheDocument();
			});
		});
		describe('Smooth Animations', () => {
			it('applies CSS transitions to arc paths for smooth updates', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const paths = container.querySelectorAll('svg path');
				expect(paths.length).toBeGreaterThan(0);
				// All arc paths should have transition styles
				const firstPath = paths[0] as HTMLElement;
				expect(firstPath.style.transition).toContain('d');
				expect(firstPath.style.transition).toContain('0.5s');
			});
			it('uses cubic-bezier easing for smooth animation curves', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const paths = container.querySelectorAll('svg path');
				expect(paths.length).toBeGreaterThan(0);
				const firstPath = paths[0] as HTMLElement;
				expect(firstPath.style.transition).toContain('cubic-bezier');
			});
			it('applies opacity transition for hover effects', () => {
				const { container } = s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				const paths = container.querySelectorAll('svg path');
				expect(paths.length).toBeGreaterThan(0);
				const firstPath = paths[0] as HTMLElement;
				expect(firstPath.style.transition).toContain('opacity');
			});
		});
		describe('Cue slice (3-way breakdown)', () => {
			it('renders only Interactive and Auto Run when cueTotals is omitted', () => {
				s3_render(<SourceDistributionChart data={mockData} theme={theme} />);
				expect(s3_screen.getByText('Session Type')).toBeInTheDocument();
				expect(s3_screen.getByText('Interactive')).toBeInTheDocument();
				expect(s3_screen.getByText('Auto Run')).toBeInTheDocument();
				expect(s3_screen.queryByText('Cue')).not.toBeInTheDocument();
			});
			it('adds a Cue slice and relabels the chart when cueTotals is provided', () => {
				s3_render(
					<SourceDistributionChart
						data={mockData}
						theme={theme}
						cueTotals={{ occurrences: 15, totalDurationMs: 600000 }}
					/>
				);
				// Title switches from "Session Type" to the broader "Activity Source"
				expect(s3_screen.getByText('Activity Source')).toBeInTheDocument();
				expect(s3_screen.queryByText('Session Type')).not.toBeInTheDocument();
				expect(s3_screen.getByText('Cue')).toBeInTheDocument();
			});
			it('hides the Cue slice (and keeps the Session Type title) when Cue is idle in range', () => {
				s3_render(
					<SourceDistributionChart
						data={mockData}
						theme={theme}
						cueTotals={{ occurrences: 0, totalDurationMs: 0 }}
					/>
				);
				// Cue enabled but zero usage: zero-value slices are hidden, matching
				// the original two-way donut, so the chart looks unchanged.
				expect(s3_screen.getByText('Session Type')).toBeInTheDocument();
				expect(s3_screen.queryByText('Cue')).not.toBeInTheDocument();
			});
			it('includes Cue occurrences in the count total and percentages', () => {
				// user 35 + auto 15 + cue 50 = 100 total; Cue should read 50.0%
				s3_render(
					<SourceDistributionChart
						data={mockData}
						theme={theme}
						cueTotals={{ occurrences: 50, totalDurationMs: 600000 }}
					/>
				);
				expect(s3_screen.getByText('100')).toBeInTheDocument();
				expect(s3_screen.getByText(/50\.0%/)).toBeInTheDocument();
			});
			it('treats an all-zero range with Cue enabled as having data', () => {
				s3_render(
					<SourceDistributionChart
						data={emptyData}
						theme={theme}
						cueTotals={{ occurrences: 4, totalDurationMs: 120000 }}
					/>
				);
				// With Cue occurrences present, the empty-state message must not show.
				expect(s3_screen.queryByText('No source data available')).not.toBeInTheDocument();
				expect(s3_screen.getByText('Cue')).toBeInTheDocument();
			});
		});
	});
});
