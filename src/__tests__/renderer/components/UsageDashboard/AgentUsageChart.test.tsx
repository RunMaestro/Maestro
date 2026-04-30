/**
 * Tests for AgentUsageChart component
 *
 * Focuses on session-name resolution behavior shared with the other dashboard
 * charts: session keys from `bySessionByDay` are resolved via `buildNameMap`
 * so the line legend, tooltips, and aria labels show user-assigned session
 * names (or the prettified type fallback) instead of raw UUID prefixes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentUsageChart } from '../../../../renderer/components/UsageDashboard/AgentUsageChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

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

const theme = THEMES['dracula'];

const baseEmptyData: StatsAggregation = {
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

function dataForSessions(
	sessionDays: Record<string, Array<{ date: string; count: number; duration: number }>>
): StatsAggregation {
	return { ...baseEmptyData, bySessionByDay: sessionDays };
}

describe('AgentUsageChart', () => {
	describe('Rendering', () => {
		it('renders the title', () => {
			render(<AgentUsageChart data={baseEmptyData} timeRange="week" theme={theme} />);
			expect(screen.getByText('Agent Usage Over Time')).toBeInTheDocument();
		});

		it('renders the empty-state message when no session data is present', () => {
			render(<AgentUsageChart data={baseEmptyData} timeRange="week" theme={theme} />);
			expect(screen.getByText('No usage data available')).toBeInTheDocument();
		});
	});

	describe('Session Name Resolution', () => {
		it('uses the user-assigned session name when the stat key matches a session', () => {
			const session = makeSession({ id: 'sess-aaa', name: 'Backend API' });
			const data = dataForSessions({
				'sess-aaa': [{ date: '2024-12-20', count: 5, duration: 60_000 }],
			});

			render(<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={[session]} />);

			expect(screen.getByText('Backend API')).toBeInTheDocument();
		});

		it('matches stat keys with tab-id suffixes back to the underlying session', () => {
			const session = makeSession({ id: 'sess-bbb', name: 'Frontend' });
			const data = dataForSessions({
				'sess-bbb-ai-tab1': [{ date: '2024-12-20', count: 3, duration: 30_000 }],
			});

			render(<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={[session]} />);

			expect(screen.getByText('Frontend')).toBeInTheDocument();
		});

		it('disambiguates colliding session names with " (2)" suffixes', () => {
			const a = makeSession({ id: 'sess-aaa', name: 'Worker' });
			const b = makeSession({ id: 'sess-bbb', name: 'Worker' });
			const data = dataForSessions({
				'sess-aaa': [{ date: '2024-12-20', count: 5, duration: 60_000 }],
				'sess-bbb': [{ date: '2024-12-20', count: 3, duration: 30_000 }],
			});

			render(<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={[a, b]} />);

			expect(screen.getByText('Worker')).toBeInTheDocument();
			expect(screen.getByText('Worker (2)')).toBeInTheDocument();
		});

		it('appends " (WT)" suffix to worktree-child session names', () => {
			const parent = makeSession({ id: 'parent', name: 'Main App' });
			const worktree = makeSession({
				id: 'wt-1',
				name: 'Feature Branch',
				parentSessionId: 'parent',
			});
			const data = dataForSessions({
				parent: [{ date: '2024-12-20', count: 5, duration: 60_000 }],
				'wt-1': [{ date: '2024-12-20', count: 3, duration: 30_000 }],
			});

			render(
				<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={[parent, worktree]} />
			);

			expect(screen.getByText('Main App')).toBeInTheDocument();
			expect(screen.getByText('Feature Branch (WT)')).toBeInTheDocument();
		});

		it('falls back to a prettified key when no matching session exists', () => {
			// "claude-code" is the canonical agent id, so prettifyAgentType returns
			// "Claude Code" — used as the legend label when no session is registered
			// for this stat key.
			const data = dataForSessions({
				'claude-code': [{ date: '2024-12-20', count: 5, duration: 60_000 }],
			});

			render(<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={[]} />);

			expect(screen.getByText('Claude Code')).toBeInTheDocument();
		});
	});

	describe('Drill-down filter', () => {
		// Two-session fixture used across the drill-down tests below.
		function buildTwoSessionFixture() {
			const sessionA = makeSession({ id: 'sess-aaa', name: 'Backend' });
			const sessionB = makeSession({ id: 'sess-bbb', name: 'Frontend' });
			const data = dataForSessions({
				'sess-aaa': [{ date: '2024-12-20', count: 5, duration: 60_000 }],
				'sess-bbb': [{ date: '2024-12-20', count: 3, duration: 30_000 }],
			});
			return { sessions: [sessionA, sessionB], data };
		}

		it('renders legend items as non-interactive when onAgentClick is not provided', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const { container } = render(
				<AgentUsageChart data={data} timeRange="week" theme={theme} sessions={sessions} />
			);

			const legendButtons = container.querySelectorAll('[role="button"]');
			expect(legendButtons.length).toBe(0);
		});

		it('renders legend items as buttons with tabIndex when onAgentClick is provided', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const { container } = render(
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
			const { container } = render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme}
					sessions={sessions}
					onAgentClick={onAgentClick}
				/>
			);

			const legendButtons = container.querySelectorAll('[role="button"]');
			fireEvent.click(legendButtons[0]); // Backend (sorted first by total)

			expect(onAgentClick).toHaveBeenCalledTimes(1);
			expect(onAgentClick).toHaveBeenCalledWith('sess-aaa', 'Backend');
		});

		it('fires onAgentClick on Enter and Space key activation', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const onAgentClick = vi.fn();
			const { container } = render(
				<AgentUsageChart
					data={data}
					timeRange="week"
					theme={theme}
					sessions={sessions}
					onAgentClick={onAgentClick}
				/>
			);

			const legendButtons = container.querySelectorAll('[role="button"]');
			fireEvent.keyDown(legendButtons[0], { key: 'Enter' });
			fireEvent.keyDown(legendButtons[0], { key: ' ' });

			expect(onAgentClick).toHaveBeenCalledTimes(2);
		});

		it('highlights the matching legend item with an accent background', () => {
			const { sessions, data } = buildTwoSessionFixture();
			const { container } = render(
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
			const { container } = render(
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
			const { container } = render(
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
			const { container } = render(
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
