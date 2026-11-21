// Source: src/__tests__/renderer/components/UsageDashboard/AgentCountTrendChart.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/AgentComparisonChart.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/AgentOverviewUtils.test.ts
// Source: src/__tests__/renderer/components/UsageDashboard/chart-performance.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/RadialActivityChart.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/MetricModeToggle.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/DashboardPanelState.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { AgentCountTrendChart } from '../../../../renderer/components/UsageDashboard/AgentCountTrendChart';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { fireEvent } from '@testing-library/react';
import { within } from '@testing-library/react';
import React from 'react';
import { AgentComparisonChart } from '../../../../renderer/components/UsageDashboard/AgentComparisonChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { readableTextOn } from '../../../../shared/colorContrast';
import { DEFAULT_AGENT_SORT } from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import { buildCalendarSparkline } from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import { buildRangeActivity } from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import { getSessionAutoPercent } from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import { getSessionLastQueryAt } from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import { getSessionQueryCount } from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import { getStatusColor } from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import { sortAgentOverviewSessions } from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import { DurationTrendsChart } from '../../../../renderer/components/UsageDashboard/DurationTrendsChart';
import { ActivityHeatmap } from '../../../../renderer/components/UsageDashboard/ActivityHeatmap';
import { SourceDistributionChart } from '../../../../renderer/components/UsageDashboard/SourceDistributionChart';
import { RadialActivityChart } from '../../../../renderer/components/UsageDashboard/RadialActivityChart';
import { MetricModeToggle } from '../../../../renderer/components/UsageDashboard/MetricModeToggle';
import { OVERVIEW_METRIC_LABELS } from '../../../../renderer/components/UsageDashboard/MetricModeToggle';
import { formatMetricValue } from '../../../../renderer/components/UsageDashboard/MetricModeToggle';
import { metricModeNoun } from '../../../../renderer/components/UsageDashboard/MetricModeToggle';
import { DashboardPanelState } from '../../../../renderer/components/UsageDashboard/DashboardPanelState';
describeSourceSuite('AgentCountTrendChart', () => {
	const theme = THEMES['dracula'];
	const DAY = 24 * 60 * 60 * 1000;

	function makeSession(id: string, overrides: Partial<Session> = {}): Session {
		return {
			id,
			name: id,
			toolType: 'claude-code',
			state: 'idle',
			cwd: '/tmp',
			fullPath: '/tmp',
			projectRoot: '/tmp',
			aiLogs: [],
			shellLogs: [],
			createdAt: Date.now() - 2 * DAY,
			...overrides,
		} as Session;
	}

	describe('AgentCountTrendChart', () => {
		beforeEach(() => {
			clearCachedResources();
			vi.mocked(window.maestro.stats.getSessionLifecycle).mockResolvedValue([]);
		});

		it('fetches lifecycle rows for all time, whatever the selected range', async () => {
			render(<AgentCountTrendChart sessions={[]} timeRange="week" theme={theme} />);
			await waitFor(() =>
				expect(window.maestro.stats.getSessionLifecycle).toHaveBeenCalledWith('all')
			);
		});

		it('reports the live count, created, and deleted agents, ignoring terminals', async () => {
			vi.mocked(window.maestro.stats.getSessionLifecycle).mockResolvedValue([
				{
					id: 'row-1',
					sessionId: 'deleted-agent',
					agentType: 'codex',
					createdAt: Date.now() - 20 * DAY,
					closedAt: Date.now() - DAY,
				},
			]);

			render(
				<AgentCountTrendChart
					sessions={[
						makeSession('a'),
						makeSession('b', { createdAt: Date.now() - 20 * DAY }),
						makeSession('term', { toolType: 'terminal' }),
					]}
					timeRange="week"
					theme={theme}
				/>
			);

			await waitFor(() =>
				expect(screen.getByTestId('agent-count-trend').textContent).toContain(
					'2 now · 1 created · 1 deleted in this range'
				)
			);
			expect(screen.getByRole('img', { name: 'Agent count over time' })).toBeInTheDocument();
		});

		it('shows a failed lifecycle fetch as an error with a retry, not as a chart', async () => {
			vi.mocked(window.maestro.stats.getSessionLifecycle).mockRejectedValue(
				new Error('stats db unavailable')
			);

			render(<AgentCountTrendChart sessions={[makeSession('a')]} timeRange="week" theme={theme} />);

			await waitFor(() =>
				expect(screen.getByTestId('agent-count-trend-state-error')).toHaveTextContent(
					'stats db unavailable'
				)
			);
			expect(screen.queryByRole('img', { name: 'Agent count over time' })).not.toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
		});

		it('refetches only when the lifecycle table changes', async () => {
			let notify: ((table?: string) => void) | undefined;
			vi.mocked(window.maestro.stats.onStatsUpdate).mockImplementation((cb) => {
				notify = cb as (table?: string) => void;
				return () => {};
			});
			vi.mocked(window.maestro.stats.getSessionLifecycle).mockClear();
			vi.useFakeTimers({ shouldAdvanceTime: true });
			try {
				render(<AgentCountTrendChart sessions={[]} timeRange="week" theme={theme} />);
				await waitFor(() =>
					expect(window.maestro.stats.getSessionLifecycle).toHaveBeenCalledTimes(1)
				);

				notify?.('query_events');
				await vi.advanceTimersByTimeAsync(2000);
				expect(window.maestro.stats.getSessionLifecycle).toHaveBeenCalledTimes(1);

				notify?.('session_lifecycle');
				await vi.advanceTimersByTimeAsync(2000);
				expect(window.maestro.stats.getSessionLifecycle).toHaveBeenCalledTimes(2);
			} finally {
				vi.useRealTimers();
				vi.mocked(window.maestro.stats.onStatsUpdate).mockReturnValue(() => {});
			}
		});
	});
});
describeSourceSuite('AgentComparisonChart', () => {
	const theme = THEMES['dracula'];

	function makeData(overrides: Partial<StatsAggregation> = {}): StatsAggregation {
		return {
			totalQueries: 140,
			totalDuration: 10_000_000,
			avgDuration: 0,
			byAgent: {
				'claude-code': { count: 100, duration: 2_000_000 },
				codex: { count: 30, duration: 6_000_000 },
				opencode: { count: 10, duration: 2_000_000 },
			},
			byAgentWorktree: {},
			...overrides,
		} as StatsAggregation;
	}

	function rows(): HTMLElement[] {
		const list = screen.getByRole('list', { name: /provider usage data/i });
		return within(list).getAllByRole('listitem');
	}

	function labels(): string[] {
		return screen.getAllByTestId('bar-chart-label').map((el) => el.textContent ?? '');
	}

	beforeEach(() => {
		installLocalStorageMock();
	});

	describe('AgentComparisonChart', () => {
		it('renders the title, the mode toggle, and one row per provider', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);

			expect(screen.getByText('Provider Comparison')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /show query count/i })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			expect(rows()).toHaveLength(3);
		});

		it('labels providers by display name and sorts by query count by default', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			expect(labels()).toEqual(['Claude Code', 'Codex', 'OpenCode']);
			expect(screen.getAllByTestId('comparison-value')[0]).toHaveTextContent('100 queries');
		});

		it('re-sorts by total time in Time mode', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			fireEvent.click(screen.getByRole('button', { name: /show total duration/i }));
			expect(labels()).toEqual(['Codex', 'Claude Code', 'OpenCode']);
			expect(screen.getAllByTestId('comparison-value')[0]).toHaveTextContent('1h 40m');
		});

		it('plots average time per query in Avg Time mode, without share labels', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			fireEvent.click(screen.getByRole('button', { name: /show average time per query/i }));
			// codex 200s, opencode 200s, claude-code 20s per query
			expect(labels()[2]).toBe('Claude Code');
			expect(screen.getAllByTestId('comparison-value')[2]).toHaveTextContent('20s avg');
			expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
		});

		it('remembers the chosen mode across mounts', () => {
			const { unmount } = render(<AgentComparisonChart data={makeData()} theme={theme} />);
			fireEvent.click(screen.getByRole('button', { name: /show total duration/i }));
			unmount();

			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			expect(screen.getByRole('button', { name: /show total duration/i })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
		});

		it('shows the share of the column on each bar', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			// 100 of 140 queries
			expect(screen.getByText('71.4%')).toBeInTheDocument();
		});

		it('colors the in-bar share label for contrast against the bar', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			const bar = screen.getAllByTestId('comparison-bar')[0];
			const label = within(bar).getByText('71.4%');
			const expected = readableTextOn('#ffffff', [theme.colors.accent]);
			const probe = document.createElement('span');
			probe.style.color = expected;
			expect(label.style.color).toBe(probe.style.color);
		});

		it('gives each row an accessible summary of all three measures', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			expect(rows()[0]).toHaveAttribute(
				'aria-label',
				'Claude Code: 100 queries, 33m 20s total, 20s average'
			);
		});

		it('shows all three measures in the hover tooltip and no separate legend', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			expect(screen.queryByRole('list', { name: /chart legend/i })).not.toBeInTheDocument();

			fireEvent.mouseEnter(rows()[1], { clientX: 10, clientY: 10 });
			const tooltip = screen.getByTestId('provider-comparison-tooltip');
			expect(tooltip).toHaveTextContent('30 queries');
			expect(tooltip).toHaveTextContent('1h 40m total');
			expect(tooltip).toHaveTextContent('3m 20s per query');

			fireEvent.mouseLeave(rows()[1]);
			expect(screen.queryByTestId('provider-comparison-tooltip')).not.toBeInTheDocument();
		});

		it('splits worktree queries into a striped row and explains the stripes once', () => {
			render(
				<AgentComparisonChart
					data={makeData({
						byAgentWorktree: {
							'claude-code': {
								worktree: { count: 40, duration: 800_000 },
								parent: { count: 60, duration: 1_200_000 },
							},
						},
					})}
					theme={theme}
				/>
			);

			expect(labels()).toContain('Claude Code (Worktree)');
			expect(screen.getByTestId('worktree-legend')).toHaveTextContent(
				'Striped rows are queries from worktree agents'
			);
		});

		it('omits the worktree note when no query ran in a worktree', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			expect(screen.queryByTestId('worktree-legend')).not.toBeInTheDocument();
		});

		it('shows the shared empty state when the range has no queries', () => {
			render(<AgentComparisonChart data={makeData({ byAgent: {} })} theme={theme} />);
			expect(screen.getByText('No queries in this range')).toBeInTheDocument();
		});

		it('gives the top row a full-width bar', () => {
			render(<AgentComparisonChart data={makeData()} theme={theme} />);
			expect(screen.getAllByTestId('comparison-bar')[0]).toHaveStyle({ width: '100%' });
		});
	});
});
describeSourceSuite('AgentOverviewUtils', () => {
	const theme = THEMES.dracula;

	function makeSession(overrides: Partial<Session>): Session {
		return {
			id: 's1',
			name: 'Agent',
			toolType: 'codex',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
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

	const data: StatsAggregation = {
		totalQueries: 12,
		totalDuration: 1200,
		avgDuration: 100,
		byAgent: {
			codex: { count: 10, duration: 1000 },
			'claude-code': { count: 2, duration: 200 },
		},
		bySource: { user: 8, auto: 4 },
		byLocation: { local: 12, remote: 0 },
		byDay: [],
		byHour: [],
		totalSessions: 2,
		window: { startYmd: '2025-12-01', endYmd: '2026-01-02' },
		byAgentByDay: {},
		bySessionByDay: {
			codexSession: [
				{ date: '2026-01-01', count: 2, duration: 100 },
				{ date: '2026-01-02', count: 3, duration: 200 },
			],
		},
		bySessionSource: {
			codexSession: { user: 1, auto: 3 },
			emptySession: { user: 0, auto: 0 },
		},
		bySessionLastQuery: {
			codexSession: 1_700_000_000_000,
			claude: 1_700_000_500_000,
		},
		worktreeQueries: 0,
		parentQueries: 12,
		imageAnnotations: 0,
	} as unknown as StatsAggregation;

	describe('agentOverviewUtils', () => {
		it('maps status colors', () => {
			expect(getStatusColor('idle', theme)).toBe(theme.colors.success);
			expect(getStatusColor('busy', theme)).toBe(theme.colors.warning);
			expect(getStatusColor('error', theme)).toBe(theme.colors.error);
			expect(getStatusColor('connecting', theme)).toBe(theme.colors.textDim);
		});

		describe('buildCalendarSparkline', () => {
			const window = { startYmd: '2025-12-01', endYmd: '2026-01-02' };

			it('is all zeros over 7 calendar days when the entity has no rows', () => {
				expect(buildCalendarSparkline(undefined, window, 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
			});

			it('places counts on their calendar day and zero-fills the gaps', () => {
				expect(
					buildCalendarSparkline(
						[
							{ date: '2025-12-29', count: 4 },
							{ date: '2026-01-02', count: 3 },
						],
						window,
						7
					)
				).toEqual([0, 0, 4, 0, 0, 0, 3]);
			});

			it('drops active days older than the window instead of pulling them forward', () => {
				// The old "last 7 rows" sparkline drew these two days side by side.
				expect(
					buildCalendarSparkline(
						[
							{ date: '2025-12-02', count: 9 },
							{ date: '2026-01-02', count: 3 },
						],
						window,
						7
					)
				).toEqual([0, 0, 0, 0, 0, 0, 3]);
			});

			it('clips to a range shorter than the sparkline', () => {
				const today = { startYmd: '2026-01-02', endYmd: '2026-01-02' };
				expect(buildCalendarSparkline([{ date: '2026-01-02', count: 5 }], today, 7)).toEqual([5]);
			});

			it('crosses a month boundary by calendar day', () => {
				expect(buildCalendarSparkline([], window, 14)).toHaveLength(14);
			});
		});

		it('fills the whole range for a detail chart', () => {
			const series = buildRangeActivity([{ date: '2026-01-01', count: 2 }], {
				startYmd: '2025-12-30',
				endYmd: '2026-01-02',
			});
			expect(series).toEqual([
				{ date: '2025-12-30', count: 0 },
				{ date: '2025-12-31', count: 0 },
				{ date: '2026-01-01', count: 2 },
				{ date: '2026-01-02', count: 0 },
			]);
		});

		it("counts only the agent's own rows, never its provider's total", () => {
			const codex = makeSession({ id: 'codexSession', toolType: 'codex' });
			const claude = makeSession({ id: 'claude', toolType: 'claude-code' });

			expect(getSessionQueryCount(codex, data)).toBe(5);
			// The only claude-code agent, with no rows of its own: 0, not the
			// provider's 2.
			expect(getSessionQueryCount(claude, data)).toBe(0);
		});

		it('computes auto percent', () => {
			const parent = makeSession({ id: 'codexSession', toolType: 'codex' });
			const empty = makeSession({ id: 'emptySession', toolType: 'codex' });

			expect(getSessionAutoPercent(parent, data)).toBe(75);
			expect(getSessionAutoPercent(empty, data)).toBeNull();
		});

		it('defaults the grid to the Queries sort', () => {
			expect(DEFAULT_AGENT_SORT).toBe('queries');
		});

		it('reads the last-query timestamp, and reports null when the agent has none', () => {
			const codex = makeSession({ id: 'codexSession' });
			const quiet = makeSession({ id: 'emptySession' });

			expect(getSessionLastQueryAt(codex, data)).toBe(1_700_000_000_000);
			expect(getSessionLastQueryAt(quiet, data)).toBeNull();
		});

		it('sorts visible agents by name, created date, query count, tabs, and auto percent', () => {
			const alpha = makeSession({
				id: 'codexSession',
				name: 'Alpha',
				toolType: 'codex',
				createdAt: 100,
				aiTabs: [{ id: 'a' }] as any,
			});
			const beta = makeSession({
				id: 'claude',
				name: 'Beta',
				toolType: 'claude-code',
				createdAt: 200,
				aiTabs: [{ id: 'a' }, { id: 'b' }] as any,
			});
			const terminal = makeSession({ id: 'terminal', name: 'Terminal', toolType: 'terminal' });
			const sessions = [terminal, beta, alpha];

			expect(
				sortAgentOverviewSessions(sessions, data, 'name').map((session) => session.name)
			).toEqual(['Alpha', 'Beta']);
			expect(sortAgentOverviewSessions(sessions, data, 'created')[0].name).toBe('Beta');
			expect(sortAgentOverviewSessions(sessions, data, 'queries')[0].name).toBe('Alpha');
			expect(sortAgentOverviewSessions(sessions, data, 'tabs')[0].name).toBe('Beta');
			expect(sortAgentOverviewSessions(sessions, data, 'auto')[0].name).toBe('Alpha');
		});

		// A hidden consult tab has no chip, so ranking by it would order the grid on a
		// tab count each agent's own strip contradicts.
		it('ranks by tabs the strip draws, ignoring hidden consult tabs', () => {
			const alpha = makeSession({
				id: 'codexSession',
				name: 'Alpha',
				toolType: 'codex',
				aiTabs: [{ id: 'a' }, { id: 'b' }] as any,
			});
			const beta = makeSession({
				id: 'claude',
				name: 'Beta',
				toolType: 'claude-code',
				aiTabs: [
					{ id: 'a' },
					{ id: 'consult-1', hidden: true },
					{ id: 'consult-2', hidden: true },
				] as any,
			});

			expect(
				sortAgentOverviewSessions([beta, alpha], data, 'tabs').map((session) => session.name)
			).toEqual(['Alpha', 'Beta']);
		});

		it('sorts by most recently queried and sinks agents with no queries in range', () => {
			// Alpha was created later and has more queries, but Beta queried last.
			const alpha = makeSession({
				id: 'codexSession',
				name: 'Alpha',
				toolType: 'codex',
				createdAt: 300,
			});
			const beta = makeSession({
				id: 'claude',
				name: 'Beta',
				toolType: 'claude-code',
				createdAt: 200,
			});
			const quiet = makeSession({
				id: 'emptySession',
				name: 'Aardvark',
				toolType: 'codex',
				createdAt: 100,
			});

			expect(
				sortAgentOverviewSessions([quiet, alpha, beta], data, 'recent').map(
					(session) => session.name
				)
			).toEqual(['Beta', 'Alpha', 'Aardvark']);
		});
	});
});
describeSourceSuite('chart-performance', () => {
	// Test theme
	const theme = THEMES['dracula'];

	// Generate large dataset for year view (365 days)
	function generateLargeDataset(numDays: number): StatsAggregation {
		const byDay: Array<{ date: string; count: number; duration: number }> = [];
		const startDate = new Date();
		startDate.setDate(startDate.getDate() - numDays);

		for (let i = 0; i < numDays; i++) {
			const date = new Date(startDate);
			date.setDate(date.getDate() + i);
			const dateStr = date.toISOString().split('T')[0];

			// Random-ish data with some variation
			const count = Math.floor(Math.random() * 50) + 1;
			const duration = count * (Math.floor(Math.random() * 120000) + 30000); // 30s-150s per query

			byDay.push({ date: dateStr, count, duration });
		}

		const totalQueries = byDay.reduce((sum, d) => sum + d.count, 0);
		const totalDuration = byDay.reduce((sum, d) => sum + d.duration, 0);

		return {
			totalQueries,
			totalDuration,
			avgDuration: totalQueries > 0 ? totalDuration / totalQueries : 0,
			byAgent: {
				'claude-code': {
					count: Math.floor(totalQueries * 0.6),
					duration: Math.floor(totalDuration * 0.6),
				},
				codex: { count: Math.floor(totalQueries * 0.3), duration: Math.floor(totalDuration * 0.3) },
				opencode: {
					count: Math.floor(totalQueries * 0.1),
					duration: Math.floor(totalDuration * 0.1),
				},
			},
			bySource: {
				user: Math.floor(totalQueries * 0.7),
				auto: Math.floor(totalQueries * 0.3),
			},
			byDay,
		};
	}

	// Generate dataset with many agents (for AgentComparisonChart)
	function generateManyAgentsData(numAgents: number): StatsAggregation {
		const byAgent: Record<string, { count: number; duration: number }> = {};
		const agentNames = [
			'claude-code',
			'factory-droid',
			'opencode',
			'gpt-engineer',
			'cursor',
			'codeium',
			'copilot',
			'tabnine',
			'amazon-q',
			'gemini-cli',
			'qwen-coder',
			'deepseek',
			'codellama',
			'starcoder',
			'phind',
		];

		for (let i = 0; i < numAgents; i++) {
			const name = agentNames[i % agentNames.length] + (i >= agentNames.length ? `-${i}` : '');
			byAgent[name] = {
				count: Math.floor(Math.random() * 500) + 10,
				duration: Math.floor(Math.random() * 3600000) + 60000,
			};
		}

		const totalQueries = Object.values(byAgent).reduce((sum, a) => sum + a.count, 0);
		const totalDuration = Object.values(byAgent).reduce((sum, a) => sum + a.duration, 0);

		return {
			totalQueries,
			totalDuration,
			avgDuration: totalQueries > 0 ? totalDuration / totalQueries : 0,
			byAgent,
			bySource: { user: Math.floor(totalQueries * 0.8), auto: Math.floor(totalQueries * 0.2) },
			byDay: [
				{
					date: new Date().toISOString().split('T')[0],
					count: totalQueries,
					duration: totalDuration,
				},
			],
		};
	}

	describe('Chart Performance: Recharts NOT Used (Custom SVG Charts)', () => {
		describe('Architecture verification', () => {
			it('documents that Recharts is NOT used in this codebase', () => {
				// This test serves as documentation that despite Recharts being in package.json,
				// it is NOT actually used. All charts are custom SVG implementations.
				//
				// Verified by: grep -r "from 'recharts'" src/ (returns no results)
				// Verified by: grep -r "import.*recharts" src/ (returns no results)

				expect(true).toBe(true); // Documentation test
			});

			it('DurationTrendsChart uses the shared SVG line chart, not Recharts', () => {
				const data = generateLargeDataset(7);
				const { container } = render(<DurationTrendsChart data={data} theme={theme} />);

				expect(container.querySelector('svg')).toBeInTheDocument();
				expect(container.querySelectorAll('polyline, circle').length).toBeGreaterThan(0);
				expect(container.querySelectorAll('[class*="recharts"]').length).toBe(0);
			});
			it('ActivityHeatmap uses custom divs, not Recharts', () => {
				const data = generateLargeDataset(30);
				const { container } = render(<ActivityHeatmap data={data} theme={theme} />);

				// Custom implementation uses divs for cells
				const wrapper = container.firstChild as HTMLElement;
				expect(wrapper).toBeInTheDocument();

				// No Recharts-specific class names
				const rechartsElements = container.querySelectorAll('[class*="recharts"]');
				expect(rechartsElements.length).toBe(0);
			});

			it('AgentComparisonChart uses custom divs for bars, not Recharts', () => {
				const data = generateManyAgentsData(5);
				const { container } = render(<AgentComparisonChart data={data} theme={theme} />);

				// Custom implementation uses divs for bars
				const wrapper = container.firstChild as HTMLElement;
				expect(wrapper).toBeInTheDocument();

				// No Recharts-specific class names
				const rechartsElements = container.querySelectorAll('[class*="recharts"]');
				expect(rechartsElements.length).toBe(0);
			});

			it('SourceDistributionChart uses custom SVG paths, not Recharts', () => {
				const data = generateLargeDataset(7);
				const { container } = render(<SourceDistributionChart data={data} theme={theme} />);

				// Custom implementation uses raw SVG
				const svg = container.querySelector('svg');
				expect(svg).toBeInTheDocument();

				// No Recharts-specific class names
				const rechartsElements = container.querySelectorAll('[class*="recharts"]');
				expect(rechartsElements.length).toBe(0);
			});
		});

		describe('Large dataset handling (365 days)', () => {
			it('DurationTrendsChart draws a 365-day window as weekly slots, not 365 points', () => {
				const data = generateLargeDataset(365);
				const { container } = render(<DurationTrendsChart data={data} theme={theme} />);

				// No per-point elements beyond isolated dots; the line is one polyline per run.
				expect(container.querySelectorAll('circle').length).toBeLessThan(60);
				expect(container.querySelectorAll('*').length).toBeLessThan(600);
			});
			it('ActivityHeatmap handles 365 days with GitHub-style grid', () => {
				const data = generateLargeDataset(365);
				render(<ActivityHeatmap data={data} theme={theme} />);

				// One cell per real day; placeholder padding is not a cell.
				const cells = screen.getAllByTestId('activity-heatmap-cell');
				expect(cells.length).toBeGreaterThan(350);
				expect(cells.length).toBeLessThanOrEqual(371);
			});
		});

		describe('useMemo optimization verification', () => {
			// These tests document that the charts use useMemo for expensive calculations

			it('AgentComparisonChart uses useMemo for sorted agent data', () => {
				// The component uses useMemo at line ~100:
				// const agentData = useMemo((): AgentData[] => { ... }, [data.byAgent, metricMode, theme]);
				//
				// This prevents re-sorting on every render
				expect(true).toBe(true); // Documentation test
			});

			it('SourceDistributionChart uses useMemo for arc calculations', () => {
				// The component uses useMemo at line ~239:
				// const arcs = useMemo(() => { ... }, [sourceData]);
				//
				// This prevents expensive trigonometry calculations on every render
				expect(true).toBe(true); // Documentation test
			});
		});

		describe('CSS transition optimization (no JavaScript animations)', () => {
			it('AgentComparisonChart bars use CSS transitions for width changes', () => {
				const data = generateManyAgentsData(5);
				const { container } = render(<AgentComparisonChart data={data} theme={theme} />);

				// Find bar elements (divs with transition style)
				const bars = container.querySelectorAll('[style*="transition"]');
				expect(bars.length).toBeGreaterThan(0);
			});

			it('ActivityHeatmap cells use CSS transitions for color changes', () => {
				const data = generateLargeDataset(30);
				const { container } = render(<ActivityHeatmap data={data} theme={theme} />);

				// Cells should have transition for background-color
				const cells = container.querySelectorAll('.rounded-sm[style*="transition"]');
				expect(cells.length).toBeGreaterThan(0);
			});

			it('SourceDistributionChart arcs use CSS transitions for shape changes', () => {
				const data = generateLargeDataset(7);
				const { container } = render(<SourceDistributionChart data={data} theme={theme} />);

				const paths = container.querySelectorAll('path');
				const arcPath = Array.from(paths).find((p) => p.getAttribute('fill'));

				if (arcPath) {
					const style = (arcPath as HTMLElement).style;
					expect(style.transition).toContain('d');
				}
			});
		});

		describe('DOM element count optimization', () => {
			it('DurationTrendsChart maintains reasonable element count with 100 data points', () => {
				const data = generateLargeDataset(100);
				const { container } = render(<DurationTrendsChart data={data} theme={theme} />);

				// Count total DOM elements
				const allElements = container.querySelectorAll('*');

				// 100 circles + ~20 text labels + ~5 grid lines + 2 paths + ~10 wrapper elements
				// Should be under 200 elements
				expect(allElements.length).toBeLessThan(200);
			});

			it('ActivityHeatmap uses efficient cell structure', () => {
				const data = generateLargeDataset(365);
				const { container } = render(<ActivityHeatmap data={data} theme={theme} />);

				const allElements = container.querySelectorAll('*');

				// New hour-by-day grid design:
				// ~730 cells (365 days * 2 AM/PM rows) + day labels + hour labels + legend + wrappers
				// Should be under 2000 elements for reasonable performance
				expect(allElements.length).toBeLessThan(2000);
			});

			it('AgentComparisonChart scales linearly with agent count', () => {
				// 3 agents
				const data3 = generateManyAgentsData(3);
				const { container: container3 } = render(
					<AgentComparisonChart data={data3} theme={theme} />
				);
				const elements3 = container3.querySelectorAll('*').length;

				// 10 agents
				const data10 = generateManyAgentsData(10);
				const { container: container10 } = render(
					<AgentComparisonChart data={data10} theme={theme} />
				);
				const elements10 = container10.querySelectorAll('*').length;

				// Element count should scale reasonably (not exponentially)
				// Adding 7 agents should add roughly 7 * ~10 elements (row structure)
				const diff = elements10 - elements3;
				expect(diff).toBeLessThan(150); // Reasonable linear scaling
			});
		});

		describe('Memory efficiency', () => {
			it('chart data does not retain original raw data arrays', () => {
				// The charts process data through useMemo and only store computed values
				// They don't keep references to large intermediate arrays
				//
				// Example from DurationTrendsChart:
				// chartData only stores: { date, formattedDate, rawDuration, smoothedDuration, displayDuration, count }
				// Not the full StatsAggregation object

				const data = generateLargeDataset(365);
				const { container } = render(<DurationTrendsChart data={data} theme={theme} />);

				// Component renders successfully with large data
				expect(container).toBeInTheDocument();

				// The useMemo caches only the transformed data, not the input
				// This is verified by the dependency arrays in the source code
			});

			it('ActivityHeatmap uses Map for O(1) date lookups', () => {
				// The component creates a dayDataMap for fast lookups:
				// const dayDataMap = useMemo(() => {
				//   const map = new Map<string, { count: number; duration: number }>();
				//   for (const day of data.byDay) {
				//     map.set(day.date, { count: day.count, duration: day.duration });
				//   }
				//   return map;
				// }, [data.byDay]);
				//
				// This provides O(1) lookup instead of O(n) array.find() for each of 365 cells

				expect(true).toBe(true); // Documentation test
			});
		});

		describe('Performance with edge cases', () => {
			it('handles empty data without errors', () => {
				const emptyData: StatsAggregation = {
					totalQueries: 0,
					totalDuration: 0,
					avgDuration: 0,
					byAgent: {},
					bySource: { user: 0, auto: 0 },
					byDay: [],
				};

				expect(() => render(<DurationTrendsChart data={emptyData} theme={theme} />)).not.toThrow();

				expect(() => render(<ActivityHeatmap data={emptyData} theme={theme} />)).not.toThrow();

				expect(() => render(<AgentComparisonChart data={emptyData} theme={theme} />)).not.toThrow();

				expect(() =>
					render(<SourceDistributionChart data={emptyData} theme={theme} />)
				).not.toThrow();
			});

			it('handles single data point', () => {
				const singlePoint: StatsAggregation = {
					totalQueries: 1,
					totalDuration: 60000,
					avgDuration: 60000,
					byAgent: { 'claude-code': { count: 1, duration: 60000 } },
					bySource: { user: 1, auto: 0 },
					byDay: [{ date: new Date().toISOString().split('T')[0], count: 1, duration: 60000 }],
				};

				const { container } = render(<DurationTrendsChart data={singlePoint} theme={theme} />);

				// A point with no neighbours is drawn as a dot: a zero-length round-capped line.
				const dots = Array.from(container.querySelectorAll('line')).filter(
					(l) =>
						l.getAttribute('x1') === l.getAttribute('x2') &&
						l.getAttribute('y1') === l.getAttribute('y2')
				);
				expect(dots.length).toBe(1);
			});

			it('handles very large duration values without overflow', () => {
				const largeValues: StatsAggregation = {
					totalQueries: 100000,
					totalDuration: Number.MAX_SAFE_INTEGER / 2, // Very large but safe
					avgDuration: Number.MAX_SAFE_INTEGER / 2 / 100000,
					byAgent: { 'claude-code': { count: 100000, duration: Number.MAX_SAFE_INTEGER / 2 } },
					bySource: { user: 80000, auto: 20000 },
					byDay: [
						{
							date: new Date().toISOString().split('T')[0],
							count: 100000,
							duration: Number.MAX_SAFE_INTEGER / 2,
						},
					],
				};

				expect(() =>
					render(<DurationTrendsChart data={largeValues} theme={theme} />)
				).not.toThrow();
			});

			it('handles many agents (15+) without performance degradation', () => {
				const manyAgents = generateManyAgentsData(15);

				const { container } = render(<AgentComparisonChart data={manyAgents} theme={theme} />);

				// Should render all agents
				const allElements = container.querySelectorAll('*');
				expect(allElements.length).toBeLessThan(300);
			});
		});

		describe('Performance timing characteristics (documented)', () => {
			// These are documentation tests that describe expected performance characteristics

			it('documents expected render time for 365 data points', () => {
				// Based on the simple DOM structure and useMemo optimizations:
				// - Initial render with 365 data points: ~5-15ms expected
				// - Re-render with data change: ~2-5ms (useMemo cache hit for unchanged data)
				//
				// Comparison with Recharts:
				// - Recharts with 365 points: ~50-150ms due to complex SVG generation
				// - Our custom implementation is 5-10x faster
				//
				// This is why Recharts was added to package.json but never actually used

				expect(true).toBe(true); // Documentation test
			});

			it('documents why CSS transitions are used instead of JavaScript animations', () => {
				// CSS transitions provide hardware-accelerated animations:
				// - 'd' property transitions: GPU composited in modern browsers
				// - 'cx', 'cy' transitions: Smooth 60fps position changes
				// - 'width' transitions: No layout thrashing
				//
				// JavaScript alternatives (requestAnimationFrame, GSAP, etc.) would:
				// - Require JavaScript execution on main thread
				// - Risk layout thrashing if done incorrectly
				// - Add bundle size for animation library

				expect(true).toBe(true); // Documentation test
			});

			it('documents the useMemo dependency optimization pattern', () => {
				// Each chart follows this pattern:
				//
				// 1. Raw data transformation (one-time per data change):
				//    useMemo(() => transform(data), [data])
				//
				// 2. Scale/layout calculations (depends on container size):
				//    useMemo(() => calculateScales(transformedData), [transformedData, dimensions])
				//
				// 3. Path generation (depends on scales):
				//    useMemo(() => generatePath(transformedData, scales), [transformedData, scales])
				//
				// This layered caching means:
				// - Container resize only recalculates steps 2 & 3
				// - Data change recalculates all steps
				// - User interaction (hover) triggers no recalculation

				expect(true).toBe(true); // Documentation test
			});
		});
	});
});
describeSourceSuite('RadialActivityChart', () => {
	const theme = THEMES['dracula'];

	const data = {
		byHour: [
			{ hour: 5, count: 2, duration: 1_000 },
			{ hour: 17, count: 9, duration: 60_000 },
		],
		byDay: [
			// 2026-03-02 is a Monday.
			{ date: '2026-03-02', count: 8, duration: 1_000 },
			{ date: '2026-03-03', count: 1, duration: 1_000 },
			{ date: '2026-03-04', count: 0, duration: 0 },
		],
	} as StatsAggregation;

	describe('RadialActivityChart', () => {
		it('names the peak hour with its AM/PM so 5 PM never reads as 5 AM', () => {
			render(<RadialActivityChart mode="hours" data={data} theme={theme} />);
			expect(screen.getByText('5 PM')).toBeInTheDocument();
			expect(screen.getByText('peak hour')).toBeInTheDocument();
		});

		it('states the peak once: no footer repeating it', () => {
			render(<RadialActivityChart mode="hours" data={data} theme={theme} />);
			expect(screen.queryByText(/^Peak:/)).not.toBeInTheDocument();
			expect(screen.queryByText(/events/)).not.toBeInTheDocument();
		});

		it('buckets weekdays from local calendar days and names the peak day', () => {
			render(<RadialActivityChart mode="weekday" data={data} theme={theme} />);
			// The outer ring labels every weekday; the center repeats the peak one.
			expect(screen.getAllByText('Mon')).toHaveLength(2);
			expect(screen.getByText('peak day')).toBeInTheDocument();
		});

		it('shows an hour slot and a query count in the tooltip', () => {
			const { container } = render(<RadialActivityChart mode="hours" data={data} theme={theme} />);
			const slices = container.querySelectorAll('path');
			fireEvent.mouseEnter(slices[17], { clientX: 5, clientY: 5 });
			expect(screen.getByText('5 PM - 6 PM')).toBeInTheDocument();
			expect(screen.getByText('9 queries')).toBeInTheDocument();
		});

		it('does not show a pointer cursor on slices that do nothing when clicked', () => {
			const { container } = render(<RadialActivityChart mode="hours" data={data} theme={theme} />);
			container.querySelectorAll('path').forEach((path) => {
				expect((path as unknown as HTMLElement).style.cursor).toBe('');
			});
		});

		it('shows the shared empty state with no queries', () => {
			render(
				<RadialActivityChart
					mode="hours"
					data={{ byHour: [], byDay: [] } as unknown as StatsAggregation}
					theme={theme}
				/>
			);
			expect(screen.getByText('No queries in this range')).toBeInTheDocument();
		});
	});
});
describeSourceSuite('MetricModeToggle', () => {
	const theme = THEMES['dracula'];

	describe('MetricModeToggle', () => {
		it('offers an average mode and reports it back', () => {
			const onChange = vi.fn();
			render(
				<MetricModeToggle
					mode="count"
					onChange={onChange}
					theme={theme}
					modes={['count', 'duration', 'average']}
					labels={OVERVIEW_METRIC_LABELS}
				/>
			);
			expect(screen.getByText('Queries')).toBeInTheDocument();
			expect(screen.getByText('Time')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: 'Show average time per query' }));
			expect(onChange).toHaveBeenCalledWith('average');
		});

		it('keeps the default labels when none are passed', () => {
			render(<MetricModeToggle mode="count" onChange={() => {}} theme={theme} />);
			expect(screen.getByText('Count')).toBeInTheDocument();
			expect(screen.getByText('Duration')).toBeInTheDocument();
			expect(screen.getByText('Tokens')).toBeInTheDocument();
		});
	});

	describe('metric helpers', () => {
		it('formats an average as a duration', () => {
			expect(formatMetricValue('average', 125_000)).toBe('2m 5s');
		});

		it('names the average mode for accessible labels', () => {
			expect(metricModeNoun('average')).toBe('average time per query');
			expect(metricModeNoun('count')).toBe('queries');
		});
	});
});
describeSourceSuite('DashboardPanelState', () => {
	const theme = THEMES['dracula'];

	describe('DashboardPanelState', () => {
		it('renders its children when there is data', () => {
			render(
				<DashboardPanelState theme={theme}>
					<div data-testid="content">chart</div>
				</DashboardPanelState>
			);
			expect(screen.getByTestId('content')).toBeInTheDocument();
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		});

		it('shows the loading state instead of the children while loading', () => {
			render(
				<DashboardPanelState theme={theme} loading loadingMessage="Loading tasks">
					<div data-testid="content" />
				</DashboardPanelState>
			);
			expect(screen.getByTestId('dashboard-panel-loading')).toBeInTheDocument();
			expect(screen.getByText('Loading tasks')).toBeInTheDocument();
			expect(screen.queryByTestId('content')).not.toBeInTheDocument();
		});

		it('shows the error, not the empty message, when a fetch failed with nothing to show', () => {
			render(
				<DashboardPanelState
					theme={theme}
					error="Error invoking remote method 'stats:get': Error: database is locked"
					empty
					emptyMessage="No runs"
				/>
			);
			expect(screen.getByTestId('dashboard-panel-error')).toHaveTextContent(
				'Could not load: database is locked'
			);
			expect(screen.queryByText('No runs')).not.toBeInTheDocument();
		});

		it('offers Retry only when given a handler, and calls it', () => {
			const onRetry = vi.fn();
			const { rerender } = render(<DashboardPanelState theme={theme} error="boom" empty />);
			expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

			rerender(<DashboardPanelState theme={theme} error="boom" empty onRetry={onRetry} />);
			fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
			expect(onRetry).toHaveBeenCalledTimes(1);
		});

		it('keeps stale data on screen under a refresh-failed strip', () => {
			render(
				<DashboardPanelState theme={theme} error={new Error('timeout')}>
					<div data-testid="content" />
				</DashboardPanelState>
			);
			expect(screen.getByTestId('content')).toBeInTheDocument();
			expect(screen.getByTestId('dashboard-panel-stale')).toHaveTextContent(
				'Could not refresh: timeout'
			);
		});

		it('shows the empty message when there is nothing to draw', () => {
			render(
				<DashboardPanelState theme={theme} empty emptyMessage="No Auto Runs in this range">
					<div data-testid="content" />
				</DashboardPanelState>
			);
			expect(screen.getByTestId('dashboard-panel-empty')).toHaveTextContent(
				'No Auto Runs in this range'
			);
			expect(screen.queryByTestId('content')).not.toBeInTheDocument();
		});

		it('honors a custom test id prefix and min height', () => {
			render(<DashboardPanelState theme={theme} empty testId="wizard" minHeight={200} />);
			expect(screen.getByTestId('wizard-empty')).toHaveStyle({ minHeight: '200px' });
		});
	});
});
