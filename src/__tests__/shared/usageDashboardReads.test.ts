/**
 * Tests for the pure builders behind the `maestro-cli stats-*` Usage Dashboard
 * reads.
 */

import { describe, it, expect } from 'vitest';
import {
	buildUsageActivityStats,
	fillDelegationDays,
	usageReadWindow,
} from '../../shared/usageDashboardReads';
import type { DelegationDay } from '../../shared/delegation';

const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime();
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).getTime();

describe('usageReadWindow', () => {
	it('starts a bounded range on its own first local day', () => {
		expect(usageReadWindow('week', null, NOW)).toEqual({
			startYmd: '2026-11-08',
			endYmd: '2026-11-14',
		});
		expect(usageReadWindow('day', '2020-01-01', NOW)).toEqual({
			startYmd: '2026-11-14',
			endYmd: '2026-11-14',
		});
	});

	it('starts All Time on the earliest known day, or today when there is none', () => {
		expect(usageReadWindow('all', '2026-10-01', NOW).startYmd).toBe('2026-10-01');
		expect(usageReadWindow('all', null, NOW).startYmd).toBe('2026-11-14');
	});
});

describe('fillDelegationDays', () => {
	it('fills every day of the window with zero slices', () => {
		const day: DelegationDay = {
			date: '2026-11-13',
			interactive: { count: 1, durationMs: 10 },
			autoRun: { count: 0, durationMs: 0 },
			cue: { count: 2, durationMs: 20 },
		};
		const { window, byDay } = fillDelegationDays([day], 'week', NOW);
		expect(window.startYmd).toBe('2026-11-08');
		expect(byDay.map((d) => d.date)).toHaveLength(7);
		expect(byDay[5]).toBe(day);
		expect(byDay[0].cue).toEqual({ count: 0, durationMs: 0 });
	});
});

describe('buildUsageActivityStats', () => {
	it('counts each source on its own local day and totals the range', () => {
		const stats = buildUsageActivityStats({
			range: 'week',
			now: NOW,
			autoRunSessions: [
				{
					id: 'ar',
					sessionId: 's',
					agentType: 'codex',
					startTime: at(12),
					duration: 60_000,
					tasksTotal: 5,
					tasksCompleted: 4,
				},
			],
			wizardRuns: [
				{
					id: 'w',
					sessionId: 's',
					agentType: 'codex',
					surface: 'inline',
					mode: 'new',
					outcome: 'generated',
					startedAt: at(13),
					endedAt: at(13, 11),
					exchanges: 2,
					documents: 3,
					tasks: 12,
					activeMs: 90_000,
				},
				{
					id: 'w2',
					sessionId: 's',
					agentType: 'codex',
					surface: 'inline',
					mode: 'new',
					outcome: 'abandoned',
					startedAt: at(13),
					endedAt: at(13),
					exchanges: 1,
					documents: 0,
					tasks: 0,
				},
			],
			resilienceEvents: [
				{
					id: 'r',
					sessionId: 's',
					agentType: 'claude-code',
					strategy: 'availability',
					outcome: 'recovered',
					startedAt: at(11, 23),
					resolvedAt: at(12, 1),
					retries: 3,
				},
			],
			shortcutUsageByDay: [{ date: '2026-11-14', count: 7 }],
			shortcutTotal: 7,
		});

		expect(stats.window).toEqual({ startYmd: '2026-11-08', endYmd: '2026-11-14' });
		expect(stats.byDay).toHaveLength(7);
		const byDate = Object.fromEntries(stats.byDay.map((d) => [d.date, d]));
		expect(byDate['2026-11-12']).toMatchObject({
			autoRuns: 1,
			autoRunTasksCompleted: 4,
			resilienceEvents: 1,
		});
		expect(byDate['2026-11-13'].wizardRuns).toBe(2);
		expect(byDate['2026-11-14'].shortcutPresses).toBe(7);
		expect(byDate['2026-11-08'].autoRuns).toBe(0);
		expect(stats.totals).toEqual({
			autoRuns: 1,
			autoRunGoalRuns: 0,
			autoRunUnfinished: 0,
			autoRunDurationMs: 60_000,
			autoRunTasksTotal: 5,
			autoRunTasksCompleted: 4,
			autoRunSuccessRate: 80,
			wizardRuns: 2,
			wizardRunsGenerated: 1,
			wizardDocuments: 3,
			wizardTasks: 12,
			wizardActiveMs: 90_000,
			resilienceEvents: 1,
			resilienceRecovered: 1,
			resilienceRetries: 3,
			shortcutPresses: 7,
		});
	});

	it('keeps goal runs and unfinished runs out of the task totals, like the Auto Run tab', () => {
		const run = (id: string, over: Record<string, unknown>) => ({
			id,
			sessionId: 's',
			agentType: 'codex',
			startTime: at(12),
			duration: 60_000,
			tasksTotal: 4,
			tasksCompleted: 4,
			...over,
		});
		const stats = buildUsageActivityStats({
			range: 'week',
			now: NOW,
			autoRunSessions: [
				run('doc', {}),
				// A goal run records progress as tasksCompleted of tasksTotal: 100.
				run('goal', { tasksTotal: 100, tasksCompleted: 60, documentPath: 'Goal: ship it' }),
				// Never recorded its end.
				run('open', { duration: 0, tasksCompleted: 0 }),
			],
			wizardRuns: [],
			resilienceEvents: [],
			shortcutUsageByDay: [],
			shortcutTotal: 0,
			shortcutUsageByShortcut: [
				{ shortcutId: 'newTab', count: 2 },
				{ shortcutId: 'toggleSidebar', count: 9 },
			],
		});
		expect(stats.totals).toMatchObject({
			autoRuns: 3,
			autoRunUnfinished: 1,
			autoRunTasksTotal: 4,
			autoRunTasksCompleted: 4,
			autoRunSuccessRate: 100,
		});
		expect(stats.byShortcut.map((s) => s.shortcutId)).toEqual(['toggleSidebar', 'newTab']);
		expect(stats.autoRunTurnsByHour).toEqual([]);
	});

	it('starts All Time on the earliest activity', () => {
		const stats = buildUsageActivityStats({
			range: 'all',
			now: NOW,
			autoRunSessions: [],
			wizardRuns: [],
			resilienceEvents: [],
			shortcutUsageByDay: [{ date: '2026-11-10', count: 1 }],
			shortcutTotal: 1,
		});
		expect(stats.window.startYmd).toBe('2026-11-10');
		expect(stats.byDay).toHaveLength(5);
	});
});
