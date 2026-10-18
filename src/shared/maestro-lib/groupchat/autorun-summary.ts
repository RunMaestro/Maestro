/**
 * @file groupchat/autorun-summary.ts
 * @description The line a group chat logs as a participant's reply when the Auto Run a `!autorun`
 * directive started has ended. The desktop's batch handler and the headless runtime say it the same
 * way, so a chat reads alike whichever host ran the participant.
 */

export interface GroupChatAutoRunOutcome {
	/** The run was stopped before it finished its tasks. */
	wasStopped: boolean;
	completedTasks: number;
	totalTasks: number;
	documentsProcessed: number;
}

export function groupChatAutoRunSummary(outcome: GroupChatAutoRunOutcome): string {
	return outcome.wasStopped
		? `Auto Run stopped: completed ${outcome.completedTasks} of ${outcome.totalTasks} tasks across ${outcome.documentsProcessed} document(s).`
		: `Auto Run complete: ${outcome.completedTasks}/${outcome.totalTasks} tasks finished across ${outcome.documentsProcessed} document(s).`;
}
