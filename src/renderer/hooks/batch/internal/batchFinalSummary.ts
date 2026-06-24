import { formatElapsedTime } from '../../../../shared/formatters';
import {
	getBadgeForTime,
	getNextBadge,
	formatTimeRemaining,
} from '../../../constants/conductorBadges';
import type { AutoRunStats, HistoryEntry } from '../../../types';

type AutoRunHistoryEntry = Pick<
	HistoryEntry,
	'type' | 'summary' | 'usageStats' | 'elapsedTimeMs' | 'timestamp' | 'completedTaskCount'
>;

export interface FinalSummaryParams {
	wasStopped: boolean;
	totalCompletedTasks: number;
	totalElapsedMs: number;
	stalledDocuments: Map<string, string>;
	documents: ReadonlyArray<{ filename: string }>;
	loopEnabled: boolean;
	loopIteration: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCost: number;
	autoRunStats?: AutoRunStats;
}

export interface FinalSummaryResult {
	summary: string;
	details: string;
	isSuccess: boolean;
	statusText: string;
}

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

/**
 * Builds the final-run summary entry shown at the end of an Auto Run.
 *
 * Pure function: takes counts/stalls/elapsed/badge inputs and returns the
 * markdown strings + success flag. Does not touch state, refs, or IO.
 */
export function buildFinalSummary(params: FinalSummaryParams): FinalSummaryResult {
	const {
		wasStopped,
		totalCompletedTasks,
		totalElapsedMs,
		stalledDocuments,
		documents,
		loopEnabled,
		loopIteration,
		totalInputTokens,
		totalOutputTokens,
		totalCost,
		autoRunStats,
	} = params;

	const loopsCompleted = loopEnabled ? loopIteration + 1 : 1;

	const stalledCount = stalledDocuments.size;
	const allDocsStalled = stalledCount === documents.length;
	const someDocsStalled = stalledCount > 0 && stalledCount < documents.length;
	const statusText = wasStopped
		? 'stopped'
		: allDocsStalled
			? 'stalled'
			: someDocsStalled
				? 'completed with stalls'
				: 'completed';

	// Project cumulative time so the badge level reflects this run before stats persist it.
	const projectedCumulativeTime = (autoRunStats?.cumulativeTimeMs || 0) + totalElapsedMs;
	const currentBadge = getBadgeForTime(projectedCumulativeTime);
	const nextBadge = getNextBadge(currentBadge);
	const levelProgressText = nextBadge
		? `Level ${currentBadge?.level || 0} → ${nextBadge.level}: ${formatTimeRemaining(projectedCumulativeTime, nextBadge)}`
		: currentBadge
			? `Level ${currentBadge.level} (${currentBadge.name}) - Maximum level achieved!`
			: 'Level 0 → 1: ' + formatTimeRemaining(0, getBadgeForTime(0));

	const stalledSuffix = stalledCount > 0 ? ` (${stalledCount} stalled)` : '';
	const summary = `Auto Run ${statusText}: ${totalCompletedTasks} task${totalCompletedTasks !== 1 ? 's' : ''} in ${formatElapsedTime(totalElapsedMs)}${stalledSuffix}`;

	let statusMessage: string;
	if (wasStopped) {
		statusMessage = 'Stopped by user';
	} else if (allDocsStalled) {
		statusMessage = `Stalled - All ${stalledCount} document(s) stopped making progress`;
	} else if (someDocsStalled) {
		statusMessage = `Completed with ${stalledCount} stalled document(s)`;
	} else {
		statusMessage = 'Completed';
	}

	const stalledDocsSection: string[] = [];
	if (stalledCount > 0) {
		stalledDocsSection.push('');
		stalledDocsSection.push('**Stalled Documents**');
		stalledDocsSection.push('');
		stalledDocsSection.push(
			'The following documents stopped making progress after multiple attempts:'
		);
		for (const [docName, reason] of stalledDocuments) {
			stalledDocsSection.push(`- **${docName}**: ${reason}`);
		}
		stalledDocsSection.push('');
		stalledDocsSection.push(
			'*Tasks in stalled documents may need manual review or clarification.*'
		);
	}

	const details = [
		`**Auto Run Summary**`,
		'',
		`- **Status:** ${statusMessage}`,
		`- **Tasks Completed:** ${totalCompletedTasks}`,
		`- **Total Duration:** ${formatElapsedTime(totalElapsedMs)}`,
		loopEnabled ? `- **Loops Completed:** ${loopsCompleted}` : '',
		totalInputTokens > 0 || totalOutputTokens > 0
			? `- **Total Tokens:** ${(totalInputTokens + totalOutputTokens).toLocaleString()} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`
			: '',
		totalCost > 0 ? `- **Total Cost:** $${totalCost.toFixed(4)}` : '',
		'',
		`- **Documents:** ${documents.map((d) => d.filename).join(', ')}`,
		...stalledDocsSection,
		'',
		`**Achievement Progress**`,
		`- ${levelProgressText}`,
	]
		.filter((line) => line !== '')
		.join('\n');

	const isSuccess = !wasStopped && !allDocsStalled;

	return { summary, details, isSuccess, statusText };
}
