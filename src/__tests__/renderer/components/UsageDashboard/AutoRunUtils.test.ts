import { describe, expect, it } from 'vitest';
import type { AutoRunSession, AutoRunTurnsByHour } from '../../../../shared/stats-types';
import { GOAL_RUN_DOCUMENT_PREFIX } from '../../../../shared/goalDriven/goalRunLabel';
import {
	computeAutoRunMetrics,
	getAutoRunChartMax,
	groupSessionsByDate,
	isFinishedAutoRun,
} from '../../../../shared/autoRunMetrics';
import {
	EMPTY_TABLE_CELL,
	extractFileName,
	extractProjectName,
	formatAutoRunDate,
	formatAutoRunProvider,
	formatAutoRunTasksLabel,
	sortAutoRunSessions,
} from '../../../../renderer/components/UsageDashboard/autoRunTableUtils';
import {
	getMaxHourlyTaskCount,
	getPeakHours,
} from '../../../../renderer/components/UsageDashboard/tasksByHourUtils';

function makeSession(overrides: Partial<AutoRunSession>): AutoRunSession {
	return {
		id: 'session',
		sessionId: 'maestro-session',
		agentType: 'claude-code',
		documentPath: '/repo/TASKS.md',
		projectPath: '/repo',
		startTime: new Date(2026, 0, 2, 10).getTime(),
		duration: 60000,
		tasksTotal: 1,
		tasksCompleted: 1,
		...overrides,
	};
}

const goal = (overrides: Partial<AutoRunSession> = {}) =>
	makeSession({
		documentPath: `${GOAL_RUN_DOCUMENT_PREFIX}Ship dashboard`,
		tasksTotal: 100,
		tasksCompleted: 75,
		...overrides,
	});

describe('autoRunStatsUtils', () => {
	it('computes run metrics from finished document runs', () => {
		const metrics = computeAutoRunMetrics([
			makeSession({ duration: 60000, tasksTotal: 4, tasksCompleted: 3 }),
			makeSession({ duration: 120000, tasksTotal: 2, tasksCompleted: 1 }),
		]);

		expect(metrics).toEqual({
			totalRuns: 2,
			finishedRuns: 2,
			unfinishedRuns: 0,
			goalRuns: 0,
			totalTasksCompleted: 4,
			totalTasksAttempted: 6,
			avgTasksPerRun: '2.0',
			successRate: 67,
			avgRunDuration: 90000,
			avgTimePerTask: 45000,
			totalDuration: 180000,
			goalDrivenDuration: 0,
			specDrivenDuration: 180000,
		});
	});

	it('splits Auto Run time by kind, counting unlabeled runs as spec-driven', () => {
		const metrics = computeAutoRunMetrics([
			makeSession({ duration: 60000, kind: 'goal-driven' }),
			makeSession({ duration: 30000, kind: 'spec-driven' }),
			// Pre-migration row: no kind at all.
			makeSession({ duration: 20000 }),
			// Unknown value from a newer build.
			makeSession({ duration: 5000, kind: 'loop-driven' as never }),
			// A goal-looking path is still spec-driven time unless the kind says otherwise.
			goal({ duration: 1000 }),
		]);

		expect(metrics.goalDrivenDuration).toBe(60000);
		expect(metrics.specDrivenDuration).toBe(56000);
		expect(metrics.totalDuration).toBe(116000);
		expect(metrics.totalDuration).toBe(metrics.goalDrivenDuration + metrics.specDrivenDuration);
	});

	it('counts goal runs separately and never sums their 0-100 progress as tasks', () => {
		const metrics = computeAutoRunMetrics([
			makeSession({ duration: 60000, tasksTotal: 4, tasksCompleted: 4 }),
			goal({ duration: 30000 }),
		]);
		expect(metrics.goalRuns).toBe(1);
		expect(metrics.totalTasksCompleted).toBe(4);
		expect(metrics.totalTasksAttempted).toBe(4);
		expect(metrics.successRate).toBe(100);
		// Run time averages over both finished runs; time per task over the document run.
		expect(metrics.avgRunDuration).toBe(45000);
		expect(metrics.avgTimePerTask).toBe(15000);
	});

	it('keeps unfinished runs out of averages and the success-rate denominator', () => {
		const metrics = computeAutoRunMetrics([
			makeSession({ duration: 60000, tasksTotal: 2, tasksCompleted: 2 }),
			makeSession({ duration: 0, tasksTotal: 50, tasksCompleted: undefined }),
		]);
		expect(metrics.totalRuns).toBe(2);
		expect(metrics.unfinishedRuns).toBe(1);
		expect(metrics.totalTasksAttempted).toBe(2);
		expect(metrics.successRate).toBe(100);
		expect(metrics.avgRunDuration).toBe(60000);
		expect(isFinishedAutoRun(makeSession({ duration: 0 }))).toBe(false);
	});

	it('caps a legacy looping run that ticked more than it started with at 100%', () => {
		const metrics = computeAutoRunMetrics([
			makeSession({ duration: 60000, tasksTotal: 3, tasksCompleted: 9 }),
		]);
		expect(metrics.successRate).toBe(100);
	});

	it('fills every day of the range, from finished document runs only', () => {
		const now = new Date(2026, 0, 7, 12).getTime();
		const grouped = groupSessionsByDate(
			[
				makeSession({
					startTime: new Date(2026, 0, 2, 9).getTime(),
					tasksTotal: 3,
					tasksCompleted: 2,
				}),
				makeSession({
					startTime: new Date(2026, 0, 2, 12).getTime(),
					tasksTotal: 1,
					tasksCompleted: 1,
				}),
				goal({ startTime: new Date(2026, 0, 3, 8).getTime() }),
				makeSession({ startTime: new Date(2026, 0, 4, 8).getTime(), duration: 0, tasksTotal: 9 }),
			],
			'week',
			now
		);

		expect(grouped.map((d) => d.date)).toEqual([
			'2026-01-01',
			'2026-01-02',
			'2026-01-03',
			'2026-01-04',
			'2026-01-05',
			'2026-01-06',
			'2026-01-07',
		]);
		expect(grouped[1]).toEqual({ date: '2026-01-02', count: 4, successCount: 3 });
		expect(grouped[2]).toEqual({ date: '2026-01-03', count: 0, successCount: 0 });
		expect(grouped[3]).toEqual({ date: '2026-01-04', count: 0, successCount: 0 });
		expect(getAutoRunChartMax(grouped)).toBe(4);
	});

	it('starts an all-time series at the first run and is empty with no runs', () => {
		const now = new Date(2026, 0, 3, 12).getTime();
		expect(groupSessionsByDate([], 'all', now)).toEqual([]);
		const grouped = groupSessionsByDate(
			[makeSession({ startTime: new Date(2026, 0, 1, 9).getTime() })],
			'all',
			now
		);
		expect(grouped.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
	});
});

describe('autoRunTableUtils', () => {
	it('formats providers and path fallbacks with a plain hyphen for empty cells', () => {
		expect(formatAutoRunProvider('claude-code')).toBe('Claude Code');
		expect(extractFileName('/repo/docs/TASKS.md')).toBe('TASKS.md');
		expect(extractProjectName('/Users/me/repo')).toBe('repo');
		expect(extractFileName()).toBe(EMPTY_TABLE_CELL);
		expect(extractProjectName()).toBe(EMPTY_TABLE_CELL);
		expect(EMPTY_TABLE_CELL).toBe('-');
		expect(formatAutoRunDate(new Date(2026, 0, 2, 10).getTime())).toBe('Jan 2, 2026');
	});

	it('sorts by any column and labels document, goal and unfinished runs', () => {
		const sessions = [
			makeSession({ id: 'short', duration: 1000, tasksTotal: undefined, projectPath: '/b' }),
			makeSession({
				id: 'long',
				duration: 5000,
				tasksTotal: 5,
				tasksCompleted: 4,
				projectPath: '/a',
			}),
			goal({ id: 'goal', duration: 3000, projectPath: '/c' }),
			makeSession({ id: 'open', duration: 0, tasksTotal: 8, tasksCompleted: undefined }),
		];

		expect(sortAutoRunSessions(sessions, 'duration', true).map((s) => s.id)).toEqual([
			'long',
			'goal',
			'short',
			'open',
		]);
		expect(sortAutoRunSessions(sessions, 'project', false)[0].id).toBe('long');
		expect(formatAutoRunTasksLabel(sessions[0])).toBe(EMPTY_TABLE_CELL);
		expect(formatAutoRunTasksLabel(sessions[1])).toBe('4 / 5');
		expect(formatAutoRunTasksLabel(sessions[2])).toBe('75%');
		expect(formatAutoRunTasksLabel(sessions[3])).toBe('- / 8');
	});
});

describe('tasksByHourUtils', () => {
	it('finds the busiest hours and leaves out hours with no turns', () => {
		const hourlyData: AutoRunTurnsByHour[] = Array.from({ length: 24 }, (_, hour) => ({
			hour,
			count: hour === 9 ? 2 : hour === 14 ? 1 : 0,
			successCount: 0,
		}));

		expect(getMaxHourlyTaskCount(hourlyData)).toBe(2);
		expect(getPeakHours(hourlyData)).toEqual([9, 14]);
		expect(getPeakHours(hourlyData.map((h) => ({ ...h, count: 0 })))).toEqual([]);
	});
});
