import type { AutoRunSession, StatsTimeRange } from './stats-types';
import { isGoalRunDocument } from './goalDriven/goalRunLabel';
import { toLocalYmd } from './localDay';
import { fillDaySeries } from './daySeries';
import { usageReadWindow } from './statsTimeRange';

/**
 * Auto Run figures for the Usage Dashboard and `maestro-cli stats-activity`.
 * One implementation, so the CLI's run and task totals match the Auto Run tab.
 *
 * Two kinds of row need keeping out of the task math:
 * - **Goal runs** record their goal as the document and their 0-100 progress
 *   as `tasksCompleted` of `tasksTotal: 100`. They have no checkboxes, so they
 *   are counted on their own and never summed into tasks.
 * - **Unfinished runs** (still going, or the app quit before `endAutoRun`)
 *   have `duration` 0 and no completed count yet. They count as runs, but stay
 *   out of averages and out of the success rate's denominator, where their
 *   start-time checkbox total would read as tasks that failed.
 */

export interface AutoRunDayData {
	/** Local `YYYY-MM-DD`. */
	date: string;
	/** Checkboxes in the day's finished document runs. */
	count: number;
	/** Checkboxes those runs ticked. */
	successCount: number;
}

export interface AutoRunMetrics {
	/** Every run in range, of any kind or state. */
	totalRuns: number;
	/** Runs that recorded an end (duration > 0). */
	finishedRuns: number;
	/** Runs still going, or that never recorded an end. */
	unfinishedRuns: number;
	/** Goal-driven runs (no checkboxes). */
	goalRuns: number;
	/** Checkboxes ticked by finished document runs. */
	totalTasksCompleted: number;
	/** Checkboxes those same runs had. */
	totalTasksAttempted: number;
	/** Ticked checkboxes per finished document run. */
	avgTasksPerRun: string;
	/** Ticked over attempted, 0-100. */
	successRate: number;
	/** Mean wall time of finished runs (document and goal). */
	avgRunDuration: number;
	/** Finished document runs' wall time per ticked checkbox. */
	avgTimePerTask: number;
	/** Sum of every run's duration; always goalDrivenDuration + specDrivenDuration. */
	totalDuration: number;
	/** Run time of runs stored with `kind: 'goal-driven'`. */
	goalDrivenDuration: number;
	/** Includes runs with no or an unrecognized `kind` (rows from before the column). */
	specDrivenDuration: number;
}

/** A run that recorded its end (`endAutoRun` writes a duration). */
export function isFinishedAutoRun(session: AutoRunSession): boolean {
	return session.duration > 0;
}

/** A checkbox-document run (not a goal run). */
export function isDocumentAutoRun(session: AutoRunSession): boolean {
	return !isGoalRunDocument(session.documentPath);
}

/**
 * Ticked vs total checkboxes per local day, over the range's whole window
 * (zero-filled), from finished document runs only.
 */
export function groupSessionsByDate(
	sessions: AutoRunSession[],
	timeRange: StatsTimeRange,
	now: number = Date.now()
): AutoRunDayData[] {
	const grouped = new Map<string, AutoRunDayData>();
	let earliest: string | null = null;
	for (const session of sessions) {
		const date = toLocalYmd(session.startTime);
		if (earliest === null || date < earliest) earliest = date;
		if (!isFinishedAutoRun(session) || !isDocumentAutoRun(session)) continue;
		const day = grouped.get(date) ?? { date, count: 0, successCount: 0 };
		day.count += session.tasksTotal ?? 0;
		day.successCount += session.tasksCompleted ?? 0;
		grouped.set(date, day);
	}
	if (sessions.length === 0) return [];
	const window = usageReadWindow(timeRange, earliest, now);
	return fillDaySeries([...grouped.values()], window.startYmd, window.endYmd, (date) => ({
		date,
		count: 0,
		successCount: 0,
	}));
}

export function computeAutoRunMetrics(sessions: AutoRunSession[]): AutoRunMetrics {
	const finished = sessions.filter(isFinishedAutoRun);
	const finishedDocs = finished.filter(isDocumentAutoRun);
	const goalRuns = sessions.filter((s) => !isDocumentAutoRun(s)).length;

	const totalTasksCompleted = finishedDocs.reduce((sum, s) => sum + (s.tasksCompleted ?? 0), 0);
	const totalTasksAttempted = finishedDocs.reduce((sum, s) => sum + (s.tasksTotal ?? 0), 0);
	const finishedDuration = finished.reduce((sum, s) => sum + s.duration, 0);
	const finishedDocDuration = finishedDocs.reduce((sum, s) => sum + s.duration, 0);
	// The time split reads the stored engine kind only - not the `Goal: `
	// document-path prefix, which is a display label and not the source of truth.
	const totalDuration = sessions.reduce((sum, s) => sum + s.duration, 0);
	const goalDrivenDuration = sessions.reduce(
		(sum, s) => (s.kind === 'goal-driven' ? sum + s.duration : sum),
		0
	);

	return {
		totalRuns: sessions.length,
		finishedRuns: finished.length,
		unfinishedRuns: sessions.length - finished.length,
		goalRuns,
		totalTasksCompleted,
		totalTasksAttempted,
		avgTasksPerRun:
			finishedDocs.length > 0 ? (totalTasksCompleted / finishedDocs.length).toFixed(1) : '0',
		// Main stores tasks_total >= tasks_completed for every finished run, so
		// this cannot pass 100; the clamp covers rows written before that rule.
		successRate:
			totalTasksAttempted > 0
				? Math.min(100, Math.round((totalTasksCompleted / totalTasksAttempted) * 100))
				: 0,
		avgRunDuration: finished.length > 0 ? finishedDuration / finished.length : 0,
		avgTimePerTask: totalTasksCompleted > 0 ? finishedDocDuration / totalTasksCompleted : 0,
		totalDuration,
		goalDrivenDuration,
		specDrivenDuration: totalDuration - goalDrivenDuration,
	};
}

export function getAutoRunChartMax(tasksByDate: AutoRunDayData[]): number {
	if (tasksByDate.length === 0) return 0;
	return Math.max(...tasksByDate.map((day) => Math.max(day.successCount, day.count)));
}
