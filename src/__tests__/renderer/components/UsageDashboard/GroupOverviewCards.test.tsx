/**
 * Tests for GroupOverviewCards - the Usage Dashboard's per-group tile grid.
 *
 * The cases that matter are the ones where a tile could quietly lie: cost
 * presented as complete when most turns predate token recording, agents lost
 * because they belong to no group, and Ungrouped outranking real groups in a
 * sort.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { GroupOverviewCards } from '../../../../renderer/components/UsageDashboard/GroupOverviewCards';
import type { Session } from '../../../../renderer/types';
import type { StatsAggregation } from '../../../../shared/stats-types';
import type { GroupLike } from '../../../../shared/statsGroupRollup';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
	return {
		id,
		name: `Agent ${id}`,
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

function makeData(overrides: Partial<StatsAggregation> = {}): StatsAggregation {
	return {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		queryDurationPercentiles: { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 },
		queryDurationPercentilesByAgent: {},
		autoRunTaskDurationPercentiles: { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 },
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byDay: [],
		byLocation: { local: 0, remote: 0 },
		byHour: [],
		totalSessions: 0,
		sessionsByAgent: {},
		sessionsByDay: [],
		avgSessionDuration: 0,
		byAgentByDay: {},
		bySessionByDay: {},
		bySessionSource: {},
		bySessionTokens: {},
		worktreeQueries: 0,
		parentQueries: 0,
		byWorktreeStatus: { worktree: { count: 0, duration: 0 }, parent: { count: 0, duration: 0 } },
		imageAnnotations: 0,
		...overrides,
	} as StatsAggregation;
}

const GROUPS: GroupLike[] = [
	{ id: 'g-acme', name: 'Acme Corp', emoji: '🏢' },
	{ id: 'g-internal', name: 'Internal', emoji: '🔧' },
];

const SESSIONS = [
	makeSession('s1', { name: 'Acme API', groupId: 'g-acme' }),
	makeSession('s2', { name: 'Acme Web', groupId: 'g-acme', toolType: 'codex' }),
	makeSession('s3', { name: 'Tooling', groupId: 'g-internal' }),
	makeSession('s4', { name: 'Scratch' }),
];

function renderCards(props: Partial<React.ComponentProps<typeof GroupOverviewCards>> = {}) {
	return render(
		<GroupOverviewCards
			groups={GROUPS}
			sessions={SESSIONS}
			data={makeData()}
			theme={theme}
			{...props}
		/>
	);
}

describe('GroupOverviewCards', () => {
	it('renders one tile per non-empty group plus an Ungrouped tile', () => {
		renderCards();

		const cards = screen.getAllByTestId('group-card');
		expect(cards).toHaveLength(3);
		expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
		expect(screen.getByText(/Internal/)).toBeInTheDocument();
		expect(screen.getByText('Ungrouped')).toBeInTheDocument();
	});

	it('shows the member count on each tile', () => {
		renderCards();

		expect(screen.getByText('2 agents')).toBeInTheDocument();
		expect(screen.getAllByText('1 agent')).toHaveLength(2);
	});

	it('sums member queries onto the group tile', () => {
		renderCards({
			data: makeData({
				bySessionByDay: {
					s1: [{ date: '2026-08-01', count: 4, duration: 4000 }],
					s2: [{ date: '2026-08-01', count: 6, duration: 6000 }],
				},
			}),
		});

		const acme = screen.getByText(/Acme Corp/).closest('[data-testid="group-card"]')!;
		expect(within(acme as HTMLElement).getByTestId('group-card-queries')).toHaveTextContent('10');
	});

	it('renders an em-dash for cost when no member reported token usage', () => {
		// Not "$0.00" - a group whose turns predate token recording has not
		// spent nothing, it has an unknown spend.
		renderCards({
			data: makeData({
				bySessionByDay: { s1: [{ date: '2026-08-01', count: 40, duration: 40000 }] },
			}),
		});

		const acme = screen.getByText(/Acme Corp/).closest('[data-testid="group-card"]')!;
		expect(within(acme as HTMLElement).getByTestId('group-card-cost')).toHaveTextContent('—');
	});

	it('renders the summed cost when members reported usage', () => {
		renderCards({
			data: makeData({
				bySessionTokens: {
					s1: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: 1.25,
						pricedQueries: 5,
					},
					s2: {
						inputTokens: 2000,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: 2.75,
						pricedQueries: 5,
					},
				},
			}),
		});

		const acme = screen.getByText(/Acme Corp/).closest('[data-testid="group-card"]')!;
		expect(within(acme as HTMLElement).getByTestId('group-card-cost')).toHaveTextContent('$4.00');
		expect(within(acme as HTMLElement).getByTestId('group-card-tokens')).toHaveTextContent('4.0K');
	});

	it('says how many queries the cost figure actually covers', () => {
		renderCards({
			data: makeData({
				bySessionByDay: { s1: [{ date: '2026-08-01', count: 100, duration: 1000 }] },
				bySessionTokens: {
					s1: {
						inputTokens: 10,
						outputTokens: 10,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: 0.5,
						pricedQueries: 4,
					},
				},
			}),
		});

		const acme = screen.getByText(/Acme Corp/).closest('[data-testid="group-card"]')!;
		expect(within(acme as HTMLElement).getByTestId('group-card-cost')).toHaveAttribute(
			'title',
			expect.stringContaining('Covers 4 of 100 queries')
		);
	});

	it('shows the auto share as a badge when the group has recorded queries', () => {
		renderCards({
			data: makeData({
				bySessionSource: { s1: { user: 1, auto: 3 } },
			}),
		});

		expect(screen.getByTestId('group-card-auto-badge')).toHaveTextContent('75% auto');
	});

	it('omits the auto badge for a group with no recorded queries', () => {
		renderCards();

		expect(screen.queryByTestId('group-card-auto-badge')).not.toBeInTheDocument();
	});

	it('keeps Ungrouped last even when it has the most queries', () => {
		// Ungrouped is a leftovers bucket, not a competitor - a big pile of
		// unfiled agents must not top the board.
		renderCards({
			data: makeData({
				bySessionByDay: {
					s1: [{ date: '2026-08-01', count: 1, duration: 1 }],
					s4: [{ date: '2026-08-01', count: 999, duration: 999 }],
				},
			}),
		});

		const cards = screen.getAllByTestId('group-card');
		expect(cards[cards.length - 1]).toHaveTextContent('Ungrouped');
	});

	it('reports the clicked group to the caller with its member ids', () => {
		const onSelectGroup = vi.fn();
		renderCards({ onSelectGroup });

		fireEvent.click(screen.getByText(/Acme Corp/).closest('[data-testid="group-card"]')!);

		expect(onSelectGroup).toHaveBeenCalledTimes(1);
		expect(onSelectGroup.mock.calls[0][0]).toMatchObject({
			groupId: 'g-acme',
			name: 'Acme Corp',
		});
		expect(onSelectGroup.mock.calls[0][0].sessions.map((s: { id: string }) => s.id)).toEqual([
			's1',
			's2',
		]);
	});

	it('marks the active group tile as selected', () => {
		renderCards({ activeGroupId: 'g-acme' });

		const acme = screen.getByText(/Acme Corp/).closest('[data-testid="group-card"]')!;
		expect(acme).toHaveAttribute('data-selected', 'true');
	});

	it('excludes terminal sessions from member counts', () => {
		renderCards({
			sessions: [
				makeSession('s1', { name: 'Real', groupId: 'g-acme' }),
				makeSession('t1', { name: 'Shell', groupId: 'g-acme', toolType: 'terminal' }),
			],
		});

		expect(screen.getByText('1 agent')).toBeInTheDocument();
	});

	it('filters tiles by group name', () => {
		renderCards();

		fireEvent.change(screen.getByLabelText('Filter groups'), { target: { value: 'acme' } });

		expect(screen.getAllByTestId('group-card')).toHaveLength(1);
		expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
	});

	it('filters tiles by member agent name', () => {
		// The user thinks in agents as often as in groups - "which client is
		// Tooling under" should find the group without knowing its name.
		renderCards();

		fireEvent.change(screen.getByLabelText('Filter groups'), { target: { value: 'Tooling' } });

		expect(screen.getAllByTestId('group-card')).toHaveLength(1);
		expect(screen.getByText(/Internal/)).toBeInTheDocument();
	});

	it('reports when the filter matches nothing', () => {
		renderCards();

		fireEvent.change(screen.getByLabelText('Filter groups'), { target: { value: 'zzzz' } });

		expect(screen.getByTestId('group-overview-no-matches')).toBeInTheDocument();
	});

	it('prompts the user to create a group when there is nothing to roll up', () => {
		renderCards({ groups: [], sessions: [] });

		expect(screen.getByTestId('group-overview-empty')).toBeInTheDocument();
	});
});
