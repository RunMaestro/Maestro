/**
 * @file workflow-state-machine.ts
 * @description Pure state transitions for Group Chat workflow runs.
 */

import type {
	GroupChatWorkflowHandoff,
	GroupChatWorkflowPlan,
	GroupChatWorkflowRun,
	GroupChatWorkflowStage,
} from '../../shared/group-chat-workflow-types';

function copyRun(run: GroupChatWorkflowRun): GroupChatWorkflowRun {
	return {
		...run,
		stageStatuses: { ...run.stageStatuses },
		handoffs: [...run.handoffs],
	};
}

/** Create an approval-gated run with every stage pending. */
export function createRun(plan: GroupChatWorkflowPlan): GroupChatWorkflowRun {
	return {
		plan,
		status: 'awaiting-approval',
		currentStageIndex: 0,
		stageStatuses: Object.fromEntries(plan.stages.map((stage) => [stage.id, 'pending'])),
		handoffs: [],
	};
}

/** Approve a pending run and start its first stage. */
export function approveRun(run: GroupChatWorkflowRun): GroupChatWorkflowRun {
	const nextRun = copyRun(run);
	if (run.status !== 'awaiting-approval') return nextRun;

	const currentStage = getCurrentStage(run);
	if (!currentStage) {
		return {
			...nextRun,
			status: 'complete',
			endedAt: Date.now(),
		};
	}

	nextRun.status = 'running';
	nextRun.startedAt = Date.now();
	nextRun.stageStatuses[currentStage.id] = 'running';
	return nextRun;
}

/** Complete the running stage and advance to the next stage, if any. */
export function completeStage(
	run: GroupChatWorkflowRun,
	handoff: GroupChatWorkflowHandoff
): GroupChatWorkflowRun {
	const nextRun = copyRun(run);
	if (run.status !== 'running') return nextRun;

	const currentStage = getCurrentStage(run);
	if (!currentStage) return nextRun;

	nextRun.stageStatuses[currentStage.id] = 'complete';
	nextRun.handoffs.push({
		...handoff,
		...(handoff.artifactPaths ? { artifactPaths: [...handoff.artifactPaths] } : {}),
	});
	nextRun.currentStageIndex += 1;

	const nextStage = getCurrentStage(nextRun);
	if (nextStage) {
		nextRun.stageStatuses[nextStage.id] = 'running';
		return nextRun;
	}

	nextRun.status = 'complete';
	nextRun.endedAt = Date.now();
	return nextRun;
}

/** Fail the running stage and abort the run immediately. */
export function failStage(run: GroupChatWorkflowRun, reason: string): GroupChatWorkflowRun {
	const nextRun = copyRun(run);
	if (run.status !== 'running') return nextRun;

	const currentStage = getCurrentStage(run);
	if (!currentStage) return nextRun;

	nextRun.stageStatuses[currentStage.id] = 'failed';
	nextRun.status = 'aborted';
	nextRun.abortReason = reason;
	nextRun.endedAt = Date.now();
	return nextRun;
}

/** Abort an active run without changing its current stage status. */
export function abortRun(run: GroupChatWorkflowRun, reason: string): GroupChatWorkflowRun {
	const nextRun = copyRun(run);
	if (!isRunActive(run)) return nextRun;

	nextRun.status = 'aborted';
	nextRun.abortReason = reason;
	nextRun.endedAt = Date.now();
	return nextRun;
}

/** Return the stage at the run's cursor, or null after the final stage. */
export function getCurrentStage(run: GroupChatWorkflowRun): GroupChatWorkflowStage | null {
	return run.plan.stages[run.currentStageIndex] ?? null;
}

/** Whether a run can still be approved, advanced, failed, or aborted. */
export function isRunActive(run: GroupChatWorkflowRun): boolean {
	return run.status === 'awaiting-approval' || run.status === 'running';
}
