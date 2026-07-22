// Auto Run history reconciliation.
//
// The Auto Run runners (renderer batch runner and CLI batch processor) keep
// cumulative counters in memory: tasks completed, tokens, cost, elapsed time.
// Those counters reset whenever an Auto Run spans a process/runtime boundary
// (app restart, resume, manual stop/restart, process kill). The per-task
// history entries, however, persist on disk. This module reconstructs the
// cumulative totals from the durable history so the final summary survives
// restarts, and merges them with the live counters via Math.max so neither
// source can undercount the other.
//
// This is shared verbatim between the renderer and the CLI so both surfaces
// report identical cumulative stats.

import type { HistoryEntry } from './types';

// Only the fields reconciliation needs. Accepts both the shared HistoryEntry
// and the renderer's extension of it.
export type AutoRunHistoryEntry = Pick<
	HistoryEntry,
	'type' | 'summary' | 'usageStats' | 'elapsedTimeMs' | 'timestamp' | 'completedTaskCount'
>;

export interface FinalSummaryTotals {
	totalCompletedTasks: number;
	totalElapsedMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCost: number;
}

export interface AutoRunHistoryTotals extends FinalSummaryTotals {
	entryCount: number;
}

const FINAL_AUTORUN_SUMMARY_RE =
	/^Auto Run (completed|completed with stalls|stalled|stopped|killed):/;
const LOOP_SUMMARY_RE = /^Loop \d+(?: \(final\))? completed:/;
const CONTROL_SUMMARY_PREFIXES = [
	'Auto Run started in worktree',
	'Auto Run error:',
	'PR created:',
	'PR creation failed:',
	'Document stalled:',
	'Goal-Driven Auto Run started',
	'Goal progress:',
	'Goal completed',
	'Goal run hit a deadlock',
	'Goal run reached its iteration limit',
	'Goal run stalled',
	'Goal run stopped by user',
];

function isFinalAutoRunSummary(entry: AutoRunHistoryEntry): boolean {
	// Real per-task rows carry completedTaskCount; summary/control rows never do.
	// A genuine task summary can still read like a control phrase (e.g.
	// "Auto Run completed: ..." pasted into a task), so trust the field first.
	if (entry.completedTaskCount !== undefined) return false;
	return entry.type === 'AUTO' && FINAL_AUTORUN_SUMMARY_RE.test(entry.summary);
}

function isAutoRunControlEntry(entry: AutoRunHistoryEntry): boolean {
	if (entry.type !== 'AUTO') return true;
	// A persisted task row (completedTaskCount set) is real work, never a control
	// row, regardless of how its free-form summary happens to read.
	if (entry.completedTaskCount !== undefined) return false;
	if (isFinalAutoRunSummary(entry)) return true;
	if (LOOP_SUMMARY_RE.test(entry.summary)) return true;
	return CONTROL_SUMMARY_PREFIXES.some((prefix) => entry.summary.startsWith(prefix));
}

/**
 * Reconstruct cumulative Auto Run work stats from persisted history entries.
 *
 * The runner keeps in-memory counters, but those reset if an Auto Run spans
 * process/runtime boundaries. The history file is the durable source for the
 * final summary, so aggregate entries after the previous final summary and
 * exclude summary/control rows that would double-count task work.
 *
 * Known limitation: the run boundary is the last persisted final-summary row.
 * If a prior run crashed or was force-quit before writing its final summary,
 * its task rows fall inside this window and inflate the totals. Because callers
 * merge with `Math.max`, that inflation wins over the live counter. Filtering by
 * a per-run start timestamp would close this gap; until every run writes a start
 * marker, treat the aggregate as an upper bound rather than an exact count.
 */
export function aggregateAutoRunHistoryTotals(
	entries: ReadonlyArray<AutoRunHistoryEntry>
): AutoRunHistoryTotals | null {
	const orderedEntries = [...entries]
		.filter((entry) => entry.type === 'AUTO')
		.sort((a, b) => a.timestamp - b.timestamp);
	let previousFinalSummaryIndex = -1;
	for (let i = orderedEntries.length - 1; i >= 0; i--) {
		if (isFinalAutoRunSummary(orderedEntries[i])) {
			previousFinalSummaryIndex = i;
			break;
		}
	}
	const currentRunEntries = orderedEntries.slice(previousFinalSummaryIndex + 1);
	const taskEntries = currentRunEntries.filter((entry) => !isAutoRunControlEntry(entry));

	if (taskEntries.length === 0) return null;

	return taskEntries.reduce<AutoRunHistoryTotals>(
		(totals, entry) => {
			const usageStats = entry.usageStats;
			totals.totalCompletedTasks += Math.max(0, entry.completedTaskCount ?? 1);
			totals.totalElapsedMs += entry.elapsedTimeMs || 0;
			totals.totalInputTokens += usageStats?.inputTokens || 0;
			totals.totalOutputTokens += usageStats?.outputTokens || 0;
			totals.totalCost += usageStats?.totalCostUsd || 0;
			totals.entryCount += 1;
			return totals;
		},
		{
			totalCompletedTasks: 0,
			totalElapsedMs: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCost: 0,
			entryCount: 0,
		}
	);
}

export function mergeFinalSummaryTotals(
	runtimeTotals: FinalSummaryTotals,
	historyTotals: AutoRunHistoryTotals | null
): FinalSummaryTotals {
	if (!historyTotals) return runtimeTotals;

	return {
		totalCompletedTasks: Math.max(
			runtimeTotals.totalCompletedTasks,
			historyTotals.totalCompletedTasks
		),
		totalElapsedMs: Math.max(runtimeTotals.totalElapsedMs, historyTotals.totalElapsedMs),
		totalInputTokens: Math.max(runtimeTotals.totalInputTokens, historyTotals.totalInputTokens),
		totalOutputTokens: Math.max(runtimeTotals.totalOutputTokens, historyTotals.totalOutputTokens),
		totalCost: Math.max(runtimeTotals.totalCost, historyTotals.totalCost),
	};
}
