import type { AutoRunSession } from '../../../shared/stats-types';

export interface AutoRunDayData {
	date: string;
	count: number;
	successCount: number;
}

export interface AutoRunMetrics {
	totalSessions: number;
	totalTasksCompleted: number;
	totalTasksAttempted: number;
	avgTasksPerSession: string;
	successRate: number;
	avgSessionDuration: number;
	avgTaskDuration: number;
}

export function groupSessionsByDate(sessions: AutoRunSession[]): AutoRunDayData[] {
	const grouped: Record<string, { count: number; successCount: number }> = {};

	for (const session of sessions) {
		const date = formatLocalDate(new Date(session.startTime));
		if (!grouped[date]) {
			grouped[date] = { count: 0, successCount: 0 };
		}
		grouped[date].count += session.tasksTotal ?? 0;
		grouped[date].successCount += session.tasksCompleted ?? 0;
	}

	return Object.entries(grouped)
		.map(([date, stats]) => ({ date, ...stats }))
		.filter((entry) => entry.count > 0 || entry.successCount > 0)
		.sort((a, b) => a.date.localeCompare(b.date));
}

export function computeAutoRunMetrics(sessions: AutoRunSession[]): AutoRunMetrics {
	const totalSessions = sessions.length;
	const totalTasksCompleted = sessions.reduce((sum, session) => {
		return sum + (session.tasksCompleted ?? 0);
	}, 0);
	const totalTasksAttempted = sessions.reduce((sum, session) => {
		return sum + (session.tasksTotal ?? 0);
	}, 0);
	const totalSessionDuration = sessions.reduce((sum, session) => sum + session.duration, 0);

	return {
		totalSessions,
		totalTasksCompleted,
		totalTasksAttempted,
		avgTasksPerSession: totalSessions > 0 ? (totalTasksCompleted / totalSessions).toFixed(1) : '0',
		successRate:
			totalTasksAttempted > 0 ? Math.round((totalTasksCompleted / totalTasksAttempted) * 100) : 0,
		avgSessionDuration: totalSessions > 0 ? totalSessionDuration / totalSessions : 0,
		avgTaskDuration: totalTasksCompleted > 0 ? totalSessionDuration / totalTasksCompleted : 0,
	};
}

export function getAutoRunChartMax(tasksByDate: AutoRunDayData[]): number {
	if (tasksByDate.length === 0) return 0;
	return Math.max(...tasksByDate.map((day) => Math.max(day.successCount, day.count)));
}

export function formatFullDate(dateStr: string): string {
	return parseLocalDate(dateStr).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

function formatLocalDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(dateStr: string): Date {
	return new Date(dateStr + 'T00:00');
}
