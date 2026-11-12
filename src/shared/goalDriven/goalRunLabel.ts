/**
 * Stats/History label helpers for Goal-Driven Auto Run.
 *
 * A goal run has no document, but the stats layer keys everything off an Auto
 * Run session's `documentPath` (see `src/main/stats/auto-run.ts`). To make goal
 * runs first-class without a schema migration, the runner records the goal text
 * behind a stable `Goal: ` prefix as the `documentPath`
 * (see `useGoalRunner.startGoalRun`). That prefix is the discriminator the
 * Usage Dashboard uses to render a "Goal" affordance instead of the
 * file-name / task-count UI that only makes sense for real document runs.
 *
 * Pure string helpers - no Electron, React, or IPC.
 */

/** Prefix marking a stats `documentPath` as a goal run rather than a file path. */
export const GOAL_RUN_DOCUMENT_PREFIX = 'Goal: ';

/**
 * Max goal characters kept in the recorded label. Long goals are clipped so the
 * History/stats label stays readable in tables and tooltips.
 */
export const GOAL_RUN_LABEL_MAX_LENGTH = 80;

/**
 * Build the `documentPath` recorded for a goal run: `Goal: <first 80 chars>`.
 * The goal is trimmed first; anything past the limit is clipped with an ellipsis.
 */
export function formatGoalRunDocumentPath(goal: string): string {
	const trimmed = goal.trim();
	const clipped =
		trimmed.length > GOAL_RUN_LABEL_MAX_LENGTH
			? `${trimmed.slice(0, GOAL_RUN_LABEL_MAX_LENGTH).trimEnd()}…`
			: trimmed;
	return `${GOAL_RUN_DOCUMENT_PREFIX}${clipped}`;
}

/** True when a stats `documentPath` represents a goal run. */
export function isGoalRunDocument(documentPath?: string | null): boolean {
	return typeof documentPath === 'string' && documentPath.startsWith(GOAL_RUN_DOCUMENT_PREFIX);
}

/**
 * The human-readable goal text for display: the recorded label with the
 * `Goal: ` prefix stripped. Document-run paths are returned unchanged.
 */
export function goalRunLabel(documentPath?: string | null): string {
	if (!isGoalRunDocument(documentPath)) {
		return documentPath ?? '';
	}
	return (documentPath as string).slice(GOAL_RUN_DOCUMENT_PREFIX.length);
}
