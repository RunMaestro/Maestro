/**
 * Tests for AgentEfficiencyChart component
 *
 * Focuses on the name resolution behavior shared with the other dashboard
 * charts: provider keys are resolved via `buildNameMap` so chart labels and
 * row titles show the user-assigned session names (or the prettified type
 * fallback) instead of raw "claude-code"-style identifiers.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentEfficiencyChart } from '../../../../renderer/components/UsageDashboard/AgentEfficiencyChart';
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
			render(<AgentEfficiencyChart data={baseData} theme={theme} />);
			expect(screen.getByText('Agent Efficiency')).toBeInTheDocument();
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
			render(<AgentEfficiencyChart data={emptyData} theme={theme} />);
			expect(screen.getByText('No agent query data available')).toBeInTheDocument();
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

			render(<AgentEfficiencyChart data={data} theme={theme} sessions={[session]} />);

			expect(screen.getAllByText('Backend API').length).toBeGreaterThanOrEqual(1);
			expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
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

			render(<AgentEfficiencyChart data={data} theme={theme} sessions={[a, b]} />);

			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
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

			render(<AgentEfficiencyChart data={data} theme={theme} sessions={[a, b]} />);

			expect(screen.getAllByText('Worker').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Worker (2)').length).toBeGreaterThanOrEqual(1);
		});

		it('prettifies raw agent type keys when no sessions are provided', () => {
			render(<AgentEfficiencyChart data={baseData} theme={theme} />);
			// "claude-code" → "Claude Code", "factory-droid" → "Factory Droid"
			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Factory Droid').length).toBeGreaterThanOrEqual(1);
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

			const { container } = render(
				<AgentEfficiencyChart data={data} theme={theme} sessions={[session]} />
			);

			const labelEl = container.querySelector('.w-28[title]') as HTMLElement | null;
			expect(labelEl).not.toBeNull();
			expect(labelEl?.title).toBe('Backend API');
		});
	});

	describe('Drill-down filter', () => {
		it('renders all entries at full opacity when no activeFilterKey is provided', () => {
			const { container } = render(<AgentEfficiencyChart data={baseData} theme={theme} />);
			// Row containers live at the top of the .space-y-3 wrapper as
			// `.flex.items-center.gap-3` divs. With no filter, neither row should
			// have the dim opacity applied.
			const rows = container.querySelectorAll('.space-y-3 > div.flex.items-center.gap-3');
			expect(rows.length).toBe(2);
			rows.forEach((row) => {
				expect((row as HTMLElement).style.opacity).not.toBe('0.3');
			});
		});

		it('dims rows that do not match activeFilterKey to 0.3 opacity', () => {
			const { container } = render(
				<AgentEfficiencyChart data={baseData} theme={theme} activeFilterKey="claude-code" />
			);
			const rows = container.querySelectorAll(
				'.space-y-3 > div.flex.items-center.gap-3'
			) as NodeListOf<HTMLElement>;
			expect(rows.length).toBe(2);

			// Two providers: claude-code (matches) and factory-droid (dimmed).
			// Sort by efficiency: data has claude-code at 2000000/30 ≈ 66667ms,
			// factory-droid at 1600000/20 = 80000ms — claude-code is faster, so
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
			const { container } = render(
				<AgentEfficiencyChart data={baseData} theme={theme} activeFilterKey="nonexistent" />
			);
			const rows = container.querySelectorAll(
				'.space-y-3 > div.flex.items-center.gap-3'
			) as NodeListOf<HTMLElement>;
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

			render(
				<AgentEfficiencyChart data={dataWithSessions} theme={theme} sessions={[parent, worktree]} />
			);

			// Two sessions share toolType "claude-code" so the name resolves to
			// the prettified type for the regular row plus a "(Worktree)" suffix.
			expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('Claude Code (Worktree)').length).toBeGreaterThanOrEqual(1);
		});
	});
});
