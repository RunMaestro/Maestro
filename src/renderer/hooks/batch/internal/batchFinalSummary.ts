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
import type {
	AutoRunEndOutcome,
	AutoRunFailureEntry,
	AutoRunOutcomeStatus,
} from '../../../../shared/stats-types';
import {
	buildFinalSummaryFacts,
	renderFinalSummaryFactsMarkdown,
	type FinalSummaryFacts,
	type FinalSummaryFactsParams,
} from '../../../../shared/playbookRunReport';

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

// The pure facts half of the final summary lives in shared/playbookRunReport
// so the CLI and the run report reuse it. Re-exported for existing importers.
export { buildFinalSummaryFacts, type FinalSummaryFacts, type FinalSummaryFactsParams };

export interface FinalSummaryParams extends FinalSummaryFactsParams {
	autoRunStats?: AutoRunStats;
}

export interface FinalSummaryResult {
	summary: string;
	details: string;
	isSuccess: boolean;
	statusText: string;
	/** Tier A of the playbook run report. */
	facts: FinalSummaryFacts;
}

/**
 * Builds the final-run summary entry shown at the end of an Auto Run.
 *
 * Pure function: the facts come from the shared `buildFinalSummaryFacts`; this
 * adds the renderer-only achievement progress line. Does not touch state,
 * refs, or IO.
 */
export function buildFinalSummary(params: FinalSummaryParams): FinalSummaryResult {
	const { autoRunStats, ...factsParams } = params;
	const facts = buildFinalSummaryFacts(factsParams);

	// Project cumulative time so the badge level reflects this run before stats persist it.
	const projectedCumulativeTime = (autoRunStats?.cumulativeTimeMs || 0) + facts.totalElapsedMs;
	const currentBadge = getBadgeForTime(projectedCumulativeTime);
	const nextBadge = getNextBadge(currentBadge);
	const levelProgressText = nextBadge
		? `Level ${currentBadge?.level || 0} → ${nextBadge.level}: ${formatTimeRemaining(projectedCumulativeTime, nextBadge)}`
		: currentBadge
			? `Level ${currentBadge.level} (${currentBadge.name}) - Maximum level achieved!`
			: 'Level 0 → 1: ' + formatTimeRemaining(0, getBadgeForTime(0));

	const details = [
		renderFinalSummaryFactsMarkdown(facts),
		`**Achievement Progress**`,
		`- ${levelProgressText}`,
	].join('\n');

	return {
		summary: facts.summary,
		details,
		isSuccess: facts.isSuccess,
		statusText: facts.statusText,
		facts,
	};
}

/**
 * The `auto_run_sessions.status` for a finished run, from its summary's
 * `statusText`. A halt marker ends the run early, so a halted run the user did
 * not stop is `failed`. "completed with stalls" is `completed`: the stalled
 * document count is stored beside it.
 */
export function autoRunOutcomeStatus(statusText: string, halted: boolean): AutoRunOutcomeStatus {
	if (statusText === 'stopped') return 'stopped';
	if (halted) return 'failed';
	if (statusText === 'stalled') return 'stalled';
	return 'completed';
}

/**
 * The outcome `endAutoRun` records: the status, how many distinct documents
 * stalled, and every stall, error, and halt in the order they happened. The
 * stalled count comes from the failures so a force-kill, which has only the
 * failure list, reports the same figure as a run that finished.
 */
export function buildAutoRunEndOutcome(
	status: AutoRunOutcomeStatus,
	failures: readonly AutoRunFailureEntry[]
): AutoRunEndOutcome {
	const stalledDocuments = new Set(
		failures.filter((failure) => failure.kind === 'stall').map((f) => f.documentFilename)
	);
	return { status, documentsStalled: stalledDocuments.size, failures: [...failures] };
}
