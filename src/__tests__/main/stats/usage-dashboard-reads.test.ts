/**
 * Tests for the Usage Dashboard reads the dashboard IPC handlers and the
 * `maestro-cli stats-*` bridge handlers share.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = {
	getQuerySourceTotals: vi.fn(),
	getQuerySourceByDay: vi.fn(),
	getAutoRunSessions: vi.fn(() => []),
	getWizardRuns: vi.fn(() => []),
	getResilienceEvents: vi.fn(() => []),
	getShortcutUsageByDay: vi.fn(() => []),
	getShortcutUsageTotal: vi.fn(() => 0),
	getSessionLifecycleEvents: vi.fn(() => []),
};
vi.mock('../../../main/stats/singleton', () => ({ getStatsDB: () => mockDb }));

const mockGetCueRunTotals = vi.fn();
const mockGetCueRunTotalsByDay = vi.fn();
vi.mock('../../../main/cue/cue-db', () => ({
	getCueRunTotals: (...args: unknown[]) => mockGetCueRunTotals(...args),
	getCueRunTotalsByDay: (...args: unknown[]) => mockGetCueRunTotalsByDay(...args),
}));

const mockGetCueStatsAggregation = vi.fn();
vi.mock('../../../main/cue/stats/cue-stats-query', () => ({
	getCueStatsAggregation: (...args: unknown[]) => mockGetCueStatsAggregation(...args),
}));

let storedSessions: Array<Record<string, unknown>> = [];
let storedGroups: Array<Record<string, unknown>> = [];
vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: () => ({ get: () => storedSessions }),
	getGroupsStore: () => ({ get: () => storedGroups }),
}));

let claudeSnapshots: Record<string, unknown> = {};
let codexSnapshots: Record<string, unknown> = {};
vi.mock('../../../main/stores/claudeUsageStore', () => ({
	SNAPSHOT_TTL_MS: 24 * 60 * 60 * 1000,
	getRetainedSnapshots: () => claudeSnapshots,
	forgetSnapshots: vi.fn(),
}));
vi.mock('../../../main/stores/codexUsageStore', () => ({
	CODEX_USAGE_SNAPSHOT_TTL_MS: 24 * 60 * 60 * 1000,
	getRetainedCodexUsageSnapshots: () => codexSnapshots,
	forgetCodexUsageSnapshots: vi.fn(),
}));
vi.mock('../../../main/stores/quotaAccountsStore', () => ({
	dropSnapshotsForMissingAccounts: async (snapshots: unknown) => snapshots,
}));

import {
	getAgentCountStats,
	getDelegationByDay,
	getDelegationStats,
	getDelegationTotals,
	getPlanUsageReport,
	getUsageActivityStats,
	getUsageDashboardCueStats,
	readAgentDirectory,
} from '../../../main/stats/usage-dashboard-reads';
import { toLocalYmd } from '../../../shared/localDay';

const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime();
const slice = (count: number, durationMs: number) => ({ count, durationMs });

describe('delegation reads', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.getQuerySourceTotals.mockReturnValue({
			interactive: slice(3, 3000),
			autoRun: slice(1, 1000),
		});
		mockDb.getQuerySourceByDay.mockReturnValue([
			{ date: '2026-11-12', interactive: slice(3, 3000), autoRun: slice(1, 1000) },
		]);
		mockGetCueRunTotals.mockReturnValue(slice(2, 4000));
		mockGetCueRunTotalsByDay.mockReturnValue([{ date: '2026-11-13', count: 2, durationMs: 4000 }]);
	});

	it('joins the stats DB and the Cue DB for the totals', () => {
		expect(getDelegationTotals('week')).toEqual({
			interactive: slice(3, 3000),
			autoRun: slice(1, 1000),
			cue: slice(2, 4000),
		});
		expect(mockDb.getQuerySourceTotals).toHaveBeenCalledWith('week');
	});

	it('merges both systems per day, sorted, with no empty days', () => {
		expect(getDelegationByDay('week').map((day) => day.date)).toEqual(['2026-11-12', '2026-11-13']);
	});

	it('gap-fills the trend over the range window and reports the delegated share', () => {
		const stats = getDelegationStats('week', NOW);
		expect(stats.window).toEqual({ startYmd: '2026-11-08', endYmd: '2026-11-14' });
		expect(stats.byDay).toHaveLength(7);
		expect(stats.byDay[0].interactive).toEqual(slice(0, 0));
		// Delegated time: Auto Run 1000 + Cue 4000 of 8000 tracked.
		expect(stats.percent).toBeCloseTo(62.5);
	});
});

describe('getUsageDashboardCueStats', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns null without querying when Cue stats are off', async () => {
		const store = { get: () => ({ maestroCue: false }) };
		await expect(getUsageDashboardCueStats('week', store)).resolves.toBeNull();
		expect(mockGetCueStatsAggregation).not.toHaveBeenCalled();
	});

	it('runs the Cue tab query with the caller options when on', async () => {
		mockGetCueStatsAggregation.mockResolvedValue({ totals: {} });
		const store = { get: () => undefined };
		await expect(
			getUsageDashboardCueStats('month', store, { excludeTriggerTypes: ['time.heartbeat'] })
		).resolves.toEqual({ totals: {} });
		expect(mockGetCueStatsAggregation).toHaveBeenCalledWith('month', {
			excludeTriggerTypes: ['time.heartbeat'],
		});
	});
});

describe('getUsageActivityStats', () => {
	it('reads the four panel sources for the range', () => {
		mockDb.getShortcutUsageTotal.mockReturnValue(5);
		const stats = getUsageActivityStats('day', NOW);
		expect(mockDb.getWizardRuns).toHaveBeenCalledWith('day');
		expect(mockDb.getShortcutUsageTotal).toHaveBeenCalledWith('day');
		expect(stats.totals.shortcutPresses).toBe(5);
		expect(stats.byDay).toHaveLength(1);
	});
});

describe('getAgentCountStats', () => {
	it('counts live agents (no terminals) plus deleted agents from lifecycle rows', () => {
		const created = new Date(2026, 10, 10, 9).getTime();
		storedSessions = [
			{ id: 'a', toolType: 'claude-code', createdAt: created },
			{ id: 't', toolType: 'terminal', createdAt: created },
		];
		mockDb.getSessionLifecycleEvents.mockReturnValue([
			{
				sessionId: 'gone',
				agentType: 'codex',
				createdAt: new Date(2026, 10, 9, 9).getTime(),
				closedAt: new Date(2026, 10, 12, 9).getTime(),
			},
		] as never);

		const stats = getAgentCountStats('week', NOW);
		expect(mockDb.getSessionLifecycleEvents).toHaveBeenCalledWith('all');
		expect(stats.liveAgents).toBe(1);
		expect(stats.created).toBe(2);
		expect(stats.removed).toBe(1);
		const byDate = Object.fromEntries(stats.points.map((p) => [p.date, p.count]));
		expect(byDate['2026-11-08']).toBe(0);
		expect(byDate['2026-11-10']).toBe(2);
		expect(byDate[toLocalYmd(NOW)]).toBe(1);
	});
});

describe('readAgentDirectory', () => {
	it('returns agent names and group names from the stores', () => {
		storedSessions = [{ id: 'a', name: 'Backend', toolType: 'codex', groupId: 'g' }];
		storedGroups = [{ id: 'g', name: 'Work', emoji: 'x' }];
		expect(readAgentDirectory()).toEqual({
			agents: [{ id: 'a', name: 'Backend', toolType: 'codex', groupId: 'g' }],
			groups: [{ id: 'g', name: 'Work' }],
		});
	});
});

describe('getPlanUsageReport', () => {
	it('normalizes Claude and Codex snapshots into one row per account, marking stale ones', async () => {
		claudeSnapshots = {
			'/home/me/.claude': {
				sampledAt: new Date(NOW - 60_000).toISOString(),
				configDirKey: '/home/me/.claude',
				accountEmail: 'me@example.com',
				weekAllModels: { percent: 40, resetsAt: 'Nov 20' },
				weekSonnetOnly: { percent: 10, label: 'Opus' },
			},
		};
		codexSnapshots = {
			'/home/me/.codex': {
				sampledAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
				codexHomeKey: '/home/me/.codex',
				authState: 'authenticated',
				planType: 'pro',
				session: { percent: 5, resetsAt: '2026-11-14T18:00:00Z' },
				weekly: { percent: 50, resetsAt: '2026-11-18T00:00:00Z' },
				resetCredits: { available: 2 },
			},
		};

		const report = await getPlanUsageReport(NOW);
		expect(report.claude).toEqual([
			expect.objectContaining({
				provider: 'claude-code',
				accountKey: '/home/me/.claude',
				email: 'me@example.com',
				stale: false,
				windows: [
					{ name: 'Week (all models)', percent: 40, resetsAt: 'Nov 20' },
					{ name: 'Week (Opus)', percent: 10, resetsAt: undefined },
				],
			}),
		]);
		expect(report.codex).toEqual([
			expect.objectContaining({
				provider: 'codex',
				plan: 'pro',
				stale: true,
				resetCreditsAvailable: 2,
				windows: [
					{ name: 'Session', percent: 5, resetsAt: '2026-11-14T18:00:00Z' },
					{ name: 'Weekly', percent: 50, resetsAt: '2026-11-18T00:00:00Z' },
				],
			}),
		]);
	});
});
