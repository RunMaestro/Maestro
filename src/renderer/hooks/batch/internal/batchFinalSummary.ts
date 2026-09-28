import { formatElapsedTime } from '../../../../shared/formatters';
import {
	aggregateAutoRunHistoryTotals,
	mergeFinalSummaryTotals,
	type AutoRunHistoryEntry,
	type AutoRunHistoryTotals,
	type FinalSummaryTotals,
} from '../../../../shared/autoRunHistoryReconciliation';
import {
	getBadgeForTime,
	getNextBadge,
	formatTimeRemaining,
} from '../../../constants/conductorBadges';
import type { AutoRunStats } from '../../../types';

// Reconciliation helpers now live in shared/ so the CLI batch processor can
// reuse the exact same logic. Re-exported here to keep existing importers
// (useBatchRunner, useBatchKillAction, tests) unchanged.
export {
	aggregateAutoRunHistoryTotals,
	mergeFinalSummaryTotals,
	type AutoRunHistoryEntry,
	type AutoRunHistoryTotals,
	type FinalSummaryTotals,
};

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
