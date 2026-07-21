import { describe, expect, it } from 'vitest';
import type { AutoRunSession, AutoRunTask } from '../../../../shared/stats-types';
import { GOAL_RUN_DOCUMENT_PREFIX } from '../../../../shared/goalDriven/goalRunLabel';
import {
	computeAutoRunMetrics,
	formatFullDate,
	getAutoRunChartMax,
	groupSessionsByDate,
} from '../../../../renderer/components/UsageDashboard/autoRunStatsUtils';
import { formatUsageShortDate } from '../../../../renderer/components/UsageDashboard/usageDashboardUtils';
import {
	extractFileName,
	extractProjectName,
	formatAgentName,
	formatAutoRunDate,
	formatAutoRunTasksLabel,
	getTopAutoRunSessions,
} from '../../../../renderer/components/UsageDashboard/autoRunTableUtils';
import {
	buildHourlyTaskData,
	formatHourFull,
	formatHourShort,
	getMaxHourlyTaskCount,
	getPeakHours,
} from '../../../../renderer/components/UsageDashboard/tasksByHourUtils';

const emptyCell = String.fromCharCode(8212);

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
	} as AutoRunSession;
}

function makeTask(startHour: number, success: boolean): AutoRunTask {
	return {
		id: `task-${startHour}-${success}`,
		autoRunSessionId: 'session',
		sessionId: 'maestro-session',
		agentType: 'claude-code',
		taskIndex: 0,
		taskContent: 'Task',
		startTime: new Date(2026, 0, 2, startHour, 15).getTime(),
		duration: 1000,
		success,
	} as AutoRunTask;
}

describe('autoRunStatsUtils', () => {
	it('computes session metrics from completed and attempted task counts', () => {
		const metrics = computeAutoRunMetrics([
			makeSession({ duration: 60000, tasksTotal: 4, tasksCompleted: 3 }),
			makeSession({ duration: 120000, tasksTotal: 2, tasksCompleted: 1 }),
		]);

		expect(metrics).toEqual({
			totalSessions: 2,
			totalTasksCompleted: 4,
			totalTasksAttempted: 6,
			avgTasksPerSession: '2.0',
			successRate: 67,
			avgSessionDuration: 90000,
			avgTaskDuration: 45000,
		});
	});

	it('groups sessions by local date and keeps completion-only days', () => {
		const grouped = groupSessionsByDate([
			makeSession({
				startTime: new Date(2026, 0, 2, 9).getTime(),
				tasksTotal: 0,
				tasksCompleted: 2,
			}),
			makeSession({
				startTime: new Date(2026, 0, 2, 12).getTime(),
				tasksTotal: 3,
				tasksCompleted: 1,
			}),
			makeSession({
				startTime: new Date(2026, 0, 3, 8).getTime(),
				tasksTotal: 0,
				tasksCompleted: 0,
			}),
		]);

		expect(grouped).toEqual([{ date: '2026-01-02', count: 3, successCount: 3 }]);
		expect(getAutoRunChartMax(grouped)).toBe(3);
		expect(formatUsageShortDate('2026-01-02')).toBe('Jan 2');
		expect(formatFullDate('2026-01-02')).toContain('Jan 2, 2026');
	});
});

describe('autoRunTableUtils', () => {
	it('formats table aliases and path fallbacks without changing display behavior', () => {
		expect(formatAgentName('claude-code')).toBe('Claude Code');
		expect(formatAgentName('unknown-agent')).toBe('unknown-agent');
		expect(extractFileName('/repo/docs/TASKS.md')).toBe('TASKS.md');
		expect(extractProjectName('/Users/me/repo')).toBe('repo');
		expect(extractFileName()).toBe(emptyCell);
		expect(extractProjectName()).toBe(emptyCell);
		expect(formatAutoRunDate(new Date(2026, 0, 2, 10).getTime())).toBe('Jan 2, 2026');
	});

	it('sorts longest sessions and formats document and goal task labels', () => {
		const sessions = [
			makeSession({ id: 'short', duration: 1000, tasksTotal: undefined }),
			makeSession({ id: 'long', duration: 5000, tasksTotal: 5, tasksCompleted: 4 }),
			makeSession({
				id: 'goal',
				duration: 3000,
				documentPath: `${GOAL_RUN_DOCUMENT_PREFIX}Ship dashboard`,
				tasksCompleted: 75,
				tasksTotal: 100,
			}),
		];

		expect(getTopAutoRunSessions(sessions, 2).map((session) => session.id)).toEqual([
			'long',
			'goal',
		]);
		expect(formatAutoRunTasksLabel(sessions[0])).toBe(emptyCell);
		expect(formatAutoRunTasksLabel(sessions[1])).toBe('4 / 5');
		expect(formatAutoRunTasksLabel(sessions[2])).toBe('75%');
	});
});

describe('tasksByHourUtils', () => {
	it('builds hourly buckets, peak hours, and labels', () => {
		const hourlyData = buildHourlyTaskData([
			makeTask(9, true),
			makeTask(9, false),
			makeTask(14, true),
		]);

		expect(hourlyData).toHaveLength(24);
		expect(hourlyData[9]).toEqual({ hour: 9, count: 2, successCount: 1 });
		expect(hourlyData[14]).toEqual({ hour: 14, count: 1, successCount: 1 });
		expect(getMaxHourlyTaskCount(hourlyData)).toBe(2);
		expect(getPeakHours(hourlyData, 2)).toEqual([9, 14]);
		expect(formatHourShort(0)).toBe('12a');
		expect(formatHourShort(12)).toBe('12p');
		expect(formatHourShort(23)).toBe('11p');
		expect(formatHourFull(0)).toBe('12:00 AM');
		expect(formatHourFull(13)).toBe('1:00 PM');
	});
});
