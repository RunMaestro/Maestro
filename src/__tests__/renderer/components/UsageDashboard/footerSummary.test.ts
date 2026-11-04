/**
 * Tests for the Usage Dashboard footer summary builders.
 *
 * These are the copy for eleven tabs, so the assertions are on exact strings:
 * a separator or pluralization drift is exactly the failure this module exists
 * to prevent.
 */

import { describe, it, expect } from 'vitest';
import {
	buildActivitySummary,
	buildAgentOverviewSummary,
	buildAgentsSummary,
	buildAutoRunSummary,
	buildCueSummary,
	buildGroupsSummary,
	buildModalOwnedFooterSummary,
	buildOverviewSummary,
	buildQuotaSummary,
	buildShortcutsSummary,
	buildTokensSummary,
} from '../../../../renderer/components/UsageDashboard/footerSummary';
import type { StatsAggregation } from '../../../../shared/stats-types';
import type { Session } from '../../../../renderer/types';

const buildData = (overrides: Partial<StatsAggregation> = {}): StatsAggregation =>
	({
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
		bySessionTokens: {},
		...overrides,
	}) as StatsAggregation;

const buildSession = (overrides: Partial<Session>): Session =>
	({
		id: 'sess-1',
		name: 'Agent One',
		toolType: 'claude-code',
		state: 'idle',
		contextUsage: 0,
		...overrides,
	}) as Session;

describe('buildOverviewSummary', () => {
	it('states volume, fleet size, and active days', () => {
		const data = buildData({
			totalQueries: 2100,
			byDay: [
				{ date: '2026-09-01', count: 100, duration: 0 },
				{ date: '2026-09-02', count: 2000, duration: 0 },
			],
		});
		const sessions = [
			buildSession({ id: 's1' }),
			buildSession({ id: 's2' }),
			buildSession({ id: 's3', toolType: 'terminal' }),
		];

		expect(buildOverviewSummary(data, sessions)).toBe('2.1K queries · 2 agents · 2 active days');
	});

	it('drops the agent count when no sessions are supplied', () => {
		const data = buildData({
			totalQueries: 5,
			byDay: [{ date: '2026-09-01', count: 5, duration: 0 }],
		});

		expect(buildOverviewSummary(data)).toBe('5 queries · 1 active day');
	});

	it('says nothing for an empty range', () => {
		expect(buildOverviewSummary(buildData())).toBeNull();
	});
});

describe('buildAgentOverviewSummary', () => {
	it('reports fleet size, provider spread, and range activity', () => {
		const sessions = [
			buildSession({ id: 's1' }),
			buildSession({ id: 's2', toolType: 'codex' }),
			buildSession({ id: 's3', toolType: 'terminal' }),
		];
		const data = buildData({
			bySessionByDay: { s1: [{ date: '2026-09-01', count: 4, duration: 0 }] },
		});

		expect(buildAgentOverviewSummary(sessions, data)).toBe('2 agents · 2 providers · 1 active');
	});

	it('adds the worktree count only when worktrees exist', () => {
		const sessions = [
			buildSession({ id: 's1' }),
			buildSession({ id: 's2', parentSessionId: 's1' }),
		];

		expect(buildAgentOverviewSummary(sessions, buildData())).toBe(
			'2 agents · 1 provider · 0 active · 1 worktree'
		);
	});
});

describe('buildAgentsSummary', () => {
	it('shows a bare total when nothing is filtered', () => {
		// "84 of 84" would send the user hunting for a filter they never set.
		expect(buildAgentsSummary(84, 84)).toBe('84 agents');
	});

	it('shows the fraction when filters are narrowing the grid', () => {
		expect(buildAgentsSummary(24, 84)).toBe('24 of 84 agents');
	});

	it('reports an empty result against the real total', () => {
		expect(buildAgentsSummary(0, 84)).toBe('0 of 84 agents');
	});

	it('says nothing when there are no agents at all', () => {
		expect(buildAgentsSummary(0, 0)).toBeNull();
	});
});

describe('buildGroupsSummary', () => {
	it('pairs the group count with the unfiled remainder', () => {
		expect(buildGroupsSummary(7, 7, 23)).toBe('7 groups · 23 agents unfiled');
	});

	it('omits the remainder when every agent is filed', () => {
		expect(buildGroupsSummary(7, 7, 0)).toBe('7 groups');
	});

	it('shows the fraction while the group filter is narrowing', () => {
		expect(buildGroupsSummary(3, 7, 1)).toBe('3 of 7 groups · 1 agent unfiled');
	});
});

describe('buildTokensSummary', () => {
	it('states the coverage fraction behind the cost', () => {
		// Rows written before the token columns existed report no usage, so a
		// total drawn from half the turns must say so.
		const data = buildData({
			totalQueries: 2000,
			bySessionTokens: {
				s1: {
					inputTokens: 500,
					outputTokens: 400,
					cacheReadTokens: 100,
					cacheCreationTokens: 0,
					costUsd: 12.5,
					pricedQueries: 1000,
				},
			},
		});

		expect(buildTokensSummary(data)).toBe('1.0K tokens · ~$12.50 · 1.0K of 2.0K turns priced');
	});

	it('drops the caveat when every turn is priced', () => {
		const data = buildData({
			totalQueries: 10,
			bySessionTokens: {
				s1: {
					inputTokens: 10,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 1,
					pricedQueries: 10,
				},
			},
		});

		expect(buildTokensSummary(data)).toBe('10 tokens · ~$1.00');
	});

	it('says nothing when no session reported usage', () => {
		expect(buildTokensSummary(buildData())).toBeNull();
	});
});

describe('buildActivitySummary', () => {
	it('names the peak hour and the busiest day', () => {
		const data = buildData({
			totalQueries: 214,
			byHour: [
				{ hour: 9, count: 50, duration: 0 },
				{ hour: 20, count: 164, duration: 0 },
			],
			byDay: [
				{ date: '2026-08-21', count: 50, duration: 0 },
				{ date: '2026-08-22', count: 164, duration: 0 },
			],
		});

		expect(buildActivitySummary(data)).toBe(
			'Peak hour 8 PM · busiest Aug 22 with 164 · 2 active days'
		);
	});

	it('says nothing for an empty range', () => {
		expect(buildActivitySummary(buildData())).toBeNull();
	});
});

describe('buildAutoRunSummary', () => {
	it('keeps the completion rate attached to the fraction it describes', () => {
		expect(buildAutoRunSummary({ runs: 48, tasksCompleted: 312, tasksAttempted: 340 })).toBe(
			'48 runs · 312 of 340 tasks done (92%)'
		);
	});

	it('reports runs alone when no run declared a task total', () => {
		expect(buildAutoRunSummary({ runs: 3, tasksCompleted: 0, tasksAttempted: 0 })).toBe('3 runs');
	});

	it('says nothing when nothing ran', () => {
		expect(buildAutoRunSummary({ runs: 0, tasksCompleted: 0, tasksAttempted: 0 })).toBeNull();
	});
});

describe('buildCueSummary', () => {
	it('leads with failures when there are any', () => {
		// A comfortable "94% success" buries the eight runs that broke.
		expect(buildCueSummary({ runs: 126, failures: 8, pipelines: 12 })).toBe(
			'126 runs · 12 pipelines · 8 failed'
		);
	});

	it('falls back to a success rate when nothing failed', () => {
		expect(buildCueSummary({ runs: 126, failures: 0, pipelines: 12 })).toBe(
			'126 runs · 12 pipelines · 100% success'
		);
	});
});

describe('buildShortcutsSummary', () => {
	it('states presses, mastery fraction, and level', () => {
		expect(
			buildShortcutsSummary({ presses: 1200, used: 47, bound: 180, levelName: 'Virtuoso' })
		).toBe('1.2K presses · 47 of 180 shortcuts used · Virtuoso');
	});

	it('omits the press count when nothing was pressed in range', () => {
		expect(buildShortcutsSummary({ presses: 0, used: 5, bound: 180 })).toBe(
			'5 of 180 shortcuts used'
		);
	});
});

describe('buildQuotaSummary', () => {
	it('surfaces the tightest window across accounts', () => {
		expect(
			buildQuotaSummary({ accounts: 3, needsLogin: 0, peakPercent: 87.4, sampledAtMs: null })
		).toBe('3 accounts · peak window 87%');
	});

	it('calls out accounts that are locked out', () => {
		expect(
			buildQuotaSummary({ accounts: 3, needsLogin: 1, peakPercent: null, sampledAtMs: null })
		).toBe('3 accounts · 1 needs login');
	});

	it('says nothing when no account feeds the panel', () => {
		expect(
			buildQuotaSummary({ accounts: 0, needsLogin: 0, peakPercent: 50, sampledAtMs: null })
		).toBeNull();
	});
});

describe('buildModalOwnedFooterSummary', () => {
	const data = buildData({
		totalQueries: 10,
		byDay: [{ date: '2026-09-01', count: 10, duration: 0 }],
	});

	it('describes the tabs the modal has data for', () => {
		expect(buildModalOwnedFooterSummary('overview', { data, sessions: [] })).toBe(
			'10 queries · 0 agents · 1 active day'
		);
	});

	it('defers to the panel for panel-owned tabs', () => {
		// These tabs fetch their own data, so the modal must not guess at them.
		for (const tab of ['agents', 'groups', 'autorun', 'cue', 'shortcuts'] as const) {
			expect(buildModalOwnedFooterSummary(tab, { data, sessions: [] })).toBeNull();
		}
	});

	it('says nothing before stats have loaded', () => {
		expect(buildModalOwnedFooterSummary('overview', { data: null, sessions: [] })).toBeNull();
	});
});
